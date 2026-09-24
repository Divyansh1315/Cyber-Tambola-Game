// Feature: module-6-realtime-multi-device-sync — regression test (task 17.3)
//
// Guarantee under test: a refresh/reconnect (modeled as a HYDRATE_FROM_REMOTE
// dispatch carrying a freshly fetched RemoteSnapshot) must restore the SAME
// ticket a player already had — never assign or surface a different one, and
// never create a duplicate ticket row for that player. HYDRATE_FROM_REMOTE is
// a one-shot whole-slice replace of game/players/tickets/marks/claims/winners
// that leaves `currentPlayerId` untouched (see gameSessionReducer.ts's case),
// so `currentTicket` — derived exactly as GameSessionContext.tsx derives it
// (`players.find(currentPlayerId)` -> `tickets.find(ticketId)`) — must resolve
// to a ticket with the identical `id` before and after the simulated
// reconnect.
//
// Validates: Requirements 24.3
import { describe, it, expect } from 'vitest'
import { gameSessionReducer, type RemoteSnapshot } from './gameSessionReducer'
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

/**
 * Replicates the exact `currentTicket` derivation used by
 * GameSessionContext.tsx's `useMemo` (players.find(currentPlayerId) ->
 * tickets.find(ticketId)), so this reducer-level test exercises the same
 * concept the context exposes without needing to render React.
 */
function deriveCurrentTicket(state: GameSessionState): Ticket | undefined {
  const currentPlayer = state.players.find((p) => p.id === state.currentPlayerId)
  return currentPlayer ? state.tickets.find((t) => t.id === currentPlayer.ticketId) : undefined
}

const PLAYER_ID = 'PLAYER_A'
const TICKET_ID = 'TICKET_A'

describe('refresh/reconnect restores the same ticket, never a different one (regression, Req 24.3)', () => {
  it('HYDRATE_FROM_REMOTE with a snapshot containing the same ticket id leaves currentTicket unchanged', () => {
    const ticket = makeTicket(TICKET_ID, PLAYER_ID)
    const player = makePlayer(PLAYER_ID, TICKET_ID)

    // Before "reconnect": player has joined and has their ticket locally.
    const before: GameSessionState = gameSessionReducer(gameSessionInitialState, {
      type: 'JOIN_PLAYER',
      player,
      ticket,
    })

    const ticketBefore = deriveCurrentTicket(before)
    expect(ticketBefore?.id).toBe(TICKET_ID)

    // Simulate a reconnect fetch returning the player's own persisted ticket
    // (same id, same core fields) as part of a full snapshot.
    const snapshot: RemoteSnapshot = {
      game: before.game,
      players: [player],
      tickets: [ticket],
      marks: [],
      claims: [],
      winners: [],
    }

    const after = gameSessionReducer(before, {
      type: 'HYDRATE_FROM_REMOTE',
      snapshot,
    })

    // currentPlayerId is untouched by HYDRATE_FROM_REMOTE, so the derivation
    // still resolves through the same player.
    expect(after.currentPlayerId).toBe(PLAYER_ID)

    const ticketAfter = deriveCurrentTicket(after)
    expect(ticketAfter?.id).toBe(ticketBefore?.id)
    expect(ticketAfter?.id).toBe(TICKET_ID)

    // No duplicate ticket was created for this player.
    const ticketsForPlayer = after.tickets.filter((t) => t.playerId === PLAYER_ID)
    expect(ticketsForPlayer).toHaveLength(1)
  })
})
