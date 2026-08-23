import { randomUUID } from 'node:crypto'
import { createKernel, type Kernel } from '@kernhq/kernel'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { billingModule } from './index.js'
import { invoices } from './schema.js'
import * as entitlements from './services/entitlements.js'
import * as plansSvc from './services/plans.js'
import * as subsSvc from './services/subscriptions.js'
import * as usageSvc from './services/usage.js'

/**
 * Billing against a real Postgres, in a scratch database dropped afterwards.
 *
 * The case worth the most attention is the one where nothing is sold: a workspace with no
 * subscription row must come back unlimited, because that is what every self-hosted Kern is.
 */

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_billing_test_${Date.now().toString(36)}`

let kernel: Kernel
let admin: pg.Client
let databaseUrl: string

const WS_A = randomUUID()
const WS_B = randomUUID()

/** Seat and byte counts core would report, so the recount path has something to read. */
const counted = new Map<string, { seats: number; storageBytes: number }>()

function registerCoreStubs(k: Kernel) {
  k.broker.register('core', {
    'modules.isEnabled': { handler: async () => true },
    'workspaces.seats': {
      handler: async (input: { workspaceId: string }) => ({
        seats: counted.get(input.workspaceId)?.seats ?? 0,
      }),
    },
    'workspaces.usage': {
      handler: async (input: { workspaceId: string }) =>
        counted.get(input.workspaceId) ?? { seats: 0, storageBytes: 0 },
    },
    'workspaces.list': {
      handler: async () => [
        { id: WS_A, name: 'Acme', slug: 'acme' },
        { id: WS_B, name: 'Beta', slug: 'beta' },
      ],
    },
  })
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`
  databaseUrl = url.toString()

  kernel = await createKernel({
    service: 'billing-test',
    modules: [billingModule],
    role: 'api',
    env: {
      DATABASE_URL: databaseUrl,
      KERN_SECRET: 'test-secret-that-is-long-enough-for-kern',
      NODE_ENV: 'test',
      NATS_URL: undefined,
      VALKEY_URL: undefined,
    },
  })
  registerCoreStubs(kernel)
  await kernel.start()
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.end().catch(() => undefined)
}, 60_000)

describe('migrations', () => {
  it('secures the tenant table and deliberately leaves the operator tables open', async () => {
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      const tables = await client.query<{ tablename: string; rowsecurity: boolean }>(
        `select tablename, rowsecurity from pg_tables where schemaname = 'mod_billing' order by tablename`,
      )
      const secured = tables.rows
        .filter((r) => r.rowsecurity)
        .map((r) => r.tablename)
        .sort()
      // Only `invoices` is the customer's own record; the rest are the operator's, and the console
      // that lists every workspace could not read them under a policy. See schema.ts.
      expect(secured).toEqual(['invoices'])
      const policies = await client.query<{ n: number }>(
        `select count(*)::int as n from pg_policies where schemaname = 'mod_billing'`,
      )
      expect(policies.rows[0]!.n).toBe(1)
    } finally {
      await client.end()
    }
  })
})

describe('entitlements', () => {
  it('is unlimited for a workspace nothing bills', async () => {
    const e = await entitlements.resolve(kernel, WS_B)
    expect(e.planName).toBeNull()
    expect(e.active).toBe(true)
    expect(e.seats).toBeUndefined()
  })

  it('applies the plan a workspace is on', async () => {
    const plan = await plansSvc.upsert(kernel, {
      slug: 'team',
      name: 'Team',
      description: 'the usual one',
      priceMinor: 800,
      currency: 'usd',
      interval: 'month',
      perSeat: true,
      trialDays: 14,
      limits: {
        seats: 3,
        storageBytes: 1024,
        modules: null,
        sso: false,
        auditRetentionDays: 30,
        apiRateLimit: null,
      },
      stripePriceId: null,
      highlights: ['Everything in self-hosted'],
      published: true,
      order: 10,
    })
    await subsSvc.setPlan(kernel, WS_A, plan.id)
    const e = await entitlements.resolve(kernel, WS_A)
    expect(e.planName).toBe('Team')
    expect(e.seats).toBe(3)
    expect(e.sso).toBe(false)
    expect(e.active).toBe(true)
  })

  it('lets an override comp one limit without resetting the others', async () => {
    await subsSvc.setOverride(kernel, WS_A, { seats: 50 }, null)
    const e = await entitlements.resolve(kernel, WS_A)
    expect(e.seats).toBe(50)
    // still the plan's, not a default
    expect(e.sso).toBe(false)
    expect(e.auditRetentionDays).toBe(30)
    await subsSvc.setOverride(kernel, WS_A, null, null)
    expect((await entitlements.resolve(kernel, WS_A)).seats).toBe(3)
  })

  it('marks a suspended workspace inactive so writes stop and reads do not', async () => {
    await subsSvc.setStatus(kernel, WS_A, 'suspended')
    const e = await entitlements.resolve(kernel, WS_A)
    expect(e.active).toBe(false)
    await subsSvc.setStatus(kernel, WS_A, 'active')
    expect((await entitlements.resolve(kernel, WS_A)).active).toBe(true)
  })

  it('answers the kernel through the broker, which is the only coupling core has', async () => {
    expect(kernel.broker.has('billing.entitlements.get')).toBe(true)
    const e = await kernel.entitlements.of(WS_A)
    expect(e.seats).toBe(3)
    await expect(kernel.entitlements.require(WS_A, 'seats', 3)).resolves.toBeUndefined()
    await expect(kernel.entitlements.require(WS_A, 'seats', 4)).rejects.toThrow(/3 seats/)
    kernel.entitlements.invalidate(WS_A)
  })
})

