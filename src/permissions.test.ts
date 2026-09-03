/**
 * The billing permission matrix, blessed rather than assumed.
 *
 * Two keys. Seeing the subscription is an admin's job; changing it — the plan, the seats, the
 * card — is the owner's alone, because it is the one screen in the product that spends money. Rows
 * list the *effective* grants, cascade included: the kernel expands declared `defaultRoles` upward
 * through guest ⊆ member ⊆ admin ⊆ owner, and `permissionMatrixDiff` applies the same expansion.
 *
 * Changing a default is meant to be deliberate: edit `defaultRoles` → this fails naming every row
 * that moved → confirm that is what you meant → update `BLESSED` in the same commit.
 */
import { permissionMatrixDiff } from '@kernhq/testing'
import { describe, expect, it } from 'vitest'
import { billingPermissions } from './contract.js'

/** Every built-in role that holds the permission by default, lowest role first. */
const BLESSED: Record<string, readonly string[]> = {
  'billing.subscription.view': ['admin', 'owner'],
  'billing.subscription.manage': ['owner'],
}

/** It spends money. */
const DANGEROUS = ['billing.subscription.manage']

describe('billing permissions', () => {
  it('grants each permission to exactly the blessed roles', () => {
    expect(permissionMatrixDiff(billingPermissions, BLESSED)).toEqual([])
  })

  it('namespaces every key under the module id and declares it once', () => {
    const keys = billingPermissions.map((p) => p.key)
    expect(keys.filter((key) => !key.startsWith('billing.'))).toEqual([])
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([])
  })

  it('marks exactly the destructive permissions dangerous', () => {
    const flagged = billingPermissions.filter((p) => p.dangerous).map((p) => p.key)
    expect(flagged.toSorted()).toEqual(DANGEROUS.toSorted())
  })

  it('keeps the owner as the only role that can change what the workspace pays for', () => {
    expect(BLESSED['billing.subscription.manage']).toEqual(['owner'])
  })
})
