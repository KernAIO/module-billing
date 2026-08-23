import { KernError, type Kernel } from '@kernhq/kernel'
import { desc, eq, inArray } from 'drizzle-orm'
import {
  type AdminWorkspaceRow,
  billingEvents,
  type Invoice,
  PlanLimitsPatch,
  type Subscription,
  type SubscriptionStatus,
} from '../../contract.js'
import { invoices, overrides, plans, subscriptions } from '../schema.js'
import * as usage from './usage.js'

/** Workspace identity, which lives in core — billing only knows ids. */
interface WorkspaceRef {
  id: string
  name: string
  slug: string
}

const ser = (
  r: typeof subscriptions.$inferSelect,
  plan: { name: string; slug: string } | null,
): Subscription => ({
  workspaceId: r.workspaceId as Subscription['workspaceId'],
  planId: r.planId,
  planName: plan?.name ?? null,
  planSlug: plan?.slug ?? null,
  status: r.status as SubscriptionStatus,
  seatsPurchased: r.seatsPurchased,
  trialEndsAt: r.trialEndsAt?.toISOString() ?? null,
  currentPeriodEnd: r.currentPeriodEnd?.toISOString() ?? null,
  cancelAtPeriodEnd: r.cancelAtPeriodEnd,
  stripeCustomerId: r.stripeCustomerId,
  stripeSubscriptionId: r.stripeSubscriptionId,
})

export async function get(kernel: Kernel, workspaceId: string): Promise<Subscription | null> {
  const [row] = await kernel.database.db
    .select({ sub: subscriptions, planName: plans.name, planSlug: plans.slug })
    .from(subscriptions)
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.workspaceId, workspaceId))
    .limit(1)
  if (!row) return null
  return ser(row.sub, row.planName && row.planSlug ? { name: row.planName, slug: row.planSlug } : null)
}

/**
 * Write a subscription and tell the rest of the instance.
 *
 * The event matters as much as the row: the kernel drops its entitlement cache on
 * `billing.subscription.*`, so a customer who has just paid gets the seat now rather than when a TTL
 * happens to expire.
 */
export async function upsert(
  kernel: Kernel,
  workspaceId: string,
  patch: Partial<typeof subscriptions.$inferInsert>,
): Promise<Subscription> {
  const db = kernel.database.db
  await db
    .insert(subscriptions)
    .values({ workspaceId, status: 'trialing', ...patch })
    .onConflictDoUpdate({
      target: subscriptions.workspaceId,
      set: { ...patch, updatedAt: new Date() },
    })
  const next = await get(kernel, workspaceId)
  if (!next) throw KernError.notFound('Subscription')
  await kernel.emit(
    billingEvents.subscriptionChanged,
    { workspaceId: workspaceId as Subscription['workspaceId'], status: next.status, planSlug: next.planSlug },
    { workspaceId },
  )
  return next
}

export async function setPlan(
  kernel: Kernel,
  workspaceId: string,
  planId: string | null,
  seatsPurchased?: number,
): Promise<Subscription> {
  if (planId) {
    const [plan] = await kernel.database.db
      .select({ id: plans.id, trialDays: plans.trialDays })
      .from(plans)
      .where(eq(plans.id, planId))
      .limit(1)
    if (!plan) throw KernError.notFound('Plan')
  }
  return upsert(kernel, workspaceId, {
    planId,
    ...(seatsPurchased !== undefined ? { seatsPurchased } : {}),
    // An admin assigning a plan by hand is a decision, not a trial: it takes effect now.
    status: 'active',
    graceEndsAt: null,
  })
}

export async function extendTrial(kernel: Kernel, workspaceId: string, days: number): Promise<Subscription> {
  const current = await get(kernel, workspaceId)
  const from =
    current?.trialEndsAt && new Date(current.trialEndsAt) > new Date()
      ? new Date(current.trialEndsAt)
      : new Date()
  from.setUTCDate(from.getUTCDate() + days)
  return upsert(kernel, workspaceId, { status: 'trialing', trialEndsAt: from, graceEndsAt: null })
}

export async function setStatus(
  kernel: Kernel,
  workspaceId: string,
  status: 'active' | 'suspended',
): Promise<Subscription> {
  const next = await upsert(kernel, workspaceId, { status, graceEndsAt: null })
  if (status === 'suspended')
    await kernel.emit(
      billingEvents.subscriptionSuspended,
      {
        workspaceId: workspaceId as Subscription['workspaceId'],
        reason: 'an instance admin suspended this workspace',
      },
      { workspaceId },
    )
  return next
}

