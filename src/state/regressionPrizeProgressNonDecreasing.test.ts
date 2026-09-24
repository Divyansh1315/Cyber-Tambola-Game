// Feature: module-6-realtime-multi-device-sync — task 17.4
// Regression test: a new word call (delivered via SYNC_REMOTE, the Module 6
// realtime path) never decreases any prize's progress.
//
// getAllPrizeProgress is a pure function of a Ticket + validMarks — it never
// reads `revealedTermIds` — and SYNC_REMOTE's 'called_terms' case only ever
// folds the new term into `state.game.revealedTermIds`, never touching
// `state.marks` or `state.tickets`. So prize progress before and after a new
// word call must be identical (never mind just non-decreasing) as long as no
// marks changed in between — this test asserts the non-decreasing property
// design.md's Regression checklist calls for.
//
// Validates: Requirements 24.4
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import type { GameSessionState } from './gameSessionInitialState'
import { getAllPrizeProgress, getPlayerTicketMarks } from '../utils/prizeEngine'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'

const GAME_ID = 'GAME_001'
const PLAYER_ID = 'PLAYER_1'
const TICKET_ID = 'TICKET_1'

/** A 3x5 ticket whose 15 cells have distinct termIds T0..T14. */
function makeTicket(): Ticket {
  const rows: TicketCell[][] = []
  let n = 0
  for (let row = 0; row < 3; row++) {
    const cells: TicketCell[] = []
    for (let col = 0; col < 5; col++) {
      cells.push({ termId: `T${n}`, term: `Term ${n}`, state: 'LOCKED', row, col })
      n++
    }
    rows.push(cells)
  }
  return {
    id: TICKET_ID,
    playerId: PLAYER_ID,
    gameId: GAME_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: 'Ticket #1',
    rows,
  }
}

function makePlayer(): Player {
  return {
    id: PLAYER_ID,
    gameId: GAME_ID,
    displayName: 'Asha',
    employeeDemoId: 'EMP-1001',
    ticketId: TICKET_ID,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: 'Asha',
    employeeId: 'EMP-1001',
    ticketRef: 'Ticket #1',
  }
}

function baseState(revealedTermIds: string[]): GameSessionState {
  const ticket = makeTicket()
  const player = makePlayer()
  return {
    ...gameSessionInitialState,
    game: {
      ...gameSessionInitialState.game,
      id: GAME_ID,
      status: 'WORD_ACTIVE',
      currentRound: 1,
      revealedTermIds,
    },
    players: [player],
    tickets: [ticket],
    currentPlayerId: player.id,
  }
}

/** Compute this player's current prize-progress array from a state snapshot. */
function computeProgress(state: GameSessionState) {
  const ticket = state.tickets.find((t) => t.id === TICKET_ID)!
  const validMarks = getPlayerTicketMarks(state.marks, PLAYER_ID, TICKET_ID)
  return getAllPrizeProgress(ticket, validMarks)
}

describe("Regression: a new word call never decreases any prize's progress (Req 24.4)", () => {
  it('leaves every prize\'s current progress unchanged (hence non-decreasing) across a SYNC_REMOTE called_terms insert', () => {
    // Build up realistic state with an existing mark on the ticket.
    let state = baseState(['T0'])
    state = gameSessionReducer(state, { type: 'MARK_TERM', termId: 'T0' })
    expect(state.marks).toHaveLength(1)

    const progressBefore = computeProgress(state)

    // Simulate a SYNC_REMOTE delivering a `called_terms` INSERT for a new,
    // not-yet-marked term.
    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'called_terms',
        eventType: 'INSERT',
        row: { game_id: GAME_ID, term_id: 'T1', called_at: '2026-01-01T00:01:00.000Z', round: 2 },
      },
    })

    const progressAfter = computeProgress(state)

    expect(progressAfter).toHaveLength(progressBefore.length)
    progressBefore.forEach((before, i) => {
      const after = progressAfter[i]
      expect(after.id).toBe(before.id)
      expect(after.current).toBeGreaterThanOrEqual(before.current)
    })
    // Progress is in fact identical, since marks were untouched.
    expect(progressAfter).toEqual(progressBefore)
  })

  it('property: for any ticket/marks/new-term-id combination, prize progress never decreases after a called_terms SYNC_REMOTE insert', () => {
    fc.assert(
      fc.property(
        // Choose how many of the ticket's 15 terms are already marked, and
        // which additional term id gets "called" next (may already be
        // revealed/marked — SYNC_REMOTE folding is a set-union either way).
        fc.array(fc.integer({ min: 0, max: 14 }), { maxLength: 15 }),
        fc.integer({ min: 0, max: 14 }),
        (markedIndexes, newTermIndex) => {
          const uniqueMarkedIds = [...new Set(markedIndexes)].map((i) => `T${i}`)
          const newTermId = `T${newTermIndex}`

          let state = baseState(uniqueMarkedIds)
          for (const termId of uniqueMarkedIds) {
            state = gameSessionReducer(state, { type: 'MARK_TERM', termId })
          }

          const progressBefore = computeProgress(state)

          state = gameSessionReducer(state, {
            type: 'SYNC_REMOTE',
            change: {
              table: 'called_terms',
              eventType: 'INSERT',
              row: {
                game_id: GAME_ID,
                term_id: newTermId,
                called_at: '2026-01-01T00:01:00.000Z',
                round: 2,
              },
            },
          })

          const progressAfter = computeProgress(state)

          expect(progressAfter).toHaveLength(progressBefore.length)
          progressBefore.forEach((before, i) => {
            const after = progressAfter[i]
            expect(after.id).toBe(before.id)
            expect(after.current).toBeGreaterThanOrEqual(before.current)
          })
        },
      ),
      { numRuns: 100 },
    )
  })
})
