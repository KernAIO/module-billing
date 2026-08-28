import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Principal, WorkspaceId } from '@kernhq/contracts'
import {
  defineModule,
  defineServerModule,
  httpStatusFor,
  KernError,
  type Kernel,
  packageVersion,
} from '@kernhq/kernel'
import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm'
import { z } from 'zod'
import { billingContract, billingEvents, billingPermissions, MODULE_ID } from '../contract.js'
import { billingRouter } from './router.js'
import { schema, subscriptions } from './schema.js'
import { assertDefaultPlan, seedPlansFromFile } from './services/catalogue.js'
import * as entitlements from './services/entitlements.js'
import * as plansSvc from './services/plans.js'
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

  /**
   * The one thing oRPC cannot carry: Stripe picks the URL, the method and the content type, and the
   * signature covers the exact bytes it sent. `raw: true` is what hands the handler those bytes —
   * anything that parses and re-encodes the JSON breaks every signature, and breaks it in a way that
   * reads as a wrong secret.
   *
   * `/webhook` under billing's prefix, so `https://<instance>/api/billing/webhook` — which is the
   * URL `selfhost/.env.example` has been telling operators to give Stripe all along, and which
   * answered 404 because nothing was ever mounted here.
   *
   * No principal, no permission and no workspace: Stripe is not a Kern caller. The signature is the
   * authentication, and it is checked before anything touches the database.
   */
  httpRoutes: [
    {
      method: 'POST',
      path: '/webhook',
      raw: true,
      // Stripe's own limit for an event body; well under the server's 25 MB, and it means a body
      // that could not be a Stripe event is refused before it is buffered.
      bodyLimit: 1024 * 1024,
      handler: async ({ kernel, request, reply, body }) => {
        const signature = request.headers['stripe-signature']
        if (typeof signature !== 'string' || !signature)
          return reply.status(400).send({ error: 'Missing the stripe-signature header' })
        try {
          const result = await stripeSvc.handleWebhook(kernel, body as Buffer, signature)
          return { received: true, ...result }
        } catch (err) {
          // A 4xx tells Stripe to stop retrying, so only the two failures a retry cannot fix get
          // one: a body that is not from Stripe, and an instance with no webhook secret. Anything
          // else — the database being down, the bus being unreachable — is 500 on purpose, because
          // Stripe retrying for three days is exactly what should happen to an event we dropped.
          if (err instanceof KernError && (err.code === 'BAD_REQUEST' || err.code === 'CONFLICT')) {
            kernel.log.warn({ err: err.message }, 'billing: refused a Stripe webhook')
            return reply.status(httpStatusFor(err.code)).send({ error: err.message })
          }
          /**
           * 500, set explicitly, and never by rethrowing.
           *
           * Fastify answers a thrown error with that error's own `statusCode`, and a Stripe SDK
           * error carries the status *Stripe's API* returned — so a `StripeInvalidRequestError` from
           * `subscriptions.retrieve` came back to Stripe as **404**. Stripe reads 4xx as "delivered,
           * do not send this again" and stops retrying, which loses the event permanently: the same
           * failure the claim-and-release above exists to prevent, arriving by a different door.
           * Caught by a test that made the retrieve fail and asserted the status.
           *
           * The message is not passed on either. Stripe does not read it, and it is the internals of
           * this instance.
           */
          kernel.log.error({ err: String(err) }, 'billing: a Stripe webhook failed; Stripe will retry')
          return reply.status(500).send({ error: 'The webhook could not be applied' })
        }
      },
    },
  ],

  /**
   * Seed the catalogue before anything reads it, then refuse to start an instance that sells
   * subscriptions and has no default plan to sell — see `services/catalogue.ts` for why one of
   * those two conditions throws and the other only shouts.
   */
  onBoot: async (kernel: Kernel) => {
    await seedPlansFromFile(kernel)
    await assertDefaultPlan(kernel)
  },

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
      const plan = await plansSvc.bySlug(kernel, slug)
      if (!plan) {
        const message = `billing: KERN_DEFAULT_PLAN_SLUG names "${slug}", which is not a plan on this instance`
        // On an instance that takes payments this is not a warning, it is a workspace being handed
        // the whole product for nothing — so it throws, the bus retries, and the workspace picks up
        // its subscription as soon as the plan exists. An instance with no Stripe key is a
        // self-hosted Kern, where unlimited is the intended answer and nothing should fail.
        if (stripeSvc.paymentsEnabled()) {
          kernel.log.error({ slug, workspaceId: p.workspaceId }, message)
          throw KernError.conflict(message, 'billing.plan.default_missing')
        }
        kernel.log.warn({ slug }, message)
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
      /**
       * End a trial that nobody ever put a card behind.
       *
       * Signup writes `status: 'trialing'` with a `trialEndsAt` and — until this job existed —
       * absolutely nothing read that column again. `trialing` is an entitled status, so every
       * workspace that ever signed up stayed on the trial plan for ever, free, with no card.
       *
       * A trial with a `stripeSubscriptionId` behind it is **not** this job's business: Stripe owns
       * that clock and says what happened to it through `customer.subscription.updated`. Expiring
       * it here would race Stripe and suspend a workspace whose card was about to be charged.
       */
      name: 'billing.expire-trials',
      cron: '23 * * * *',
      handler: async (_input: unknown, { kernel }: { kernel: Kernel }) => {
        const due = await kernel.database.db
          .select({ workspaceId: subscriptions.workspaceId })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.status, 'trialing'),
              isNotNull(subscriptions.trialEndsAt),
              lte(subscriptions.trialEndsAt, new Date()),
              isNull(subscriptions.stripeSubscriptionId),
            ),
          )
        for (const row of due) {
          // Suspended, not cancelled: the workspace is read-only and everything in it survives, so
          // paying — or an admin extending the trial — brings it straight back. See ADR 0003 §6.
          await subsSvc.upsert(kernel, row.workspaceId, { status: 'suspended', graceEndsAt: null })
          await kernel.emit(
            billingEvents.subscriptionSuspended,
            {
              workspaceId: row.workspaceId as WorkspaceId,
              reason: 'the trial ended and no subscription was started',
            },
            { workspaceId: row.workspaceId },
          )
          kernel.log.info({ workspaceId: row.workspaceId }, 'billing: trial ended, workspace suspended')
        }
      },
    },
    {
      name: 'billing.close-grace-periods',
      cron: '7 * * * *',
      handler: async (_input: unknown, { kernel }: { kernel: Kernel }) => {
        /**
         * A `past_due` row with no clock cannot be closed by the query below, so it would stay
         * entitled for ever. That is how every row written before the grace period stopped being
         * wiped by `customer.subscription.updated` looks, and starting the clock here is what lets
         * those rows reach a decision instead of sitting past due indefinitely.
         */
        const started = await kernel.database.db
          .update(subscriptions)
          .set({ graceEndsAt: stripeSvc.graceFrom(), updatedAt: new Date() })
          .where(and(eq(subscriptions.status, 'past_due'), isNull(subscriptions.graceEndsAt)))
          .returning({ workspaceId: subscriptions.workspaceId })
        if (started.length)
          kernel.log.warn(
            { workspaces: started.map((r) => r.workspaceId) },
            'billing: found past-due workspaces with no grace period and started one',
          )

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
