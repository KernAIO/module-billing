import type { AdminWorkspaceRow, BillingApi, Invoice, Plan, Subscription, WorkspaceBilling } from './index.js'

/**
 * Billing with no backend, for `pnpm dev:mock` and the end-to-end tests.
 *
 * It satisfies the same contract types as the real client, so no view has a second code path for
 * demos. What it deliberately does *not* do is take a payment: `checkout` and `portal` throw, because
 * the one thing a demo must never be able to imply is that money moved.
 */

const GB = 1024 ** 3
const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString()

let plans: Plan[] = [
  {
    id: 'plan-team',
    slug: 'team',
    name: 'Team',
    description: 'The same Kern, run by us.',
    priceMinor: 800,
    currency: 'usd',
    interval: 'month',
    perSeat: true,
    trialDays: 14,
    limits: {
      seats: 25,
      storageBytes: 50 * GB,
      modules: null,
      sso: false,
      auditRetentionDays: 90,
      apiRateLimit: null,
    },
    stripePriceId: 'price_demo_team',
    highlights: ['Everything in self-hosted', 'Daily backups, kept 30 days'],
    published: true,
    order: 10,
    createdAt: iso(-40),
    updatedAt: iso(-2),
  },
  {
    id: 'plan-business',
    slug: 'business',
    name: 'Business',
    description: 'For companies with a compliance team.',
    priceMinor: 1600,
    currency: 'usd',
    interval: 'month',
    perSeat: true,
    trialDays: 14,
    limits: {
      seats: null,
      storageBytes: 250 * GB,
      modules: null,
      sso: true,
      auditRetentionDays: 730,
      apiRateLimit: null,
    },
    stripePriceId: 'price_demo_business',
    highlights: ['Everything in Team', 'SSO over OIDC and SAML'],
    published: true,
    order: 20,
    createdAt: iso(-40),
    updatedAt: iso(-2),
  },
]

const subscription: Subscription = {
  workspaceId: 'ws-demo' as Subscription['workspaceId'],
  planId: 'plan-team',
  planName: 'Team',
  planSlug: 'team',
  status: 'trialing',
  seatsPurchased: 12,
  trialEndsAt: iso(9),
  currentPeriodEnd: iso(21),
  cancelAtPeriodEnd: false,
  stripeCustomerId: 'cus_demo',
  stripeSubscriptionId: 'sub_demo',
}

const invoices: Invoice[] = [
  {
    id: 'inv-2',
    workspaceId: subscription.workspaceId,
    number: 'KERN-0002',
    status: 'paid',
    totalMinor: 9600,
    currency: 'usd',
    periodStart: iso(-30),
    periodEnd: iso(0),
    hostedUrl: null,
    pdfUrl: null,
    createdAt: iso(-30),
  },
  {
    id: 'inv-1',
    workspaceId: subscription.workspaceId,
    number: 'KERN-0001',
    status: 'paid',
    totalMinor: 8800,
    currency: 'usd',
    periodStart: iso(-60),
    periodEnd: iso(-30),
    hostedUrl: null,
    pdfUrl: null,
    createdAt: iso(-60),
  },
]

const adminRows: AdminWorkspaceRow[] = [
  {
    workspaceId: 'ws-demo' as AdminWorkspaceRow['workspaceId'],
    workspaceName: 'Acme',
    workspaceSlug: 'acme',
    planName: 'Team',
    planSlug: 'team',
    status: 'trialing',
    seatsUsed: 12,
    seatsPurchased: 12,
    storageBytes: 18 * GB,
    trialEndsAt: iso(9),
    currentPeriodEnd: iso(21),
    monthlyMinor: 9600,
    currency: 'usd',
    overridden: false,
    stripeCustomerId: 'cus_demo',
  },
  {
    workspaceId: 'ws-two' as AdminWorkspaceRow['workspaceId'],
    workspaceName: 'Northwind',
    workspaceSlug: 'northwind',
    planName: 'Business',
    planSlug: 'business',
    status: 'active',
    seatsUsed: 48,
    seatsPurchased: 50,
    storageBytes: 190 * GB,
    trialEndsAt: null,
    currentPeriodEnd: iso(12),
    monthlyMinor: 80000,
    currency: 'usd',
    overridden: true,
    stripeCustomerId: 'cus_demo2',
  },
  {
    workspaceId: 'ws-three' as AdminWorkspaceRow['workspaceId'],
    workspaceName: 'Tiny Studio',
    workspaceSlug: 'tiny',
    planName: null,
    planSlug: null,
    status: 'past_due',
    seatsUsed: 3,
    seatsPurchased: 3,
    storageBytes: 2 * GB,
    trialEndsAt: null,
    currentPeriodEnd: iso(-4),
    monthlyMinor: 2400,
    currency: 'usd',
    overridden: false,
    stripeCustomerId: null,
  },
]

const notInDemo = (what: string) => {
  throw new Error(`${what} is not available without a backend`)
}

export function createMockBillingApi(): BillingApi {
  return {
    plans: {
      list: async ({ includeUnpublished }: { includeUnpublished?: boolean }) =>
        includeUnpublished ? plans : plans.filter((p) => p.published),
      public: async () => plans.filter((p) => p.published),
      upsert: async (input: Record<string, unknown>) => {
        const next = {
          ...(input as Plan),
          id: (input.id as string) ?? `plan-${plans.length + 1}`,
          createdAt: iso(0),
          updatedAt: iso(0),
        }
        plans = plans.some((p) => p.id === next.id)
          ? plans.map((p) => (p.id === next.id ? next : p))
          : [...plans, next]
        return next
      },
      setPublished: async ({ id, published }: { id: string; published: boolean }) => {
        plans = plans.map((p) => (p.id === id ? { ...p, published } : p))
        return plans.find((p) => p.id === id)!
      },
      archive: async ({ id }: { id: string }) => {
        plans = plans.filter((p) => p.id !== id)
        return { ok: true as const }
      },
    },
    subscription: {
      get: async (): Promise<WorkspaceBilling> => ({
        subscription,
        usage: { seats: 12, storageBytes: 18 * GB, updatedAt: iso(0) },
        limits: plans[0]!.limits,
        active: true,
        // true, so the demo shows the plan picker rather than the "not set up" note; the checkout
        // itself still refuses
        paymentsEnabled: true,
      }),
      invoices: async () => ({ items: invoices, nextCursor: null }),
      checkout: async () => notInDemo('Checkout'),
      portal: async () => notInDemo('The billing portal'),
    },
    admin: {
      workspaces: async ({ q }: { q?: string }) => ({
        items: q
          ? adminRows.filter((r) => r.workspaceName.toLowerCase().includes(q.toLowerCase()))
          : adminRows,
        nextCursor: null,
      }),
      setPlan: async () => subscription,
      override: async () => subscription,
      extendTrial: async () => subscription,
      setStatus: async () => subscription,
    },
  } as unknown as BillingApi
}
