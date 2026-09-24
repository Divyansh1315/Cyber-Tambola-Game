import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  parseEnvelope,
  toEnvelope,
  PERSIST_VERSION,
  type PersistedSlice,
} from './persistence'
import type { Game, GameStatus } from '../types/game'
import type { Mark } from '../types/mark'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'

// Fast-check arbitraries for the persisted slice (Game / Player[] / Ticket[] / Mark[]).
// Mirrors src/state/persistence.test.ts's Module 3 generator conventions, extended
// with a marks generator and malformed-marks variants for Module 4.

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

/** A Mark for a given player/ticket, with an arbitrary termId/timestamp/validity. */
function markArb(gameId: string, playerId: string, ticketId: string): fc.Arbitrary<Mark> {
  return fc.record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    gameId: fc.constant(gameId),
    playerId: fc.constant(playerId),
    ticketId: fc.constant(ticketId),
    termId: fc.string({ minLength: 1, maxLength: 10 }),
    markedAt: fc.date().map((d) => d.toISOString()),
    valid: fc.boolean(),
  })
}

/**
 * A valid SHARED-state slice (no `currentPlayerId` — that is client-local
 * identity, persisted separately) whose marks reference real
 * players/tickets. Produces distinct player ids so referencing is
 * unambiguous.
 */
const validSliceArb: fc.Arbitrary<PersistedSlice> = gameArb.chain((game) =>
  fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 10 }), {
      minLength: 0,
      maxLength: 5,
    })
    .chain((playerIds) =>
      fc
        .tuple(...playerIds.map((pid) => playerArb(pid, game.id)))
        .chain((players) =>
          fc
            .tuple(...playerIds.map((pid) => ticketArbForPlayer(pid, game.id)))
            .chain((tickets) => {
              const marksArb: fc.Arbitrary<Mark[]> =
                playerIds.length === 0
                  ? fc.constant([])
                  : fc.array(
                      fc
                        .tuple(
                          fc.constantFrom(...playerIds),
                          fc.constantFrom(...(tickets as Ticket[]).map((t) => t.id)),
                        )
                        .chain(([pid, tid]) => markArb(game.id, pid, tid)),
                      { maxLength: 5 },
                    )

              return marksArb.map((marks) => ({
                game,
                players: players as Player[],
                tickets: tickets as Ticket[],
                marks,
                claims: [],
                winners: [],
              }))
            }),
        ),
    ),
)

// Feature: module-4-term-marking-prize-engine, Property 9: Persistence round-trips marks and defaults missing/invalid marks safely
//
// Validates: Requirements 5.1, 5.2, 5.3
describe('persistence marks round-trip (property 9)', () => {
  it('parseEnvelope(JSON.stringify(toEnvelope(slice))) deep-equals the original slice including marks', () => {
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
})

// Feature: module-4-term-marking-prize-engine, Property 9: Persistence round-trips marks and defaults missing/invalid marks safely
//
// Validates: Requirements 5.4, 5.5
describe('persistence marks fail-safe defaulting (property 9)', () => {
  /** An otherwise-valid envelope (version/game/players/tickets) missing marks entirely. */
  function envelopeWithoutMarksKey(slice: PersistedSlice): Record<string, unknown> {
    const envelope = toEnvelope(slice) as unknown as Record<string, unknown>
    const { marks, ...rest } = envelope
    void marks
    return rest
  }

  it('defaults marks to [] when the key is omitted entirely (legacy Module 3 envelope)', () => {
    fc.assert(
      fc.property(validSliceArb, (slice) => {
        const raw = JSON.stringify(envelopeWithoutMarksKey(slice))
        let restored: PersistedSlice | null = null
        expect(() => {
          restored = parseEnvelope(raw)
        }).not.toThrow()

        expect(restored).not.toBeNull()
        expect(restored!.marks).toEqual([])
        expect(restored!.game).toEqual(slice.game)
        expect(restored!.players).toEqual(slice.players)
        expect(restored!.tickets).toEqual(slice.tickets)
      }),
      { numRuns: 150 },
    )
  })

  it('defaults marks to [] when the field is null', () => {
    fc.assert(
      fc.property(validSliceArb, (slice) => {
        const envelope = { ...envelopeWithoutMarksKey(slice), marks: null }
        const raw = JSON.stringify(envelope)
        let restored: PersistedSlice | null = null
        expect(() => {
          restored = parseEnvelope(raw)
        }).not.toThrow()

        expect(restored).not.toBeNull()
        expect(restored!.marks).toEqual([])
        expect(restored!.game).toEqual(slice.game)
        expect(restored!.players).toEqual(slice.players)
        expect(restored!.tickets).toEqual(slice.tickets)
      }),
      { numRuns: 150 },
    )
  })

  it('defaults marks to [] when the field is a non-array value', () => {
    const nonArrayMarksArb = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.dictionary(fc.string(), fc.string()),
    )

    fc.assert(
      fc.property(validSliceArb, nonArrayMarksArb, (slice, badMarks) => {
        const envelope = { ...envelopeWithoutMarksKey(slice), marks: badMarks }
        const raw = JSON.stringify(envelope)
        let restored: PersistedSlice | null = null
        expect(() => {
          restored = parseEnvelope(raw)
        }).not.toThrow()

        expect(restored).not.toBeNull()
        expect(restored!.marks).toEqual([])
        expect(restored!.game).toEqual(slice.game)
        expect(restored!.players).toEqual(slice.players)
        expect(restored!.tickets).toEqual(slice.tickets)
      }),
      { numRuns: 150 },
    )
  })

  it('never throws across omitted/null/non-array marks variants, always stamping the current PERSIST_VERSION', () => {
    fc.assert(
      fc.property(validSliceArb, (slice) => {
        expect(toEnvelope(slice).version).toBe(PERSIST_VERSION)
      }),
      { numRuns: 100 },
    )
  })
})
