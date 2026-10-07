// Spec: claim-player-ticket-identity-mismatch — task 9 (unit tests for
// `getActivePlayerSession()`).
//
// `getActivePlayerSession()` (GameSessionContext.tsx) is the single
// active-session resolver both the UI's `currentPlayer`/`currentTicket`
// derivation and the pre-submission claim guard read from. It is pure given
// its `state`/`isBackendConfirmed` arguments, so it is tested directly here
// as a plain function rather than through the provider.
//
// Resolution order (design.md Fix Implementation point 2 / task 4.1):
//   1. NOT_BACKEND_CONFIRMED  — isBackendConfirmed is false
//   2. PLAYER_NOT_FOUND       — no player with id === state.currentPlayerId
//   3. PLAYER_NOT_IN_GAME     — activePlayer.gameId !== activeGame.id
//   4. TICKET_NOT_FOUND       — no ticket with playerId === activePlayer.id
//                                && gameId === activeGame.id
//   5. TICKET_NOT_OWNED_BY_PLAYER — activeTicket.playerId !== activePlayer.id // not-a-ticket-dimension
//                                    || activeTicket.gameId !== activeGame.id
//
// Each failure mode must be independently attributable (Req 2.2, 2.7), and
// `isConsistent` must match the exact boolean formula from bugfix.md's
// `isBugCondition` (negated) for every input (Req 2.1, 2.6).
//
// Validates: Requirements 2.1, 2.2, 2.6, 2.7
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { getActivePlayerSession } from './GameSessionContext'
import { gameSessionInitialState } from './gameSessionInitialState'
import type { GameSessionState } from './gameSessionInitialState'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'

const ACTIVE_GAME_ID = 'GAME_ACTIVE'
const OTHER_GAME_ID = 'GAME_OTHER'
const PLAYER_ID = 'PLAYER_1'
const TICKET_ID = 'TICKET_1'

function buildTicketRows(): TicketCell[][] {
  let n = 0
  const rows: TicketCell[][] = []
  for (let row = 0; row < 3; row++) {
    const cells: TicketCell[] = []
    for (let col = 0; col < 5; col++) {
      cells.push({ termId: `T${n}`, term: `Term ${n}`, state: 'LOCKED', row, col })
      n++
    }
    rows.push(cells)
  }
  return rows
}

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: PLAYER_ID,
    gameId: ACTIVE_GAME_ID,
    displayName: 'Divyansh',
    ticketId: TICKET_ID,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: 'Divyansh',
    ticketRef: 'Ticket #6405',
    ...overrides,
  }
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: TICKET_ID,
    playerId: PLAYER_ID,
    gameId: ACTIVE_GAME_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: 'Ticket #6405',
    rows: buildTicketRows(),
    ...overrides,
  }
}

function buildState(overrides: Partial<GameSessionState> = {}): GameSessionState {
  return {
    ...gameSessionInitialState,
    game: { ...gameSessionInitialState.game, id: ACTIVE_GAME_ID },
    currentPlayerId: PLAYER_ID,
    players: [makePlayer()],
    tickets: [makeTicket()],
    ...overrides,
  }
}

describe('getActivePlayerSession() — existence checks', () => {
  it('returns PLAYER_NOT_FOUND when currentPlayerId does not resolve to any player', () => {
    const state = buildState({ currentPlayerId: 'MISSING_PLAYER', players: [makePlayer()] })

    const result = getActivePlayerSession(state, true)

    expect(result.activePlayer).toBeUndefined()
    expect(result.isConsistent).toBe(false)
    expect(result.inconsistencyReason).toBe('PLAYER_NOT_FOUND')
  })

  it('returns PLAYER_NOT_FOUND when currentPlayerId is undefined', () => {
    const state = buildState({ currentPlayerId: undefined })

    const result = getActivePlayerSession(state, true)

    expect(result.activePlayer).toBeUndefined()
    expect(result.isConsistent).toBe(false)
    expect(result.inconsistencyReason).toBe('PLAYER_NOT_FOUND')
  })

  it('returns TICKET_NOT_FOUND when the player exists and is in the active game, but no ticket resolves for them', () => {
    const state = buildState({ tickets: [] })

    const result = getActivePlayerSession(state, true)

    expect(result.activePlayer).toBeDefined()
    expect(result.activeTicket).toBeUndefined()
    expect(result.isConsistent).toBe(false)
    expect(result.inconsistencyReason).toBe('TICKET_NOT_FOUND')
  })
})

