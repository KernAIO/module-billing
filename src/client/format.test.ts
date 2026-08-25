import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatMoney,
  isEntitled,
  planBlockedReason,
  trialDaysLeft,
  usageRatio,
} from './format.js'

describe('formatMoney', () => {
  it('shows a whole-unit price without decimals and a part-unit one with them', () => {
    expect(formatMoney(800, 'usd')).toBe('$8')
    expect(formatMoney(1650, 'usd')).toBe('$16.50')
  })
})

describe('formatBytes', () => {
  it('climbs binary units and keeps one decimal only where it means something', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(53_687_091_200)).toBe('50 GB')
  })
})

describe('usageRatio', () => {
  it('has no ratio when there is no limit', () => {
    expect(usageRatio(10, null)).toBeNull()
  })
  it('clamps at one so being over a limit can still be drawn', () => {
    expect(usageRatio(5, 10)).toBe(0.5)
    expect(usageRatio(30, 10)).toBe(1)
  })
})

describe('planBlockedReason', () => {
  it('names the reason a smaller plan cannot be chosen, rather than returning false', () => {
    expect(planBlockedReason({ limits: { seats: 3 } }, { seats: 5 })).toBe('seats')
    expect(planBlockedReason({ limits: { seats: 10 } }, { seats: 5 })).toBeNull()
    expect(planBlockedReason({ limits: { seats: null } }, { seats: 5000 })).toBeNull()
  })
})

describe('isEntitled', () => {
  it('keeps a past-due workspace working and stops a suspended one', () => {
    expect(isEntitled('trialing')).toBe(true)
    expect(isEntitled('active')).toBe(true)
    expect(isEntitled('past_due')).toBe(true)
    expect(isEntitled('suspended')).toBe(false)
    expect(isEntitled('canceled')).toBe(false)
    expect(isEntitled(null)).toBe(false)
  })
})

describe('trialDaysLeft', () => {
  const now = new Date('2026-08-23T12:00:00Z')
  it('rounds up, floors at zero, and is null when no trial is running', () => {
    expect(trialDaysLeft(null, now)).toBeNull()
    expect(trialDaysLeft('2026-08-25T12:00:00Z', now)).toBe(2)
    expect(trialDaysLeft('2026-08-25T13:00:00Z', now)).toBe(3)
    expect(trialDaysLeft('2026-08-01T12:00:00Z', now)).toBe(0)
  })
})
