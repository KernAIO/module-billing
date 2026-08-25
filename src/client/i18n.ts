/**
 * Billing's own strings, in every locale the platform ships.
 *
 * A module ships separately from the app, so Paraglide cannot compile these — the shell merges
 * them into the framework's message runtime when it registers this module, and `t()` resolves
 * against the merged map. Keys are namespaced by module id, which is what keeps two modules from
 * colliding in that one map.
 *
 * Bundles are thunks so a locale is only fetched when it is the one in use; English is the
 * fallback and is therefore always loaded.
 */
import { type Message, scopedT } from '@kernhq/ui'

export const en: Record<string, Message> = {}

export type BillingMessageKey = keyof typeof en

const ar: Record<string, Message> = {}

const de: Record<string, Message> = {}

const fa: Record<string, Message> = {}

const tr: Record<string, Message> = {}

/** In the shape `defineClientModule().messages` expects. */
export const billingMessageBundles = {
  ar: async () => ar,
  de: async () => de,
  en: async () => en,
  fa: async () => fa,
  tr: async () => tr,
}

/** `t('settings_nav')` — the module id is implied. */
export const t = scopedT('billing')
