import type { Kernel } from '@kernhq/kernel'
import { eq, sql } from 'drizzle-orm'
import { workspaceUsage } from '../schema.js'

/** What core reports when asked to recount a workspace from its own tables. */
export interface CountedUsage {
  seats: number
  storageBytes: number
}

/** Ensure a usage row exists, so the counters below can be plain arithmetic. */
async function ensureRow(kernel: Kernel, workspaceId: string): Promise<void> {
  await kernel.database.db
    .insert(workspaceUsage)
    .values({ workspaceId, seats: 0, storageBytes: 0 })
    .onConflictDoNothing()
}

/**
 * Move a counter by a delta.
 *
 * Arithmetic in SQL rather than read-modify-write in JavaScript: two members joining at once is the
 * normal case, not a rare one, and the read-modify-write version loses one of them.
 * `greatest(0, …)` because a counter that has drifted negative is a bug that must not also start
 * refusing uploads — the nightly reconcile is what corrects it.
 */
export async function bump(kernel: Kernel, workspaceId: string, delta: Partial<CountedUsage>): Promise<void> {
  await ensureRow(kernel, workspaceId)
  await kernel.database.db
    .update(workspaceUsage)
    .set({
      ...(delta.seats !== undefined
        ? { seats: sql`greatest(0, ${workspaceUsage.seats} + ${delta.seats})` }
        : {}),
      ...(delta.storageBytes !== undefined
        ? { storageBytes: sql`greatest(0, ${workspaceUsage.storageBytes} + ${delta.storageBytes})` }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(workspaceUsage.workspaceId, workspaceId))
}

/**
 * Recount seats for one workspace and write the answer down.
 *
 * Seats are recounted rather than moved by a delta, because the events do not carry enough to do the
 * arithmetic safely: `core.member.removed` does not say what role the person had, and
 * `core.member.updated` does not say what role they had *before* — so a guest being promoted, or a
 * member leaving, would each be counted wrongly. A count over one workspace's memberships is cheap;
 * being wrong about what a customer is charged is not.
 */
export async function recountSeats(kernel: Kernel, workspaceId: string): Promise<number> {
  const { seats } = await kernel.call<{ seats: number }>('core.workspaces.seats', { workspaceId })
  await ensureRow(kernel, workspaceId)
  await kernel.database.db
    .update(workspaceUsage)
    .set({ seats, updatedAt: new Date() })
    .where(eq(workspaceUsage.workspaceId, workspaceId))
  return seats
}

export async function read(kernel: Kernel, workspaceId: string): Promise<CountedUsage & { updatedAt: Date }> {
  const [row] = await kernel.database.db
    .select()
    .from(workspaceUsage)
    .where(eq(workspaceUsage.workspaceId, workspaceId))
    .limit(1)
  return {
    seats: row?.seats ?? 0,
    storageBytes: row?.storageBytes ?? 0,
    updatedAt: row?.updatedAt ?? new Date(0),
  }
}

/**
 * Recount one workspace from core's own tables and write the answer down.
 *
 * Returns the drift it found. The caller logs it rather than swallowing it: a counter that keeps
 * needing correction means an event is being missed somewhere, and silently fixing the number every
 * night is how that goes unnoticed for a year.
 */
export async function reconcile(
  kernel: Kernel,
  workspaceId: string,
): Promise<{ drift: CountedUsage; counted: CountedUsage }> {
  const counted = await kernel.call<CountedUsage>('core.workspaces.usage', { workspaceId })
  const before = await read(kernel, workspaceId)
  await kernel.database.db
    .insert(workspaceUsage)
    .values({
      workspaceId,
      seats: counted.seats,
      storageBytes: counted.storageBytes,
      reconciledAt: new Date(),
    })
    .onConflictDoUpdate({
      target: workspaceUsage.workspaceId,
      set: {
        seats: counted.seats,
        storageBytes: counted.storageBytes,
        reconciledAt: new Date(),
        updatedAt: new Date(),
      },
    })
  return {
    counted,
    drift: {
      seats: counted.seats - before.seats,
      storageBytes: counted.storageBytes - before.storageBytes,
    },
  }
}
