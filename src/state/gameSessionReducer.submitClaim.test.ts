// Feature: module-5-prize-claim-processing-winner-management
//
// Property tests for SUBMIT_PRIZE_CLAIM:
//   Property 3: Claims are only ever appended or selectively updated by id,
//               never bulk-rewritten
//   Property 9: Claim and winner actions never affect marks, tickets,
//               players, currentPlayerId, or other prizes' progress
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState, type GameSessionState } from './gameSessionInitialState'
import { PRIZES, getAllPrizeProgress, getPlayerTicketMarks } from '../utils/prizeEngine'
import type { Player } from '../types/player'
import type { Ticket } from '../types/ticket'
import type { Mark } from '../types/mark'
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

const prizeIdArb: fc.Arbitrary<PrizeId> = fc.constantFrom(...PRIZES.map((p) => p.id))

function makePlayer(id: string, ticketId: string): Player {
  return {
    id,
    gameId: 'GAME_001',
    displayName: `Player ${id}`,
    employeeDemoId: `EMP-${id}`,
    ticketId,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: `Player ${id}`,
    employeeId: `EMP-${id}`,
    ticketRef: ticketId,
  }
}

function makeTicket(id: string, playerId: string): Ticket {
  return {
    id,
    playerId,
    gameId: 'GAME_001',
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: `Ticket #${id}`,
    rows: [
      [
        { termId: 'TERM_001', term: 'Phishing', state: 'AVAILABLE' as const, row: 0, col: 0 },
        { termId: 'TERM_002', term: 'Malware', state: 'AVAILABLE' as const, row: 0, col: 1 },
        { termId: 'TERM_003', term: 'Ransomware', state: 'AVAILABLE' as const, row: 0, col: 2 },
        { termId: 'TERM_004', term: 'Spyware', state: 'AVAILABLE' as const, row: 0, col: 3 },
        { termId: 'TERM_005', term: 'Trojan', state: 'AVAILABLE' as const, row: 0, col: 4 },
      ],
      [
        { termId: 'TERM_006', term: 'Firewall', state: 'AVAILABLE' as const, row: 1, col: 0 },
        { termId: 'TERM_007', term: 'VPN', state: 'AVAILABLE' as const, row: 1, col: 1 },
      ],
      [
        { termId: 'TERM_008', term: 'Encryption', state: 'AVAILABLE' as const, row: 2, col: 0 },
        { termId: 'TERM_009', term: 'Backup', state: 'AVAILABLE' as const, row: 2, col: 1 },
      ],
    ],
  }
}

/** Prior-claim history generator for a single (playerId, prizeId) pair, plus
 * an arbitrary sprinkling of unrelated claims for other players/prizes, so
 * DUPLICATE_ACTIVE_CLAIM / RESUBMISSION_LIMIT_REACHED gates are exercised
 * without needing to be triggered on every run. */
function historyArb(playerId: string, prizeId: PrizeId): fc.Arbitrary<PrizeClaim[]> {
  const decisionArb = fc.constantFrom<'PENDING' | 'CONFIRMED' | 'REJECTED'>(
    'PENDING',
    'CONFIRMED',
    'REJECTED',
  )
  const ownHistoryArb = fc
    .array(decisionArb, { maxLength: 3 })
    .map((decisions) =>
      decisions.map((hostDecision, i) => makeClaim(`own-${i}`, playerId, prizeId, hostDecision)),
    )
  const unrelatedArb = fc
    .array(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 8 }),
        otherPlayerId: fc.string({ minLength: 1, maxLength: 8 }),
        otherPrizeId: prizeIdArb,
        hostDecision: decisionArb,
      }),
      { maxLength: 3 },
    )
    .map((entries) =>
      entries.map((e) =>
        makeClaim(`unrelated-${e.id}`, `other-${e.otherPlayerId}`, e.otherPrizeId, e.hostDecision),
      ),
    )
  return fc.tuple(ownHistoryArb, unrelatedArb).map(([own, unrelated]) => [...own, ...unrelated])
}

function makeClaim(
  id: string,
  playerId: string,
  prizeId: PrizeId,
  hostDecision: 'PENDING' | 'CONFIRMED' | 'REJECTED',
): PrizeClaim {
  return {
    id,
    gameId: 'GAME_001',
    playerId,
    ticketId: `TICKET_${playerId}`,
    prizeId,
    submittedAt: '2026-01-01T00:00:00.000Z',
    validationStatus: 'VALID',
    hostDecision,
    decidedAt: hostDecision === 'PENDING' ? undefined : '2026-01-01T00:05:00.000Z',
    prizeLabel: PRIZES.find((p) => p.id === prizeId)!.label,
    playerName: `Player ${playerId}`,
    ticketRef: `Ticket #${playerId}`,
  }
}

/** Some marks for the ticket — random subset marked valid, so eligibility
 * may or may not be satisfied across runs. */
