// Feature: module-5-prize-claim-processing-winner-management
//
// Property tests for REJECT_CLAIM:
//   Property 8: Rejecting a pending claim updates exactly that claim and
//               never creates a Winner
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
      ],
    ],
  }
}

function makeClaim(
  id: string,
  playerId: string,
  prizeId: PrizeId,
  validationStatus: 'VALID' | 'INVALID',
  hostDecision: 'PENDING' | 'CONFIRMED' | 'REJECTED',
): PrizeClaim {
  return {
    id,
    gameId: 'GAME_001',
    playerId,
    ticketId: `TICKET_${playerId}`,
    prizeId,
    submittedAt: '2026-01-01T00:00:00.000Z',
    validationStatus,
    hostDecision,
    decidedAt: hostDecision === 'PENDING' ? undefined : '2026-01-01T00:05:00.000Z',
    prizeLabel: PRIZES.find((p) => p.id === prizeId)!.label,
    playerName: `Player ${playerId}`,
    ticketRef: `Ticket #${playerId}`,
  }
}

function makeWinner(id: string, playerId: string, prizeId: PrizeId, claimId: string): Winner {
  return {
    id,
    gameId: 'GAME_001',
    prizeId,
    playerId,
    ticketId: `TICKET_${playerId}`,
    claimId,
    confirmedAt: '2026-01-01T00:05:00.000Z',
    prizeLabel: PRIZES.find((p) => p.id === prizeId)!.label,
    playerName: `Player ${playerId}`,
  }
}

const rejectionReasonArb = fc.option(
  fc.constantFrom(
    'Duplicate / already won',
    'Host verification issue',
    'Invalid event claim',
    'Other',
  ),
  { nil: undefined },
)

/** A state with one target claim (random validationStatus/hostDecision) plus
 * unrelated noise claims/winners, and an optional rejection reason to pass
 * to the reject action. Varies whether the target is rejectable so both the
 * reject and no-op branches get exercised. */
const scenarioArb: fc.Arbitrary<{
  state: GameSessionState
  claimId: string
  rejectionReason?: string
}> = fc
  .record({
    prizeId: prizeIdArb,
    validationStatus: fc.constantFrom<'VALID' | 'INVALID'>('VALID', 'INVALID'),
    hostDecision: fc.constantFrom<'PENDING' | 'CONFIRMED' | 'REJECTED'>(
      'PENDING',
      'CONFIRMED',
      'REJECTED',
    ),
    rejectionReason: rejectionReasonArb,
    noiseClaims: fc.array(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 8 }),
        playerId: fc.string({ minLength: 1, maxLength: 8 }),
        prizeId: prizeIdArb,
        validationStatus: fc.constantFrom<'VALID' | 'INVALID'>('VALID', 'INVALID'),
        hostDecision: fc.constantFrom<'PENDING' | 'CONFIRMED' | 'REJECTED'>(
          'PENDING',
          'CONFIRMED',
          'REJECTED',
        ),
      }),
      { maxLength: 3 },
    ),
    noiseWinners: fc.array(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 8 }),
        playerId: fc.string({ minLength: 1, maxLength: 8 }),
        prizeId: prizeIdArb,
        claimId: fc.string({ minLength: 1, maxLength: 8 }),
      }),
      { maxLength: 2 },
    ),
  })
  .map(
    ({
      prizeId,
      validationStatus,
      hostDecision,
      rejectionReason,
      noiseClaims,
      noiseWinners,
    }) => {
      const playerId = 'P1'
      const ticketId = 'TICKET_P1'
      const targetClaim = makeClaim(
        'target-claim',
        playerId,
        prizeId,
        validationStatus,
        hostDecision,
      )

      const noise = noiseClaims.map((n) =>
        makeClaim(
          `noise-${n.id}`,
          `other-${n.playerId}`,
          n.prizeId,
          n.validationStatus,
          n.hostDecision,
        ),
      )
      const winners = noiseWinners.map((w) =>
        makeWinner(`winner-${w.id}`, `other-${w.playerId}`, w.prizeId, `claim-${w.claimId}`),
      )

      const marks: Mark[] = [
        {
          id: 'mark-1',
          gameId: 'GAME_001',
          playerId,
          ticketId,
          termId: 'TERM_001',
          markedAt: '2026-01-01T00:00:00.000Z',
          valid: true,
        },
      ]

      const state: GameSessionState = {
        ...gameSessionInitialState,
        game: { ...gameSessionInitialState.game, revealedTermIds: [] },
        players: [makePlayer(playerId, ticketId)],
        tickets: [makeTicket(ticketId, playerId)],
        currentPlayerId: playerId,
        marks,
        claims: [targetClaim, ...noise],
        winners,
      }

      return { state, claimId: targetClaim.id, rejectionReason }
    },
  )

