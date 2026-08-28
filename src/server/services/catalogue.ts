import { readFile } from 'node:fs/promises'
import type { Kernel } from '@kernhq/kernel'
import { z } from 'zod'
import { UpsertPlan } from '../../contract.js'
import * as plans from './plans.js'
import { paymentsEnabled } from './stripe.js'

/**
 * Getting the plan catalogue onto an instance, and refusing to pretend one is there when it is not.
 *
 * Both halves exist for the same failure: a new workspace whose default plan is missing gets **no
 * subscription row at all**, and no row resolves to *unlimited* — which is the right answer for
 * every self-hosted Kern and exactly the wrong one for an instance that takes money. The only
 * signal used to be a `warn` nobody reads, so a Kern Cloud one typo away from giving everything
 * away looked completely healthy.
 */

/** The file `KERN_PLANS_FILE` points at: a JSON array of plans, in the shape the admin console writes. */
const PlansFile = z.array(UpsertPlan)

/**
 * Create any plan in `KERN_PLANS_FILE` whose slug this instance does not have yet.
 *
 * **Create, never update.** A plan is data an instance admin edits — prices, limits, what the
 * pricing page says — and an image that rewrote the catalogue on every boot would silently revert
 * their work at the next deploy. So a slug that already exists is left exactly as it is, and the
 * file is only ever the answer to "a fresh instance has no plans at all".
 *
 * Returns the slugs it created, so the boot log says what happened rather than that something did.
 */
export async function seedPlansFromFile(kernel: Kernel): Promise<string[]> {
  const path = process.env.KERN_PLANS_FILE
  if (!path) return []

  let parsed: z.infer<typeof PlansFile>
  try {
    parsed = PlansFile.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (err) {
    // Loud, and not fatal: an unreadable seed file must not take down a service that is otherwise
    // configured, and the boot check below is what refuses when the result is actually unusable.
    kernel.log.error(
      { err: String(err), path },
      'billing: KERN_PLANS_FILE could not be read as a list of plans; no plan was seeded',
    )
    return []
  }

  const created: string[] = []
  for (const plan of parsed) {
    if (await plans.bySlug(kernel, plan.slug)) continue
    // `id` is dropped: the file describes a catalogue, not this database's primary keys, and two
    // instances seeded from one file must not be told they share a row.
    const { id: _ignored, ...rest } = plan
    await plans.upsert(kernel, rest)
    created.push(plan.slug)
  }
  if (created.length) kernel.log.info({ created, path }, 'billing: seeded plans from KERN_PLANS_FILE')
  return created
}

/**
 * Refuse to start, or say loudly why every new workspace is about to be unlimited.
 *
 * Two conditions, and they are not equally recoverable:
 *
 * - **No `KERN_DEFAULT_PLAN_SLUG` on an instance with a Stripe key.** Pure configuration, fixable
 *   in the environment without the service running, and it means every single signup is unlimited.
 *   That one throws.
 * - **A slug naming a plan that does not exist.** Also wrong, and it is what a brand-new instance
 *   looks like for as long as it takes somebody to create the plan — so refusing here would lock
 *   the operator out of the console they need in order to fix it. That one is an `error` in the log
 *   and a refusal on the path that matters, which is `core.workspace.created`.
 *
 * An instance with no Stripe key is a self-hosted Kern: unlimited is the correct and intended
 * answer there, and nothing here fires.
 */
export async function assertDefaultPlan(kernel: Kernel): Promise<void> {
  if (!paymentsEnabled()) return
  const slug = process.env.KERN_DEFAULT_PLAN_SLUG
  if (!slug)
    throw new Error(
      'STRIPE_SECRET_KEY is set, so this instance sells subscriptions, but KERN_DEFAULT_PLAN_SLUG is ' +
        'empty. A workspace created without a plan has no subscription row, and no subscription row ' +
        'means unlimited seats, unlimited storage and SSO included — every signup would get the whole ' +
        'product for nothing.\n' +
        'Set KERN_DEFAULT_PLAN_SLUG to the slug of the plan new workspaces start on, or unset ' +
        'STRIPE_SECRET_KEY if this instance is not meant to take payments.',
    )
  if (!(await plans.bySlug(kernel, slug)))
    kernel.log.error(
      { slug },
      'billing: KERN_DEFAULT_PLAN_SLUG names a plan that does not exist, so every new workspace ' +
        'will be created without a subscription and resolve to unlimited. Create the plan in the ' +
        'instance console, seed it with KERN_PLANS_FILE, or point the variable at a plan that exists.',
    )
}
