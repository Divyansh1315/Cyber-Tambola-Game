// Feature: winner-history-and-game-reset
//
// Unit tests for the `NO_ACTIVE_GAME` action added to `gameSessionReducer.ts`
// (task 5.1): dispatched by the context's pointer-follow effect when
// `get_active_game()` resolves no row, or a pointer-change event announces
// `active_game_id = null`. Unlike `RESET_GAME` (a host-triggered lifecycle
// transition), this is the client discovering there is currently no
// Active_Game to follow at all — it must reset the shared
// game/players/tickets/marks/claims/winners slice back to
// `gameSessionInitialState`'s values while leaving `currentPlayerId`
// untouched (Req 3.4, 4.3).
import { describe, it, expect } from 'vitest'
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState, createSeedGame } from './gameSessionInitialState'
import type { GameSessionState } from './gameSessionInitialState'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'
import type { Mark } from '../types/mark'
import type { PrizeClaim } from '../types/claim'
import type { Winner } from '../types/prize'

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

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
    gameId: 'GAME_XYZ',
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: `Ticket #${id}`,
    rows,
  }
}

function makePlayer(id: string, ticketId: string): Player {
  return {
    id,
    gameId: 'GAME_XYZ',
    displayName: `Player ${id}`,
    employeeDemoId: `EMP-${id}`,
    ticketId,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: `Player ${id}`,
    employeeId: `EMP-${id}`,
    ticketRef: `Ticket #${id}`,
  }
}

function makeMark(id: string, playerId: string, ticketId: string): Mark {
  return {
    id,
    gameId: 'GAME_XYZ',
    playerId,
    ticketId,
    termId: 'T0',
    markedAt: '2026-01-01T00:05:00.000Z',
    valid: true,
  }
}

function makeClaim(id: string, playerId: string, ticketId: string): PrizeClaim {
  return {
    id,
    gameId: 'GAME_XYZ',
    playerId,
    ticketId,
    prizeId: 'CYBER_FIVE',
    submittedAt: '2026-01-01T00:06:00.000Z',
    validationStatus: 'VALID',
    hostDecision: 'PENDING',
    prizeLabel: 'Cyber Five',
    playerName: 'Player A',
    ticketRef: 'Ticket #A',
  }
}

function makeWinner(id: string, playerId: string, ticketId: string, claimId: string): Winner {
  return {
    id,
    gameId: 'GAME_XYZ',
    prizeId: 'CYBER_FIVE',
    playerId,
    ticketId,
    claimId,
    confirmedAt: '2026-01-01T00:10:00.000Z',
    prizeLabel: 'Cyber Five',
    playerName: 'Player A',
    ticketRef: 'Ticket #A',
  }
}

/** An arbitrary populated session state, "dirty" across every shared field. */
function buildDirtyState(): GameSessionState {
  const ticket = makeTicket('TICKET_A', 'PLAYER_A')
  const player = makePlayer('PLAYER_A', 'TICKET_A')
  const mark = makeMark('MARK_A', 'PLAYER_A', 'TICKET_A')
  const claim = makeClaim('CLAIM_A', 'PLAYER_A', 'TICKET_A')
  const winner = makeWinner('WINNER_A', 'PLAYER_A', 'TICKET_A', 'CLAIM_A')

  return {
    ...gameSessionInitialState,
    game: {
      ...createSeedGame('ABCD12'),
      id: 'GAME_XYZ',
      status: 'WORD_ACTIVE',
      currentRound: 3,
      currentTermId: 'T0',
      revealedTermIds: ['T0', 'T1'],
    },
    players: [player],
    tickets: [ticket],
    currentPlayerId: 'PLAYER_A',
    marks: [mark],
    claims: [claim],
    winners: [winner],
    winnerHistory: [winner],
  }
}

describe('NO_ACTIVE_GAME resets the shared session slice while preserving currentPlayerId', () => {
  it('resets game/players/tickets/marks/claims/winners to gameSessionInitialState values', () => {
    const dirty = deepFreeze(buildDirtyState())

    const next = gameSessionReducer(dirty, { type: 'NO_ACTIVE_GAME' })

    expect(next.game).toEqual(gameSessionInitialState.game)
    expect(next.players).toEqual(gameSessionInitialState.players)
    expect(next.tickets).toEqual(gameSessionInitialState.tickets)
    expect(next.marks).toEqual(gameSessionInitialState.marks)
    expect(next.claims).toEqual(gameSessionInitialState.claims)
    expect(next.winners).toEqual(gameSessionInitialState.winners)
  })

  it('leaves currentPlayerId unchanged', () => {
    const dirty = deepFreeze(buildDirtyState())

    const next = gameSessionReducer(dirty, { type: 'NO_ACTIVE_GAME' })

    expect(next.currentPlayerId).toBe('PLAYER_A')
  })

  it('leaves currentPlayerId as undefined when it was already undefined', () => {
    const dirty = deepFreeze({ ...buildDirtyState(), currentPlayerId: undefined })

    const next = gameSessionReducer(dirty, { type: 'NO_ACTIVE_GAME' })

    expect(next.currentPlayerId).toBeUndefined()
  })

  it('is a no-op safety match when dispatched from an already-initial state', () => {
    const initial = deepFreeze({ ...gameSessionInitialState })

    const next = gameSessionReducer(initial, { type: 'NO_ACTIVE_GAME' })

    expect(next.game).toEqual(gameSessionInitialState.game)
    expect(next.players).toEqual([])
    expect(next.tickets).toEqual([])
    expect(next.marks).toEqual([])
    expect(next.claims).toEqual([])
    expect(next.winners).toEqual([])
    expect(next.currentPlayerId).toBeUndefined()
  })

  it('does not fold winners into winnerHistory (unlike RESET_GAME) -- winnerHistory resets to initial too', () => {
    const dirty = deepFreeze(buildDirtyState())

    const next = gameSessionReducer(dirty, { type: 'NO_ACTIVE_GAME' })

    // NO_ACTIVE_GAME resets the whole slice to gameSessionInitialState,
    // which means winnerHistory (a shared-state field) is also reset --
    // this is expected: winnerHistory only accumulates via RESET_GAME's
    // fold, and NO_ACTIVE_GAME represents having no game to follow at all,
    // not a host-triggered reset of the currently active game.
    expect(next.winnerHistory).toEqual(gameSessionInitialState.winnerHistory)
  })
})
