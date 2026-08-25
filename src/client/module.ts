import { defineClientModule } from '@kernhq/ui'
import { BILLING_PERMISSIONS } from '../contract.js'
import { billingMessageBundles, t } from './i18n.js'

/**
 * Billing as the shell sees it.
 *
 * No navigation: what a workspace pays is not somewhere people go, it is somewhere an owner goes
 * once a month. One workspace settings page for the customer, and two instance pages for whoever
 * runs the instance — which on a self-hosted Kern is the same person, and on Kern Cloud is us.
 *
 * The instance pages carry no `capability` and are not filtered on whether this workspace has
 * billing enabled: the console is not about a workspace, and an operator looking at what every
 * workspace is billed must still see the screen from a workspace that has it switched off.
 *
 * Labels are getters because a module is defined once at import time while the interface language
 * can change afterwards; reading them on render keeps them in the language actually chosen.
 */
export const billingClientModule = defineClientModule({
  id: 'billing',
  name: 'Billing',
  icon: 'credit-card',
  messages: billingMessageBundles,

  settingsPages: [
    {
      id: 'plan',
      get label() {
        return t('settings_nav')
      },
      icon: 'credit-card',
      scope: 'workspace',
      permission: BILLING_PERMISSIONS.view,
      order: 60,
      component: () => import('./settings/PlanSettings.svelte'),
    },
    {
      id: 'subscriptions',
      get label() {
        return t('admin_subscriptions_nav')
      },
      icon: 'credit-card',
      scope: 'instance',
      order: 20,
      component: () => import('./admin/SubscriptionsAdmin.svelte'),
    },
    {
      id: 'plans',
      get label() {
        return t('admin_plans_nav')
      },
      icon: 'tag',
      scope: 'instance',
      order: 30,
      component: () => import('./admin/PlansAdmin.svelte'),
    },
  ],
})

export default billingClientModule
