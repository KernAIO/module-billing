import { KernError, type Kernel, uuidv7 } from '@kernhq/kernel'
import { and, asc, eq, isNull, ne } from 'drizzle-orm'
import { type Plan, PlanLimits, type PublicPlan, type UpsertPlan } from '../../contract.js'
import { plans } from '../schema.js'

type Row = typeof plans.$inferSelect

const ser = (r: Row): Plan => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  priceMinor: r.priceMinor,
  currency: r.currency,
  interval: r.interval as Plan['interval'],
  perSeat: r.perSeat,
  trialDays: r.trialDays,
  limits: PlanLimits.parse(r.limits ?? {}),
  stripePriceId: r.stripePriceId,
  highlights: (r.highlights as string[]) ?? [],
  published: r.published,
  order: r.order,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
})

/** What a stranger sees: published, unarchived, and nothing internal. */
const serPublic = (r: Row): PublicPlan => ({
  slug: r.slug,
  name: r.name,
  description: r.description,
  priceMinor: r.priceMinor,
  currency: r.currency,
  interval: r.interval as Plan['interval'],
  perSeat: r.perSeat,
  trialDays: r.trialDays,
  highlights: (r.highlights as string[]) ?? [],
  order: r.order,
  limits: PlanLimits.parse(r.limits ?? {}),
})

export async function list(kernel: Kernel, includeUnpublished: boolean): Promise<Plan[]> {
  const where = includeUnpublished
    ? isNull(plans.archivedAt)
    : and(isNull(plans.archivedAt), eq(plans.published, true))
  const rows = await kernel.database.db
    .select()
    .from(plans)
    .where(where)
    .orderBy(asc(plans.order), asc(plans.priceMinor))
  return rows.map(ser)
}

export async function publicList(kernel: Kernel): Promise<PublicPlan[]> {
  const rows = await kernel.database.db
    .select()
    .from(plans)
    .where(and(isNull(plans.archivedAt), eq(plans.published, true)))
    .orderBy(asc(plans.order), asc(plans.priceMinor))
  return rows.map(serPublic)
}

export async function bySlug(kernel: Kernel, slug: string): Promise<Plan | null> {
  const [row] = await kernel.database.db.select().from(plans).where(eq(plans.slug, slug)).limit(1)
  return row ? ser(row) : null
}

export async function upsert(kernel: Kernel, input: UpsertPlan): Promise<Plan> {
  const db = kernel.database.db
  // A slug appears in URLs and in whatever the marketing site has cached, so two plans may never
  // share one — checked explicitly so the admin gets a sentence rather than a unique-violation.
  const [clash] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(input.id ? and(eq(plans.slug, input.slug), ne(plans.id, input.id)) : eq(plans.slug, input.slug))
    .limit(1)
  if (clash) throw KernError.conflict('Another plan already uses that slug', 'billing.plan.slug_taken')

  const values = {
    slug: input.slug,
    name: input.name,
    description: input.description,
    priceMinor: input.priceMinor,
    currency: input.currency,
    interval: input.interval,
    perSeat: input.perSeat,
    trialDays: input.trialDays,
    limits: PlanLimits.parse(input.limits),
    stripePriceId: input.stripePriceId,
    highlights: input.highlights,
    published: input.published,
    order: input.order,
    updatedAt: new Date(),
  }
  const [row] = input.id
    ? await db.update(plans).set(values).where(eq(plans.id, input.id)).returning()
    : await db
        .insert(plans)
        .values({ id: uuidv7(), ...values })
        .returning()
  if (!row) throw KernError.notFound('Plan')
  return ser(row)
}

export async function setPublished(kernel: Kernel, id: string, published: boolean): Promise<Plan> {
  const [row] = await kernel.database.db
    .update(plans)
    .set({ published, updatedAt: new Date() })
    .where(eq(plans.id, id))
    .returning()
  if (!row) throw KernError.notFound('Plan')
  return ser(row)
}

/**
 * Archiving withdraws a plan from the catalogue without deleting it: whoever is already on it stays
 * on it, and their subscription row keeps pointing at something that still resolves. Deleting the
 * row would leave those workspaces with a dangling `plan_id` and no limits at all.
 */
export async function archive(kernel: Kernel, id: string): Promise<void> {
  const [row] = await kernel.database.db
    .update(plans)
    .set({ archivedAt: new Date(), published: false, updatedAt: new Date() })
    .where(eq(plans.id, id))
    .returning({ id: plans.id })
  if (!row) throw KernError.notFound('Plan')
}

export { ser as serialisePlan, serPublic as serialisePublicPlan }
