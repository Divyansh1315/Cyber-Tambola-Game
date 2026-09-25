// Feature: module-5-prize-claim-processing-winner-management, Property 15: Dismissing a winner announcement restores the exact live-game rendering
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { findLatestUndismissedWinner } from './PresentationView'
import type { PrizeId, Winner } from '../../types/prize'

const prizeIdArb: fc.Arbitrary<PrizeId> = fc.constantFrom(
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
)

const winnerArb: fc.Arbitrary<Winner> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: fc.string({ minLength: 1, maxLength: 10 }),
  prizeId: prizeIdArb,
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  claimId: fc.string({ minLength: 1, maxLength: 10 }),
  confirmedAt: fc.constant('2026-01-01T09:05:00.000Z'),
  prizeLabel: fc.string({ minLength: 1, maxLength: 10 }),
  playerName: fc.string({ minLength: 1, maxLength: 10 }),
  ticketRef: fc.string({ minLength: 1, maxLength: 10 }),
})

/** A winners list with unique ids, since winners are append-only records
 * each identified by a distinct id. */
const winnersArb: fc.Arbitrary<Winner[]> = fc
  .array(winnerArb, { maxLength: 8 })
  .map((winners) => {
    const seen = new Set<string>()
    const deduped: Winner[] = []
    for (const w of winners) {
      if (!seen.has(w.id)) {
        seen.add(w.id)
        deduped.push(w)
      }
    }
    return deduped
  })

describe('findLatestUndismissedWinner / dismiss-rendering equivalence (property 15)', () => {
  it('returns the last winner in the array when none are dismissed', () => {
    fc.assert(
      fc.property(winnersArb, (winners) => {
        const result = findLatestUndismissedWinner(winners, new Set())
        if (winners.length === 0) {
          expect(result).toBeUndefined()
        } else {
          expect(result).toEqual(winners[winners.length - 1])
        }
      }),
      { numRuns: 100 },
    )
  })

  it('dismissing the latest undismissed winner means it is never returned again', () => {
    fc.assert(
      fc.property(winnersArb, fc.array(fc.string(), { maxLength: 5 }), (winners, priorDismissed) => {
        const dismissedWinnerIds = new Set(priorDismissed)
        const latest = findLatestUndismissedWinner(winners, dismissedWinnerIds)
        fc.pre(latest !== undefined)

        const afterDismiss = new Set(dismissedWinnerIds).add(latest!.id)
        const next = findLatestUndismissedWinner(winners, afterDismiss)

        expect(next?.id).not.toBe(latest!.id)
      }),
      { numRuns: 100 },
    )
  })

  it('after dismissing the latest, returns the next-most-recent undismissed winner if one exists', () => {
    fc.assert(
      fc.property(winnersArb, (winners) => {
        fc.pre(winners.length >= 2)
        const latest = findLatestUndismissedWinner(winners, new Set())!
        const dismissed = new Set([latest.id])
        const next = findLatestUndismissedWinner(winners, dismissed)

        const expectedNext = [...winners]
          .reverse()
          .find((w) => w.id !== latest.id)

        expect(next).toEqual(expectedNext)
      }),
      { numRuns: 100 },
    )
  })

  it('once every winner id is dismissed, returns undefined — restoring the game.status/currentTerm view', () => {
    fc.assert(
      fc.property(winnersArb, (winners) => {
        const allDismissed = new Set(winners.map((w) => w.id))
        expect(findLatestUndismissedWinner(winners, allDismissed)).toBeUndefined()
      }),
      { numRuns: 100 },
    )
  })

  it('is a pure lookup: repeated calls with the same inputs yield the same result and no mutation', () => {
    fc.assert(
      fc.property(winnersArb, fc.array(fc.string(), { maxLength: 5 }), (winners, dismissedList) => {
        const dismissedWinnerIds = new Set(dismissedList)
        const snapshot = JSON.stringify(winners)
        Object.freeze(winners)

        const first = findLatestUndismissedWinner(winners, dismissedWinnerIds)
        const second = findLatestUndismissedWinner(winners, dismissedWinnerIds)

        expect(first).toEqual(second)
        expect(JSON.stringify(winners)).toBe(snapshot)
      }),
      { numRuns: 100 },
    )
  })
})
