import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  parseEnvelope,
  toEnvelope,
  PERSIST_VERSION,
  type PersistedSlice,
} from './persistence'
import type { Game, GameStatus } from '../types/game'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'

// Fast-check arbitraries for the persisted slice (Game / Player[] / Ticket[]).

const gameStatusArb: fc.Arbitrary<GameStatus> = fc.constantFrom(
  ...(['LOBBY', 'WORD_ACTIVE', 'PAUSED', 'COMPLETED'] as const),
)

const gameArb: fc.Arbitrary<Game> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  code: fc.string({ minLength: 1, maxLength: 8 }),
  status: gameStatusArb,
  createdAt: fc.date().map((d) => d.toISOString()),
  currentRound: fc.nat({ max: 30 }),
  currentTermId: fc.option(fc.string({ minLength: 1, maxLength: 10 }), {
    nil: undefined,
  }),
  revealedTermIds: fc.array(fc.string({ minLength: 1, maxLength: 10 }), {
    maxLength: 10,
  }),
})

const cellArb: fc.Arbitrary<TicketCell> = fc.record({
  termId: fc.string({ minLength: 1, maxLength: 10 }),
  term: fc.string({ maxLength: 24 }),
  state: fc.constantFrom('LOCKED', 'AVAILABLE', 'MARKED'),
  row: fc.integer({ min: 0, max: 2 }),
  col: fc.integer({ min: 0, max: 4 }),
})

/** A ticket for a given player id (so tickets reference real players). */
function ticketArbForPlayer(playerId: string, gameId: string): fc.Arbitrary<Ticket> {
  return fc.record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    playerId: fc.constant(playerId),
    gameId: fc.constant(gameId),
    createdAt: fc.date().map((d) => d.toISOString()),
    ref: fc.string({ maxLength: 16 }),
    rows: fc.array(fc.array(cellArb, { minLength: 1, maxLength: 5 }), {
      minLength: 1,
      maxLength: 3,
    }),
  })
}

function playerArb(id: string, gameId: string): fc.Arbitrary<Player> {
  return fc
    .record({
      displayName: fc.string({ minLength: 1, maxLength: 20 }),
      employeeDemoId: fc.string({ minLength: 1, maxLength: 20 }),
      ticketId: fc.string({ minLength: 1, maxLength: 12 }),
    })
    .map((base) => ({
      id,
      gameId,
      displayName: base.displayName,
      employeeDemoId: base.employeeDemoId,
      ticketId: base.ticketId,
      joinedAt: new Date().toISOString(),
      name: base.displayName,
      employeeId: base.employeeDemoId,
      ticketRef: base.ticketId,
    }))
}

/**
 * A valid SHARED-state slice (no `currentPlayerId` — that is client-local
 * identity, persisted separately; see GameSessionContext.tsx).
 */
const validSliceArb: fc.Arbitrary<PersistedSlice> = gameArb.chain((game) =>
  fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), {
      minLength: 0,
      maxLength: 5,
    })
    .chain((playerIds) =>
      fc
        .tuple(
          ...playerIds.map((pid) => playerArb(pid, game.id)),
        )
        .chain((players) =>
          fc
            .tuple(
              ...playerIds.map((pid) => ticketArbForPlayer(pid, game.id)),
            )
            .map((tickets) => ({
              game,
              players: players as Player[],
              tickets: tickets as Ticket[],
              marks: [],
              claims: [],
              winners: [],
            })),
        ),
    ),
)

// Feature: module-3-player-joining-tickets, property 20 — Persistence round-trips valid envelopes
//
// Validates: Requirements 16.1, 16.2, 16.3
describe('persistence round-trip (property 20)', () => {
  it('parseEnvelope(JSON.stringify(toEnvelope(slice))) deep-equals the original slice', () => {
    fc.assert(
      fc.property(validSliceArb, (slice) => {
        const raw = JSON.stringify(toEnvelope(slice))
        const restored = parseEnvelope(raw)
        expect(restored).not.toBeNull()
        expect(restored).toEqual({
          game: slice.game,
          players: slice.players,
          tickets: slice.tickets,
          marks: slice.marks,
          claims: slice.claims,
          winners: slice.winners,
        })
      }),
      { numRuns: 200 },
    )
  })

  it('always stamps the current PERSIST_VERSION in the envelope', () => {
    fc.assert(
      fc.property(validSliceArb, (slice) => {
        expect(toEnvelope(slice).version).toBe(PERSIST_VERSION)
      }),
      { numRuns: 100 },
    )
  })
})

// Feature: module-3-player-joining-tickets, property 21 — Malformed persistence never throws and falls back
//
// Validates: Requirements 16.4
describe('malformed persistence (property 21)', () => {
  it('returns null and never throws for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        let result: unknown
        expect(() => {
          result = parseEnvelope(raw)
        }).not.toThrow()
        // Arbitrary strings are essentially never a valid v2 envelope.
        expect(result).toBeNull()
      }),
      { numRuns: 200 },
    )
  })

  it('rejects the old Module 2 shape that lacks a version marker', () => {
    fc.assert(
      fc.property(gameArb, (game) => {
        // Old Module 2 persisted only the game object (no version wrapper).
        const oldShape = JSON.stringify(game)
        expect(parseEnvelope(oldShape)).toBeNull()

        // An envelope-like object with game but no version is also rejected.
        const noVersion = JSON.stringify({ game, players: [], tickets: [] })
        expect(parseEnvelope(noVersion)).toBeNull()
      }),
      { numRuns: 200 },
    )
  })

  it('returns null for empty / null input', () => {
    expect(parseEnvelope(null)).toBeNull()
    expect(parseEnvelope('')).toBeNull()
  })

  it('rejects a version marker other than the current PERSIST_VERSION', () => {
    fc.assert(
      fc.property(
        gameArb,
        fc.integer().filter((v) => v !== PERSIST_VERSION),
        (game, version) => {
          const raw = JSON.stringify({ version, game, players: [], tickets: [] })
          expect(parseEnvelope(raw)).toBeNull()
        },
      ),
      { numRuns: 100 },
    )
  })
})

// Feature: module-3-player-joining-tickets, property 22 — Dangling current player is reconciled away
//
// `currentPlayerId` is no longer part of the shared persisted envelope (it is
// client-local identity persisted under its own key — see
// GameSessionContext.tsx's `initState`, which now owns this reconciliation
// against the restored `players` array). Coverage for that reconciliation
// lives in gameSessionReducer.playerIdentity.test.ts /
// playerIdentityHydration.integration.test.tsx instead.
//
// Validates: Requirements 16.5
describe('dangling current player reconciliation (property 22)', () => {
  it('the shared envelope never carries currentPlayerId at all', () => {
    fc.assert(
      fc.property(validSliceArb, (slice) => {
        const restored = parseEnvelope(JSON.stringify(toEnvelope(slice)))
        expect(restored).not.toBeNull()
        expect(restored).not.toHaveProperty('currentPlayerId')
      }),
      { numRuns: 100 },
    )
  })
})
