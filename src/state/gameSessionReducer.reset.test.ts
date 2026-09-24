// Feature: module-4-term-marking-prize-engine
//
// Property test extending Module 3's RESET_GAME guarantee (property 18 in
// gameSessionReducer.test.ts) to cover the new `marks` collection:
//   Property 11: RESET_GAME clears marks along with the rest of the session
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState, type GameSessionState } from './gameSessionInitialState'
import { PRIZES } from '../utils/prizeEngine'
import { isPrizeClosed } from '../utils/winnerEngine'
import type { Player } from '../types/player'
import type { Ticket } from '../types/ticket'
import type { Mark } from '../types/mark'
import type { GameStatus } from '../types/game'
import type { PrizeClaim } from '../types/claim'
import type { PrizeId, Winner } from '../types/prize'

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

const markArb: fc.Arbitrary<Mark> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: fc.string({ minLength: 1, maxLength: 10 }),
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  termId: fc.string({ minLength: 1, maxLength: 10 }),
  markedAt: fc.constant('2026-01-01T00:00:00.000Z'),
  valid: fc.boolean(),
})

/** A "dirty" session state fixture with non-empty players/tickets/marks and
 * mid-game progress, so RESET_GAME has real state to clear. */
const dirtyStateArb: fc.Arbitrary<GameSessionState> = fc
  .record({
    ids: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 4 }),
    marks: fc.array(markArb, { maxLength: 6 }),
    currentRound: fc.integer({ min: 1, max: 20 }),
    revealedTermIds: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 5 }),
    status: fc.constantFrom<GameStatus>('LOBBY', 'WORD_ACTIVE', 'PAUSED', 'COMPLETED'),
  })
  .map(({ ids, marks, currentRound, revealedTermIds, status }) => {
    const players = ids.map((id) => makePlayer(id))
    const tickets = ids.map((id) => makeTicket(`TICKET_${id}`, id))
    return {
      ...gameSessionInitialState,
      game: {
        ...gameSessionInitialState.game,
        status,
        currentRound,
        currentTermId: revealedTermIds[0],
        revealedTermIds,
      },
      players,
      tickets,
      currentPlayerId: players[0]?.id,
      marks,
    }
  })

// ---------------------------------------------------------------------------
// Property 11 — RESET_GAME clears marks along with the rest of the session
// ---------------------------------------------------------------------------

// Feature: module-4-term-marking-prize-engine, Property 11: RESET_GAME clears marks along with the rest of the session
//
// Validates: Requirements 17.1, 17.2, 17.3
describe('RESET_GAME clears marks along with the rest of the session (property 11)', () => {
  it('clears marks, players, tickets, currentPlayerId, and revealedTermIds', () => {
    fc.assert(
      fc.property(dirtyStateArb, (state) => {
        const frozen = deepFreeze(state)
        const next = gameSessionReducer(frozen, { type: 'RESET_GAME' })

        expect(next.marks).toEqual([])
        expect(next.players).toEqual([])
        expect(next.tickets).toEqual([])
        expect(next.currentPlayerId).toBeUndefined()
        expect(next.game.revealedTermIds).toEqual([])
      }),
      { numRuns: 200 },
    )
  })

  it('resets even when marks is already empty (idempotent boundary case)', () => {
    const state: GameSessionState = {
      ...gameSessionInitialState,
      marks: [],
    }
    const next = gameSessionReducer(deepFreeze(state), { type: 'RESET_GAME' })
    expect(next.marks).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Property 18 — RESET_GAME clears claims and winners, and every prize
// reports open afterward
// ---------------------------------------------------------------------------

const prizeIdArb: fc.Arbitrary<PrizeId> = fc.constantFrom(...PRIZES.map((p) => p.id))

const claimArb: fc.Arbitrary<PrizeClaim> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: fc.string({ minLength: 1, maxLength: 10 }),
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  prizeId: prizeIdArb,
  submittedAt: fc.constant('2026-01-01T00:00:00.000Z'),
  validationStatus: fc.constantFrom('PENDING', 'VALID', 'INVALID'),
  hostDecision: fc.constantFrom('PENDING', 'CONFIRMED', 'REJECTED'),
  rejectionReason: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
  decidedAt: fc.option(fc.constant('2026-01-01T00:10:00.000Z'), { nil: undefined }),
  prizeLabel: fc.string({ minLength: 1, maxLength: 20 }),
  playerName: fc.string({ minLength: 1, maxLength: 20 }),
  ticketRef: fc.string({ minLength: 1, maxLength: 10 }),
})

const winnerArb: fc.Arbitrary<Winner> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: fc.string({ minLength: 1, maxLength: 10 }),
  prizeId: prizeIdArb,
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  claimId: fc.string({ minLength: 1, maxLength: 10 }),
  confirmedAt: fc.constant('2026-01-01T00:10:00.000Z'),
  prizeLabel: fc.string({ minLength: 1, maxLength: 20 }),
  playerName: fc.string({ minLength: 1, maxLength: 20 }),
})

/** A "dirty" session state fixture with non-empty claims/winners (in
 * addition to the Module 4 dirty fields) so RESET_GAME has real claim/winner
 * state to clear. */
const dirtyStateWithClaimsArb: fc.Arbitrary<GameSessionState> = fc
  .record({
    base: dirtyStateArb,
    claims: fc.array(claimArb, { maxLength: 6 }),
    // Ensure at least one winner references the game's actual id so
    // isPrizeClosed would report a closed prize pre-reset (making the
    // post-reset "all open" assertion meaningful).
    winners: fc.array(winnerArb, { maxLength: 5 }),
  })
  .map(({ base, claims, winners }) => ({
    ...base,
    claims,
    winners: winners.map((w) => ({ ...w, gameId: base.game.id })),
  }))

// Feature: module-5-prize-claim-processing-winner-management, Property 18: RESET_GAME clears claims and winners, and every prize reports open afterward
//
// Validates: Requirements 19.1, 19.2
describe('RESET_GAME clears claims and winners, and every prize reports open afterward (property 18)', () => {
  it('clears claims and winners, and reports every prize open afterward', () => {
    fc.assert(
      fc.property(dirtyStateWithClaimsArb, (state) => {
        const frozen = deepFreeze(state)
        const next = gameSessionReducer(frozen, { type: 'RESET_GAME' })

        expect(next.claims).toEqual([])
        expect(next.winners).toEqual([])

        for (const prize of PRIZES) {
          expect(isPrizeClosed(next.winners, next.game.id, prize.id)).toBe(false)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('resets even when claims/winners are already empty (idempotent boundary case)', () => {
    const state: GameSessionState = {
      ...gameSessionInitialState,
      claims: [],
      winners: [],
    }
    const next = gameSessionReducer(deepFreeze(state), { type: 'RESET_GAME' })
    expect(next.claims).toEqual([])
    expect(next.winners).toEqual([])
  })
})
