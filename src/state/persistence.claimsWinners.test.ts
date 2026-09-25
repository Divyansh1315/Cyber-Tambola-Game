import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { parseEnvelope, toEnvelope, type PersistedSlice } from './persistence'
import type { Game, GameStatus } from '../types/game'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'
import type { PrizeClaim, PrizeId, ValidationStatus, HostDecision, Winner } from '../types/prize'

// Fast-check arbitraries reused/extended from persistence.test.ts's established
// conventions (Game / Player[] / Ticket[]), plus new PrizeClaim/Winner
// generators for this module's `claims`/`winners` fields.

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

const prizeIdArb: fc.Arbitrary<PrizeId> = fc.constantFrom(
  ...([
    'CYBER_FIVE',
    'FIREWALL_LINE',
    'SECURITY_LINE',
    'DATA_DEFENDER_LINE',
    'CYBER_FULL_HOUSE',
  ] as const),
)

const validationStatusArb: fc.Arbitrary<ValidationStatus> = fc.constantFrom(
  ...(['PENDING', 'VALID', 'INVALID'] as const),
)

const hostDecisionArb: fc.Arbitrary<HostDecision> = fc.constantFrom(
  ...(['PENDING', 'CONFIRMED', 'REJECTED'] as const),
)

const claimArb: fc.Arbitrary<PrizeClaim> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  gameId: fc.string({ minLength: 1, maxLength: 12 }),
  playerId: fc.string({ minLength: 1, maxLength: 12 }),
  ticketId: fc.string({ minLength: 1, maxLength: 12 }),
  prizeId: prizeIdArb,
  submittedAt: fc.date().map((d) => d.toISOString()),
  validationStatus: validationStatusArb,
  hostDecision: hostDecisionArb,
  rejectionReason: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
  decidedAt: fc.option(fc.date().map((d) => d.toISOString()), { nil: undefined }),
  prizeLabel: fc.string({ minLength: 1, maxLength: 20 }),
  playerName: fc.string({ minLength: 1, maxLength: 20 }),
  ticketRef: fc.string({ minLength: 1, maxLength: 16 }),
})

const winnerArb: fc.Arbitrary<Winner> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  gameId: fc.string({ minLength: 1, maxLength: 12 }),
  prizeId: prizeIdArb,
  playerId: fc.string({ minLength: 1, maxLength: 12 }),
  ticketId: fc.string({ minLength: 1, maxLength: 12 }),
  claimId: fc.string({ minLength: 1, maxLength: 12 }),
  confirmedAt: fc.date().map((d) => d.toISOString()),
  prizeLabel: fc.string({ minLength: 1, maxLength: 20 }),
  playerName: fc.string({ minLength: 1, maxLength: 20 }),
  ticketRef: fc.string({ minLength: 1, maxLength: 16 }),
})

/**
 * A valid SHARED-state slice including non-empty `claims`/`winners`, extending
 * persistence.test.ts's `validSliceArb` convention.
 */
const validSliceWithClaimsWinnersArb: fc.Arbitrary<PersistedSlice> = gameArb.chain((game) =>
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
            .chain((tickets) =>
              fc
                .tuple(
                  fc.array(claimArb, { maxLength: 5 }),
                  fc.array(winnerArb, { maxLength: 5 }),
                )
                .map(([claims, winners]) => ({
                  game,
                  players: players as Player[],
                  tickets: tickets as Ticket[],
                  marks: [],
                  claims,
                  winners,
                })),
            ),
        ),
    ),
)

// Feature: module-5-prize-claim-processing-winner-management, Property 16: Persistence round-trips claims and winners and defaults missing/invalid values safely
//
// Validates: Requirements 16.2, 16.3, 16.4
describe('claims/winners persistence round-trip (property 16)', () => {
  it('round-trips claims and winners identically through toEnvelope/JSON/parseEnvelope', () => {
    fc.assert(
      fc.property(validSliceWithClaimsWinnersArb, (slice) => {
        const raw = JSON.stringify(toEnvelope(slice))
        const restored = parseEnvelope(raw)
        expect(restored).not.toBeNull()
        expect(restored).toEqual(slice)
        expect(restored?.claims).toEqual(slice.claims)
        expect(restored?.winners).toEqual(slice.winners)
      }),
      { numRuns: 100 },
    )
  })

  it('defaults claims/winners to [] when missing/null/non-array without rejecting the rest of the envelope', () => {
    const nonArrayValueArb = fc.oneof(
      fc.constant(null),
      fc.string(),
      fc.integer(),
      fc.record({ foo: fc.string() }),
      fc.boolean(),
    )

    // Which of claims/winners is mutated, and how (omit key vs bad value).
    const fieldArb = fc.constantFrom('claims', 'winners') as fc.Arbitrary<'claims' | 'winners'>
    const modeArb = fc.constantFrom('omit', 'bad-value') as fc.Arbitrary<'omit' | 'bad-value'>

    fc.assert(
      fc.property(
        validSliceWithClaimsWinnersArb,
        fieldArb,
        modeArb,
        nonArrayValueArb,
        (slice, field, mode, badValue) => {
          const envelope = toEnvelope(slice) as unknown as Record<string, unknown>

          if (mode === 'omit') {
            delete envelope[field]
          } else {
            envelope[field] = badValue
          }

          const raw = JSON.stringify(envelope)
          const restored = parseEnvelope(raw)

          expect(restored).not.toBeNull()
          // The mutated field defaults safely to [].
          expect(restored?.[field]).toEqual([])
          // The rest of the envelope still restores correctly.
          expect(restored?.game).toEqual(slice.game)
          expect(restored?.players).toEqual(slice.players)
          expect(restored?.tickets).toEqual(slice.tickets)
          expect(restored?.marks).toEqual(slice.marks)
          // The untouched field still round-trips correctly.
          const otherField = field === 'claims' ? 'winners' : 'claims'
          expect(restored?.[otherField]).toEqual(slice[otherField])
        },
      ),
      { numRuns: 100 },
    )
  })

  it('defaults both claims and winners to [] together when both are missing', () => {
    fc.assert(
      fc.property(validSliceWithClaimsWinnersArb, (slice) => {
        const envelope = toEnvelope(slice) as unknown as Record<string, unknown>
        delete envelope.claims
        delete envelope.winners

        const raw = JSON.stringify(envelope)
        const restored = parseEnvelope(raw)

        expect(restored).not.toBeNull()
        expect(restored?.claims).toEqual([])
        expect(restored?.winners).toEqual([])
        expect(restored?.game).toEqual(slice.game)
        expect(restored?.players).toEqual(slice.players)
        expect(restored?.tickets).toEqual(slice.tickets)
        expect(restored?.marks).toEqual(slice.marks)
      }),
      { numRuns: 100 },
    )
  })
})
