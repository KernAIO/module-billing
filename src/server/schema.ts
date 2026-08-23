import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// `pgSchema` directly (not `moduleSchema` from @kernhq/kernel) so drizzle-kit can load this file standalone
export const schema = pgSchema('mod_billing')

const ts = (name: string) => timestamp(name, { withTimezone: true })
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`)
const jsonObject = (name: string) => jsonb(name).notNull().default(sql`'{}'::jsonb`)
const jsonArray = (name: string) => jsonb(name).notNull().default(sql`'[]'::jsonb`)

/**
 * # Why most of this module is not row-level secured
 *
 * Kern's rule is that a module's tenant tables carry `workspace_id` and RLS. Billing is the one place
 * that rule does not fit, and it is worth saying exactly why rather than leaving the next person to
 * assume it was forgotten.
 *
 * A subscription row is not the workspace's data. It is the **instance operator's** record *about*
 * that workspace: what they charge it, whether it has paid, whether it is suspended. Two things
 * follow, and neither is possible under RLS, which returns nothing at all when `app.workspace_id` is
 * unset:
 *
 * - the instance console lists every workspace on the instance in one query — that screen is the
 *   whole reason an operator can run Kern as a service;
 * - the dunning and reconcile jobs enumerate workspaces before they can pick one.
 *
 * So `plans`, `subscriptions`, `workspace_usage`, `overrides` and `webhook_events` are operator
 * tables, and their isolation is enforced in the procedure layer: every workspace-facing procedure
 * filters by the caller's own workspace and checks `billing.subscription.view|manage` first.
 *
 * `invoices` is the exception that proves it. An invoice **is** the customer's own record, read on
 * their own billing screen, so it is a proper tenant table with RLS — see `TENANT_TABLES` below.
 */

/** The catalogue. Instance-scoped: a plan belongs to the instance, not to any workspace. */
export const plans = schema.table(
  'plans',
  {
    id: id(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** smallest currency unit, so 800 is $8.00 — money is never a float */
    priceMinor: integer('price_minor').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    interval: text('interval').notNull().default('month'),
    perSeat: boolean('per_seat').notNull().default(true),
    trialDays: integer('trial_days').notNull().default(0),
    limits: jsonObject('limits'),
    stripePriceId: text('stripe_price_id'),
    highlights: jsonArray('highlights'),
    published: boolean('published').notNull().default(false),
    order: integer('order').notNull().default(100),
    /** archived plans keep working for whoever is on them, and stop being offered */
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('plans_slug_idx').on(t.slug), index('plans_published_idx').on(t.published, t.order)],
)

/** One per workspace. Operator table — see the note at the top of this file. */
export const subscriptions = schema.table(
  'subscriptions',
  {
    workspaceId: uuid('workspace_id').primaryKey(),
    planId: uuid('plan_id'),
    status: text('status').notNull().default('trialing'),
    seatsPurchased: integer('seats_purchased').notNull().default(0),
    trialEndsAt: ts('trial_ends_at'),
    currentPeriodEnd: ts('current_period_end'),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    /** when the grace period after a failed payment runs out and the workspace is suspended */
    graceEndsAt: ts('grace_ends_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('subscriptions_status_idx').on(t.status),
    uniqueIndex('subscriptions_stripe_sub_idx').on(t.stripeSubscriptionId),
  ],
)

/**
 * What a workspace is actually using.
 *
 * Kept as a counter rather than recomputed, because `sum(files.size)` on every upload is a scan of
 * the workspace's whole file table. Event subscriptions move it; a nightly job recomputes the truth
 * and logs the drift rather than silently papering over it, because silent correction hides the bug
 * that caused the drift.
 */
export const workspaceUsage = schema.table('workspace_usage', {
  workspaceId: uuid('workspace_id').primaryKey(),
  seats: integer('seats').notNull().default(0),
  /** bigint, not integer: a 2 GiB workspace would overflow int4 counted in bytes */
  storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull().default(0),
  reconciledAt: ts('reconciled_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/** Per-workspace limit overrides, so an account can be comped without inventing a plan for it. */
export const overrides = schema.table('overrides', {
  workspaceId: uuid('workspace_id').primaryKey(),
  limits: jsonObject('limits'),
  note: text('note').notNull().default(''),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/**
 * The customer's own invoice history — a **tenant table**, read on their billing screen in their own
 * workspace context. The operator reads invoices in Stripe, which is authoritative; this is a mirror
 * kept so the screen does not have to call Stripe to render.
 */
export const invoices = schema.table(
  'invoices',
  {
    id: id(),
    workspaceId: uuid('workspace_id').notNull(),
    stripeInvoiceId: text('stripe_invoice_id'),
    number: text('number'),
    status: text('status').notNull(),
    totalMinor: integer('total_minor').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    periodStart: ts('period_start'),
    periodEnd: ts('period_end'),
    hostedUrl: text('hosted_url'),
    pdfUrl: text('pdf_url'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('invoices_ws_idx').on(t.workspaceId, t.createdAt),
    uniqueIndex('invoices_stripe_idx').on(t.stripeInvoiceId),
  ],
)

/**
 * Stripe event ids already applied.
 *
 * Stripe retries a webhook until it gets a 2xx, and it does not promise to deliver only once, so a
 * handler that is not idempotent will double-count. The unique index is what makes the second
 * delivery a no-op — checking then inserting is a race, so the insert *is* the check.
 */
export const webhookEvents = schema.table(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
  },
  (t) => [index('webhook_events_received_idx').on(t.receivedAt)],
)

/**
 * Tables that carry another workspace's rows and therefore must be row-level secured.
 * Deliberately short — see the note at the top of this file for why the rest are operator tables.
 */
export const TENANT_TABLES = ['invoices'] as const
