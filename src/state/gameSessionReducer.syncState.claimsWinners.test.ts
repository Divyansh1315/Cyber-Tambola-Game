// Feature: module-5-prize-claim-processing-winner-management, updated for
// module-6-realtime-multi-device-sync's removal of the `rev`-gated
// SYNC_STATE mechanism (design.md Decision 6/7).
//
// Property test for SYNC_LOCAL's handling of the `claims`/`winners` fields:
//   Property 17: Cross-tab sync includes, losslessly upserts-by-id, and
//   safely defaults claims and winners without disturbing currentPlayerId
//
// Validates: Requirements 17.2, 17.3, 17.4, 17.5, 17.6
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { gameSessionReducer, type SharedStatePayload } from './gameSessionReducer'
import { gameSessionInitialState, type GameSessionState } from './gameSessionInitialState'
import type { Game } from '../types/game'
import type { Player } from '../types/player'
import type { Ticket } from '../types/ticket'
import type { Mark } from '../types/mark'
import type { PrizeClaim } from '../types/claim'
import type { Winner } from '../types/prize'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

function makeGame(over: Partial<Game> = {}): Game {
  return {
    id: 'GAME_001',
    code: 'CYBER24',
    status: 'WORD_ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    currentRound: 1,
    revealedTermIds: [],
    ...over,
  }
}

function makePlayer(id: string): Player {
  return {
    id,
    gameId: 'GAME_001',
    displayName: `Player ${id}`,
    employeeDemoId: `EMP-${id}`,
    ticketId: `TICKET_${id}`,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: `Player ${id}`,
    employeeId: `EMP-${id}`,
    ticketRef: `Ticket #${id}`,
  }
}

function makeTicket(id: string, playerId: string): Ticket {
  return {
    id,
    playerId,
    gameId: 'GAME_001',
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: `Ticket #${id}`,
    rows: [[{ termId: 'TERM_001', term: 'Phishing', state: 'LOCKED', row: 0, col: 0 }]],
  }
}

const claimArb: fc.Arbitrary<PrizeClaim> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: fc.constant('GAME_001'),
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  prizeId: fc.constantFrom(
    'CYBER_FIVE',
    'FIREWALL_LINE',
    'SECURITY_LINE',
    'DATA_DEFENDER_LINE',
    'CYBER_FULL_HOUSE',
  ),
  submittedAt: fc.constant('2026-01-01T00:00:00.000Z'),
  validationStatus: fc.constantFrom('PENDING', 'VALID', 'INVALID'),
  hostDecision: fc.constantFrom('PENDING', 'CONFIRMED', 'REJECTED'),
  prizeLabel: fc.string({ minLength: 1, maxLength: 10 }),
  playerName: fc.string({ minLength: 1, maxLength: 10 }),
  ticketRef: fc.string({ minLength: 1, maxLength: 10 }),
})

const winnerArb: fc.Arbitrary<Winner> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: fc.constant('GAME_001'),
  prizeId: fc.constantFrom(
    'CYBER_FIVE',
    'FIREWALL_LINE',
    'SECURITY_LINE',
    'DATA_DEFENDER_LINE',
    'CYBER_FULL_HOUSE',
  ),
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  claimId: fc.string({ minLength: 1, maxLength: 10 }),
  confirmedAt: fc.constant('2026-01-01T00:00:00.000Z'),
  prizeLabel: fc.string({ minLength: 1, maxLength: 10 }),
  playerName: fc.string({ minLength: 1, maxLength: 10 }),
  ticketRef: fc.string({ minLength: 1, maxLength: 10 }),
})

/**
 * A base session state seeded with an arbitrary set of local claims/winners
 * (and an arbitrary currentPlayerId) so the merge/no-disturb behavior can be
 * checked against genuinely pre-existing local data, not just an empty seed.
 */
function baseStateArb(): fc.Arbitrary<GameSessionState> {
  return fc
    .record({
      localClaims: fc.uniqueArray(claimArb, { maxLength: 4, selector: (c) => c.id }),
      localWinners: fc.uniqueArray(winnerArb, { maxLength: 4, selector: (w) => w.id }),
      currentPlayerId: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: undefined }),
    })
    .map(({ localClaims, localWinners, currentPlayerId }) => ({
      ...gameSessionInitialState,
      game: { ...gameSessionInitialState.game },
      players: [],
      tickets: [],
      currentPlayerId,
      marks: [] as Mark[],
      claims: localClaims,
      winners: localWinners,
    }))
}

