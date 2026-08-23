import { type Kernel, o, requires, workspaceScoped } from '@kernhq/kernel'
import { implement, ORPCError } from '@orpc/server'
import { BILLING_PERMISSIONS, billingContract, billingEvents, MODULE_ID, PlanLimits } from '../contract.js'
import * as entitlements from './services/entitlements.js'
import * as plansSvc from './services/plans.js'
import * as stripeSvc from './services/stripe.js'
import * as subsSvc from './services/subscriptions.js'
import * as usageSvc from './services/usage.js'

const os = implement(billingContract).$context<import('@kernhq/kernel').RequestContext>()

/**
 * The instance console's audience.
 *
 * Not `workspaceScoped`: these procedures deliberately cross workspaces, which is the whole point of
 * an operator screen. Membership therefore proves nothing here and the instance-admin flag is the
 * only thing that does.
 */
const instanceAdmin = o.middleware(async ({ context, next }) => {
  const { principal } = context
  if (principal.kind === 'anonymous') throw new ORPCError('UNAUTHORIZED')
  if (!principal.instanceAdmin && principal.kind !== 'service')
    throw new ORPCError('FORBIDDEN', { message: 'Instance administrators only' })
  return next()
})

/** Any signed-in principal — enough to be shown what the plans cost. */
const signedIn = o.middleware(async ({ context, next }) => {
  if (context.principal.kind === 'anonymous') throw new ORPCError('UNAUTHORIZED')
  return next()
})

export function billingRouter(kernel: Kernel) {
  const scoped = os.use(workspaceScoped(MODULE_ID))

  return os.router({
    plans: {
      list: os.plans.list.use(signedIn).handler(async ({ input, context }) => {
        // an unpublished plan is a draft, and a draft is the operator's business
        if (
          input.includeUnpublished &&
          !context.principal.instanceAdmin &&
          context.principal.kind !== 'service'
        )
          throw new ORPCError('FORBIDDEN', { message: 'Instance administrators only' })
        return plansSvc.list(kernel, input.includeUnpublished)
      }),

      // No middleware at all: this is what a marketing site reads, and it has no session.
      public: os.plans.public.handler(async () => plansSvc.publicList(kernel)),

      upsert: os.plans.upsert.use(instanceAdmin).handler(async ({ input }) => {
        const plan = await plansSvc.upsert(kernel, input)
        await kernel.emit(billingEvents.catalogueChanged, { planSlug: plan.slug })
        return plan
      }),

      setPublished: os.plans.setPublished.use(instanceAdmin).handler(async ({ input }) => {
        const plan = await plansSvc.setPublished(kernel, input.id, input.published)
        // what the marketing site shows has changed; whoever rebuilds it listens for this
        await kernel.emit(billingEvents.catalogueChanged, { planSlug: plan.slug })
        return plan
      }),

      archive: os.plans.archive.use(instanceAdmin).handler(async ({ input }) => {
        await plansSvc.archive(kernel, input.id)
        return { ok: true as const }
      }),
    },

    subscription: {
      get: scoped.subscription.get.use(requires(BILLING_PERMISSIONS.view)).handler(async ({ input }) => {
        const [subscription, used, limits] = await Promise.all([
          subsSvc.get(kernel, input.workspaceId),
          usageSvc.read(kernel, input.workspaceId),
          entitlements.resolve(kernel, input.workspaceId),
        ])
        return {
          subscription,
          usage: {
            seats: used.seats,
            storageBytes: used.storageBytes,
            updatedAt: used.updatedAt.toISOString(),
          },
          limits: PlanLimits.parse(limits),
          active: limits.active ?? true,
          paymentsEnabled: stripeSvc.paymentsEnabled(),
        }
      }),

      invoices: scoped.subscription.invoices
        .use(requires(BILLING_PERMISSIONS.view))
        .handler(async ({ input }) => ({
          items: await subsSvc.listInvoices(kernel, input.workspaceId, input.limit),
          nextCursor: null,
        })),

      checkout: scoped.subscription.checkout
        .use(requires(BILLING_PERMISSIONS.manage))
        .handler(async ({ input, context }) =>
          stripeSvc.checkout(kernel, {
            workspaceId: input.workspaceId,
            planSlug: input.planSlug,
            seats: input.seats,
            email: context.principal.email ?? undefined,
            baseUrl: kernel.env.KERN_BASE_URL,
          }),
        ),

      portal: scoped.subscription.portal
        .use(requires(BILLING_PERMISSIONS.manage))
        .handler(async ({ input }) =>
          stripeSvc.portal(kernel, {
            workspaceId: input.workspaceId,
            returnUrl: `${kernel.env.KERN_BASE_URL.replace(/\/$/, '')}${input.returnPath}`,
          }),
        ),
    },

    admin: {
      workspaces: os.admin.workspaces.use(instanceAdmin).handler(async ({ input }) => ({
        items: await subsSvc.adminList(kernel, {
          q: input.q,
          status: input.status,
          limit: input.limit,
        }),
        nextCursor: null,
      })),

      setPlan: os.admin.setPlan
        .use(instanceAdmin)
        .handler(async ({ input }) =>
          subsSvc.setPlan(kernel, input.workspaceId, input.planId, input.seatsPurchased),
        ),

      override: os.admin.override
        .use(instanceAdmin)
        .handler(async ({ input, context }) =>
          subsSvc.setOverride(kernel, input.workspaceId, input.limits, context.principal.userId ?? null),
        ),

      extendTrial: os.admin.extendTrial
        .use(instanceAdmin)
        .handler(async ({ input }) => subsSvc.extendTrial(kernel, input.workspaceId, input.days)),

      setStatus: os.admin.setStatus
        .use(instanceAdmin)
        .handler(async ({ input }) => subsSvc.setStatus(kernel, input.workspaceId, input.status)),
    },
  })
}
