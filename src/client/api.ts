import { createModuleClient, type KernClientOptions } from '@kernhq/sdk'
import type { ContractRouterClient } from '@orpc/contract'
import type { BillingContract } from '../contract.js'

/**
 * Typed oRPC client for `/api/billing` (see `../contract`).
 *
 * The shape is generated from the contract, so every procedure, input and output stays in step with
 * the server without a second declaration: if the contract changes, callers stop compiling.
 */
export type BillingApi = ContractRouterClient<BillingContract>

export function createBillingClient(opts: KernClientOptions): BillingApi {
  return createModuleClient<BillingApi>(opts, 'billing')
}
