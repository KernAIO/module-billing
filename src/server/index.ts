import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Principal, WorkspaceId } from '@kernhq/contracts'
import { defineModule, defineServerModule, KernError, type Kernel, packageVersion } from '@kernhq/kernel'
import { and, eq, isNotNull, lte } from 'drizzle-orm'
import { z } from 'zod'
import { billingContract, billingEvents, billingPermissions, MODULE_ID } from '../contract.js'
import { billingRouter } from './router.js'
import { schema, subscriptions } from './schema.js'
import * as entitlements from './services/entitlements.js'
import * as stripeSvc from './services/stripe.js'
import * as subsSvc from './services/subscriptions.js'
import * as usageSvc from './services/usage.js'

export { billingRouter } from './router.js'
export * from './schema.js'
export * as billingEntitlements from './services/entitlements.js'
export * as billingPlans from './services/plans.js'
export * as billingStripe from './services/stripe.js'
export * as billingSubscriptions from './services/subscriptions.js'
export * as billingUsage from './services/usage.js'

/**
 * `procedures` is the service-to-service surface, reachable only over `kernel.call`. It runs with
 * elevated access, so it must never be reachable by an end user: everything a person does goes
 * through the oRPC router and its permission middleware.
 */
function requireService(principal: Principal): void {
  if (principal.kind !== 'service' && !principal.instanceAdmin) throw KernError.forbidden()
}

/** Workspaces this instance knows about, asked of core — billing only ever stores ids. */
async function allWorkspaceIds(kernel: Kernel): Promise<string[]> {
  const rows = await kernel.call<Array<{ id: string }>>('core.workspaces.list', { limit: 10_000 })
  return rows.map((r) => r.id)
}

export const billingModule = defineServerModule({
  definition: defineModule({
    id: MODULE_ID,
    name: 'Billing',
    version: packageVersion(import.meta.url),
    description: 'Plans, entitlements and subscriptions — what lets an instance sell seats on itself',
    icon: 'credit-card',
    permissions: billingPermissions,
    events: billingEvents,
  }),
  schema,
  migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '../../migrations'),
  contract: billingContract,
  router: billingRouter,

  procedures: {
    /**
     * The one the kernel calls. Its mere presence on the broker is what switches limits on for the
     * whole instance — `kernel.entitlements` checks `broker.has()` and treats an absent procedure as
     * unlimited, which is what every self-hosted Kern does on every request.
     */
    'entitlements.get': {
      input: z.object({ workspaceId: WorkspaceId }),
      handler: async (input, { kernel, principal }) => {
        requireService(principal)
        return entitlements.resolve(kernel, input.workspaceId)
      },
    },
    /** Recount one workspace from core's tables. Used by the nightly job and by support. */
    'usage.reconcile': {
      input: z.object({ workspaceId: WorkspaceId }),
      handler: async (input, { kernel, principal }) => {
        requireService(principal)
        return usageSvc.reconcile(kernel, input.workspaceId)
      },
    },
  },

  subscriptions: {
    /**
     * Seats follow membership, and only for members who cost money — a guest is invited to look at
     * one thing and must not put the workspace over its plan.
     *
     * All three events do the same thing: recount. `core.member.removed` does not say what role the
     * person had and `core.member.updated` does not say what role they had before, so neither can be
     * turned into a safe delta. Core counts non-guest memberships for one workspace, which is one
     * indexed query.
     */
    'core.member.*': async (e, kernel) => {
      const p = e.payload as { workspaceId?: string }
      if (!p.workspaceId) return
      const seats = await usageSvc.recountSeats(kernel, p.workspaceId)
      await stripeSvc.syncSeats(kernel, p.workspaceId, seats)
    },
    'core.file.ready': async (e, kernel) => {
      const p = e.payload as { workspaceId: string; size?: number }
      if (typeof p.size !== 'number') return
      await usageSvc.bump(kernel, p.workspaceId, { storageBytes: p.size })
    },
    'core.file.deleted': async (e, kernel) => {
      const p = e.payload as { workspaceId: string; size: number }
      await usageSvc.bump(kernel, p.workspaceId, { storageBytes: -p.size })
    },
    /**
     * A brand-new workspace starts on the default plan if the instance has one, so a cloud signup is
     * entitled to something before anybody has touched the admin console. An instance with no
     * default plan — every self-hosted one — gets no row, which resolves to unlimited.
     */
    'core.workspace.created': async (e, kernel) => {
      const p = e.payload as { workspaceId: string }
      const slug = process.env.KERN_DEFAULT_PLAN_SLUG
      if (!slug) return
      const { bySlug } = await import('./services/plans.js')
      const plan = await bySlug(kernel, slug)
      if (!plan) {
        kernel.log.warn({ slug }, 'billing: KERN_DEFAULT_PLAN_SLUG names a plan that does not exist')
        return
      }
      const trialEndsAt = new Date()
      trialEndsAt.setUTCDate(trialEndsAt.getUTCDate() + plan.trialDays)
      await subsSvc.upsert(kernel, p.workspaceId, {
        planId: plan.id,
        status: plan.trialDays > 0 ? 'trialing' : 'active',
        trialEndsAt: plan.trialDays > 0 ? trialEndsAt : null,
      })
    },
  },

  jobs: [
    {
      name: 'billing.reconcile-usage',
      // nightly; counters move on events all day and this is what proves they were right
      cron: '17 3 * * *',
      handler: async (_input: unknown, { kernel }: { kernel: Kernel }) => {
        for (const workspaceId of await allWorkspaceIds(kernel)) {
          try {
            const { drift } = await usageSvc.reconcile(kernel, workspaceId)
            // Logged, never silently corrected: a counter that keeps needing correction means an
            // event is being missed, and quietly fixing the number every night is how that goes
            // unnoticed for a year.
            if (drift.seats !== 0 || drift.storageBytes !== 0)
              kernel.log.warn({ workspaceId, drift }, 'billing: usage counters had drifted')
          } catch (err) {
            kernel.log.warn({ err: String(err), workspaceId }, 'billing: reconcile failed')
          }
        }
      },
    },
    {
      name: 'billing.close-grace-periods',
      cron: '7 * * * *',
      handler: async (_input: unknown, { kernel }: { kernel: Kernel }) => {
        const due = await kernel.database.db
          .select({ workspaceId: subscriptions.workspaceId })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.status, 'past_due'),
              isNotNull(subscriptions.graceEndsAt),
              lte(subscriptions.graceEndsAt, new Date()),
            ),
          )
        for (const row of due) {
          await subsSvc.upsert(kernel, row.workspaceId, { status: 'suspended', graceEndsAt: null })
          await kernel.emit(
            billingEvents.subscriptionSuspended,
            {
              workspaceId: row.workspaceId as WorkspaceId,
              reason: 'the grace period after a failed payment ended',
            },
            { workspaceId: row.workspaceId },
          )
          kernel.log.info(
            { workspaceId: row.workspaceId },
            'billing: grace period ended, workspace suspended',
          )
        }
      },
    },
  ],
})

export default billingModule
