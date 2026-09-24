import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fc from 'fast-check'
import { gameSessionReducer, type GameSessionAction } from './gameSessionReducer'
import {
  gameSessionInitialState,
  type GameSessionState,
} from './gameSessionInitialState'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively freeze an object so any mutation attempt throws in strict mode.
 * Used to enforce reducer purity: the reducer must never mutate its input.
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

// --- Fast-check arbitraries for Player and Ticket ---

const cellArb: fc.Arbitrary<TicketCell> = fc.record({
  termId: fc.string({ minLength: 1, maxLength: 10 }),
  term: fc.string({ maxLength: 24 }),
  state: fc.constantFrom(...(['LOCKED', 'AVAILABLE', 'MARKED'] as const)),
  row: fc.integer({ min: 0, max: 2 }),
  col: fc.integer({ min: 0, max: 4 }),
})

function playerArb(id?: string): fc.Arbitrary<Player> {
  return fc
    .record({
      genId: fc.string({ minLength: 1, maxLength: 12 }),
      gameId: fc.string({ minLength: 1, maxLength: 12 }),
      displayName: fc.string({ minLength: 1, maxLength: 20 }),
      employeeDemoId: fc.string({ minLength: 1, maxLength: 20 }),
      ticketId: fc.string({ minLength: 1, maxLength: 12 }),
    })
    .map((b) => {
      const playerId = id ?? b.genId
      return {
        id: playerId,
        gameId: b.gameId,
        displayName: b.displayName,
        employeeDemoId: b.employeeDemoId,
        ticketId: b.ticketId,
        joinedAt: new Date().toISOString(),
        name: b.displayName,
        employeeId: b.employeeDemoId,
        ticketRef: b.ticketId,
      }
    })
}

function ticketArb(playerId?: string): fc.Arbitrary<Ticket> {
  return fc
    .record({
      id: fc.string({ minLength: 1, maxLength: 12 }),
      pid: fc.string({ minLength: 1, maxLength: 12 }),
      gameId: fc.string({ minLength: 1, maxLength: 12 }),
      ref: fc.string({ maxLength: 16 }),
      rows: fc.array(fc.array(cellArb, { minLength: 1, maxLength: 5 }), {
        minLength: 1,
        maxLength: 3,
      }),
    })
    .map((b) => ({
      id: b.id,
      playerId: playerId ?? b.pid,
      gameId: b.gameId,
      createdAt: new Date().toISOString(),
      ref: b.ref,
      rows: b.rows,
    }))
}

/** A player paired with a ticket that references it. */
const playerWithTicketArb: fc.Arbitrary<{ player: Player; ticket: Ticket }> =
  playerArb().chain((player) =>
    ticketArb(player.id).map((ticket) => ({ player, ticket })),
  )

/** A base session state seeded with an arbitrary set of players + tickets. */
const baseStateArb: fc.Arbitrary<GameSessionState> = fc
  .array(playerWithTicketArb, { maxLength: 4 })
  .map((pairs) => ({
    ...gameSessionInitialState,
    game: { ...gameSessionInitialState.game },
    players: pairs.map((p) => p.player),
    tickets: pairs.map((p) => p.ticket),
    currentPlayerId: undefined,
  }))

/** Arbitrary actions across the full union (used for the purity property). */
const actionArb: fc.Arbitrary<GameSessionAction> = fc.oneof(
  fc.constant<GameSessionAction>({ type: 'START_GAME' }),
  fc.constant<GameSessionAction>({ type: 'CALL_NEXT_WORD' }),
  fc.constant<GameSessionAction>({ type: 'PAUSE_GAME' }),
  fc.constant<GameSessionAction>({ type: 'RESUME_GAME' }),
  fc.constant<GameSessionAction>({ type: 'END_GAME' }),
  fc.constant<GameSessionAction>({ type: 'RESET_GAME' }),
  playerWithTicketArb.map<GameSessionAction>(({ player, ticket }) => ({
    type: 'JOIN_PLAYER',
    player,
    ticket,
  })),
  fc
    .string({ minLength: 1, maxLength: 12 })
    .map<GameSessionAction>((playerId) => ({ type: 'RESTORE_PLAYER', playerId })),
)

