// Feature: winner-history-and-game-reset, Property 3: Winner_History groups are ordered newest-game-first and correctly labeled
//
// toWinnerHistoryViewModel (src/pages/HostDashboard/hostWinnerHistoryViewModel.ts)
// groups winners by their owning game and orders the resulting groups by
// that game's own `createdAt`, newest first — "newest" meaning the game's
// own creation timestamp, never a winner's confirmedAt (design.md). Each
// group must also be labeled with that game's own code/createdAt, not any
// other game's. This property test asserts both invariants hold for
// arbitrary games (with distinct createdAt values) and arbitrary winner
// distributions across them.
//
// Validates: Requirements 2.2, 2.4
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { toWinnerHistoryViewModel } from './hostWinnerHistoryViewModel'
import type { WinnerHistoryGameSummary } from './hostWinnerHistoryViewModel'
import type { Winner, PrizeId } from '../../types/prize'

const prizeIds: PrizeId[] = [
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
]

/** Builds a Winner belonging to `gameId`; other fields are fixed/irrelevant to this property. */
function makeWinner(id: string, gameId: string, prizeId: PrizeId): Winner {
  return {
    id,
    gameId,
    prizeId,
    playerId: `PLAYER_${id}`,
    ticketId: `TICKET_${id}`,
    claimId: `CLAIM_${id}`,
    confirmedAt: '2026-01-01T00:00:00.000Z',
    prizeLabel: prizeId,
    playerName: `Player ${id}`,
    ticketRef: `Ticket #${id}`,
  }
}

/**
 * Arbitrary games with distinct createdAt values. `createdAt` values are
 * built from a base timestamp plus a distinct integer offset (in minutes)
 * per game, so distinctness is guaranteed without relying on fast-check's
 * date shrinking/formatting.
 */
const gamesArb = fc
  .uniqueArray(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 8 })
  .map((offsets) =>
    offsets.map((offsetMinutes, index) => ({
      id: `GAME_${index}`,
      code: `CODE${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, offsetMinutes)).toISOString(),
    })),
  )

describe('Property 3: Winner_History groups are ordered newest-game-first and correctly labeled (Req 2.2, 2.4)', () => {
  it('orders groups by descending game createdAt and labels each with its own game code/createdAt', () => {
    fc.assert(
      fc.property(
        gamesArb,
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 0, maxLength: 8 }),
        (games: WinnerHistoryGameSummary[], winnerCountsPerGame) => {
          // Distribute an arbitrary number of winners across the arbitrary
          // games (cycling through games if there are more counts than games).
          const winners: Winner[] = []
          let counter = 0
          winnerCountsPerGame.forEach((count, i) => {
            const game = games[i % games.length]
            for (let j = 0; j < count; j++) {
              counter += 1
              const id = `W${counter}`
              winners.push(makeWinner(id, game.id, prizeIds[counter % prizeIds.length]))
            }
          })

          const groups = toWinnerHistoryViewModel(winners, games)

          // Ordering: groups appear in strictly descending order of their
          // game's own createdAt (games have distinct createdAt values, so
          // there are no ties to worry about).
          for (let i = 0; i + 1 < groups.length; i++) {
            expect(groups[i].gameCreatedAt > groups[i + 1].gameCreatedAt).toBe(true)
          }

          // Labeling: every group's gameCode/gameCreatedAt exactly match
          // that group's own game — never another game's — and its gameId
          // corresponds to a real game in the input.
          const gameById = new Map(games.map((g) => [g.id, g]))
          for (const group of groups) {
            const ownGame = gameById.get(group.gameId)
            expect(ownGame).toBeDefined()
            expect(group.gameCode).toBe(ownGame!.code)
            expect(group.gameCreatedAt).toBe(ownGame!.createdAt)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
