import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { sortClaimsForInbox } from './winnerEngine'
import type { PrizeClaim, HostDecision, ValidationStatus } from '../types/claim'
import type { PrizeId } from '../types/prize'

const RUNS = 100

// Shared claims-list generator: random hostDecision/validationStatus/submittedAt
// combinations, reused by winnerEngine.groupClaimsForHistory.test.ts.

const hostDecisionArb: fc.Arbitrary<HostDecision> = fc.constantFrom(
  'PENDING',
  'CONFIRMED',
  'REJECTED',
)

const validationStatusArb: fc.Arbitrary<ValidationStatus> = fc.constantFrom(
  'PENDING',
  'VALID',
  'INVALID',
)

const prizeIdArb: fc.Arbitrary<PrizeId> = fc.constantFrom(
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
)

// Submission timestamps as small integers turned into distinguishable ISO
// strings, so ordering is easy to reason about and ties are exercised too.
const submittedAtArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 50 })
  .map((n) => new Date(2024, 0, 1, 0, 0, n).toISOString())

const claimArb: fc.Arbitrary<PrizeClaim> = fc
  .record({
    id: fc.uuid(),
    gameId: fc.constant('game-1'),
    playerId: fc.string({ minLength: 1, maxLength: 8 }),
    ticketId: fc.string({ minLength: 1, maxLength: 8 }),
    prizeId: prizeIdArb,
    submittedAt: submittedAtArb,
    validationStatus: validationStatusArb,
    hostDecision: hostDecisionArb,
    prizeLabel: fc.constant('Prize'),
    playerName: fc.constant('Player'),
    ticketRef: fc.constant('Ticket #TEST'),
  })

export const claimsListArb: fc.Arbitrary<PrizeClaim[]> = fc.array(claimArb, {
  minLength: 0,
  maxLength: 30,
})

describe('winnerEngine.sortClaimsForInbox', () => {
  // Feature: module-5-prize-claim-processing-winner-management, Property 4: Claim inbox sorting is PENDING-first, then submission-time ascending
  it('property 4: PENDING claims all precede non-PENDING claims, and each group is sorted by submittedAt ascending', () => {
    fc.assert(
      fc.property(claimsListArb, (claims) => {
        const sorted = sortClaimsForInbox(claims)

        // Same multiset of claims — a permutation, nothing added/removed.
        expect(sorted).toHaveLength(claims.length)
        expect([...sorted].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
          [...claims].sort((a, b) => a.id.localeCompare(b.id)),
        )

        // Every PENDING claim appears before every non-PENDING claim.
        const firstNonPendingIndex = sorted.findIndex(
          (c) => c.hostDecision !== 'PENDING',
        )
        if (firstNonPendingIndex !== -1) {
          for (let i = 0; i < firstNonPendingIndex; i++) {
            expect(sorted[i].hostDecision).toBe('PENDING')
          }
          for (let i = firstNonPendingIndex; i < sorted.length; i++) {
            expect(sorted[i].hostDecision).not.toBe('PENDING')
          }
        }

        // Within the PENDING group, submittedAt is non-decreasing.
        const pendingGroup = sorted.filter((c) => c.hostDecision === 'PENDING')
        for (let i = 1; i < pendingGroup.length; i++) {
          expect(
            pendingGroup[i - 1].submittedAt <= pendingGroup[i].submittedAt,
          ).toBe(true)
        }

        // Within the non-PENDING group, submittedAt is non-decreasing.
        const otherGroup = sorted.filter((c) => c.hostDecision !== 'PENDING')
        for (let i = 1; i < otherGroup.length; i++) {
          expect(otherGroup[i - 1].submittedAt <= otherGroup[i].submittedAt).toBe(
            true,
          )
        }
      }),
      { numRuns: RUNS },
    )
  })

  // Feature: module-5-prize-claim-processing-winner-management, Property 4: Claim inbox sorting is PENDING-first, then submission-time ascending
  it('property 4: never mutates the input array', () => {
    fc.assert(
      fc.property(claimsListArb, (claims) => {
        const original = [...claims]
        sortClaimsForInbox(claims)
        expect(claims).toEqual(original)
      }),
      { numRuns: RUNS },
    )
  })
})