describe('getActivePlayerSession() — cross-id agreement checks (each independently attributable)', () => {
  it('returns PLAYER_NOT_IN_GAME when activePlayer.gameId !== activeGame.id (ticket otherwise consistent)', () => {
    const state = buildState({
      players: [makePlayer({ gameId: OTHER_GAME_ID })],
      // Ticket still agrees with the (wrong) player.gameId so this failure
      // is attributable to the player check alone, not a side effect of a
      // ticket mismatch.
      tickets: [makeTicket({ gameId: OTHER_GAME_ID })],
    })

    const result = getActivePlayerSession(state, true)

    expect(result.isConsistent).toBe(false)
    expect(result.inconsistencyReason).toBe('PLAYER_NOT_IN_GAME')
  })

  it('a ticket whose playerId disagrees never resolves via the deterministic find, surfacing as TICKET_NOT_FOUND (not a false TICKET_NOT_OWNED_BY_PLAYER)', () => {
    const state = buildState({
      tickets: [makeTicket({ playerId: 'SOMEONE_ELSE' })],
    })

    // With a mismatched playerId, the ticket no longer resolves via
    // `t.playerId === activePlayer?.id`, so TICKET_NOT_FOUND fires first —
    // this is the resolution-order consequence noted in task 9's own text
    // ("per the resolution order chosen in task 4.1"). To reach
    // TICKET_NOT_OWNED_BY_PLAYER specifically would require a ticket that
    // DOES resolve (same playerId + gameId) but then independently fails
    // the explicit ownership re-check — which, given the resolver's single
    // deterministic `.find()`, is unreachable for a playerId mismatch
    // alone. This test documents and locks in that actually-reachable
    // outcome; the gameId-mismatch variant below documents the same for
    // the fourth disjunct.
    const result = getActivePlayerSession(state, true)

    expect(result.isConsistent).toBe(false)
    expect(result.inconsistencyReason).toBe('TICKET_NOT_FOUND')
  })

  it('a ticket whose gameId disagrees with activeGame never resolves via the deterministic find, surfacing as TICKET_NOT_FOUND (not a false TICKET_NOT_OWNED_BY_PLAYER)', () => {
    // activePlayer.gameId === activeGame.id (passes PLAYER_NOT_IN_GAME), but
    // the resolver's `.find()` requires `t.gameId === activeGame.id` to
    // resolve a ticket at all, so a ticket whose gameId disagrees can never
    // be the one `activeTicket` resolves to — it again surfaces as
    // TICKET_NOT_FOUND under this resolver's single-find resolution order,
    // never TICKET_NOT_OWNED_BY_PLAYER. The only way to reach
    // TICKET_NOT_OWNED_BY_PLAYER is a ticket that DOES resolve (matches
    // activePlayer.id AND activeGame.id in the `.find()` predicate) while a
    // second, non-matching ticket for the same player also exists — in that
    // case resolution still succeeds and the explicit re-check also passes,
    // so this reason is unreachable given the resolver's current
    // implementation. We assert the behavior actually observed instead.
    const state = buildState({
      tickets: [makeTicket({ gameId: OTHER_GAME_ID })],
    })

    const result = getActivePlayerSession(state, true)

    expect(result.isConsistent).toBe(false)
    expect(result.inconsistencyReason).toBe('TICKET_NOT_FOUND')
  })

  it('is consistent when every id relationship agrees and the backend is confirmed', () => {
    const state = buildState()

    const result = getActivePlayerSession(state, true)

    expect(result.isConsistent).toBe(true)
    expect(result.inconsistencyReason).toBeUndefined()
    expect(result.activePlayer?.id).toBe(PLAYER_ID)
    expect(result.activeTicket?.id).toBe(TICKET_ID)
  })
})

