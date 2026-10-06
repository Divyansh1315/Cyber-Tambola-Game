// Spec: claim-player-ticket-identity-mismatch — task 11 (direct reducer-level
// unit tests for the `CLEAR_STALE_PLAYER` case added in task 7.1).
//
// `CLEAR_STALE_PLAYER` mirrors `RESTORE_PLAYER`'s existing "ignore if
// absent" convention, but for the inverse case: instead of pointing at an
// existing player, it clears a `currentPlayerId` that no longer resolves to
// a Player belonging to the confirmed Active Game (design.md Property 3;
// Req 2.5), so the stale resolution is never silently rendered indefinitely.
//
// Validates: Requirements 1.5, 2.5
import { describe, it, expect } from 'vitest'
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import type { GameSessionState } from './gameSessionInitialState'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'

const GAME_ID = gameSessionInitialState.game.id

function makeTicket(id: string, playerId: string, gameId: string): Ticket {
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
    gameId,
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: 'Ticket #A',
    rows,
  }
}

function makePlayer(id: string, ticketId: string, gameId: string): Player {
  return {
    id,
    gameId,
    displayName: 'Player A',
    ticketId,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: 'Player A',
    ticketRef: 'Ticket #A',
  }
}

describe('CLEAR_STALE_PLAYER reducer case (task 7.1; design.md Property 3; Req 1.5, 2.5)', () => {
  it('clears currentPlayerId when it does not resolve to any Player at all (absent)', () => {
    const state: GameSessionState = {
      ...gameSessionInitialState,
      currentPlayerId: 'GHOST_PLAYER_ID',
      players: [],
      tickets: [],
    }

    const next = gameSessionReducer(state, { type: 'CLEAR_STALE_PLAYER' })

    expect(next.currentPlayerId).toBeUndefined()
    // Nothing else about the state is touched.
    expect(next.players).toBe(state.players)
    expect(next.tickets).toBe(state.tickets)
    expect(next.game).toBe(state.game)
  })

  it('clears currentPlayerId when the resolved Player belongs to a different game than the Active Game (mismatched)', () => {
    const ticket = makeTicket('TICKET_A', 'PLAYER_A', 'OLD_GAME')
    const player = makePlayer('PLAYER_A', 'TICKET_A', 'OLD_GAME')
    const state: GameSessionState = {
      ...gameSessionInitialState,
      game: { ...gameSessionInitialState.game, id: GAME_ID },
      currentPlayerId: 'PLAYER_A',
      players: [player],
      tickets: [ticket],
    }

    // Sanity: the player genuinely resolves structurally, just to a game
    // that no longer matches state.game.id -- this is the "mismatched" case
    // the invalidation effect (task 7.2) detects before dispatching this
    // action; the reducer case itself doesn't re-check this, it is purely
    // unconditional on the caller's decision to dispatch it.
    expect(player.gameId).not.toBe(state.game.id)

    const next = gameSessionReducer(state, { type: 'CLEAR_STALE_PLAYER' })

    expect(next.currentPlayerId).toBeUndefined()
    // The stale player/ticket rows themselves are left untouched -- this
    // action only ever clears the client-local `currentPlayerId` pointer,
    // never mutates players/tickets (that is HYDRATE_FROM_REMOTE/SYNC_REMOTE's
    // job).
    expect(next.players).toBe(state.players)
    expect(next.tickets).toBe(state.tickets)
  })

  it('is a no-op (same currentPlayerId, same reference semantics) when currentPlayerId is already undefined', () => {
    const state: GameSessionState = {
      ...gameSessionInitialState,
      currentPlayerId: undefined,
    }

    const next = gameSessionReducer(state, { type: 'CLEAR_STALE_PLAYER' })

    expect(next.currentPlayerId).toBeUndefined()
    // Matches RESTORE_PLAYER's existing "ignore if absent" convention: a
    // true no-op returns the SAME state reference rather than a new object,
    // so a consumer relying on referential equality (e.g. to skip a
    // re-render) is not needlessly triggered.
    expect(next).toBe(state)
  })

  it('leaves a currently-consistent currentPlayerId alone when a caller mistakenly dispatches it anyway (reducer has no re-check of its own)', () => {
    // The reducer case itself is unconditional on the caller's decision
    // (the invalidation effect in task 7.2 is what decides whether to
    // dispatch) -- but this still documents the reducer's actual contract:
    // dispatching CLEAR_STALE_PLAYER always clears currentPlayerId
    // regardless of whether it was actually stale, since the reducer has
    // no way (and no need) to re-derive that itself.
    const ticket = makeTicket('TICKET_A', 'PLAYER_A', GAME_ID)
    const player = makePlayer('PLAYER_A', 'TICKET_A', GAME_ID)
    const state: GameSessionState = {
      ...gameSessionInitialState,
      game: { ...gameSessionInitialState.game, id: GAME_ID },
      currentPlayerId: 'PLAYER_A',
      players: [player],
      tickets: [ticket],
    }

    const next = gameSessionReducer(state, { type: 'CLEAR_STALE_PLAYER' })

    expect(next.currentPlayerId).toBeUndefined()
  })
})