describe('plans', () => {
  it('refuses a slug another plan already uses', async () => {
    await expect(
      plansSvc.upsert(kernel, {
        slug: 'team',
        name: 'Team again',
        description: '',
        priceMinor: 100,
        currency: 'usd',
        interval: 'month',
        perSeat: true,
        trialDays: 0,
        limits: {
          seats: null,
          storageBytes: null,
          modules: null,
          sso: true,
          auditRetentionDays: null,
          apiRateLimit: null,
        },
        stripePriceId: null,
        highlights: [],
        published: false,
        order: 100,
      }),
    ).rejects.toThrow(/slug/i)
  })

  it('shows a stranger only what is published, and nothing internal', async () => {
    const draft = await plansSvc.upsert(kernel, {
      slug: 'secret',
      name: 'Not ready',
      description: '',
      priceMinor: 1,
      currency: 'usd',
      interval: 'month',
      perSeat: true,
      trialDays: 0,
      limits: {
        seats: null,
        storageBytes: null,
        modules: null,
        sso: true,
        auditRetentionDays: null,
        apiRateLimit: null,
      },
      stripePriceId: 'price_secret',
      highlights: [],
      published: false,
      order: 1,
    })
    const shown = await plansSvc.publicList(kernel)
    expect(shown.map((p) => p.slug)).toEqual(['team'])
    expect(JSON.stringify(shown)).not.toContain('price_')
    await plansSvc.setPublished(kernel, draft.id, true)
    expect((await plansSvc.publicList(kernel)).map((p) => p.slug)).toContain('secret')
    await plansSvc.archive(kernel, draft.id)
    // archiving withdraws it from the catalogue without deleting what a subscriber points at
    expect((await plansSvc.publicList(kernel)).map((p) => p.slug)).toEqual(['team'])
  })
})

describe('usage', () => {
  it('recounts seats rather than trusting a delta', async () => {
    counted.set(WS_A, { seats: 7, storageBytes: 0 })
    expect(await usageSvc.recountSeats(kernel, WS_A)).toBe(7)
    expect((await usageSvc.read(kernel, WS_A)).seats).toBe(7)
  })

  it('moves storage by a delta and never below zero', async () => {
    await usageSvc.bump(kernel, WS_A, { storageBytes: 500 })
    await usageSvc.bump(kernel, WS_A, { storageBytes: 300 })
    expect((await usageSvc.read(kernel, WS_A)).storageBytes).toBe(800)
    await usageSvc.bump(kernel, WS_A, { storageBytes: -10_000 })
    expect((await usageSvc.read(kernel, WS_A)).storageBytes).toBe(0)
  })

  it('reports the drift it found rather than silently correcting it', async () => {
    counted.set(WS_A, { seats: 7, storageBytes: 4096 })
    const { drift, counted: truth } = await usageSvc.reconcile(kernel, WS_A)
    expect(truth.storageBytes).toBe(4096)
    expect(drift.storageBytes).toBe(4096)
    const again = await usageSvc.reconcile(kernel, WS_A)
    expect(again.drift).toEqual({ seats: 0, storageBytes: 0 })
  })
})

describe('tenant isolation', () => {
  it('keeps one workspace out of another workspace invoices', async () => {
    await kernel.database.withWorkspace(WS_A, async (tx) => {
      await tx
        .insert(invoices)
        .values({ workspaceId: WS_A, status: 'paid', totalMinor: 800, currency: 'usd' })
    })
    const mine = await subsSvc.listInvoices(kernel, WS_A, 50)
    expect(mine).toHaveLength(1)
    const theirs = await subsSvc.listInvoices(kernel, WS_B, 50)
    expect(theirs).toHaveLength(0)
  })
})
