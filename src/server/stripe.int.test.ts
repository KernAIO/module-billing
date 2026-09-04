import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ANONYMOUS } from '@kernhq/contracts'
import { createHttpServer, createKernel, type Kernel } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { billingModule } from './index.js'
import { invoices, subscriptions } from './schema.js'
import * as entitlements from './services/entitlements.js'
import * as plansSvc from './services/plans.js'
import * as stripeSvc from './services/stripe.js'
import * as subsSvc from './services/subscriptions.js'

/**
 * The money path, end to end, against a real Postgres and a real HTTP server.
 *
 * Every assertion here stands for something that shipped broken and that no type-check could see.
 * Kern Cloud could not learn that anybody had paid: `handleWebhook` had no route in front of it, so
 * `https://<instance>/api/billing/webhook` — the URL `selfhost/.env.example` tells operators to give
 * Stripe — answered 404. Everything downstream of that (invoices, dunning, suspension) was therefore
 * dead code.
 *
 * Stripe itself is a local double, pointed at with `STRIPE_API_BASE`. What this module *sends*
 * Stripe is the part that was wrong — a second subscription instead of a reprice, one seat instead
 * of twelve, a success URL that 404s — and none of it is observable from the database afterwards.
 */

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_billing_stripe_${Date.now().toString(36)}`
const WEBHOOK_SECRET = 'whsec_test_secret_for_signing_fixtures'

const WS = randomUUID()
const CUSTOMER = 'cus_test_1'

let kernel: Kernel
let admin: pg.Client
let app: FastifyInstance
let httpUrl: string
let planId: string
/** What core answers `workspaces.list` with — the workspaces this instance has. */
const knownWorkspaces: Array<{ id: string; name: string; slug: string }> = [
  { id: WS, name: 'Acme', slug: 'acme' },
]

/** Every request the double saw, so what we sent Stripe can be asserted. */
const seen: Array<{ method: string; path: string; body: URLSearchParams }> = []
/** Stripe's answer for `GET /v1/subscriptions/:id`; null makes the retrieve fail. */
let remoteSubscription: Record<string, unknown> | null = null
/** Stripe's answer for `GET /v1/invoices`. */
let remoteInvoices: Array<Record<string, unknown>> = []
let stripeDouble: Server

/** An invoice the way Stripe sends it: the subscription's metadata snapshotted under `parent`. */
function invoiceObject(over: Record<string, unknown> = {}) {
  return {
    id: 'in_test_1',
    object: 'invoice',
    customer: CUSTOMER,
    status: 'paid',
    total: 0,
    currency: 'usd',
    number: 'KERN-0001',
    hosted_invoice_url: 'https://invoice.stripe.test/in_test_1',
    invoice_pdf: 'https://invoice.stripe.test/in_test_1/pdf',
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: 'sub_test_1', metadata: { kern_workspace_id: WS } },
    },
    ...over,
  }
}

function subscriptionObject(over: Record<string, unknown> = {}) {
  return {
    id: 'sub_test_1',
    object: 'subscription',
    status: 'active',
    customer: CUSTOMER,
    cancel_at_period_end: false,
    trial_end: null,
    metadata: { kern_workspace_id: WS, kern_plan_id: planId },
    items: {
      object: 'list',
      data: [
        {
          id: 'si_test_1',
          object: 'subscription_item',
          quantity: 1,
          current_period_end: Math.floor(Date.now() / 1000) + 86_400 * 30,
        },
      ],
    },
    ...over,
  }
}

/** Enough of Stripe to answer the four calls this module makes. */
function startStripeDouble(): Promise<string> {
  stripeDouble = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      seen.push({ method: req.method ?? '', path, body })
      const send = (payload: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (path.startsWith('/v1/customers')) return send({ id: CUSTOMER, object: 'customer' })
      if (path === '/v1/invoices') return send({ object: 'list', data: remoteInvoices, has_more: false })
      if (path.startsWith('/v1/checkout/sessions'))
        return send({
          id: 'cs_test_1',
          object: 'checkout.session',
          url: 'https://checkout.stripe.test/cs_test_1',
        })
      if (path.startsWith('/v1/subscriptions/')) {
        if (!remoteSubscription)
          return send({ error: { type: 'invalid_request_error', message: 'No such subscription' } }, 404)
        if (req.method === 'POST') {
          // an update echoes the new state, the way Stripe does
          const quantity = Number(body.get('items[0][quantity]') ?? 1)
          remoteSubscription = subscriptionObject({
            metadata: {
              kern_workspace_id: body.get('metadata[kern_workspace_id]') ?? WS,
              kern_plan_id: body.get('metadata[kern_plan_id]') ?? planId,
            },
            items: {
              object: 'list',
              data: [{ ...(subscriptionObject().items.data[0] as object), quantity }],
            },
          })
        }
        return send(remoteSubscription)
      }
      send({ error: { type: 'invalid_request_error', message: `unhandled ${path}` } }, 404)
    })
  })
  return new Promise((resolve) => {
    stripeDouble.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(stripeDouble.address() as AddressInfo).port}`),
    )
  })
}

