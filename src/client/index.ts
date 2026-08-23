/**
 * What the app imports from this package: the contract's types, the permission keys, and the pure
 * functions a billing screen needs. The Svelte module manifest itself lives in the app
 * (`src/lib/modules/billing/client.ts`), because that is where the route components are.
 */

export {
  type AdminWorkspaceRow,
  BILLING_PERMISSIONS,
  type BillingInterval,
  billingContract,
  type Invoice,
  MODULE_ID,
  type Plan,
  PlanLimits,
  type PublicPlan,
  type Subscription,
  type SubscriptionStatus,
  type Usage,
  type WorkspaceBilling,
} from '../contract.js'
export { type BillingApi, createBillingClient } from './api.js'

/** Money, in the currency's smallest unit, rendered for a locale. */
export function formatMoney(minor: number, currency: string, locale = 'en'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    // whole units read better on a pricing table, and Kern's plans are whole units
    minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100)
}

/** Bytes as something a person reads, in binary units. */
export function formatBytes(bytes: number, locale = 'en'): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: n < 10 && i > 0 ? 1 : 0 }).format(n)} ${units[i]}`
}

/**
 * How full a limit is, 0–1, or `null` when there is no limit.
 * Clamped at 1 so a workspace that is over its limit renders a full bar rather than an overflowing
 * one — being over is a state the interface has to be able to draw.
 */
export function usageRatio(used: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null
  return Math.min(1, used / limit)
}

/**
 * Why a plan cannot be chosen right now, or `null` when it can.
 *
 * Returned as a reason rather than a boolean so the interface can *say* why the control is disabled.
 * A disabled control with no explanation is a bug.
 */
export function planBlockedReason(
  plan: { limits: { seats: number | null } },
  current: { seats: number },
): 'seats' | null {
  if (plan.limits.seats !== null && current.seats > plan.limits.seats) return 'seats'
  return null
}

/** Whether a subscription still entitles the workspace to its plan. */
export function isEntitled(status: string | null): boolean {
  return status === 'trialing' || status === 'active' || status === 'past_due'
}

/** Days left of a trial, or `null` when there is no trial running. */
export function trialDaysLeft(trialEndsAt: string | null, now = new Date()): number | null {
  if (!trialEndsAt) return null
  const ms = new Date(trialEndsAt).getTime() - now.getTime()
  if (ms <= 0) return 0
  return Math.ceil(ms / 86_400_000)
}
