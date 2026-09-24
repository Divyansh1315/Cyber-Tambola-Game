// Feature: module-5-prize-claim-processing-winner-management, Property 6: A confirm action is permitted exactly when the claim is valid, pending, and its prize is open
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { canConfirmClaim, isPrizeClosed } from './winnerEngine'
import type { HostDecision, PrizeClaim, PrizeId, ValidationStatus, Winner } from '../types/prize'

const prizeIdArb: fc.Arbitrary<PrizeId> = fc.constantFrom(
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
)

const validationStatusArb: fc.Arbitrary<ValidationStatus> = fc.constantFrom(
  'PENDING',
  'VALID',
  'INVALID',
)

const hostDecisionArb: fc.Arbitrary<HostDecision> = fc.constantFrom(
  'PENDING',
  'CONFIRMED',
  'REJECTED',
)

const claimArb: fc.Arbitrary<PrizeClaim> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: fc.string({ minLength: 1, maxLength: 8 }),
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  prizeId: prizeIdArb,
  submittedAt: fc.constant('2026-01-01T00:00:00.000Z'),
  validationStatus: validationStatusArb,
  hostDecision: hostDecisionArb,
  prizeLabel: fc.string({ minLength: 1, maxLength: 10 }),
  playerName: fc.string({ minLength: 1, maxLength: 10 }),
  ticketRef: fc.string({ minLength: 1, maxLength: 10 }),
})

const winnerArb: fc.Arbitrary<Winner> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: fc.string({ minLength: 1, maxLength: 8 }),
  prizeId: prizeIdArb,
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  claimId: fc.string({ minLength: 1, maxLength: 10 }),
  confirmedAt: fc.constant('2026-01-01T00:00:00.000Z'),
  prizeLabel: fc.string({ minLength: 1, maxLength: 10 }),
  playerName: fc.string({ minLength: 1, maxLength: 10 }),
})

const winnersArb = fc.array(winnerArb, { maxLength: 6 })

describe('canConfirmClaim (property 6)', () => {
  it('returns true iff validationStatus is VALID, hostDecision is PENDING, and the prize is open', () => {
    fc.assert(
      fc.property(claimArb, winnersArb, (claim, winners) => {
        const expected =
          claim.validationStatus === 'VALID' &&
          claim.hostDecision === 'PENDING' &&
          !isPrizeClosed(winners, claim.gameId, claim.prizeId)
        expect(canConfirmClaim(claim, winners)).toBe(expected)
      }),
      { numRuns: 100 },
    )
  })

  it('never returns true for a non-VALID or non-PENDING claim, regardless of winners', () => {
    fc.assert(
      fc.property(claimArb, winnersArb, (claim, winners) => {
        fc.pre(claim.validationStatus !== 'VALID' || claim.hostDecision !== 'PENDING')
        expect(canConfirmClaim(claim, winners)).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  it('never returns true once a Winner exists for that claim\'s (gameId, prizeId)', () => {
    fc.assert(
      fc.property(claimArb, winnerArb, (claim, winnerTemplate) => {
        const closingWinner: Winner = {
          ...winnerTemplate,
          gameId: claim.gameId,
          prizeId: claim.prizeId,
        }
        expect(canConfirmClaim(claim, [closingWinner])).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  it('returns true for a VALID/PENDING claim whose prize has no matching winner', () => {
    fc.assert(
      fc.property(claimArb, winnersArb, (claim, winners) => {
        const validClaim: PrizeClaim = { ...claim, validationStatus: 'VALID', hostDecision: 'PENDING' }
        const unrelatedWinners = winners.filter(
          (w) => !(w.gameId === validClaim.gameId && w.prizeId === validClaim.prizeId),
        )
        expect(canConfirmClaim(validClaim, unrelatedWinners)).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('does not mutate its inputs', () => {
    fc.assert(
      fc.property(claimArb, winnersArb, (claim, winners) => {
        const claimSnapshot = JSON.stringify(claim)
        const winnersSnapshot = JSON.stringify(winners)
        Object.freeze(claim)
        Object.freeze(winners)
        canConfirmClaim(claim, winners)
        expect(JSON.stringify(claim)).toBe(claimSnapshot)
        expect(JSON.stringify(winners)).toBe(winnersSnapshot)
      }),
      { numRuns: 100 },
    )
  })
})