/** A webhook body with the header Stripe would have signed it with. */
function signed(event: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event)
  return {
    payload,
    signature: Stripe.webhooks.generateTestHeaderString({ payload, secret }),
  }
}

const post = (payload: string, signature: string) =>
  fetch(`${httpUrl}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  })

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`

  process.env.STRIPE_API_BASE = await startStripeDouble()
  process.env.STRIPE_SECRET_KEY = 'sk_test_kern'
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET

  // A file of plans, and a default that names one of them: the shape a fresh Kern Cloud boots in.
  const dir = await mkdtemp(join(tmpdir(), 'kern-billing-'))
  const file = join(dir, 'plans.json')
  await writeFile(
    file,
    JSON.stringify([
      {
        slug: 'team',
        name: 'Team',
        description: 'seeded from a file',
        priceMinor: 800,
        currency: 'usd',
        interval: 'month',
        perSeat: true,
        trialDays: 14,
        limits: {
          seats: 25,
          storageBytes: 1024,
          modules: null,
          sso: false,
          auditRetentionDays: 30,
          apiRateLimit: null,
        },
        stripePriceId: 'price_team',
        highlights: [],
        published: true,
        order: 10,
      },
    ]),
  )
  process.env.KERN_PLANS_FILE = file
  process.env.KERN_DEFAULT_PLAN_SLUG = 'team'

  kernel = await createKernel({
    service: 'billing-stripe-test',
    modules: [billingModule],
    role: 'api',
    env: {
      DATABASE_URL: url.toString(),
      KERN_SECRET: 'test-secret-that-is-long-enough-for-kern',
      KERN_BASE_URL: 'https://kern.test',
      NODE_ENV: 'test',
      NATS_URL: undefined,
      VALKEY_URL: undefined,
    },
  })
  kernel.broker.register('core', {
    'modules.isEnabled': { handler: async () => true },
    'workspaces.seats': { handler: async () => ({ seats: 12 }) },
    'workspaces.usage': { handler: async () => ({ seats: 12, storageBytes: 0 }) },
    'workspaces.list': { handler: async () => knownWorkspaces },
  })
  await kernel.start()

  const team = await plansSvc.bySlug(kernel, 'team')
  planId = team?.id ?? ''
  remoteSubscription = subscriptionObject()

  app = await createHttpServer({
    kernel,
    resolvePrincipal: async () => ANONYMOUS,
    corsOrigins: ['https://kern.test'],
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  httpUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
}, 180_000)

afterAll(async () => {
  await app?.close().catch(() => undefined)
  stripeDouble?.close()
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.end().catch(() => undefined)
  for (const k of ['STRIPE_API_BASE', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'KERN_PLANS_FILE'])
    delete process.env[k]
  delete process.env.KERN_DEFAULT_PLAN_SLUG
}, 60_000)

/**
 * The route that did not exist.
 *
 * `handleWebhook` was correct and had zero callers: no contract route, nothing in the router, and no
 * raw-body route anywhere. So Stripe charged the card and Kern never heard — the plan never changed,
 * no invoice was ever mirrored, and nothing could ever become past due.
 */
describe('POST /api/billing/webhook', () => {
  it('is mounted at the path the operator is told to give Stripe', async () => {
    // `selfhost/.env.example` documents https://your-domain/api/billing/webhook. Before this route
    // existed that URL answered 404, which is indistinguishable from a typo in the Stripe dashboard.
    const { payload, signature } = signed({
      id: 'evt_mounted',
      type: 'customer.subscription.updated',
      data: { object: subscriptionObject() },
    })
    const res = await post(payload, signature)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ received: true, handled: true })
  })

  it('applies what it was sent', async () => {
    const sub = await subsSvc.get(kernel, WS)
    expect(sub?.status).toBe('active')
    expect(sub?.stripeSubscriptionId).toBe('sub_test_1')
    expect(sub?.planSlug).toBe('team')
  })

  it('refuses a body whose signature does not verify', async () => {
    const { payload } = signed({ id: 'evt_forged', type: 'invoice.paid', data: { object: {} } })
    const forged = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_a_different_secret_entirely',
    })
    const res = await post(payload, forged)
    expect(res.status).toBe(400)
  })

  it('refuses a body with no signature header at all', async () => {
    const res = await fetch(`${httpUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
  })

  /**
   * The reason the route has to be `raw`.
   *
   * Stripe signs the exact bytes it sent. Anything that parses the JSON and re-encodes it before
   * verifying breaks every signature — and breaks it in a way that reads as a wrong secret, which is
   * the wrong thing to go and check.
   */
  it('verifies against the bytes that were sent, not a re-encoding of them', async () => {
    const payload = '{"id":"evt_spacing",  "type":"invoice.paid","data":{"object":{}}}'
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
    const res = await post(payload, signature)
    // JSON.parse + JSON.stringify would collapse those two spaces and the signature would fail
    expect(res.status).toBe(200)
  })

  it('answers a replay "already applied" without applying it twice', async () => {
    const { payload, signature } = signed({
      id: 'evt_mounted',
      type: 'customer.subscription.updated',
      data: { object: subscriptionObject() },
    })
    const res = await post(payload, signature)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ received: true, handled: false })
  })
})

/**
 * A claim taken and never given back loses the event for ever.
 *
 * `claim()` inserts the id and then the handler runs, so a handler that threw left the id claimed —
 * and Stripe's retry, which is the only thing that would have fixed it, was answered "already
 * applied" and dropped. Silently, permanently, on the exact events that failed.
 */
describe('a webhook whose handler fails', () => {
  it('gives the claim back, so Stripe’s retry is a real delivery', async () => {
    remoteSubscription = null // the retrieve inside checkout.session.completed now throws
    const event = {
      id: 'evt_transient',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_x', object: 'checkout.session', subscription: 'sub_test_1' } },
    }
    const first = await post(signed(event).payload, signed(event).signature)
    expect(first.status).toBe(500)

    const claimed = await kernel.database.pool.query(
      `select 1 from mod_billing.webhook_events where id = 'evt_transient'`,
    )
    expect(claimed.rowCount).toBe(0)

    // Stripe retries, the transient cause has cleared, and the event lands
    remoteSubscription = subscriptionObject()
    const retry = await post(signed(event).payload, signed(event).signature)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ handled: true })
  })
})

/**
 * The invoice that arrived first.
 *
 * Stripe sends `invoice.paid` for a new subscription's first invoice *before*
 * `checkout.session.completed`. When no subscription row carries the customer yet — a subscription
 * made in the Stripe dashboard, an instance whose row is behind — `applyInvoice` returned quietly,
 * the event was recorded as applied and never retried, and the invoice was gone. (A checkout
 * started here writes the customer first, which is why the cloud's first purchase kept its invoice
 * while being suspected of losing it.)
 */
describe('an invoice that arrives before its subscription', () => {
  const invoiceRows = () => kernel.database.db.select().from(invoices).where(eq(invoices.workspaceId, WS))

  it('is placed by the subscription metadata Stripe snapshots on it', async () => {
    // no row knows this customer: exactly the state a first invoice meets
    await subsSvc.upsert(kernel, WS, { stripeCustomerId: null, stripeSubscriptionId: null })
    await kernel.database.pool.query(`delete from mod_billing.invoices where workspace_id = $1`, [WS])
    const { payload, signature } = signed({
      id: 'evt_first_invoice',
      type: 'invoice.paid',
      data: { object: invoiceObject({ id: 'in_first', customer: 'cus_unknown_yet' }) },
    })
    const res = await post(payload, signature)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ handled: true })

    const rows = await invoiceRows()
    expect(rows.map((r) => r.stripeInvoiceId)).toEqual(['in_first'])
    expect(rows[0]?.hostedUrl).toBe('https://invoice.stripe.test/in_test_1')
    expect(rows[0]?.pdfUrl).toBe('https://invoice.stripe.test/in_test_1/pdf')
  })

  it('is fetched from Stripe when the snapshot has no workspace, and retried when Stripe cannot answer yet', async () => {
    await subsSvc.upsert(kernel, WS, { stripeCustomerId: null, stripeSubscriptionId: null })
    await kernel.database.pool.query(`delete from mod_billing.invoices where workspace_id = $1`, [WS])
    remoteSubscription = null
    const event = {
      id: 'evt_early_invoice',
      type: 'invoice.paid',
      data: {
        object: invoiceObject({
          id: 'in_early',
          customer: 'cus_unknown_yet',
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: 'sub_test_1', metadata: {} },
          },
        }),
      },
    }
    // the assertion the defect is about: this used to be 200, which told Stripe never to try again
    expect((await post(signed(event).payload, signed(event).signature)).status).toBe(500)
    const claimed = await kernel.database.pool.query(
      `select 1 from mod_billing.webhook_events where id = 'evt_early_invoice'`,
    )
    expect(claimed.rowCount).toBe(0)

    // Stripe retries once the subscription can be read, and the invoice lands with it
    remoteSubscription = subscriptionObject()
    expect((await post(signed(event).payload, signed(event).signature)).status).toBe(200)
    expect((await invoiceRows()).map((r) => r.stripeInvoiceId)).toEqual(['in_early'])
    expect((await subsSvc.get(kernel, WS))?.stripeSubscriptionId).toBe('sub_test_1')
  })

  it('ignores an event for a workspace this instance does not have', async () => {
    // One sandbox, every endpoint: a developer's checkout reaches the cloud too. The cloud wrote
    // an invoice row for a workspace id it had never seen, with a 200 and nothing in the log.
    const stranger = randomUUID()
    const invoice = signed({
      id: 'evt_stranger_invoice',
      type: 'invoice.paid',
      data: {
        object: invoiceObject({
          id: 'in_stranger',
          customer: 'cus_stranger',
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: 'sub_stranger', metadata: { kern_workspace_id: stranger } },
          },
        }),
      },
    })
    expect((await post(invoice.payload, invoice.signature)).status).toBe(200)
    const created = signed({
      id: 'evt_stranger_sub',
      type: 'customer.subscription.created',
      data: {
        object: subscriptionObject({
          id: 'sub_stranger',
          customer: 'cus_stranger',
          metadata: { kern_workspace_id: stranger, kern_plan_id: planId },
        }),
      },
    })
    expect((await post(created.payload, created.signature)).status).toBe(200)

    const orphanInvoices = await kernel.database.pool.query(
      `select 1 from mod_billing.invoices where workspace_id = $1`,
      [stranger],
    )
    const orphanSubs = await kernel.database.pool.query(
      `select 1 from mod_billing.subscriptions where workspace_id = $1`,
      [stranger],
    )
    expect(orphanInvoices.rowCount).toBe(0)
    expect(orphanSubs.rowCount).toBe(0)
  })

  it('skips an invoice that is not a subscription’s and whose customer nobody knows', async () => {
    const { payload, signature } = signed({
      id: 'evt_stray_invoice',
      type: 'invoice.paid',
      data: { object: invoiceObject({ id: 'in_stray', customer: 'cus_nobody', parent: null }) },
    })
    const res = await post(payload, signature)
    expect(res.status).toBe(200)
    expect((await invoiceRows()).map((r) => r.stripeInvoiceId)).not.toContain('in_stray')
  })

  it('is mirrored when checkout completes, for the ones already lost', async () => {
    await kernel.database.pool.query(`delete from mod_billing.invoices where workspace_id = $1`, [WS])
    remoteSubscription = subscriptionObject()
    remoteInvoices = [invoiceObject({ id: 'in_backfilled' })]
    const { payload, signature } = signed({
      id: 'evt_checkout_backfill',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_b', object: 'checkout.session', subscription: 'sub_test_1' } },
    })
    expect((await post(payload, signature)).status).toBe(200)
    expect(seen.some((r) => r.method === 'GET' && r.path === '/v1/invoices')).toBe(true)
    expect((await invoiceRows()).map((r) => r.stripeInvoiceId)).toEqual(['in_backfilled'])
  })

  it('is mirrored by the nightly backfill on an instance that missed the webhook', async () => {
    await kernel.database.pool.query(`delete from mod_billing.invoices where workspace_id = $1`, [WS])
    remoteInvoices = [invoiceObject({ id: 'in_nightly' })]
    expect(await stripeSvc.backfillInvoices(kernel, WS)).toBe(1)
    expect((await invoiceRows()).map((r) => r.stripeInvoiceId)).toEqual(['in_nightly'])
    remoteInvoices = []
  })
})

/**
 * Stripe emits `customer.subscription.updated` for the same failed payment as
 * `invoice.payment_failed`, in no guaranteed order — and `applySubscription` wrote `graceEndsAt:
 * null` every time. So the clock the dunning job needs was wiped by Stripe's own event and
 * `past_due → suspended` never fired.
 */
describe('the grace period after a failed payment', () => {
  it('survives a subscription.updated arriving after the failed invoice', async () => {
    await subsSvc.upsert(kernel, WS, { status: 'active', graceEndsAt: null, stripeCustomerId: CUSTOMER })
    const failed = signed({
      id: 'evt_failed_1',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_1', object: 'invoice', customer: CUSTOMER, status: 'open', total: 800 } },
    })
    expect((await post(failed.payload, failed.signature)).status).toBe(200)

    const [afterInvoice] = await kernel.database.db
      .select({ graceEndsAt: subscriptions.graceEndsAt, status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, WS))
    expect(afterInvoice?.status).toBe('past_due')
    const started = afterInvoice?.graceEndsAt
    expect(started).toBeInstanceOf(Date)

    remoteSubscription = subscriptionObject({ status: 'past_due' })
    const updated = signed({
      id: 'evt_updated_past_due',
      type: 'customer.subscription.updated',
      data: { object: subscriptionObject({ status: 'past_due' }) },
    })
    expect((await post(updated.payload, updated.signature)).status).toBe(200)

    const [after] = await kernel.database.db
      .select({ graceEndsAt: subscriptions.graceEndsAt, status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, WS))
    expect(after?.status).toBe('past_due')
    // the assertion the defect is about: this was null, and the closing job needs it non-null
    expect(after?.graceEndsAt).not.toBeNull()
    expect(after?.graceEndsAt?.getTime()).toBe(started?.getTime())
  })

  it('starts a clock when subscription.updated is the only thing that arrives', async () => {
    await subsSvc.upsert(kernel, WS, { status: 'active', graceEndsAt: null })
    remoteSubscription = subscriptionObject({ status: 'past_due' })
    const updated = signed({
      id: 'evt_updated_only',
      type: 'customer.subscription.updated',
      data: { object: subscriptionObject({ status: 'past_due' }) },
    })
    expect((await post(updated.payload, updated.signature)).status).toBe(200)
    const [row] = await kernel.database.db
      .select({ graceEndsAt: subscriptions.graceEndsAt })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, WS))
    expect(row?.graceEndsAt).not.toBeNull()
  })

  it('clears the clock once the subscription is healthy again', async () => {
    remoteSubscription = subscriptionObject({ status: 'active' })
    const ok = signed({
      id: 'evt_recovered',
      type: 'customer.subscription.updated',
      data: { object: subscriptionObject({ status: 'active' }) },
    })
    expect((await post(ok.payload, ok.signature)).status).toBe(200)
    const [row] = await kernel.database.db
      .select({ graceEndsAt: subscriptions.graceEndsAt, status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, WS))
    expect(row?.status).toBe('active')
    expect(row?.graceEndsAt).toBeNull()
  })
})

/**
 * `unpaid` is Stripe saying it has stopped trying. It mapped to `past_due`, which is an entitled
 * status here, and only a grace clock ends that — which nothing on this path set. So the one
 * workspace Stripe had definitively given up on stayed entitled for ever.
 */
describe('Stripe’s own statuses', () => {
  it('treats `unpaid` as suspended rather than as another grace period', () => {
    expect(stripeSvc.mapStatus('unpaid')).toBe('suspended')
    expect(stripeSvc.mapStatus('past_due')).toBe('past_due')
    expect(stripeSvc.mapStatus('canceled')).toBe('canceled')
  })
})

/**
 * An upgrade opened a *second* Checkout session, which creates a second subscription;
 * `applySubscription` then overwrote `stripeSubscriptionId`, so the first kept charging with
 * nothing pointing at it. The customer paid twice, for ever, while the pricing page promised
 * "change any time; we bill the difference pro rata".
 */
describe('changing plan when a subscription already exists', () => {
  it('reprices the subscription item instead of opening a second subscription', async () => {
    remoteSubscription = subscriptionObject({ status: 'active' })
    await subsSvc.upsert(kernel, WS, {
      status: 'active',
      stripeCustomerId: CUSTOMER,
      stripeSubscriptionId: 'sub_test_1',
    })
    seen.length = 0

    const result = await stripeSvc.checkout(kernel, {
      workspaceId: WS,
      planSlug: 'team',
      baseUrl: 'https://kern.test',
      returnPath: '/acme/settings/billing/plan',
    })

    expect(result.changed).toBe(true)
    // the assertion that names the defect: no new Checkout session was opened
    expect(seen.some((r) => r.path.startsWith('/v1/checkout/sessions'))).toBe(false)
    const update = seen.find((r) => r.method === 'POST' && r.path === '/v1/subscriptions/sub_test_1')
    expect(update).toBeDefined()
    expect(update?.body.get('items[0][id]')).toBe('si_test_1')
    expect(update?.body.get('items[0][price]')).toBe('price_team')
    expect(update?.body.get('proration_behavior')).toBe('create_prorations')
    // the metadata has to survive, or the webhook that follows cannot find its way home
    expect(update?.body.get('metadata[kern_workspace_id]')).toBe(WS)
  })

  it('bills the workspace’s real seat count, not one seat', async () => {
    // core reports twelve billable members; the old code sent `input.seats ?? 1` and no caller
    // has ever passed `seats`, so a twelve-person workspace bought one seat
    const update = seen.find((r) => r.method === 'POST' && r.path === '/v1/subscriptions/sub_test_1')
    expect(update?.body.get('items[0][quantity]')).toBe('12')
  })

  it('opens Checkout when there is no subscription to reprice', async () => {
    await subsSvc.upsert(kernel, WS, { stripeSubscriptionId: null, status: 'trialing' })
    seen.length = 0
    const result = await stripeSvc.checkout(kernel, {
      workspaceId: WS,
      planSlug: 'team',
      baseUrl: 'https://kern.test',
      returnPath: '/acme/settings/billing/plan',
    })
    expect(result.changed).toBe(false)
    expect(result.url).toBe('https://checkout.stripe.test/cs_test_1')
    const session = seen.find((r) => r.path.startsWith('/v1/checkout/sessions'))
    expect(session?.body.get('line_items[0][quantity]')).toBe('12')
  })

  /**
   * The post-checkout redirect. `${baseUrl}/settings/billing` is not a route in Kern — the real one
   * is `/{workspace}/settings/billing/plan` — so everybody who paid landed on a 404, which is the
   * worst possible page to show somebody who has just given you money.
   */
  it('sends the person back to a route that exists', async () => {
    const session = seen.find((r) => r.path.startsWith('/v1/checkout/sessions'))
    expect(session?.body.get('success_url')).toBe(
      'https://kern.test/acme/settings/billing/plan?checkout=done',
    )
    expect(session?.body.get('cancel_url')).toBe(
      'https://kern.test/acme/settings/billing/plan?checkout=cancelled',
    )
  })

  it('keeps a query string the caller already had', () => {
    expect(stripeSvc.returnUrl('https://kern.test/', '/a/b?tab=plan', 'done')).toBe(
      'https://kern.test/a/b?tab=plan&checkout=done',
    )
  })
})

/**
 * Signup wrote `status: 'trialing'` with a `trialEndsAt` that nothing ever read again, and
 * `trialing` is an entitled status — so every workspace that ever signed up was on the trial plan
 * for ever, free, with no card.
 */
describe('a trial that has run out', () => {
  const runJob = async (name: string) => {
    const job = (billingModule.jobs ?? []).find((j) => j.name === name)
    if (!job) throw new Error(`no job named ${name}`)
    await job.handler({}, { kernel, id: 'test', attempt: 1 })
  }

  it('starts a trial for a workspace that predates the default plan', async () => {
    // A workspace with no subscription row is unlimited. On the cloud two of the three workspaces
    // were created before the default plan was configured and had been entitled to everything,
    // with no trial and no bill, ever since — and nothing would ever have changed it.
    const older = randomUUID()
    knownWorkspaces.push({ id: older, name: 'Older', slug: 'older' })
    expect(await subsSvc.get(kernel, older)).toBeNull()
    await runJob('billing.reconcile-usage')
    const sub = await subsSvc.get(kernel, older)
    expect(sub?.status).toBe('trialing')
    expect(sub?.planSlug).toBe('team')
    expect(sub?.trialEndsAt).not.toBeNull()
    knownWorkspaces.pop()
  })

  it('suspends a workspace with no Stripe subscription behind it', async () => {
    const yesterday = new Date(Date.now() - 86_400_000)
    await subsSvc.upsert(kernel, WS, {
      status: 'trialing',
      trialEndsAt: yesterday,
      stripeSubscriptionId: null,
    })
    await runJob('billing.expire-trials')
    expect((await subsSvc.get(kernel, WS))?.status).toBe('suspended')
  })

  it('leaves a trial Stripe is running alone', async () => {
    // Stripe owns that clock and reports what happened to it; expiring it here would race a card
    // that is about to be charged
    const other = randomUUID()
    await subsSvc.upsert(kernel, other, {
      status: 'trialing',
      trialEndsAt: new Date(Date.now() - 86_400_000),
      stripeSubscriptionId: 'sub_stripe_owned',
    })
    await runJob('billing.expire-trials')
    expect((await subsSvc.get(kernel, other))?.status).toBe('trialing')
  })

  it('leaves a trial that is still running alone', async () => {
    const other = randomUUID()
    await subsSvc.upsert(kernel, other, {
      status: 'trialing',
      trialEndsAt: new Date(Date.now() + 86_400_000),
      stripeSubscriptionId: null,
    })
    await runJob('billing.expire-trials')
    expect((await subsSvc.get(kernel, other))?.status).toBe('trialing')
  })

  it('gives a past-due row with no clock one, so the dunning job can reach a decision', async () => {
    const other = randomUUID()
    await subsSvc.upsert(kernel, other, { status: 'past_due', graceEndsAt: null })
    await runJob('billing.close-grace-periods')
    const [row] = await kernel.database.db
      .select({ graceEndsAt: subscriptions.graceEndsAt })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, other))
    expect(row?.graceEndsAt).not.toBeNull()
  })
})

/**
 * A suspended or cancelled workspace resolved to `PlanLimits.parse({})` — every limit null and
 * `sso: true`. Not paying therefore bought *more* than paying did.
 */
describe('what a workspace keeps when it stops being entitled', () => {
  it('never resolves to unlimited', async () => {
    await subsSvc.setPlan(kernel, WS, planId)
    const entitled = await entitlements.resolve(kernel, WS)
    expect(entitled.seats).toBe(25)
    expect(entitled.active).toBe(true)

    await subsSvc.setStatus(kernel, WS, 'suspended')
    const suspended = await entitlements.resolve(kernel, WS)
    expect(suspended.active).toBe(false)
    // the defect: each of these was null/true, i.e. wider than the plan the customer paid for
    expect(suspended.seats).not.toBeNull()
    expect(suspended.seats).toBeLessThanOrEqual(25)
    expect(suspended.storageBytes).toBe(0)
    expect(suspended.sso).toBe(false)
  })

  it('keeps reading and exporting possible — the one thing suspension promises', async () => {
    const suspended = await entitlements.resolve(kernel, WS)
    // narrowing either of these would break a read: the API budget is spent by every request, and
    // retention decides what a pruner deletes
    expect(suspended.apiRateLimit).toBeNull()
    expect(suspended.auditRetentionDays).toBe(30)
  })

  it('does not let an override outlive the status that suspended the workspace', async () => {
    await subsSvc.setOverride(kernel, WS, { seats: 500 }, null)
    const suspended = await entitlements.resolve(kernel, WS)
    expect(suspended.active).toBe(false)
    expect(suspended.storageBytes).toBe(0)
    await subsSvc.setOverride(kernel, WS, null, null)
  })

  it('is unlimited again the moment the workspace is active, and never throws', async () => {
    await subsSvc.setStatus(kernel, WS, 'active')
    const active = await entitlements.resolve(kernel, WS)
    expect(active.active).toBe(true)
    expect(active.seats).toBe(25)
    // a workspace nothing bills is the self-hosted case and must stay wide open
    const stranger = await entitlements.resolve(kernel, randomUUID())
    expect(stranger.planName).toBeNull()
    expect(stranger.active).toBe(true)
    expect(stranger.seats).toBeUndefined()
  })
})

/** A fresh instance must not need somebody to type a plan into a console before it can charge. */
describe('the plan catalogue', () => {
  it('was seeded from KERN_PLANS_FILE at boot', async () => {
    const team = await plansSvc.bySlug(kernel, 'team')
    expect(team?.name).toBe('Team')
    expect(team?.stripePriceId).toBe('price_team')
  })

  it('does not overwrite a plan an admin has since edited', async () => {
    const before = await plansSvc.bySlug(kernel, 'team')
    await plansSvc.upsert(kernel, { ...(before as never), name: 'Team (edited)' })
    const { seedPlansFromFile } = await import('./services/catalogue.js')
    expect(await seedPlansFromFile(kernel)).toEqual([])
    expect((await plansSvc.bySlug(kernel, 'team'))?.name).toBe('Team (edited)')
  })

  it('refuses to start an instance that sells subscriptions with no default plan', async () => {
    const { assertDefaultPlan } = await import('./services/catalogue.js')
    const restore = process.env.KERN_DEFAULT_PLAN_SLUG
    process.env.KERN_DEFAULT_PLAN_SLUG = ''
    await expect(assertDefaultPlan(kernel)).rejects.toThrow(/KERN_DEFAULT_PLAN_SLUG/)
    process.env.KERN_DEFAULT_PLAN_SLUG = restore
  })

  it('says nothing at all on an instance with no Stripe key — every self-hosted Kern', async () => {
    const { assertDefaultPlan } = await import('./services/catalogue.js')
    const key = process.env.STRIPE_SECRET_KEY
    delete process.env.STRIPE_SECRET_KEY
    process.env.KERN_DEFAULT_PLAN_SLUG = 'a-plan-that-does-not-exist'
    await expect(assertDefaultPlan(kernel)).resolves.toBeUndefined()
    process.env.STRIPE_SECRET_KEY = key
    process.env.KERN_DEFAULT_PLAN_SLUG = 'team'
  })
})