// ---------------------------------------------------------------------------
// Property 15 — Reducer is pure across all actions
// ---------------------------------------------------------------------------

// Feature: module-3-player-joining-tickets, property 15 — Reducer is pure across all actions
//
// Validates: Requirements 14.4
describe('reducer purity + determinism (property 15)', () => {
  // The reducer never itself performs random ticket generation: tickets are
  // built by the join service *before* dispatch and passed in. Any wall-clock
  // stamping is frozen here so the join/restore/reset actions this module owns
  // are fully deterministic. (Term selection for START_GAME / CALL_NEXT_WORD
  // is intentionally randomized inside the game engine — out of scope for this
  // module's purity guarantee — so those actions are excluded from the
  // determinism check below.)
  beforeAll(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'))
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  const NON_TERM_SELECTING = new Set([
    'PAUSE_GAME',
    'RESUME_GAME',
    'END_GAME',
    // RESET_GAME is deliberately excluded here as of
    // winner-history-and-game-reset: it now generates a fresh random
    // New_Game_Code (Req 9.3) via generateLocalGameCode(), so it is no
    // longer deterministic the way it was under module-3's
    // original 'reset re-seeds the exact same seed game' contract -- this mirrors
    // START_GAME/CALL_NEXT_WORD's own long-standing exclusion for exactly
    // the same reason (a random draw is intentional, not a purity bug).
    'JOIN_PLAYER',
    'RESTORE_PLAYER',
  ])

  it('never mutates the frozen input state and never generates tickets', () => {
    fc.assert(
      fc.property(baseStateArb, actionArb, (state, action) => {
        const frozen = deepFreeze(state)
        const snapshotPlayers = frozen.players.length
        const snapshotTickets = frozen.tickets.length

        // Dispatch against a frozen state — any in-place mutation would throw.
        const out1 = gameSessionReducer(frozen, action)
        const out2 = gameSessionReducer(frozen, action)

        // Deterministic for every action that does not draw a random term:
        // same input → structurally equal output (clock is frozen).
        if (NON_TERM_SELECTING.has(action.type)) {
          expect(out2).toEqual(out1)
        }

        // Input untouched.
        expect(frozen.players.length).toBe(snapshotPlayers)
        expect(frozen.tickets.length).toBe(snapshotTickets)

        // Never generates random tickets: a JOIN adds exactly the passed
        // ticket; any other action leaves ticket count unchanged (except the
        // seed reset, which zeroes it).
        if (action.type === 'JOIN_PLAYER') {
          expect(out1.tickets.length).toBe(snapshotTickets + 1)
        } else if (action.type === 'RESET_GAME') {
          expect(out1.tickets.length).toBe(0)
        } else {
          expect(out1.tickets.length).toBe(snapshotTickets)
        }
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 16 — JOIN_PLAYER appends and sets current player
// ---------------------------------------------------------------------------

// Feature: module-3-player-joining-tickets, property 16 — JOIN_PLAYER appends and sets current player
//
// Validates: Requirements 4.5, 6.3, 14.2
describe('JOIN_PLAYER appends and sets current (property 16)', () => {
  it('appends player + ticket (each +1) and sets currentPlayerId to the player id', () => {
    fc.assert(
      fc.property(baseStateArb, playerWithTicketArb, (state, { player, ticket }) => {
        const frozen = deepFreeze(state)
        const before = { players: frozen.players.length, tickets: frozen.tickets.length }

        const next = gameSessionReducer(frozen, { type: 'JOIN_PLAYER', player, ticket })

        expect(next.players.length).toBe(before.players + 1)
        expect(next.tickets.length).toBe(before.tickets + 1)
        expect(next.players[next.players.length - 1]).toEqual(player)
        expect(next.tickets[next.tickets.length - 1]).toEqual(ticket)
        expect(next.currentPlayerId).toBe(player.id)
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 17 — RESTORE_PLAYER sets current without creating records
// ---------------------------------------------------------------------------

// Feature: module-3-player-joining-tickets, property 17 — RESTORE_PLAYER sets current without creating records
//
// Validates: Requirements 5.2, 14.3
describe('RESTORE_PLAYER sets current without creating records (property 17)', () => {
  it('sets currentPlayerId to an existing id and leaves players/tickets unchanged', () => {
    // Base state with at least one player so there is an id to restore.
    const nonEmptyStateArb = fc
      .array(playerWithTicketArb, { minLength: 1, maxLength: 4 })
      .map((pairs) => ({
        ...gameSessionInitialState,
        game: { ...gameSessionInitialState.game },
        players: pairs.map((p) => p.player),
        tickets: pairs.map((p) => p.ticket),
        currentPlayerId: undefined as string | undefined,
      }))

    fc.assert(
      fc.property(
        nonEmptyStateArb.chain((state) =>
          fc
            .constantFrom(...state.players.map((p) => p.id))
            .map((playerId) => ({ state, playerId })),
        ),
        ({ state, playerId }) => {
          const frozen = deepFreeze(state)
          const next = gameSessionReducer(frozen, { type: 'RESTORE_PLAYER', playerId })

          expect(next.currentPlayerId).toBe(playerId)
          expect(next.players).toEqual(frozen.players)
          expect(next.tickets).toEqual(frozen.tickets)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('ignores safely when the player id does not exist', () => {
    fc.assert(
      fc.property(baseStateArb, fc.string({ minLength: 1, maxLength: 12 }), (state, rawId) => {
        const absentId = state.players.some((p) => p.id === rawId)
          ? `${rawId}-absent-x`
          : rawId
        const frozen = deepFreeze(state)
        const next = gameSessionReducer(frozen, { type: 'RESTORE_PLAYER', playerId: absentId })

        // State unchanged; current player not set to a dangling id.
        expect(next).toBe(frozen)
        expect(next.currentPlayerId).toBeUndefined()
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 18 — RESET_GAME clears session and returns to lobby
// ---------------------------------------------------------------------------

// Feature: module-3-player-joining-tickets, property 18 — RESET_GAME clears session and returns to lobby
//
// Validates: Requirements 15.1, 15.2
describe('RESET_GAME clears session and returns to lobby (property 18)', () => {
  it('clears players/tickets/currentPlayerId and resets the game to LOBBY', () => {
    fc.assert(
      fc.property(baseStateArb, (state) => {
        // Give the state a non-trivial current player + game progress first.
        const dirty: GameSessionState = {
          ...state,
          currentPlayerId: state.players[0]?.id,
          game: {
            ...state.game,
            status: 'WORD_ACTIVE',
            currentRound: 7,
            currentTermId: 'TERM_009',
            revealedTermIds: ['TERM_001', 'TERM_002'],
          },
        }
        const next = gameSessionReducer(deepFreeze(dirty), { type: 'RESET_GAME' })

        expect(next.players).toEqual([])
        expect(next.tickets).toEqual([])
        expect(next.currentPlayerId).toBeUndefined()
        expect(next.game.status).toBe('LOBBY')
        expect(next.game.currentRound).toBe(0)
        expect(next.game.currentTermId).toBeUndefined()
        expect(next.game.revealedTermIds).toEqual([])
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 19 — Participant count equals players length
// ---------------------------------------------------------------------------

// Feature: module-3-player-joining-tickets, property 19 — Participant count equals players length
//
// Validates: Requirements 6.1, 6.3
describe('participant count equals players length (property 19)', () => {
  it('after a sequence of JOIN_PLAYER dispatches, players.length equals the join count', () => {
    fc.assert(
      fc.property(fc.array(playerWithTicketArb, { maxLength: 8 }), (joins) => {
        // The host derives the participant count as players.length.
        const participantCount = (s: GameSessionState) => s.players.length

        let state: GameSessionState = {
          ...gameSessionInitialState,
          game: { ...gameSessionInitialState.game },
          players: [],
          tickets: [],
          currentPlayerId: undefined,
        }

        joins.forEach(({ player, ticket }, i) => {
          state = gameSessionReducer(state, { type: 'JOIN_PLAYER', player, ticket })
          // After i+1 joins, the derived count is exactly i+1.
          expect(participantCount(state)).toBe(i + 1)
        })

        expect(participantCount(state)).toBe(joins.length)
      }),
      { numRuns: 200 },
    )
  })
})
