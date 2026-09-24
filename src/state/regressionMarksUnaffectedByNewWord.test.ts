// Feature: module-6-realtime-multi-device-sync — task 17.1
// Regression test: a new word call (delivered via SYNC_REMOTE, the Module 6
// realtime path) never alters any previously-persisted Mark.
//
// Validates: Requirements 24.1
import { describe, it, expect } from 'vitest'
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import type { GameSessionState } from './gameSessionInitialState'
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

function baseState(): GameSessionState {
  const ticket = makeTicket()
  const player = makePlayer()
  return {
    ...gameSessionInitialState,
    game: {
      ...gameSessionInitialState.game,
      id: GAME_ID,
      status: 'WORD_ACTIVE',
      currentRound: 1,
      revealedTermIds: ['T0'],
    },
    players: [player],
    tickets: [ticket],
    currentPlayerId: player.id,
  }
}

describe('Regression: a new word call never alters existing marks (Req 24.1)', () => {
  it('leaves every previously-persisted Mark unchanged after a SYNC_REMOTE called_terms insert for a different term', () => {
    // Build up realistic state via the reducer's own MARK_TERM action.
    let state = baseState()
    state = gameSessionReducer(state, { type: 'MARK_TERM', termId: 'T0' })
    expect(state.marks).toHaveLength(1)
    const marksBefore = state.marks
    const [markBefore] = marksBefore

    // Simulate a SYNC_REMOTE delivering a `called_terms` INSERT for a
    // different, newly-called term — mirrors the shape realtimeClient.ts's
    // subscribeToGame produces for the `called_terms` table.
    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'called_terms',
        eventType: 'INSERT',
        row: { game_id: GAME_ID, term_id: 'T1', called_at: '2026-01-01T00:01:00.000Z', round: 2 },
      },
    })

    // The called_terms change only ever touches game.revealedTermIds.
    expect(state.game.revealedTermIds).toContain('T1')

    // Every previously-persisted Mark is unchanged — same length, and every
    // mark object equal (deep) to what it was before the SYNC_REMOTE.
    expect(state.marks).toHaveLength(marksBefore.length)
    expect(state.marks[0]).toEqual(markBefore)
    expect(state.marks).toEqual(marksBefore)
  })

  it('leaves marks unchanged across several consecutive SYNC_REMOTE called_terms inserts', () => {
    let state = baseState()
    state = gameSessionReducer(state, { type: 'MARK_TERM', termId: 'T0' })
    const marksBefore = state.marks

    for (const termId of ['T1', 'T2', 'T3']) {
      state = gameSessionReducer(state, {
        type: 'SYNC_REMOTE',
        change: {
          table: 'called_terms',
          eventType: 'INSERT',
          row: { game_id: GAME_ID, term_id: termId, called_at: '2026-01-01T00:01:00.000Z', round: 2 },
        },
      })
      expect(state.marks).toEqual(marksBefore)
    }
  })
})
