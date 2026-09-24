// Feature: module-6-realtime-multi-device-sync
//
// Regression test: a new player joining from another device appears in
// state.players (and hence the Host Dashboard's participant count/roster)
// via a live `players` SYNC_REMOTE event, not only after a full reconnect.
//
// `players` was previously omitted from realtimeClient.ts's subscribeToGame
// table list and from gameSessionReducer.ts's SYNC_REMOTE switch (it fell
// through to the `default: return state` no-op) -- a genuine gap: the Host
// Dashboard reads state.players directly for "Participants", so a second
// device joining never appeared there live.
import { describe, it, expect } from 'vitest'
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import type { GameSessionState } from './gameSessionInitialState'

const GAME_ID = 'GAME_001'

function baseState(): GameSessionState {
  return {
    ...gameSessionInitialState,
    game: {
      ...gameSessionInitialState.game,
      id: GAME_ID,
      status: 'LOBBY',
    },
    players: [],
    tickets: [],
  }
}

describe('SYNC_REMOTE players case (participant roster live update)', () => {
  it('adds a brand-new player row delivered as a players INSERT', () => {
    let state = baseState()

    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'players',
        eventType: 'INSERT',
        row: {
          id: 'PLAYER_1',
          game_id: GAME_ID,
          display_name: 'Asha',
          employee_demo_id: 'EMP-1',
          joined_at: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    expect(state.players).toHaveLength(1)
    expect(state.players[0].displayName).toBe('Asha')
    expect(state.players[0].id).toBe('PLAYER_1')
  })

  it('upserts (never duplicates) when the same player row arrives again', () => {
    let state = baseState()
    const change = {
      table: 'players' as const,
      eventType: 'INSERT' as const,
      row: {
        id: 'PLAYER_1',
        game_id: GAME_ID,
        display_name: 'Asha',
        employee_demo_id: 'EMP-1',
        joined_at: '2026-01-01T00:00:00.000Z',
      },
    }

    state = gameSessionReducer(state, { type: 'SYNC_REMOTE', change })
    state = gameSessionReducer(state, { type: 'SYNC_REMOTE', change })

    expect(state.players).toHaveLength(1)
  })

  it('backfills ticketId/ticketRef once the matching tickets INSERT arrives, regardless of arrival order', () => {
    let state = baseState()

    // players INSERT arrives first (ticket not yet known).
    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'players',
        eventType: 'INSERT',
        row: {
          id: 'PLAYER_1',
          game_id: GAME_ID,
          display_name: 'Asha',
          employee_demo_id: 'EMP-1',
          joined_at: '2026-01-01T00:00:00.000Z',
        },
      },
    })
    expect(state.players[0].ticketId).toBe('')

    // tickets INSERT for that same player arrives moments later.
    const flatCells = Array.from({ length: 15 }, (_, i) => ({
      termId: `T${i}`,
      row: Math.floor(i / 5),
      col: i % 5,
    }))
    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'tickets',
        eventType: 'INSERT',
        row: {
          id: 'TICKET_1',
          game_id: GAME_ID,
          player_id: 'PLAYER_1',
          ref: 'Ticket #1',
          created_at: '2026-01-01T00:00:01.000Z',
          cells: flatCells,
        },
      },
    })

    expect(state.tickets).toHaveLength(1)
    expect(state.players[0].ticketId).toBe('TICKET_1')
    expect(state.players[0].ticketRef).toBe('Ticket #1')
  })

  it('treats a players DELETE as a defensive no-op', () => {
    let state = baseState()
    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'players',
        eventType: 'INSERT',
        row: {
          id: 'PLAYER_1',
          game_id: GAME_ID,
          display_name: 'Asha',
          employee_demo_id: 'EMP-1',
          joined_at: '2026-01-01T00:00:00.000Z',
        },
      },
    })

    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: { table: 'players', eventType: 'DELETE', row: { id: 'PLAYER_1' } },
    })

    expect(state.players).toHaveLength(1)
  })
})