// ---------------------------------------------------------------------------
// Property 8 — Rejecting a pending claim updates exactly that claim and
// never creates a Winner
// ---------------------------------------------------------------------------

// Feature: module-5-prize-claim-processing-winner-management, Property 8: Rejecting a pending claim updates exactly that claim and never creates a Winner
//
// Validates: Requirements 9.1, 9.2, 9.3, 9.4
describe('REJECT_CLAIM updates exactly the target claim and never creates a Winner (property 8)', () => {
  it('when hostDecision is PENDING: sets REJECTED + decidedAt + rejectionReason on exactly that claim, winners untouched; otherwise: no-op', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, claimId, rejectionReason }) => {
        const frozen = deepFreeze(state)
        const targetClaim = frozen.claims.find((c) => c.id === claimId)!
        const wasPending = targetClaim.hostDecision === 'PENDING'

        const next = gameSessionReducer(frozen, {
          type: 'REJECT_CLAIM',
          claimId,
          rejectionReason,
        })

        if (wasPending) {
          for (const claim of frozen.claims) {
            const updated = next.claims.find((c) => c.id === claim.id)!
            if (claim.id === claimId) {
              expect(updated.hostDecision).toBe('REJECTED')
              expect(updated.decidedAt).toBeDefined()
              expect(updated.rejectionReason).toBe(rejectionReason ?? claim.rejectionReason)
              // No other field changes.
              expect(updated).toEqual({
                ...claim,
                hostDecision: 'REJECTED',
                decidedAt: updated.decidedAt,
                rejectionReason: updated.rejectionReason,
              })
            } else {
              expect(updated).toEqual(claim)
            }
          }
          expect(next.claims.length).toBe(frozen.claims.length)

          // Never creates a Winner.
          expect(next.winners).toEqual(frozen.winners)
        } else {
          // Blocked: same state reference, nothing altered.
          expect(next).toBe(frozen)
          expect(next.claims).toEqual(frozen.claims)
          expect(next.winners).toEqual(frozen.winners)
        }
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 9 — Claim/winner actions never affect unrelated state
// (REJECT_CLAIM slice)
// ---------------------------------------------------------------------------

// Feature: module-5-prize-claim-processing-winner-management, Property 9: Claim and winner actions never affect marks, tickets, players, currentPlayerId, or other prizes' progress
//
// Validates: Requirements 18.1, 18.2, 18.3, 18.4
describe('REJECT_CLAIM never affects unrelated state (property 9)', () => {
  it('leaves marks, tickets, players, currentPlayerId, and all prize progress unchanged', () => {
    fc.assert(
      fc.property(scenarioArb, ({ state, claimId, rejectionReason }) => {
        const frozen = deepFreeze(state)

        const beforeProgress = getAllPrizeProgress(
          frozen.tickets[0],
          getPlayerTicketMarks(frozen.marks, 'P1', 'TICKET_P1'),
        )

        const next = gameSessionReducer(frozen, {
          type: 'REJECT_CLAIM',
          claimId,
          rejectionReason,
        })

        expect(next.marks).toEqual(frozen.marks)
        expect(next.tickets).toEqual(frozen.tickets)
        expect(next.players).toEqual(frozen.players)
        expect(next.currentPlayerId).toBe(frozen.currentPlayerId)

        const afterProgress = getAllPrizeProgress(
          next.tickets[0],
          getPlayerTicketMarks(next.marks, 'P1', 'TICKET_P1'),
        )
        expect(afterProgress).toEqual(beforeProgress)
      }),
      { numRuns: 200 },
    )
  })
})