function marksArb(playerId: string, ticketId: string): fc.Arbitrary<Mark[]> {
  const allTermIds = [
    'TERM_001',
    'TERM_002',
    'TERM_003',
    'TERM_004',
    'TERM_005',
    'TERM_006',
    'TERM_007',
    'TERM_008',
    'TERM_009',
  ]
  return fc.subarray(allTermIds).map((termIds) =>
    termIds.map((termId, i) => ({
      id: `mark-${i}`,
      gameId: 'GAME_001',
      playerId,
      ticketId,
      termId,
      markedAt: '2026-01-01T00:00:00.000Z',
      valid: true,
    })),
  )
}

/** Base state with a single player+ticket, random marks, random claim
 * history for the target (player, prize) pair, and no winners (prize open). */
function baseStateArb(prizeId: PrizeId): fc.Arbitrary<GameSessionState> {
  const playerId = 'P1'
  const ticketId = 'TICKET_P1'
  return fc
    .tuple(marksArb(playerId, ticketId), historyArb(playerId, prizeId))
    .map(([marks, claims]) => ({
      ...gameSessionInitialState,
      game: { ...gameSessionInitialState.game, revealedTermIds: [] },
      players: [makePlayer(playerId, ticketId)],
      tickets: [makeTicket(ticketId, playerId)],
      currentPlayerId: playerId,
      marks,
      claims,
      winners: [] as Winner[],
    }))
}

// ---------------------------------------------------------------------------
// Property 3 — Claims are only ever appended, never bulk-rewritten
// ---------------------------------------------------------------------------

// Feature: module-5-prize-claim-processing-winner-management, Property 3: Claims are only ever appended or selectively updated by id, never bulk-rewritten
//
// Validates: Requirements 6.1, 6.3, 6.4
describe('SUBMIT_PRIZE_CLAIM only ever appends a claim (property 3)', () => {
  it('appends exactly one new claim by id, leaving every existing claim byte-for-byte unchanged', () => {
    fc.assert(
      fc.property(prizeIdArb, (prizeId) =>
        fc.assert(
          fc.property(baseStateArb(prizeId), (state) => {
            const frozen = deepFreeze(state)
            const priorClaims = frozen.claims

            const next = gameSessionReducer(frozen, {
              type: 'SUBMIT_PRIZE_CLAIM',
              playerId: 'P1',
              ticketId: 'TICKET_P1',
              prizeId,
            })

            // Exactly one new claim appended.
            expect(next.claims.length).toBe(priorClaims.length + 1)

            // Every prior claim is present, unchanged, by id, at its
            // original relative order (append-only, never bulk-rewritten).
            for (let i = 0; i < priorClaims.length; i++) {
              expect(next.claims[i]).toEqual(priorClaims[i])
            }

            // The new claim is the last entry and references the right ids.
            const appended = next.claims[next.claims.length - 1]
            expect(appended.playerId).toBe('P1')
            expect(appended.ticketId).toBe('TICKET_P1')
            expect(appended.prizeId).toBe(prizeId)
            expect(appended.hostDecision).toBe('PENDING')
            expect(['VALID', 'INVALID']).toContain(appended.validationStatus)

            // No id collision: the appended claim's id is new.
            expect(priorClaims.some((c) => c.id === appended.id)).toBe(false)
          }),
          { numRuns: 100 },
        ),
      ),
      { numRuns: 1 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 9 — Claim/winner actions never affect unrelated state
// (SUBMIT_PRIZE_CLAIM slice)
// ---------------------------------------------------------------------------

// Feature: module-5-prize-claim-processing-winner-management, Property 9: Claim and winner actions never affect marks, tickets, players, currentPlayerId, or other prizes' progress
//
// Validates: Requirements 18.1, 18.2, 18.3, 18.4
describe('SUBMIT_PRIZE_CLAIM never affects unrelated state (property 9)', () => {
  it('leaves marks, tickets, players, currentPlayerId, and all prize progress unchanged', () => {
    fc.assert(
      fc.property(prizeIdArb, (prizeId) =>
        fc.assert(
          fc.property(baseStateArb(prizeId), (state) => {
            const frozen = deepFreeze(state)

            const beforeProgress = getAllPrizeProgress(
              frozen.tickets[0],
              getPlayerTicketMarks(frozen.marks, 'P1', 'TICKET_P1'),
            )

            const next = gameSessionReducer(frozen, {
              type: 'SUBMIT_PRIZE_CLAIM',
              playerId: 'P1',
              ticketId: 'TICKET_P1',
              prizeId,
            })

            // Marks/tickets/players/currentPlayerId untouched.
            expect(next.marks).toEqual(frozen.marks)
            expect(next.tickets).toEqual(frozen.tickets)
            expect(next.players).toEqual(frozen.players)
            expect(next.currentPlayerId).toBe(frozen.currentPlayerId)

            // Winners untouched by a mere submission.
            expect(next.winners).toEqual(frozen.winners)

            // Prize progress for every prize is unaffected by a claim
            // submission (progress is derived only from ticket + marks).
            const afterProgress = getAllPrizeProgress(
              next.tickets[0],
              getPlayerTicketMarks(next.marks, 'P1', 'TICKET_P1'),
            )
            expect(afterProgress).toEqual(beforeProgress)
          }),
          { numRuns: 100 },
        ),
      ),
      { numRuns: 1 },
    )
  })
})
