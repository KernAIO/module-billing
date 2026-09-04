import { KernError, type Kernel } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import Stripe from 'stripe'
import type { SubscriptionStatus } from '../../contract.js'
import { invoices, plans, subscriptions, webhookEvents } from '../schema.js'
import * as subs from './subscriptions.js'
import * as usage from './usage.js'

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
    ...apiBase(),
  })
}

/**
 * Where the Stripe API lives. `api.stripe.com` unless `STRIPE_API_BASE` says otherwise.
 *
 * It exists so that what this module *sends* Stripe can be asserted — that an upgrade repriced one
 * subscription item instead of opening a second subscription, that the quantity was the workspace's
 * real seat count, that the success URL is a route that exists. None of that is observable from the
 * outside, and all three shipped wrong. Point it at `stripe-mock` or at a test double.
 *
 * Not a documented operator setting: an instance that sets this is not talking to Stripe, and the
 * only honest reason to do that is a test.
 */
function apiBase(): { host: string; port: number; protocol: 'https' | 'http' } | Record<string, never> {
  const base = process.env.STRIPE_API_BASE
  if (!base) return {}
  const url = new URL(base)
  const protocol = url.protocol === 'https:' ? 'https' : 'http'
  return { host: url.hostname, port: Number(url.port || (protocol === 'https' ? 443 : 80)), protocol }
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
export function mapStatus(s: Stripe.Subscription.Status): SubscriptionStatus {
  switch (s) {
    case 'trialing':
      return 'trialing'
    case 'active':
      return 'active'
    case 'past_due':
      return 'past_due'
    /**
     * `unpaid` is Stripe saying it has finished trying: the dunning window is over and it will not
     * attempt the card again. It used to map to `past_due`, which is an *entitled* status here — and
     * only the grace clock ends it, which nothing sets on this path. So the workspace Stripe had
     * given up on stayed entitled for ever. It is suspended: read-only, resumable the moment a
     * payment succeeds, and nothing deleted.
     */
    case 'unpaid':
      return 'suspended'
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

/**
 * Stripe subscription states an existing subscription can be repriced in.
 *
 * Everything else — cancelled, expired, given up on, never completed — is not a subscription to
 * move; it is one to replace, which means Checkout and a fresh card.
 */
const REPRICEABLE: ReadonlySet<Stripe.Subscription.Status> = new Set(['active', 'trialing', 'past_due'])

/**
 * How many seats this workspace should be billed for right now.
 *
 * The count comes from core through the shared seat definition — guests never consume one — rather
 * than from anything this module decides. It used to default to `1` whenever the caller did not
 * pass a number, and no caller ever passes one, so a twelve-person workspace bought a single seat
 * and stayed on it until the next membership event happened to fire `syncSeats`.
 *
 * Core being unreachable must not stop somebody paying us, so the stored counter is the fallback,
 * and 1 is the floor — Stripe rejects a quantity of 0.
 */
export async function billableSeats(kernel: Kernel, workspaceId: string, asked?: number): Promise<number> {
  if (asked !== undefined) return Math.max(1, asked)
  try {
    return Math.max(1, await usage.recountSeats(kernel, workspaceId))
  } catch (err) {
    kernel.log.warn(
      { err: String(err), workspaceId },
      'billing: could not recount seats for checkout; using the stored counter',
    )
    return Math.max(1, (await usage.read(kernel, workspaceId)).seats)
  }
}

/** Where Stripe sends the person back to, with `checkout=` for the screen to render. */
export function returnUrl(baseUrl: string, returnPath: string, outcome: string): string {
  const url = `${baseUrl.replace(/\/$/, '')}${returnPath.startsWith('/') ? returnPath : `/${returnPath}`}`
  return `${url}${url.includes('?') ? '&' : '?'}checkout=${outcome}`
}

/**
 * Put a workspace on a plan.
 *
 * **A workspace that already has a subscription is repriced, never sent through Checkout again.**
 * Checkout in `subscription` mode creates a *new* subscription every time it completes, and
 * `applySubscription` then overwrites `stripeSubscriptionId` — so an upgrade left the old
 * subscription running with nothing pointing at it, and the customer was charged for both, for
 * ever, while the pricing page promised "change any time; we bill the difference pro rata".
 *
 * Repricing is what keeps that promise: one subscription item moved to the new price with
 * `create_prorations`, so Stripe credits the unused part of the old plan and charges the new one
 * from today.
 */
export async function checkout(
  kernel: Kernel,
  input: {
    workspaceId: string
    planSlug: string
    seats?: number
    email?: string
    baseUrl: string
    returnPath?: string
  },
): Promise<{ url: string; changed: boolean }> {
  const stripe = required()
  const [plan] = await kernel.database.db.select().from(plans).where(eq(plans.slug, input.planSlug)).limit(1)
  if (!plan) throw KernError.notFound('Plan')
  if (!plan.stripePriceId)
    throw KernError.conflict('That plan has no Stripe price attached', 'billing.plan.no_price')

  const quantity = plan.perSeat ? await billableSeats(kernel, input.workspaceId, input.seats) : 1
  const back = input.returnPath ?? '/'

  const existing = await subs.get(kernel, input.workspaceId)
  if (existing?.stripeSubscriptionId) {
    const remote = await stripe.subscriptions.retrieve(existing.stripeSubscriptionId).catch(() => null)
    const item = remote?.items.data[0]
    if (remote && item && REPRICEABLE.has(remote.status)) {
      const updated = await stripe.subscriptions.update(remote.id, {
        items: [{ id: item.id, price: plan.stripePriceId, quantity }],
        // the customer is billed the difference from today, not from the next period
        proration_behavior: 'create_prorations',
        // choosing a plan is a decision to keep the subscription, so a pending cancellation is off
        cancel_at_period_end: false,
        // the metadata is how a webhook finds its way home, and `kern_plan_id` is how the row
        // learns which plan it is on — losing either here would strand the subscription
        metadata: { kern_workspace_id: input.workspaceId, kern_plan_id: plan.id },
      })
      // Applied now rather than waiting for `customer.subscription.updated`: the person is looking
      // at the screen. The webhook arrives too and writes the same thing, which is why it is safe.
      await applySubscription(kernel, updated)
      return { url: returnUrl(input.baseUrl, back, 'changed'), changed: true }
    }
  }

  const customer = await customerFor(kernel, input.workspaceId, input.email)
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price: plan.stripePriceId, quantity }],
    subscription_data: {
      ...(plan.trialDays > 0 ? { trial_period_days: plan.trialDays } : {}),
      metadata: { kern_workspace_id: input.workspaceId, kern_plan_id: plan.id },
    },
    // The card is taken up front, trial or not, so the subscription converts without asking again.
    payment_method_collection: 'always',
    success_url: returnUrl(input.baseUrl, back, 'done'),
    cancel_url: returnUrl(input.baseUrl, back, 'cancelled'),
  })
  if (!session.url) throw KernError.conflict('Stripe did not return a checkout URL', 'billing.stripe.no_url')
  return { url: session.url, changed: false }
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