/** A valid SharedStatePayload shape whose `claims`/`winners` are actual arrays. */
function validPayloadArb(): fc.Arbitrary<SharedStatePayload> {
  return fc
    .record({
      game: fc.record({
        id: fc.string({ minLength: 1, maxLength: 10 }),
        status: fc.constantFrom<Game['status']>('LOBBY', 'WORD_ACTIVE', 'PAUSED', 'COMPLETED'),
        revealedTermIds: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 5 }),
      }),
      players: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 3 }).map((ids) =>
        ids.map((id) => makePlayer(id)),
      ),
      tickets: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 3 }).map((ids) =>
        ids.map((id) => makeTicket(`T_${id}`, id)),
      ),
      marks: fc.constant([] as Mark[]),
      claims: fc.uniqueArray(claimArb, { maxLength: 5, selector: (c) => c.id }),
      winners: fc.uniqueArray(winnerArb, { maxLength: 5, selector: (w) => w.id }),
    })
    .map(({ game, players, tickets, marks, claims, winners }) => ({
      game: makeGame(game),
      players,
      tickets,
      marks,
      claims,
      winners,
    }))
}

/** Malformed variants for the `claims`/`winners` fields (Req 17.5). */
const badCollectionArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.string(),
  fc.integer(),
  fc.record({ notAnArray: fc.boolean() }),
)

// ---------------------------------------------------------------------------
// Property 17 — sync includes, losslessly upserts-by-id, and safely defaults
// claims/winners without disturbing currentPlayerId
// ---------------------------------------------------------------------------

describe('SYNC_LOCAL upserts and safely defaults claims/winners (property 17)', () => {
  it('losslessly unions local + incoming claims/winners by id', () => {
    fc.assert(
      fc.property(baseStateArb(), validPayloadArb(), (state, payload) => {
        const frozen = deepFreeze(state)

        const next = gameSessionReducer(frozen, { type: 'SYNC_LOCAL', payload })

        // Every local claim/winner id must still be present.
        const nextClaimIds = new Set(next.claims.map((c) => c.id))
        const nextWinnerIds = new Set(next.winners.map((w) => w.id))
        for (const localClaim of state.claims) {
          expect(nextClaimIds.has(localClaim.id)).toBe(true)
        }
        for (const localWinner of state.winners) {
          expect(nextWinnerIds.has(localWinner.id)).toBe(true)
        }
        // Every incoming claim/winner id must be present too (union).
        for (const incomingClaim of payload.claims) {
          expect(nextClaimIds.has(incomingClaim.id)).toBe(true)
        }
        for (const incomingWinner of payload.winners) {
          expect(nextWinnerIds.has(incomingWinner.id)).toBe(true)
        }
        // The merged size never exceeds the union of unique ids on both
        // sides (no duplication introduced by the upsert).
        const expectedClaimIdCount = new Set([
          ...state.claims.map((c) => c.id),
          ...payload.claims.map((c) => c.id),
        ]).size
        const expectedWinnerIdCount = new Set([
          ...state.winners.map((w) => w.id),
          ...payload.winners.map((w) => w.id),
        ]).size
        expect(next.claims.length).toBe(expectedClaimIdCount)
        expect(next.winners.length).toBe(expectedWinnerIdCount)
      }),
      { numRuns: 100 },
    )
  })

  it('defaults claims/winners to [] when missing/null/non-array without losing the rest of the sync, and never drops local claims/winners', () => {
    fc.assert(
      fc.property(
        baseStateArb(),
        validPayloadArb(),
        badCollectionArb,
        badCollectionArb,
        (state, basePayload, badClaims, badWinners) => {
          const frozen = deepFreeze(state)
          const payload = {
            ...basePayload,
            claims: badClaims,
            winners: badWinners,
          } as unknown as SharedStatePayload
          deepFreeze(payload)

          const next = gameSessionReducer(frozen, { type: 'SYNC_LOCAL', payload })

          // Nothing crashes, and other fields still apply.
          expect(next.game.id).toBe(basePayload.game.id)
          expect(next.players).toEqual(basePayload.players)
          expect(next.tickets).toEqual(basePayload.tickets)

          // Malformed incoming claims/winners are treated as empty, so
          // the result is exactly the local claims/winners, untouched.
          expect(next.claims).toEqual(state.claims)
          expect(next.winners).toEqual(state.winners)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('never touches currentPlayerId as a result of any claims/winners-bearing SYNC_LOCAL payload', () => {
    fc.assert(
      fc.property(baseStateArb(), validPayloadArb(), (state, payload) => {
        const frozen = deepFreeze(state)
        const before = state.currentPlayerId

        const next = gameSessionReducer(frozen, { type: 'SYNC_LOCAL', payload })

        expect(next.currentPlayerId).toBe(before)
      }),
      { numRuns: 100 },
    )
  })

  it('never throws for any valid-shape payload regardless of claims/winners content', () => {
    fc.assert(
      fc.property(baseStateArb(), validPayloadArb(), (state, payload) => {
        const frozen = deepFreeze(state)
        expect(() =>
          gameSessionReducer(frozen, { type: 'SYNC_LOCAL', payload }),
        ).not.toThrow()
      }),
      { numRuns: 100 },
    )
  })
})
