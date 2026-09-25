import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import type { Mark } from '../types/mark'
import type { Ticket, TicketCell } from '../types/ticket'
import type { HostDecision, PrizeClaim, ValidationStatus } from '../types/claim'
import type { PrizeId, Winner } from '../types/prize'
import { getAllPrizeProgress } from './prizeEngine'
import { derivePlayerClaimStatus } from './winnerEngine'

const RUNS = 100

const PRIZE_IDS: PrizeId[] = [
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
]

/** Builds a 3x5 ticket with 15 distinct termIds `TERM_000`..`TERM_014`. */
function makeTicket(): Ticket {
  const rows: TicketCell[][] = []
  for (let r = 0; r < 3; r++) {
    const row: TicketCell[] = []
    for (let c = 0; c < 5; c++) {
      const index = r * 5 + c
      row.push({
        termId: `TERM_${String(index).padStart(3, '0')}`,
        term: `Term ${index}`,
        state: 'LOCKED',
        row: r,
        col: c,
      })
    }
    rows.push(row)
  }
  return {
    id: 'ticket-1',
    playerId: 'player-1',
    gameId: 'game-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    ref: 'Ticket #TEST',
    rows,
  }
}

function ticketTermIds(ticket: Ticket): string[] {
  return ticket.rows.flat().map((c) => c.termId)
}

/** Builds valid Marks for a subset of the ticket's termIds, for one player/ticket. */
function marksFor(ticket: Ticket, markedTermIds: readonly string[]): Mark[] {
  return markedTermIds.map((termId, i) => ({
    id: `mark-${i}`,
    gameId: ticket.gameId,
    playerId: ticket.playerId,
    ticketId: ticket.id,
    termId,
    markedAt: '2024-01-01T00:00:00.000Z',
    valid: true,
  }))
}

// An arbitrary that produces a random subset (any size 0-15) of the fixed
// ticket's 15 termIds, used to derive realistic PrizeProgress inputs.
function markedSubsetArb(ticket: Ticket) {
  return fc.subarray(ticketTermIds(ticket))
}

function makeClaim(overrides: {
  playerId: string
  prizeId: PrizeId
  validationStatus: ValidationStatus
  hostDecision: HostDecision
}): PrizeClaim {
  return {
    id: 'claim-1',
    gameId: 'game-1',
    playerId: overrides.playerId,
    ticketId: 'ticket-1',
    prizeId: overrides.prizeId,
    submittedAt: '2024-01-01T00:00:00.000Z',
    validationStatus: overrides.validationStatus,
    hostDecision: overrides.hostDecision,
    prizeLabel: 'Prize',
    playerName: 'Player',
    ticketRef: 'Ticket #TEST',
  }
}

function makeWinner(overrides: { playerId: string; prizeId: PrizeId }): Winner {
  return {
    id: 'winner-1',
    gameId: 'game-1',
    prizeId: overrides.prizeId,
    playerId: overrides.playerId,
    ticketId: 'ticket-1',
    claimId: 'claim-1',
    confirmedAt: '2024-01-01T00:00:00.000Z',
    prizeLabel: 'Prize',
    playerName: 'Player',
    ticketRef: 'Ticket #TEST',
  }
}

// The "own claim" shapes that can precede a status derivation, per the
// precedence rules: no claim at all, or a claim with any hostDecision.
type OwnClaimShape = 'NONE' | HostDecision

