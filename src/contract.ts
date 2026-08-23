import {
  baseContract,
  defineEvent,
  definePermissions,
  Id,
  PageInput,
  page,
  WorkspaceId,
} from '@kernhq/contracts'
import { z } from 'zod'

export const MODULE_ID = 'billing'

/**
 * The limits a plan may set.
 *
 * These keys mirror `Entitlement` in `@kernhq/kernel` exactly, and that is the point: the kernel
 * declares what can be limited, this module decides the values, and every key has one place in core
 * that enforces it. A plan can therefore be edited freely by an instance admin without ever being
 * able to promise something nothing checks.
 *
 * `null` means unlimited, everywhere.
 */
export const PlanLimits = z.object({
  /** billable seats; members with the `guest` role never consume one */
  seats: z.number().int().positive().nullable().default(null),
  storageBytes: z.number().int().nonnegative().nullable().default(null),
  /** module ids this plan allows to be switched on; `null` = every module the instance ships */
  modules: z.array(z.string()).nullable().default(null),
  sso: z.boolean().default(true),
  auditRetentionDays: z.number().int().positive().nullable().default(null),
  apiRateLimit: z.number().int().positive().nullable().default(null),
})
export type PlanLimits = z.infer<typeof PlanLimits>

/**
 * A patch over `PlanLimits`, for comping one limit without touching the rest.
 *
 * Written out rather than derived with `.partial()`, because `.partial()` keeps the field defaults:
 * parsing `{ seats: 50 }` through it returns every other key at its default too, so spreading the
 * result silently resets limits the admin never mentioned. Absent here means absent.
 */
export const PlanLimitsPatch = z.object({
  seats: z.number().int().positive().nullable().optional(),
  storageBytes: z.number().int().nonnegative().nullable().optional(),
  modules: z.array(z.string()).nullable().optional(),
  sso: z.boolean().optional(),
  auditRetentionDays: z.number().int().positive().nullable().optional(),
  apiRateLimit: z.number().int().positive().nullable().optional(),
})
export type PlanLimitsPatch = z.infer<typeof PlanLimitsPatch>

export const BillingInterval = z.enum(['month', 'year'])
export type BillingInterval = z.infer<typeof BillingInterval>

