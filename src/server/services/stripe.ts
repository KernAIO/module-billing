import { KernError, type Kernel } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import Stripe from 'stripe'
import type { SubscriptionStatus } from '../../contract.js'
import { invoices, plans, subscriptions, webhookEvents } from '../schema.js'
import * as subs from './subscriptions.js'

/**
 * Stripe, or nothing at all.
 *
 * The module ships in every Kern image, including every self-hosted one, so the absence of a key is
 * the normal case rather than a misconfiguration. `client()` returning null is how the rest of the
 * module finds out, and every caller has to handle it — there is no "assume it is configured" path.
 */
export function client(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key, {
    // Pinned deliberately: an account-level API version change must not reach a running instance
    // before its image has been built against it. This must match the version bundled with the
    // installed `stripe` package — the SDK's types reject any other literal.
    apiVersion: '2026-08-26.dahlia',
    appInfo: { name: 'Kern', url: 'https://kernaio.com' },
    maxNetworkRetries: 2,
  })
}

export const paymentsEnabled = () => Boolean(process.env.STRIPE_SECRET_KEY)

function required(): Stripe {
  const s = client()
  if (!s)
    throw KernError.conflict(
      'This instance is not configured to take payments',
      'billing.stripe.not_configured',
    )
  return s
}

/** Stripe's subscription statuses, mapped onto the five this module recognises. */
function mapStatus(s: Stripe.Subscription.Status): SubscriptionStatus {
  switch (s) {
    case 'trialing':
      return 'trialing'
    case 'active':
      return 'active'
    case 'past_due':
    case 'unpaid':
      return 'past_due'
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled'
    // `incomplete` means the first payment has not succeeded yet: not entitled, not yet a customer
    case 'incomplete':
    case 'paused':
      return 'suspended'
    default:
      return 'suspended'
  }
}

/** The Stripe customer for a workspace, created on first use and remembered. */
async function customerFor(kernel: Kernel, workspaceId: string, email?: string): Promise<string> {
  const existing = await subs.get(kernel, workspaceId)
  if (existing?.stripeCustomerId) return existing.stripeCustomerId
  const stripe = required()
  const customer = await stripe.customers.create({
    email,
    // the workspace id travels with the customer so a webhook can find its way home even if our
    // own row is missing — which is exactly the case during a first checkout
    metadata: { kern_workspace_id: workspaceId },
  })
  await subs.upsert(kernel, workspaceId, { stripeCustomerId: customer.id })
  return customer.id
}

export async function checkout(
  kernel: Kernel,
  input: { workspaceId: string; planSlug: string; seats?: number; email?: string; baseUrl: string },
): Promise<{ url: string }> {
  const stripe = required()
  const [plan] = await kernel.database.db.select().from(plans).where(eq(plans.slug, input.planSlug)).limit(1)
  if (!plan) throw KernError.notFound('Plan')
  if (!plan.stripePriceId)
    throw KernError.conflict('That plan has no Stripe price attached', 'billing.plan.no_price')

  const customer = await customerFor(kernel, input.workspaceId, input.email)
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price: plan.stripePriceId, quantity: plan.perSeat ? (input.seats ?? 1) : 1 }],
    subscription_data: {
      ...(plan.trialDays > 0 ? { trial_period_days: plan.trialDays } : {}),
      metadata: { kern_workspace_id: input.workspaceId, kern_plan_id: plan.id },
    },
    // The card is taken up front, trial or not, so the subscription converts without asking again.
    payment_method_collection: 'always',
    success_url: `${input.baseUrl}/settings/billing?checkout=done`,
    cancel_url: `${input.baseUrl}/settings/billing?checkout=cancelled`,
  })
  if (!session.url) throw KernError.conflict('Stripe did not return a checkout URL', 'billing.stripe.no_url')
  return { url: session.url }
}

export async function portal(
  kernel: Kernel,
  input: { workspaceId: string; returnUrl: string },
): Promise<{ url: string }> {
  const stripe = required()
  const sub = await subs.get(kernel, input.workspaceId)
  if (!sub?.stripeCustomerId)
    throw KernError.conflict('This workspace has no billing account yet', 'billing.stripe.no_customer')
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: input.returnUrl,
  })
  return { url: session.url }
}

/** Keep the seat quantity on Stripe in step with the workspace's actual membership. */
export async function syncSeats(kernel: Kernel, workspaceId: string, seats: number): Promise<void> {
  const stripe = client()
  if (!stripe) return
  const sub = await subs.get(kernel, workspaceId)
  if (!sub?.stripeSubscriptionId) return
  const remote = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId)
  const item = remote.items.data[0]
  if (!item || item.quantity === seats) return
  await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    items: [{ id: item.id, quantity: seats }],
    // the customer is billed for the seat from the moment it is used, not from the next period
    proration_behavior: 'create_prorations',
  })
  await subs.upsert(kernel, workspaceId, { seatsPurchased: seats })
}

/**
 * Record that an event id has been handled, and say whether it is new.
 *
 * The insert *is* the check. Reading first and then inserting is a race that two concurrent
 * deliveries of the same event will lose, and losing it means charging or crediting twice.
 */