export async function setOverride(
  kernel: Kernel,
  workspaceId: string,
  limits: PlanLimitsPatch | null,
  actorId: string | null,
): Promise<Subscription> {
  const db = kernel.database.db
  if (limits === null) await db.delete(overrides).where(eq(overrides.workspaceId, workspaceId))
  else
    await db
      .insert(overrides)
      .values({ workspaceId, limits: PlanLimitsPatch.parse(limits), createdBy: actorId })
      .onConflictDoUpdate({
        target: overrides.workspaceId,
        set: { limits: PlanLimitsPatch.parse(limits), updatedAt: new Date() },
      })
  const next = await get(kernel, workspaceId)
  // an override changes what the workspace may do, so the cache has to be told even though the
  // subscription row itself did not move
  await kernel.emit(
    billingEvents.subscriptionChanged,
    {
      workspaceId: workspaceId as Subscription['workspaceId'],
      status: next?.status ?? 'trialing',
      planSlug: next?.planSlug ?? null,
    },
    { workspaceId },
  )
  if (!next) throw KernError.notFound('Subscription')
  return next
}

/** What a plan bills per month, so annual and monthly plans can be added up in one column. */
function monthlyMinor(priceMinor: number, interval: string, perSeat: boolean, seats: number): number {
  const perMonth = interval === 'year' ? Math.round(priceMinor / 12) : priceMinor
  return perSeat ? perMonth * seats : perMonth
}

/**
 * Every workspace on the instance, with what it pays.
 *
 * Workspace names live in core, so this reads billing's own rows first and then asks core to name
 * them — a module never reaches into another module's tables, and this is the one screen where that
 * rule costs an extra round trip.
 */
export async function adminList(
  kernel: Kernel,
  input: { q?: string; status?: SubscriptionStatus; limit: number },
): Promise<AdminWorkspaceRow[]> {
  const refs = await kernel.call<WorkspaceRef[]>('core.workspaces.list', { q: input.q, limit: input.limit })
  if (!refs.length) return []
  const ids = refs.map((w) => w.id)

  const subs = await kernel.database.db
    .select({ sub: subscriptions, plan: plans })
    .from(subscriptions)
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .where(inArray(subscriptions.workspaceId, ids))
  const byWs = new Map(subs.map((s) => [s.sub.workspaceId, s]))

  const ovr = await kernel.database.db
    .select({ workspaceId: overrides.workspaceId })
    .from(overrides)
    .where(inArray(overrides.workspaceId, ids))
  const overridden = new Set(ovr.map((o) => o.workspaceId))

  const rows: AdminWorkspaceRow[] = []
  for (const w of refs) {
    const hit = byWs.get(w.id)
    if (input.status && hit?.sub.status !== input.status) continue
    const used = await usage.read(kernel, w.id)
    const plan = hit?.plan ?? null
    rows.push({
      workspaceId: w.id as AdminWorkspaceRow['workspaceId'],
      workspaceName: w.name,
      workspaceSlug: w.slug,
      planName: plan?.name ?? null,
      planSlug: plan?.slug ?? null,
      status: (hit?.sub.status as SubscriptionStatus) ?? null,
      seatsUsed: used.seats,
      seatsPurchased: hit?.sub.seatsPurchased ?? 0,
      storageBytes: used.storageBytes,
      trialEndsAt: hit?.sub.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: hit?.sub.currentPeriodEnd?.toISOString() ?? null,
      monthlyMinor: plan
        ? monthlyMinor(plan.priceMinor, plan.interval, plan.perSeat, hit?.sub.seatsPurchased ?? used.seats)
        : 0,
      currency: plan?.currency ?? 'usd',
      overridden: overridden.has(w.id),
      stripeCustomerId: hit?.sub.stripeCustomerId ?? null,
    })
  }
  return rows
}

export async function listInvoices(kernel: Kernel, workspaceId: string, limit: number): Promise<Invoice[]> {
  // a tenant table, so it is read inside the workspace's own RLS context
  return kernel.database.withWorkspace(workspaceId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.workspaceId, workspaceId))
      .orderBy(desc(invoices.createdAt))
      .limit(limit)
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId as Invoice['workspaceId'],
      number: r.number,
      status: r.status,
      totalMinor: r.totalMinor,
      currency: r.currency,
      periodStart: r.periodStart?.toISOString() ?? null,
      periodEnd: r.periodEnd?.toISOString() ?? null,
      hostedUrl: r.hostedUrl,
      pdfUrl: r.pdfUrl,
      createdAt: r.createdAt.toISOString(),
    }))
  })
}

export { ser as serialiseSubscription }
