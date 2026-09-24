// Feature: winner-history-and-game-reset, Property 2: Winner_History includes every winner across every game
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { toWinnerHistoryViewModel } from './hostWinnerHistoryViewModel'
import type { WinnerHistoryGameSummary } from './hostWinnerHistoryViewModel'
import type { PrizeId, Winner } from '../../types/prize'

const RUNS = 100

const prizeIdArb: fc.Arbitrary<PrizeId> = fc.constantFrom(
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
)

const gameSummaryArb: fc.Arbitrary<WinnerHistoryGameSummary> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  code: fc.string({ minLength: 1, maxLength: 8 }),
  createdAt: fc.constant('2026-01-01T09:00:00.000Z'),
})

/** A Winner belonging to a specific gameId, with a caller-supplied unique id. */
function winnerForGameArb(id: string, gameId: string): fc.Arbitrary<Winner> {
  return fc.record({
    id: fc.constant(id),
    gameId: fc.constant(gameId),
    prizeId: prizeIdArb,
    playerId: fc.string({ minLength: 1, maxLength: 10 }),
    ticketId: fc.string({ minLength: 1, maxLength: 10 }),
    claimId: fc.string({ minLength: 1, maxLength: 10 }),
    confirmedAt: fc.constant('2026-01-01T09:05:00.000Z'),
    prizeLabel: fc.string({ minLength: 1, maxLength: 20 }),
    playerName: fc.string({ minLength: 1, maxLength: 20 }),
    ticketRef: fc.string({ minLength: 1, maxLength: 10 }),
  })
}

/**
 * Generates an arbitrary set of distinct games, each with an arbitrary
 * number of winners (each winner given a globally unique id), spanning an
 * arbitrary number of games — including games with zero winners and a
 * winners list that is empty overall.
 */
const scenarioArb: fc.Arbitrary<{ games: WinnerHistoryGameSummary[]; winners: Winner[] }> = fc
  .uniqueArray(gameSummaryArb, { selector: (g) => g.id, minLength: 0, maxLength: 6 })
  .chain((games) => {
    if (games.length === 0) {
      return fc.constant({ games, winners: [] as Winner[] })
    }
    return fc
      .array(fc.tuple(fc.nat({ max: games.length - 1 }), fc.string({ minLength: 1, maxLength: 12 })), {
        maxLength: 20,
      })
      .map((entries) => {
        // De-duplicate winner ids so every winner id is globally unique,
        // regardless of how many times the same random id string was drawn.
        const seenIds = new Set<string>()
        const winners: Winner[] = []
        entries.forEach(([gameIndex, rawId], i) => {
          let id = rawId
          let suffix = 0
          while (seenIds.has(id)) {
            suffix += 1
            id = `${rawId}-${i}-${suffix}`
          }
          seenIds.add(id)
          const gameId = games[gameIndex].id
          const winner = fc.sample(winnerForGameArb(id, gameId), 1)[0]
          winners.push(winner)
        })
        return { games, winners }
      })
  })

describe('toWinnerHistoryViewModel (property 2)', () => {
  it('includes every winner exactly once across all returned groups, regardless of how many games they span', () => {
    fc.assert(
      fc.property(scenarioArb, ({ games, winners }) => {
        const groups = toWinnerHistoryViewModel(winners, games)

        // Flatten every group's rows and compare against the input winner
        // set by identity (matching winner ids one-to-one).
        const flattenedRowCount = groups.reduce((sum, g) => sum + g.rows.length, 0)
        expect(flattenedRowCount).toBe(winners.length)

        for (const winner of winners) {
          const group = groups.find((g) => g.gameId === winner.gameId)
          expect(group).toBeDefined()

          const matchingRows = group!.rows.filter(
            (row) =>
              row.prizeLabel === winner.prizeLabel &&
              row.playerName === winner.playerName &&
              row.ticketRef === winner.ticketRef &&
              row.confirmedAt === winner.confirmedAt,
          )
          expect(matchingRows).toHaveLength(1)
        }
      }),
      { numRuns: RUNS },
    )
  })

  it('produces no groups and no rows when there are no winners at all', () => {
    const groups = toWinnerHistoryViewModel([], [])
    expect(groups).toHaveLength(0)
  })
})
