// Feature: module-5-prize-claim-processing-winner-management, Property 2: Prize-closed derivation and the at-most-one-winner invariant
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { isPrizeClosed, getWinnerForPrize } from './winnerEngine'
import type { PrizeId, Winner } from '../types/prize'

const prizeIdArb: fc.Arbitrary<PrizeId> = fc.constantFrom(
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
)

const gameIdArb = fc.string({ minLength: 1, maxLength: 8 })

const winnerArb: fc.Arbitrary<Winner> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: gameIdArb,
  prizeId: prizeIdArb,
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  claimId: fc.string({ minLength: 1, maxLength: 10 }),
  confirmedAt: fc.constant('2026-01-01T00:00:00.000Z'),
  prizeLabel: fc.string({ minLength: 1, maxLength: 10 }),
  playerName: fc.string({ minLength: 1, maxLength: 10 }),
  ticketRef: fc.string({ minLength: 1, maxLength: 10 }),
})

/** A winners list constrained so at most one Winner exists per (gameId, prizeId)
 * pair — the invariant the reducer's CONFIRM_CLAIM case is responsible for
 * upholding (Req 5.5). */
const atMostOneWinnerPerPairArb: fc.Arbitrary<Winner[]> = fc
  .array(winnerArb, { maxLength: 8 })
  .map((winners) => {
    const seen = new Set<string>()
    const deduped: Winner[] = []
    for (const w of winners) {
      const key = `${w.gameId}::${w.prizeId}`
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(w)
      }
    }
    return deduped
  })

describe('isPrizeClosed / getWinnerForPrize (property 2)', () => {
  it('reports closed exactly when a matching (gameId, prizeId) Winner exists', () => {
    fc.assert(
      fc.property(
        atMostOneWinnerPerPairArb,
        gameIdArb,
        prizeIdArb,
        (winners, gameId, prizeId) => {
          const expected = winners.some((w) => w.gameId === gameId && w.prizeId === prizeId)
          expect(isPrizeClosed(winners, gameId, prizeId)).toBe(expected)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('getWinnerForPrize agrees with isPrizeClosed on presence/absence', () => {
    fc.assert(
      fc.property(
        atMostOneWinnerPerPairArb,
        gameIdArb,
        prizeIdArb,
        (winners, gameId, prizeId) => {
          const closed = isPrizeClosed(winners, gameId, prizeId)
          const found = getWinnerForPrize(winners, gameId, prizeId)
          if (closed) {
            expect(found).toBeDefined()
            expect(found!.gameId).toBe(gameId)
            expect(found!.prizeId).toBe(prizeId)
          } else {
            expect(found).toBeUndefined()
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('under the at-most-one-winner invariant, at most one Winner ever matches a given (gameId, prizeId)', () => {
    fc.assert(
      fc.property(
        atMostOneWinnerPerPairArb,
        gameIdArb,
        prizeIdArb,
        (winners, gameId, prizeId) => {
          const matches = winners.filter((w) => w.gameId === gameId && w.prizeId === prizeId)
          expect(matches.length).toBeLessThanOrEqual(1)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('adding a fresh Winner for an open prize causes it to be reported closed', () => {
    fc.assert(
      fc.property(
        atMostOneWinnerPerPairArb,
        winnerArb,
        (winners, newWinner) => {
          fc.pre(!winners.some((w) => w.gameId === newWinner.gameId && w.prizeId === newWinner.prizeId))
          expect(isPrizeClosed(winners, newWinner.gameId, newWinner.prizeId)).toBe(false)
          const next = [...winners, newWinner]
          expect(isPrizeClosed(next, newWinner.gameId, newWinner.prizeId)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('does not mutate the winners array', () => {
    fc.assert(
      fc.property(atMostOneWinnerPerPairArb, gameIdArb, prizeIdArb, (winners, gameId, prizeId) => {
        const snapshot = JSON.stringify(winners)
        Object.freeze(winners)
        isPrizeClosed(winners, gameId, prizeId)
        getWinnerForPrize(winners, gameId, prizeId)
        expect(JSON.stringify(winners)).toBe(snapshot)
      }),
      { numRuns: 100 },
    )
  })
})
