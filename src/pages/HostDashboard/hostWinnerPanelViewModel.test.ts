// Feature: module-5-prize-claim-processing-winner-management, Property 13: The winner panel lists all five prizes, each awarded or explicitly not
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { toWinnerPanelViewModel } from './HostDashboard'
import { PRIZES } from '../../utils/prizeEngine'
import type { PrizeId, Winner } from '../../types/prize'

const RUNS = 100

const GAME_ID = 'game-1'

const prizeIdArb: fc.Arbitrary<PrizeId> = fc.constantFrom(...PRIZES.map((p) => p.id))

/** A Winner for the fixed GAME_ID, over any of the five fixed prizes. */
const winnerArb: fc.Arbitrary<Winner> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: fc.constant(GAME_ID),
  prizeId: prizeIdArb,
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  claimId: fc.string({ minLength: 1, maxLength: 10 }),
  confirmedAt: fc.constant('2026-01-01T09:05:00.000Z'),
  prizeLabel: fc.string({ minLength: 1, maxLength: 20 }),
  playerName: fc.string({ minLength: 1, maxLength: 20 }),
})

/**
 * A winners list covering a random subset of the five PrizeIds (each prize
 * appearing at most once, since a prize can have at most one winner), plus
 * noise winners for other games that must never affect this game's panel.
 */
const winnersForGameArb: fc.Arbitrary<Winner[]> = fc
  .uniqueArray(prizeIdArb, { minLength: 0, maxLength: PRIZES.length })
  .chain((prizeIds) =>
    fc.tuple(...prizeIds.map((prizeId) => winnerArb.map((w) => ({ ...w, prizeId })))),
  )

const noiseWinnerArb: fc.Arbitrary<Winner> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: fc.string({ minLength: 1, maxLength: 10 }).filter((id) => id !== GAME_ID),
  prizeId: prizeIdArb,
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  claimId: fc.string({ minLength: 1, maxLength: 10 }),
  confirmedAt: fc.constant('2026-01-01T09:05:00.000Z'),
  prizeLabel: fc.string({ minLength: 1, maxLength: 20 }),
  playerName: fc.string({ minLength: 1, maxLength: 20 }),
})

const scenarioArb = fc.record({
  gameWinners: winnersForGameArb,
  noiseWinners: fc.array(noiseWinnerArb, { maxLength: 5 }),
})

describe('toWinnerPanelViewModel (property 13)', () => {
  it('always returns exactly 5 rows, one per PRIZES entry in PRIZES order, each reflecting that prize\'s winner or lack thereof', () => {
    fc.assert(
      fc.property(scenarioArb, ({ gameWinners, noiseWinners }) => {
        const allWinners = [...gameWinners, ...noiseWinners]

        const rows = toWinnerPanelViewModel(allWinners, GAME_ID)

        expect(rows).toHaveLength(PRIZES.length)
        expect(rows.map((r) => r.prizeId)).toEqual(PRIZES.map((p) => p.id))

        rows.forEach((row, index) => {
          const prize = PRIZES[index]
          expect(row.label).toBe(prize.label)

          const matchingWinner = gameWinners.find((w) => w.prizeId === prize.id)
          if (matchingWinner) {
            expect(row.winnerName).toBe(matchingWinner.playerName)
          } else {
            expect(row.winnerName).toBeNull()
          }
        })
      }),
      { numRuns: RUNS },
    )
  })

  it('returns all 5 prizes as "not awarded" (null) when there are no winners at all', () => {
    const rows = toWinnerPanelViewModel([], GAME_ID)
    expect(rows).toHaveLength(5)
    expect(rows.every((r) => r.winnerName === null)).toBe(true)
  })

  it('does not mutate its inputs', () => {
    fc.assert(
      fc.property(scenarioArb, ({ gameWinners, noiseWinners }) => {
        const allWinners = [...gameWinners, ...noiseWinners]
        const snapshot = JSON.stringify(allWinners)
        Object.freeze(allWinners)
        toWinnerPanelViewModel(allWinners, GAME_ID)
        expect(JSON.stringify(allWinners)).toBe(snapshot)
      }),
      { numRuns: RUNS },
    )
  })
})