async function claim(kernel: Kernel, id: string, type: string): Promise<boolean> {
  const rows = await kernel.database.db
    .insert(webhookEvents)
    .values({ id, type })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id })
  return rows.length > 0
}

/** The workspace a Stripe object belongs to, from the metadata we set when creating it. */
function workspaceOf(o: { metadata?: Stripe.Metadata | null }): string | null {
  return o.metadata?.kern_workspace_id ?? null
}

async function applySubscription(kernel: Kernel, s: Stripe.Subscription): Promise<void> {
  const workspaceId = workspaceOf(s)
  if (!workspaceId) {
    kernel.log.warn({ subscription: s.id }, 'billing: Stripe subscription without a workspace id')
    return
  }
  const planId = s.metadata?.kern_plan_id ?? null
  const item = s.items.data[0]
  const periodEnd = item?.current_period_end ?? null
  await subs.upsert(kernel, workspaceId, {
    ...(planId ? { planId } : {}),
    status: mapStatus(s.status),
    seatsPurchased: item?.quantity ?? 0,
    stripeSubscriptionId: s.id,
    stripeCustomerId: typeof s.customer === 'string' ? s.customer : s.customer.id,
    cancelAtPeriodEnd: s.cancel_at_period_end,
    trialEndsAt: s.trial_end ? new Date(s.trial_end * 1000) : null,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    graceEndsAt: null,
  })
}

async function applyInvoice(kernel: Kernel, inv: Stripe.Invoice): Promise<void> {
  const customer = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id
  if (!customer) return
  const [row] = await kernel.database.db
    .select({ workspaceId: subscriptions.workspaceId })
    .from(subscriptions)
    .where(eq(subscriptions.stripeCustomerId, customer))
    .limit(1)
  if (!row) return
  const workspaceId = row.workspaceId
  const line = inv.lines?.data?.[0]
  await kernel.database.withWorkspace(workspaceId, async (tx) => {
    await tx
      .insert(invoices)
      .values({
        workspaceId,
        stripeInvoiceId: inv.id ?? null,
        number: inv.number ?? null,
        status: inv.status ?? 'draft',
        totalMinor: inv.total ?? 0,
        currency: inv.currency ?? 'usd',
        periodStart: line?.period?.start ? new Date(line.period.start * 1000) : null,
        periodEnd: line?.period?.end ? new Date(line.period.end * 1000) : null,
        hostedUrl: inv.hosted_invoice_url ?? null,
        pdfUrl: inv.invoice_pdf ?? null,
      })
      .onConflictDoUpdate({
        target: invoices.stripeInvoiceId,
        set: {
          status: inv.status ?? 'draft',
          totalMinor: inv.total ?? 0,
          hostedUrl: inv.hosted_invoice_url ?? null,
          pdfUrl: inv.invoice_pdf ?? null,
        },
      })
  })
}

/**
 * Apply one webhook.
 *
 * Verification happens against the **raw body**, before anything parses it — a signature over
 * re-encoded JSON proves nothing, because re-encoding is not guaranteed to reproduce the bytes that
 * were signed.
 */
export async function handleWebhook(
  kernel: Kernel,
  raw: Buffer | string,
  signature: string,
): Promise<{ handled: boolean; type: string }> {
  const stripe = required()
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret)
    throw KernError.conflict('No Stripe webhook secret is configured', 'billing.stripe.no_webhook_secret')

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(raw, signature, secret)
  } catch (err) {
    throw KernError.badRequest('Stripe signature did not verify', { err: String(err) })
  }

  if (!(await claim(kernel, event.id, event.type))) {
    kernel.log.info({ event: event.id, type: event.type }, 'billing: webhook already applied')
    return { handled: false, type: event.type }
  }

  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(kernel, event.data.object)
      break
    case 'checkout.session.completed': {
      const session = event.data.object
      const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id
      if (subId) await applySubscription(kernel, await stripe.subscriptions.retrieve(subId))
      break
    }
    case 'invoice.paid':
      await applyInvoice(kernel, event.data.object)
      break
    case 'invoice.payment_failed': {
      const inv = event.data.object
      await applyInvoice(kernel, inv)
      const customer = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id
      if (customer) {
        const [row] = await kernel.database.db
          .select({ workspaceId: subscriptions.workspaceId })
          .from(subscriptions)
          .where(eq(subscriptions.stripeCustomerId, customer))
          .limit(1)
        if (row) {
          // A failed payment starts a clock, it does not close the workspace. Stripe keeps retrying
          // for its own dunning window; the grace period is what decides when we stop waiting.
          const grace = new Date()
          grace.setUTCDate(grace.getUTCDate() + GRACE_DAYS)
          await subs.upsert(kernel, row.workspaceId, { status: 'past_due', graceEndsAt: grace })
        }
      }
      break
    }
    default:
      kernel.log.debug({ type: event.type }, 'billing: unhandled Stripe event')
  }
  return { handled: true, type: event.type }
}

/** How long a workspace keeps working after a payment fails. */
export const GRACE_DAYS = 14
