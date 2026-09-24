// Feature: bugfix — Player redirected to Join screen on Host lifecycle actions
//
// Root cause: `currentPlayerId` answers "which player is THIS browser tab" —
// it is client-local identity, not shared/synchronized game state. It used
// to be reconciled inside SYNC_STATE against the BROADCASTING tab's own
// (possibly empty/stale) `players` array, which could wipe out a Player
// tab's identity the moment a Host tab (with no players of its own locally)
// broadcast any lifecycle action. The fix removed `currentPlayerId` from
// the broadcast payload entirely and made the reducer never touch it — a
// guarantee that carried forward unchanged when SYNC_STATE/SyncPayload were
// superseded by SYNC_LOCAL/SharedStatePayload (module-6-realtime-multi-
// device-sync, design.md Decision 6/7).
//
// These regression tests cover:
//   A) currentPlayerId survives a full realistic sequence of the player's own
//      lifecycle + gameplay dispatches.
//   B) A Host tab's own SYNC_LOCAL broadcast (with a `players` array that
//      does not include the Player) never clobbers the Player tab's identity.
import { describe, it, expect } from 'vitest'
import { gameSessionReducer, type SharedStatePayload } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import type { GameSessionState } from './gameSessionInitialState'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'

const GAME_ID = 'GAME_001'

function makeTicket(id: string, playerId: string): Ticket {
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
    id,
    playerId,
    gameId: GAME_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: 'Ticket #A',
    rows,
  }
}

function makePlayer(id: string, ticketId: string): Player {
  return {
    id,
    gameId: GAME_ID,
    displayName: 'Player A',
    employeeDemoId: 'EMP-A',
    ticketId,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: 'Player A',
    employeeId: 'EMP-A',
    ticketRef: 'Ticket #A',
  }
}

// ---------------------------------------------------------------------------
// A) currentPlayerId survives every dispatch across a full realistic sequence
// ---------------------------------------------------------------------------

describe('currentPlayerId survives a full lifecycle + gameplay dispatch sequence (bugfix regression, Test A)', () => {
  it('stays set to the joined player id after every dispatch in the sequence', () => {
    const PLAYER_ID = 'PLAYER_A'
    const TICKET_ID = 'TICKET_A'
    const ticket = makeTicket(TICKET_ID, PLAYER_ID)
    const player = makePlayer(PLAYER_ID, TICKET_ID)

    let state: GameSessionState = gameSessionReducer(gameSessionInitialState, {
      type: 'JOIN_PLAYER',
      player,
      ticket,
    })
    expect(state.currentPlayerId).toBe(PLAYER_ID)

    state = gameSessionReducer(state, { type: 'START_GAME' })
    expect(state.currentPlayerId).toBe(PLAYER_ID)

    // START_GAME already selects AND reveals a term in one step (Module 5).
    // Force it to a known ticket term so MARK_TERM below is deterministic.
    state = {
      ...state,
      game: {
        ...state.game,
        currentTermId: 'T0',
        revealedTermIds: ['T0'],
      },
    }

    state = gameSessionReducer(state, { type: 'CALL_NEXT_WORD' })
    expect(state.currentPlayerId).toBe(PLAYER_ID)

    // Whatever term CALL_NEXT_WORD picked, force it to a known ticket term
    // (it's already revealed as part of that one dispatch — Module 5).
    state = {
      ...state,
      game: {
        ...state.game,
        currentTermId: 'T1',
        revealedTermIds: [...state.game.revealedTermIds.filter((id) => id !== 'T1'), 'T1'],
      },
    }

    state = gameSessionReducer(state, { type: 'MARK_TERM', termId: 'T1' })
    expect(state.currentPlayerId).toBe(PLAYER_ID)
    expect(state.marks).toHaveLength(1)

    state = gameSessionReducer(state, { type: 'PAUSE_GAME' })
    expect(state.currentPlayerId).toBe(PLAYER_ID)

    state = gameSessionReducer(state, { type: 'RESUME_GAME' })
    expect(state.currentPlayerId).toBe(PLAYER_ID)
  })
})

