import { getHost } from '@kernhq/ui'
import { type BillingApi, createBillingClient } from './index.js'
import { createMockBillingApi } from './mock.js'

/**
 * The billing API client.
 *
 * Billing is hosted by core, so `/api/billing` is the same origin and the same session cookie as
 * everything else. `PUBLIC_API_MOCK=1` swaps in the in-memory implementation from `./mock`, which
 * satisfies the same contract types, so no view has a second code path for demos and end-to-end
 * tests — with one deliberate hole: the demo's checkout and billing portal throw rather than
 * pretending, because the one thing a demo must never imply is that money moved.
 */
export type { BillingApi }

let cached: BillingApi | null = null

export function getBillingApi(): BillingApi {
  if (cached) return cached
  const host = getHost()
  if (host.isMock) {
    cached = createMockBillingApi()
    return cached
  }
  cached = createBillingClient({
    // The shell decides the origin. Same-origin in every real deployment — the dev server proxies
    // /api and the reverse proxy routes it in production — so this module never names a port.
    baseUrl: host.apiBaseUrl,
  })
  return cached
}

/** Test seam: lets tests install a fake without touching module state elsewhere. */
export function __setBillingApi(api: BillingApi | null) {
  cached = api
}