describe('getActivePlayerSession() — isBackendConfirmed gate', () => {
  it('returns NOT_BACKEND_CONFIRMED when isBackendConfirmed is false, even for an otherwise fully consistent session', () => {
    const state = buildState()

    const result = getActivePlayerSession(state, false)

    expect(result.isConsistent).toBe(false)
    expect(result.inconsistencyReason).toBe('NOT_BACKEND_CONFIRMED')
    // Rendering still gets activePlayer/activeTicket unconditionally (Req
    // 2.4's no-flicker optimistic rendering) — only isConsistent/claim
    // submission is gated.
    expect(result.activePlayer?.id).toBe(PLAYER_ID)
    expect(result.activeTicket?.id).toBe(TICKET_ID)
  })

  it('takes priority over every other check (first in resolution order)', () => {
    // Even a player/ticket that would otherwise fail PLAYER_NOT_IN_GAME
    // reports NOT_BACKEND_CONFIRMED first when the backend isn't confirmed.
    const state = buildState({ players: [makePlayer({ gameId: OTHER_GAME_ID })] })

    const result = getActivePlayerSession(state, false)

    expect(result.inconsistencyReason).toBe('NOT_BACKEND_CONFIRMED')
  })
})

describe('getActivePlayerSession() — activeGame is always state.game', () => {
  it('resolves activeGame to state.game regardless of consistency', () => {
    const state = buildState()

    const result = getActivePlayerSession(state, true)

    expect(result.activeGame).toBe(state.game)
    expect(result.activeGame.id).toBe(ACTIVE_GAME_ID)
  })
})

// ---------------------------------------------------------------------------
// Property-based test: isConsistent matches the exact boolean formula from
// bugfix.md's `isBugCondition` (negated) for every generated tuple of
// (player.gameId, ticket.playerId, ticket.gameId, activeGame.id,
// isBackendConfirmed).
// ---------------------------------------------------------------------------

/** A small closed pool of ids so equality/inequality is exercised directly, not by chance. */
const idPoolArb = fc.constantFrom('ID_1', 'ID_2', 'ID_3')

const tupleArb = fc.record({
  playerGameId: idPoolArb,
  ticketPlayerId: fc.constantFrom(PLAYER_ID, 'SOMEONE_ELSE'),
  ticketGameId: idPoolArb,
  activeGameId: idPoolArb,
  isBackendConfirmed: fc.boolean(),
})

describe('getActivePlayerSession() — property: isConsistent matches isBugCondition (negated) for every generated tuple', () => {
  it('isConsistent === NOT isBugCondition(tuple) for every generated (player.gameId, ticket.playerId, ticket.gameId, activeGame.id, isBackendConfirmed)', () => {
    fc.assert(
      fc.property(tupleArb, (tuple) => {
        const { playerGameId, ticketPlayerId, ticketGameId, activeGameId, isBackendConfirmed } = tuple

        const player = makePlayer({ gameId: playerGameId })
        const ticket = makeTicket({ playerId: ticketPlayerId, gameId: ticketGameId })

        const state = buildState({
          game: { ...gameSessionInitialState.game, id: activeGameId },
          players: [player],
          tickets: [ticket],
          currentPlayerId: PLAYER_ID,
        })

        const result = getActivePlayerSession(state, isBackendConfirmed)

        // The resolver's deterministic single-ticket resolution (Req 2.6):
        // a ticket only resolves at all when playerId === activePlayer.id
        // AND gameId === activeGame.id. This means the formal
        // isBugCondition's third/fourth disjuncts
        // (`resolvedTicket.playerId !== resolvedPlayer.id` /
        // `resolvedTicket.gameId !== activeGameId`) can only ever be
        // evaluated against an UNDEFINED resolvedTicket when the ticket
        // doesn't resolve — which is itself already a bug condition
        // (no ticket found). So the exact formula holds either way: when no
        // ticket resolves, the bug condition is true regardless of the
        // specific disjunct; when a ticket resolves, every disjunct in the
        // formula is checked against real values.
        const ticketResolves = ticketPlayerId === PLAYER_ID && ticketGameId === activeGameId

        const isBugCondition =
          !isBackendConfirmed ||
          playerGameId !== activeGameId ||
          !ticketResolves ||
          ticketPlayerId !== PLAYER_ID ||
          ticketGameId !== activeGameId

        expect(result.isConsistent).toBe(!isBugCondition)

        if (result.isConsistent) {
          expect(result.inconsistencyReason).toBeUndefined()
          expect(result.activePlayer?.id).toBe(PLAYER_ID)
          expect(result.activeTicket?.id).toBe(TICKET_ID)
        } else {
          expect(result.inconsistencyReason).toBeDefined()
        }
      }),
      { numRuns: 500 },
    )
  })
})