/**
 * Give the claim back, so Stripe's retry is handled rather than answered "already applied".
 *
 * The claim is taken *before* the handler runs, because taking it after leaves two concurrent
 * deliveries both applying the event. That ordering had a worse failure of its own: a handler that
 * threw left the id claimed for ever, so every retry Stripe sent was recognised as a duplicate and
 * dropped — the event was lost, permanently and silently, and a paid invoice was never mirrored.
 *
 * The two are not both fixable by one insert, so the claim is released on failure instead of being
 * held in a transaction with the work. A transaction is the tidier answer and cannot be had here:
 * `applyInvoice` runs inside `withWorkspace`, which takes its own connection to set the RLS context,
 * so the insert and the write are on different connections by construction. The window this leaves
 * — a duplicate delivery arriving while the first is failing — ends in the duplicate being dropped,
 * which is what would have happened anyway, and Stripe retries either way.
 */
async function release(kernel: Kernel, id: string): Promise<void> {
  await kernel.database.db
    .delete(webhookEvents)
    .where(eq(webhookEvents.id, id))
    .catch((err: unknown) =>
      kernel.log.error(
        { err: String(err), event: id },
        'billing: could not release a webhook claim; Stripe will treat its retry as a duplicate',
      ),
    )
}

/** The workspace a Stripe object belongs to, from the metadata we set when creating it. */
function workspaceOf(o: { metadata?: Stripe.Metadata | null }): string | null {
  return o.metadata?.kern_workspace_id ?? null
}

/** A grace clock `GRACE_DAYS` from now. */
export function graceFrom(now = new Date()): Date {
  const grace = new Date(now)
  grace.setUTCDate(grace.getUTCDate() + GRACE_DAYS)
  return grace
}

