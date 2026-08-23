import type { Entitlement, Kernel } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import { PlanLimits, PlanLimitsPatch, type SubscriptionStatus } from '../../contract.js'
import { overrides, plans, subscriptions } from '../schema.js'

/**
 * Statuses that still entitle a workspace to its plan.
 *
 * `past_due` is deliberately in the list: a card that failed this morning must not lock a team out
 * of their work the same afternoon. The grace period is what ends, and ending it moves the row to
 * `suspended` — which is not here, and which makes writes fail while reads keep working.
 */
const ENTITLED: ReadonlySet<string> = new Set<SubscriptionStatus>(['trialing', 'active', 'past_due'])

/** Statuses where the workspace may read but not write. */
const INACTIVE: ReadonlySet<string> = new Set<SubscriptionStatus>(['suspended', 'canceled'])

/**
 * What a workspace is allowed to do, resolved from its plan and any override an admin has set.
 *
 * The result is exactly the shape `kernel.entitlements` expects, because this is the procedure the
 * kernel calls. Anything this function cannot answer — no subscription row, no plan, an unparseable
 * limits blob — resolves to *unlimited* rather than to nothing. A billing bug must not be able to
 * lock a paying customer out of their own workspace; the failure has to fall open.
 */
/** Drop the keys a patch does not mention, so a spread cannot overwrite with `undefined`. */
function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>
}

export async function resolve(kernel: Kernel, workspaceId: string): Promise<Partial<Entitlement>> {
  const db = kernel.database.db
  const [row] = await db
    .select({
      status: subscriptions.status,
      planName: plans.name,
      limits: plans.limits,
    })
    .from(subscriptions)
    .leftJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.workspaceId, workspaceId))
    .limit(1)

  // Nothing bills this workspace — a self-hosted instance, or one where the admin has not assigned
  // a plan. Unlimited, and silent about it.
  if (!row) return { planName: null, active: true }

  const parsed = PlanLimits.safeParse(row.limits ?? {})
  if (!parsed.success)
    kernel.log.warn(
      { workspaceId, issues: parsed.error.issues.length },
      'billing: plan limits did not parse; treating the workspace as unlimited',
    )
  const base = parsed.success ? parsed.data : PlanLimits.parse({})

  const [ovr] = await db
    .select({ limits: overrides.limits })
    .from(overrides)
    .where(eq(overrides.workspaceId, workspaceId))
    .limit(1)

  // An override is a patch over the plan, so comping one limit does not silently reset the others to
  // a default the admin never chose — which means dropping the keys the patch does not mention
  // rather than spreading them as `undefined`.
  const patch = ovr?.limits ? definedOnly(PlanLimitsPatch.parse(ovr.limits)) : null
  const merged = patch
    ? { ...base, ...patch }
    : ENTITLED.has(row.status)
      ? base
      : // Not entitled: the plan's allowances do not apply, but nothing is taken away that would
        // stop the customer reading and exporting what is theirs.
        PlanLimits.parse({})

  return {
    ...merged,
    planName: row.planName ?? null,
    active: !INACTIVE.has(row.status),
  }
}