describe('winnerEngine.derivePlayerClaimStatus', () => {
  // Feature: module-5-prize-claim-processing-winner-management, Property 10: Player claim status is total, unambiguous, and reflects another player's win
  it('property 10: derives exactly one well-defined status for every combination of progress, own claim, and winner', () => {
    const ticket = makeTicket()
    const currentPlayerId = 'player-current'
    const otherPlayerId = 'player-other'

    fc.assert(
      fc.property(
        markedSubsetArb(ticket),
        fc.constantFrom(...PRIZE_IDS),
        fc.constantFrom<OwnClaimShape>('NONE', 'PENDING', 'CONFIRMED', 'REJECTED'),
        fc.boolean(), // whether a Winner exists at all
        fc.boolean(), // if a Winner exists, whether it belongs to the current player
        (markedTermIds, prizeId, ownClaimShape, winnerExists, winnerIsSelf) => {
          const marks = marksFor(ticket, markedTermIds)
          const progress = getAllPrizeProgress(ticket, marks).find(
            (p) => p.id === prizeId,
          )!

          const ownLatestClaim: PrizeClaim | undefined =
            ownClaimShape === 'NONE'
              ? undefined
              : makeClaim({
                  playerId: currentPlayerId,
                  prizeId,
                  // An own claim reaching CONFIRMED/REJECTED implies the
                  // system validated it VALID at submission time; a claim
                  // still PENDING is also always VALID once accepted.
                  validationStatus: 'VALID',
                  hostDecision: ownClaimShape,
                })

          const winner: Winner | undefined = winnerExists
            ? makeWinner({
                playerId: winnerIsSelf ? currentPlayerId : otherPlayerId,
                prizeId,
              })
            : undefined

          const status = derivePlayerClaimStatus({
            progress,
            ownLatestClaim,
            winner,
            playerId: currentPlayerId,
          })

          // Totality: always exactly one of the six literals.
          expect([
            'NOT_ELIGIBLE',
            'ELIGIBLE',
            'PENDING',
            'CONFIRMED',
            'REJECTED',
            'CLOSED_BY_OTHER_WINNER',
          ]).toContain(status)

          // Precedence rule 1/2: a Winner takes priority over everything else.
          if (winner) {
            if (winner.playerId === currentPlayerId) {
              expect(status).toBe('CONFIRMED')
            } else {
              expect(status).toBe('CLOSED_BY_OTHER_WINNER')
            }
            return
          }

          // No winner: own claim's hostDecision takes priority over eligibility.
          if (ownClaimShape === 'PENDING') {
            expect(status).toBe('PENDING')
            return
          }
          if (ownClaimShape === 'REJECTED') {
            expect(status).toBe('REJECTED')
            return
          }

          // No winner, no PENDING/REJECTED own claim (NONE or CONFIRMED without
          // a winner record — the latter shouldn't happen in practice but the
          // helper must still be total): falls through to eligibility.
          const eligible = progress.current >= progress.target
          expect(status).toBe(eligible ? 'ELIGIBLE' : 'NOT_ELIGIBLE')
        },
      ),
      { numRuns: RUNS },
    )
  })

  // Feature: module-5-prize-claim-processing-winner-management, Property 10: Player claim status is total, unambiguous, and reflects another player's win
  it('property 10: a winner for another player always yields CLOSED_BY_OTHER_WINNER regardless of the current player\'s own claim/progress', () => {
    const ticket = makeTicket()
    const currentPlayerId = 'player-current'
    const otherPlayerId = 'player-other'

    fc.assert(
      fc.property(
        markedSubsetArb(ticket),
        fc.constantFrom(...PRIZE_IDS),
        fc.constantFrom<OwnClaimShape>('NONE', 'PENDING', 'CONFIRMED', 'REJECTED'),
        (markedTermIds, prizeId, ownClaimShape) => {
          const marks = marksFor(ticket, markedTermIds)
          const progress = getAllPrizeProgress(ticket, marks).find(
            (p) => p.id === prizeId,
          )!

          const ownLatestClaim: PrizeClaim | undefined =
            ownClaimShape === 'NONE'
              ? undefined
              : makeClaim({
                  playerId: currentPlayerId,
                  prizeId,
                  validationStatus: 'VALID',
                  hostDecision: ownClaimShape,
                })

          const winner = makeWinner({ playerId: otherPlayerId, prizeId })

          const status = derivePlayerClaimStatus({
            progress,
            ownLatestClaim,
            winner,
            playerId: currentPlayerId,
          })

          expect(status).toBe('CLOSED_BY_OTHER_WINNER')
        },
      ),
      { numRuns: RUNS },
    )
  })
})