export const Plan = z.object({
  id: Id,
  /** stable identifier used in URLs and by the marketing site; never reused */
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  name: z.string().min(1).max(80),
  description: z.string().max(300).default(''),
  /** in the currency's smallest unit, so 800 is $8.00 — never a float */
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3).default('usd'),
  interval: BillingInterval.default('month'),
  /** true when `priceMinor` is charged per seat rather than per workspace */
  perSeat: z.boolean().default(true),
  trialDays: z.number().int().nonnegative().default(0),
  limits: PlanLimits,
  /** the price object in Stripe; null until the plan is wired to one */
  stripePriceId: z.string().nullable().default(null),
  /** what the marketing site lists under the plan */
  highlights: z.array(z.string()).default([]),
  published: z.boolean().default(false),
  order: z.number().int().default(100),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Plan = z.infer<typeof Plan>

/**
 * What a stranger may see. Served unauthenticated so the marketing site can render prices that come
 * from the same row the instance actually charges against — no internal ids, no Stripe ids, and
 * published plans only.
 */
export const PublicPlan = Plan.pick({
  slug: true,
  name: true,
  description: true,
  priceMinor: true,
  currency: true,
  interval: true,
  perSeat: true,
  trialDays: true,
  highlights: true,
  order: true,
}).extend({ limits: PlanLimits })
export type PublicPlan = z.infer<typeof PublicPlan>

export const UpsertPlan = Plan.omit({ id: true, createdAt: true, updatedAt: true }).extend({
  id: Id.optional(),
})
export type UpsertPlan = z.infer<typeof UpsertPlan>

/**
 * `trialing` and `active` are the two states that entitle a workspace to its plan.
 * `past_due` still does — there is a grace period — and `suspended` does not.
 * `canceled` keeps the row so the history and the Stripe ids survive a resubscribe.
 */
export const SubscriptionStatus = z.enum(['trialing', 'active', 'past_due', 'canceled', 'suspended'])
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>

export const Subscription = z.object({
  workspaceId: WorkspaceId,
  planId: Id.nullable(),
  planName: z.string().nullable(),
  planSlug: z.string().nullable(),
  status: SubscriptionStatus,
  seatsPurchased: z.number().int().nonnegative(),
  trialEndsAt: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  /** set once the workspace has a Stripe customer; null on a comped or manually managed workspace */
  stripeCustomerId: z.string().nullable(),
  stripeSubscriptionId: z.string().nullable(),
})
export type Subscription = z.infer<typeof Subscription>

export const Usage = z.object({
  seats: z.number().int().nonnegative(),
  storageBytes: z.number().int().nonnegative(),
  updatedAt: z.string(),
})
export type Usage = z.infer<typeof Usage>

/** Everything the workspace's own billing screen needs, in one round trip. */
export const WorkspaceBilling = z.object({
  subscription: Subscription.nullable(),
  usage: Usage,
  limits: PlanLimits,
  /** false while past due or suspended */
  active: z.boolean(),
  /** whether this instance can take a payment at all — false when no Stripe key is configured */
  paymentsEnabled: z.boolean(),
})
export type WorkspaceBilling = z.infer<typeof WorkspaceBilling>

export const Invoice = z.object({
  id: Id,
  workspaceId: WorkspaceId,
  number: z.string().nullable(),
  status: z.string(),
  totalMinor: z.number().int(),
  currency: z.string(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  hostedUrl: z.string().nullable(),
  pdfUrl: z.string().nullable(),
  createdAt: z.string(),
})
export type Invoice = z.infer<typeof Invoice>

/** One row of the instance console's list of every workspace on the instance. */
export const AdminWorkspaceRow = z.object({
  workspaceId: WorkspaceId,
  workspaceName: z.string(),
  workspaceSlug: z.string(),
  planName: z.string().nullable(),
  planSlug: z.string().nullable(),
  status: SubscriptionStatus.nullable(),
  seatsUsed: z.number().int().nonnegative(),
  seatsPurchased: z.number().int().nonnegative(),
  storageBytes: z.number().int().nonnegative(),
  trialEndsAt: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  /** what this workspace bills per month, in minor units; annual plans are divided by twelve */
  monthlyMinor: z.number().int().nonnegative(),
  currency: z.string(),
  /** true when an admin has overridden any limit by hand */
  overridden: z.boolean(),
  stripeCustomerId: z.string().nullable(),
})
export type AdminWorkspaceRow = z.infer<typeof AdminWorkspaceRow>

const ws = z.object({ workspaceId: WorkspaceId })

export const billingContract = {
  plans: {
    list: baseContract
      .route({ method: 'GET', path: '/plans', tags: ['billing'] })
      .input(z.object({ includeUnpublished: z.boolean().default(false) }))
      .output(z.array(Plan)),
    /**
     * Unauthenticated on purpose: this is what kernaio.com and any other instance's marketing page
     * reads, so that a price is edited in one place and true in both.
     */
    public: baseContract
      .route({ method: 'GET', path: '/plans/public', tags: ['billing'] })
      .input(z.object({}))
      .output(z.array(PublicPlan)),
    upsert: baseContract
      .route({ method: 'POST', path: '/plans', tags: ['billing'] })
      .input(UpsertPlan)
      .output(Plan),
    setPublished: baseContract
      .route({ method: 'POST', path: '/plans/{id}/published', tags: ['billing'] })
      .input(z.object({ id: Id, published: z.boolean() }))
      .output(Plan),
    archive: baseContract
      .route({ method: 'DELETE', path: '/plans/{id}', tags: ['billing'] })
      .input(z.object({ id: Id }))
      .output(z.object({ ok: z.literal(true) })),
  },
  subscription: {
    get: baseContract
      .route({ method: 'GET', path: '/subscription', tags: ['billing'] })
      .input(ws)
      .output(WorkspaceBilling),
    invoices: baseContract
      .route({ method: 'GET', path: '/subscription/invoices', tags: ['billing'] })
      .input(ws.extend(PageInput.shape))
      .output(page(Invoice)),
    /** Stripe Checkout for a new subscription or a plan change; returns a URL to send the user to. */
    checkout: baseContract
      .route({ method: 'POST', path: '/subscription/checkout', tags: ['billing'] })
      .input(ws.extend({ planSlug: z.string(), seats: z.number().int().positive().optional() }))
      .output(z.object({ url: z.string() })),
    /** Stripe's own billing portal: payment method, cancellation, invoice download. */
    portal: baseContract
      .route({ method: 'POST', path: '/subscription/portal', tags: ['billing'] })
      .input(ws.extend({ returnPath: z.string().default('/') }))
      .output(z.object({ url: z.string() })),
  },
  admin: {
    workspaces: baseContract
      .route({ method: 'GET', path: '/admin/workspaces', tags: ['billing'] })
      .input(
        z.object({ q: z.string().optional(), status: SubscriptionStatus.optional() }).extend(PageInput.shape),
      )
      .output(page(AdminWorkspaceRow)),
    setPlan: baseContract
      .route({ method: 'POST', path: '/admin/workspaces/{workspaceId}/plan', tags: ['billing'] })
      .input(ws.extend({ planId: Id.nullable(), seatsPurchased: z.number().int().nonnegative().optional() }))
      .output(Subscription),
    /**
     * Comp an account without inventing a plan for it. `null` clears the override and the plan's own
     * limit applies again.
     */
    override: baseContract
      .route({ method: 'POST', path: '/admin/workspaces/{workspaceId}/override', tags: ['billing'] })
      .input(ws.extend({ limits: PlanLimitsPatch.nullable() }))
      .output(Subscription),
    extendTrial: baseContract
      .route({ method: 'POST', path: '/admin/workspaces/{workspaceId}/trial', tags: ['billing'] })
      .input(ws.extend({ days: z.number().int().positive().max(365) }))
      .output(Subscription),
    setStatus: baseContract
      .route({ method: 'POST', path: '/admin/workspaces/{workspaceId}/status', tags: ['billing'] })
      .input(ws.extend({ status: z.enum(['active', 'suspended']) }))
      .output(Subscription),
  },
}
export type BillingContract = typeof billingContract

export const billingEvents = {
  /**
   * Emitted whenever anything changes what a workspace is allowed to do. The kernel listens on
   * `billing.subscription.*` and drops its entitlement cache, so a customer who has just paid does
   * not wait out a TTL for the seat they bought.
   */
  subscriptionChanged: defineEvent(
    'billing.subscription.changed',
    z.object({
      workspaceId: WorkspaceId,
      status: SubscriptionStatus,
      planSlug: z.string().nullable(),
    }),
  ),
  subscriptionSuspended: defineEvent(
    'billing.subscription.suspended',
    z.object({ workspaceId: WorkspaceId, reason: z.string() }),
  ),
  /** A plan was published or unpublished — what the marketing site shows has changed. */
  catalogueChanged: defineEvent('billing.catalogue.changed', z.object({ planSlug: z.string() })),
}

export const BILLING_PERMISSIONS = {
  view: 'billing.subscription.view',
  manage: 'billing.subscription.manage',
} as const

export const billingPermissions = definePermissions([
  {
    key: BILLING_PERMISSIONS.view,
    label: 'View the plan and what it costs',
    scope: 'workspace',
    defaultRoles: ['owner', 'admin'],
    dangerous: false,
  },
  {
    key: BILLING_PERMISSIONS.manage,
    label: 'Change the plan and the payment method',
    scope: 'workspace',
    defaultRoles: ['owner'],
    dangerous: true,
  },
])
