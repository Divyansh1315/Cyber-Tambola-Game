// Feature: winner-history-and-game-reset, Property 13: Local Fallback retains every prior winner across any number of resets
//
// RESET_GAME (src/state/gameSessionReducer.ts) folds state.winners into
// winnerHistory on every reset rather than discarding them (design.md
// Decision 7). This property test asserts that invariant holds no matter
// how many "add winner(s), then RESET_GAME" cycles are performed: after any
// number of resets, winnerHistory must contain every winner ever added
// across every cycle — none lost, and none duplicated beyond what was
// actually added.
//
// Validates: Requirements 9.1
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import type { GameSessionState } from './gameSessionInitialState'
import type { Winner } from '../types/prize'

/** Builds a Winner with a distinct id; other fields are fixed/irrelevant to this property. */
function makeWinner(id: string): Winner {
  return {
    id,
    gameId: 'GAME_001',
    prizeId: 'CYBER_FIVE',
    playerId: `PLAYER_${id}`,
    ticketId: `TICKET_${id}`,
    claimId: `CLAIM_${id}`,
    confirmedAt: '2026-01-01T00:00:00.000Z',
    prizeLabel: 'Cyber Five',
    playerName: `Player ${id}`,
  }
}

/**
 * One cycle: add a batch of winners directly onto state.winners (mirroring
 * what CONFIRM_CLAIM would have produced), then dispatch RESET_GAME.
 */
type Cycle = { winnerIds: string[] }

// Each cycle adds between 0 and 4 winners, with globally-unique ids so
// "every winner ever added" is unambiguous to check for across cycles.
const cycleArb = fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 0, maxLength: 8 })

describe('Property 13: Local Fallback retains every prior winner across any number of resets (Req 9.1)', () => {
  it('winnerHistory contains exactly every winner ever added, across any number of add-then-reset cycles', () => {
    fc.assert(
      fc.property(cycleArb, (winnerCountsPerCycle) => {
        let state: GameSessionState = gameSessionInitialState
        const allAddedIds: string[] = []
        let counter = 0

        for (const winnerCount of winnerCountsPerCycle) {
          // Add `winnerCount` distinct winners to the current session's winners.
          const newWinners: Winner[] = []
          for (let i = 0; i < winnerCount; i++) {
            counter += 1
            const id = `W${counter}`
            newWinners.push(makeWinner(id))
            allAddedIds.push(id)
          }
          state = { ...state, winners: [...state.winners, ...newWinners] }

          // Reset: winners must fold into winnerHistory, never vanish.
          state = gameSessionReducer(state, { type: 'RESET_GAME' })
        }

        const historyIds = state.winnerHistory.map((w) => w.id).sort()
        const expectedIds = [...allAddedIds].sort()

        // No winner lost: every id ever added is present in winnerHistory.
        expect(historyIds).toEqual(expectedIds)

        // None duplicated beyond what was actually added: same count, no
        // extra copies (the sorted-array equality above already implies
        // this, but assert set-size equality explicitly for clarity).
        expect(new Set(historyIds).size).toBe(historyIds.length)

        // The current session's winners are cleared by each reset — the
        // last reset leaves the live `winners` collection empty, since no
        // winners are added after the final reset in this cycle sequence.
        expect(state.winners).toEqual([])
      }),
      { numRuns: 100 },
    )
  })
})
