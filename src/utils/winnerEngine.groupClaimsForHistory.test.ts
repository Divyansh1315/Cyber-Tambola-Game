import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { groupClaimsForHistory } from './winnerEngine'
import { claimsListArb } from './winnerEngine.sortClaimsForInbox.test'

const RUNS = 100

describe('winnerEngine.groupClaimsForHistory', () => {
  // Feature: module-5-prize-claim-processing-winner-management, Property 5: Claim history grouping is a lossless, non-overlapping partition
  it('property 5: every claim appears in exactly one of pending/confirmed/rejectedOrInvalid, none dropped or duplicated', () => {
    fc.assert(
      fc.property(claimsListArb, (claims) => {
        const { pending, confirmed, rejectedOrInvalid } =
          groupClaimsForHistory(claims)

        // Lossless: concatenation is a permutation of the input.
        const concatenated = [...pending, ...confirmed, ...rejectedOrInvalid]
        expect(concatenated).toHaveLength(claims.length)
        expect([...concatenated].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
          [...claims].sort((a, b) => a.id.localeCompare(b.id)),
        )

        // Non-overlapping: no claim id appears in more than one group.
        const pendingIds = new Set(pending.map((c) => c.id))
        const confirmedIds = new Set(confirmed.map((c) => c.id))
        const rejectedOrInvalidIds = new Set(rejectedOrInvalid.map((c) => c.id))
        for (const id of pendingIds) {
          expect(confirmedIds.has(id)).toBe(false)
          expect(rejectedOrInvalidIds.has(id)).toBe(false)
        }
        for (const id of confirmedIds) {
          expect(rejectedOrInvalidIds.has(id)).toBe(false)
        }

        // Placement rule: rejectedOrInvalid iff INVALID or REJECTED.
        for (const claim of rejectedOrInvalid) {
          expect(
            claim.validationStatus === 'INVALID' || claim.hostDecision === 'REJECTED',
          ).toBe(true)
        }
        for (const claim of confirmed) {
          expect(claim.hostDecision).toBe('CONFIRMED')
          expect(claim.validationStatus).not.toBe('INVALID')
        }
        for (const claim of pending) {
          expect(claim.hostDecision).not.toBe('CONFIRMED')
          expect(claim.hostDecision).not.toBe('REJECTED')
          expect(claim.validationStatus).not.toBe('INVALID')
        }

        // Every original claim lands in the group implied by the rule.
        for (const claim of claims) {
          if (claim.validationStatus === 'INVALID' || claim.hostDecision === 'REJECTED') {
            expect(rejectedOrInvalidIds.has(claim.id)).toBe(true)
          } else if (claim.hostDecision === 'CONFIRMED') {
            expect(confirmedIds.has(claim.id)).toBe(true)
          } else {
            expect(pendingIds.has(claim.id)).toBe(true)
          }
        }
      }),
      { numRuns: RUNS },
    )
  })

  // Feature: module-5-prize-claim-processing-winner-management, Property 5: Claim history grouping is a lossless, non-overlapping partition
  it('property 5: never mutates the input array', () => {
    fc.assert(
      fc.property(claimsListArb, (claims) => {
        const original = [...claims]
        groupClaimsForHistory(claims)
        expect(claims).toEqual(original)
      }),
      { numRuns: RUNS },
    )
  })
})
