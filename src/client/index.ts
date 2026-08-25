/**
 * Billing's client half: the contract's types, the permission keys, the pure functions its screens
 * need, its own strings, and the client module the shell registers.
 *
 * The screens live here too — the workspace plan page and the two instance console pages — rather
 * than in the app. The shell mounts whatever the manifest declares, so deleting this package removes
 * the feature completely.
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
export { __setBillingApi, getBillingApi } from './api-instance.js'
export {
  formatBytes,
  formatMoney,
  isEntitled,
  planBlockedReason,
  trialDaysLeft,
  usageRatio,
} from './format.js'
export { type BillingMessageKey, billingMessageBundles, t } from './i18n.js'
export { billingClientModule, billingClientModule as default } from './module.js'