/**
 * Write what Stripe says about a subscription into our row.
 *
 * The grace clock is the delicate part. This used to write `graceEndsAt: null` unconditionally, and
 * Stripe emits `customer.subscription.updated` for the same failed payment as
 * `invoice.payment_failed` — in no guaranteed order. So the update wiped the clock the invoice
 * event had just set, `billing.close-grace-periods` requires a non-null clock to act, and the
 * `past_due → suspended` transition therefore almost never fired: a workspace that stopped paying
 * kept working indefinitely.
 *
 * The clock now belongs to the *status*, not to the event that happened to arrive last. Past due
 * keeps a clock already running and starts one if there is none — which also covers the order where
 * `subscription.updated` is the only thing that arrives. Any other status means the payment problem
 * is over, and clears it.
 */
async function applySubscription(kernel: Kernel, s: Stripe.Subscription): Promise<void> {
  const workspaceId = workspaceOf(s)
  if (!workspaceId) {
    kernel.log.warn({ subscription: s.id }, 'billing: Stripe subscription without a workspace id')
    return
  }
  const planId = s.metadata?.kern_plan_id ?? null
  const item = s.items.data[0]
  const periodEnd = item?.current_period_end ?? null
  const status = mapStatus(s.status)

  let graceEndsAt: Date | null = null
  if (status === 'past_due') {
    const [row] = await kernel.database.db
      .select({ graceEndsAt: subscriptions.graceEndsAt })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .limit(1)
    graceEndsAt = row?.graceEndsAt ?? graceFrom()
  }

  await subs.upsert(kernel, workspaceId, {
    ...(planId ? { planId } : {}),
    status,
    seatsPurchased: item?.quantity ?? 0,
    stripeSubscriptionId: s.id,
    stripeCustomerId: typeof s.customer === 'string' ? s.customer : s.customer.id,
    cancelAtPeriodEnd: s.cancel_at_period_end,
    trialEndsAt: s.trial_end ? new Date(s.trial_end * 1000) : null,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    graceEndsAt,
  })
}

/**
 * Which workspace an invoice belongs to.
 *
 * This used to be one lookup — the subscription row whose Stripe customer matches — and `return`
 * when it found nothing. The first invoice of a new subscription is exactly the case where it finds
 * nothing: Stripe sends `invoice.paid` for it *before* `checkout.session.completed`, so no row has
 * the customer yet, the event was recorded as applied, Stripe never retried, and the invoice was
 * gone for good. The cloud's first real purchase lost its invoice this way.
 *
 * The invoice itself says where it belongs: `parent.subscription_details.metadata` is a snapshot of
 * the subscription's metadata, which carries `kern_workspace_id`. That is read first; the customer
 * row second; and when neither answers, the subscription is fetched from Stripe — a fetch that
 * fails is *not* caught, so the route answers 500, the claim is released and Stripe delivers the
 * event again, by which time the subscription has usually arrived. An invoice with no subscription
 * behind it and a customer nobody here knows is not a Kern invoice, and is skipped, loudly.
 */
async function workspaceOfInvoice(
  kernel: Kernel,
  stripe: Stripe,
  inv: Stripe.Invoice,
): Promise<string | null> {
  const details = inv.parent?.subscription_details
  const fromSnapshot = details?.metadata?.kern_workspace_id
  if (fromSnapshot) return fromSnapshot

  const customer = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id
  if (customer) {
    const [row] = await kernel.database.db
      .select({ workspaceId: subscriptions.workspaceId })
      .from(subscriptions)
      .where(eq(subscriptions.stripeCustomerId, customer))
      .limit(1)
    if (row) return row.workspaceId
  }

  const subId = typeof details?.subscription === 'string' ? details.subscription : details?.subscription?.id
  if (subId) {
    const remote = await stripe.subscriptions.retrieve(subId)
    const workspaceId = workspaceOf(remote)
    if (workspaceId) {
      // The subscription event has not arrived yet; writing it now is what lets the invoice land.
      await applySubscription(kernel, remote)
      return workspaceId
    }
  }

  kernel.log.warn(
    { invoice: inv.id, customer, subscription: subId },
    'billing: Stripe invoice belongs to no workspace here; skipped',
  )
  return null
}

/**
 * Mirror every invoice Stripe holds for a subscription or a customer.
 *
 * Webhooks are the normal path; this is the repair for the ones that were lost — the first invoice
 * of every subscription created before `workspaceOfInvoice` existed, and any delivery an instance
 * missed while it was down. It runs after checkout completes and once a night for every workspace
 * with a Stripe customer, and is idempotent: `applyInvoice` upserts on the Stripe invoice id.
 */