// ---------------------------------------------------------------------------
// B) A Host tab broadcasting its own (player-less) state must never log the
//    Player tab out.
// ---------------------------------------------------------------------------

describe("a Host tab's SYNC_LOCAL broadcast never clobbers the Player tab's currentPlayerId (bugfix regression, Test B)", () => {
  const PLAYER_A = 'PLAYER_A'
  const TICKET_A = 'TICKET_A'

  function buildPlayerTab(): GameSessionState {
    const ticket = makeTicket(TICKET_A, PLAYER_A)
    const player = makePlayer(PLAYER_A, TICKET_A)
    return gameSessionReducer(gameSessionInitialState, {
      type: 'JOIN_PLAYER',
      player,
      ticket,
    })
  }

  it("survives a Host broadcast whose players array does not include Player A", () => {
    const playerTab = buildPlayerTab()
    expect(playerTab.currentPlayerId).toBe(PLAYER_A)

    // Host tab: never sets currentPlayerId, and its own local `players` is
    // empty (e.g. it hasn't synced yet, or has a stale/partial view).
    const hostTab: GameSessionState = {
      ...gameSessionInitialState,
      game: { ...gameSessionInitialState.game, status: 'WORD_ACTIVE', currentTermId: 'T0' },
      currentPlayerId: undefined,
      players: [],
      tickets: [],
    }

    const hostAfterReveal = gameSessionReducer(hostTab, { type: 'CALL_NEXT_WORD' })
    expect(hostAfterReveal.players).toEqual([])

    // Build a SharedStatePayload the way GameSessionContext.tsx's
    // BroadcastChannel convenience does — note there is no `currentPlayerId`
    // field on SharedStatePayload at all.
    const payload: SharedStatePayload = {
      game: hostAfterReveal.game,
      players: hostAfterReveal.players,
      tickets: hostAfterReveal.tickets,
      marks: hostAfterReveal.marks,
      claims: [],
      winners: [],
    }

    const playerAfterSync = gameSessionReducer(playerTab, {
      type: 'SYNC_LOCAL',
      payload,
    })

    // The defect: this used to become `undefined`, redirecting the player to
    // the join screen. The fix: currentPlayerId is completely untouched.
    expect(playerAfterSync.currentPlayerId).toBe(PLAYER_A)
    // The player's own record still resolves against the newly-synced
    // players array only if it's present there — in this exact reproduction
    // the Host's players array is empty, matching the real defect scenario
    // (PlayerGame would need to have also synced players by then in
    // practice; this test isolates the currentPlayerId-preservation claim
    // specifically).
    expect(playerAfterSync.game.status).toBe('WORD_ACTIVE')
  })

  it('survives a Host broadcast for CALL_NEXT_WORD, PAUSE_GAME, and RESUME_GAME the same way', () => {
    const playerTab = buildPlayerTab()

    const hostBase: GameSessionState = {
      ...gameSessionInitialState,
      game: { ...gameSessionInitialState.game, status: 'WORD_ACTIVE', currentTermId: 'T0' },
      currentPlayerId: undefined,
      players: [],
      tickets: [],
    }

    let host = hostBase
    let player = playerTab

    for (const action of [
      { type: 'CALL_NEXT_WORD' } as const,
      { type: 'PAUSE_GAME' } as const,
      { type: 'RESUME_GAME' } as const,
    ]) {
      host = gameSessionReducer(host, action)
      const payload: SharedStatePayload = {
        game: host.game,
        players: host.players,
        tickets: host.tickets,
        marks: host.marks,
        claims: [],
        winners: [],
      }
      player = gameSessionReducer(player, { type: 'SYNC_LOCAL', payload })
      expect(player.currentPlayerId).toBe(PLAYER_A)
    }
  })
})