export async function syncInvoices(
  kernel: Kernel,
  by: { subscription: string } | { customer: string },
): Promise<number> {
  const stripe = required()
  const list = await stripe.invoices.list({ ...by, limit: 100 })
  let n = 0
  for (const inv of list.data) {
    await applyInvoice(kernel, stripe, inv)
    n += 1
  }
  return n
}

/** `syncInvoices` for a workspace, when it has a Stripe customer; a no-op otherwise. */
export async function backfillInvoices(kernel: Kernel, workspaceId: string): Promise<number> {
  if (!paymentsEnabled()) return 0
  const [row] = await kernel.database.db
    .select({ customer: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, workspaceId))
    .limit(1)
  if (!row?.customer) return 0
  return syncInvoices(kernel, { customer: row.customer })
}

async function applyInvoice(kernel: Kernel, stripe: Stripe, inv: Stripe.Invoice): Promise<void> {
  const workspaceId = await workspaceOfInvoice(kernel, stripe, inv)
  if (!workspaceId) return
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

  try {
    await apply(kernel, stripe, event)
  } catch (err) {
    // The claim goes back so Stripe's retry is a real delivery rather than a duplicate. Rethrowing
    // is what turns the retry on: the route answers 5xx and Stripe sends the event again.
    await release(kernel, event.id)
    throw err
  }
  return { handled: true, type: event.type }
}

async function apply(kernel: Kernel, stripe: Stripe, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await applySubscription(kernel, event.data.object)
      break
    case 'checkout.session.completed': {
      const session = event.data.object
      const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id
      if (!subId) break
      const remote = await stripe.subscriptions.retrieve(subId)
      await applySubscription(kernel, remote)
      /**
       * The quantity was taken from the seat count at the moment the session was opened, and
       * somebody may have joined or left while the card was being typed. `syncSeats` is a no-op when
       * the two already agree, so this costs one read on the normal path.
       *
       * The whole thing is inside the try, `await billableSeats` included: written as an argument to
       * a `.catch()`ed call it would be evaluated *before* the handler is attached, so a failure
       * counting seats would escape, fail the webhook, and cost us the record of a payment that has
       * already happened. A wrong seat count is a billing correction the nightly reconcile makes; a
       * lost `checkout.session.completed` is a customer who paid and got nothing.
       */
      const workspaceId = workspaceOf(remote)
      if (workspaceId) {
        try {
          await syncSeats(kernel, workspaceId, await billableSeats(kernel, workspaceId))
        } catch (err) {
          kernel.log.warn(
            { err: String(err), workspaceId },
            'billing: could not sync seats after checkout; the nightly reconcile will correct it',
          )
        }
      }
      // The first invoice was paid before this event was sent, and its own webhook may have arrived
      // before the subscription existed here. Same rule as the seats: never fail the event over it.
      try {
        await syncInvoices(kernel, { subscription: subId })
      } catch (err) {
        kernel.log.warn(
          { err: String(err), subscription: subId },
          'billing: could not mirror invoices after checkout; the nightly backfill will',
        )
      }
      break
    }
    case 'invoice.paid':
      await applyInvoice(kernel, stripe, event.data.object)
      break
    case 'invoice.payment_failed': {
      const inv = event.data.object
      await applyInvoice(kernel, stripe, inv)
      const customer = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id
      if (customer) {
        const [row] = await kernel.database.db
          .select({ workspaceId: subscriptions.workspaceId, graceEndsAt: subscriptions.graceEndsAt })
          .from(subscriptions)
          .where(eq(subscriptions.stripeCustomerId, customer))
          .limit(1)
        if (row) {
          // A failed payment starts a clock, it does not close the workspace. Stripe keeps retrying
          // for its own dunning window; the grace period is what decides when we stop waiting.
          // A clock already running is kept: a second failed invoice inside the window must not
          // hand the customer another fourteen days.
          await subs.upsert(kernel, row.workspaceId, {
            status: 'past_due',
            graceEndsAt: row.graceEndsAt ?? graceFrom(),
          })
        }
      }
      break
    }
    default:
      kernel.log.debug({ type: event.type }, 'billing: unhandled Stripe event')
  }
}

/** How long a workspace keeps working after a payment fails. */
export const GRACE_DAYS = 14
