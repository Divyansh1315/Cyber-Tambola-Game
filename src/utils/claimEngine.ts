import type { Game } from '../types/game'
import type { Mark } from '../types/mark'
import type { Player } from '../types/player'
import type { PrizeClaim, PrizeId, Winner } from '../types/prize'
import type { Ticket } from '../types/ticket'
import {
  PRIZES,
  getAllPrizeProgress,
  getPlayerTicketMarks,
  isPrizeEligible,
} from './prizeEngine'
import { isPrizeClosed } from './winnerEngine'

/** Reason a claim submission was rejected as INVALID, or valid when it may proceed. */
export type ClaimValidationResult =
  | { valid: true }
  | {
      valid: false
      reason:
        | 'GAME_NOT_FOUND'
        | 'PLAYER_NOT_FOUND'
        | 'PLAYER_NOT_IN_GAME'
        | 'TICKET_NOT_FOUND'
        | 'TICKET_NOT_OWNED_BY_PLAYER'
        | 'PRIZE_NOT_FOUND'
        | 'DUPLICATE_ACTIVE_CLAIM'
        | 'RESUBMISSION_LIMIT_REACHED'
        | 'PRIZE_CLOSED'
        | 'NOT_ELIGIBLE'
    }

/**
 * The single validation pipeline for Requirements 3 and 4, shared by the
 * reducer's SUBMIT_PRIZE_CLAIM case (and available to the UI for pre-checks
 * without duplicating logic). Never mutates its inputs. Computes
 * Prize_Eligible exclusively via prizeEngine's existing functions — no
 * prize-counting logic is reimplemented here (Req 3.6).
 *
 * Gates, in order (Req 3.2, 4.1-4.4):
 *  1. GAME_NOT_FOUND            - `game` is undefined/missing an id
 *  2. PLAYER_NOT_FOUND          - `player` is undefined
 *  3. PLAYER_NOT_IN_GAME        - player.gameId !== game.id
 *  4. TICKET_NOT_FOUND          - `ticket` is undefined
 *  5. TICKET_NOT_OWNED_BY_PLAYER- ticket.playerId !== player.id (or
 *                                 ticket.id !== player.ticketId)
 *  6. PRIZE_NOT_FOUND           - prizeId is not among PRIZES
 *  7. DUPLICATE_ACTIVE_CLAIM    - player already has a claim for this
 *                                 prizeId with hostDecision 'PENDING' or
 *                                 'CONFIRMED' (Req 4.1, 4.2)
 *  8. RESUBMISSION_LIMIT_REACHED- player already has 2+ claims for this
 *                                 prizeId with hostDecision 'REJECTED'
 *                                 (i.e. a resubmission has already
 *                                 occurred) (Req 4.4)
 *  9. PRIZE_CLOSED              - isPrizeClosed(winners, game.id, prizeId)
 * 10. NOT_ELIGIBLE               - !isPrizeEligible(progress) for this
 *                                 player's ticket, computed via
 *                                 getPlayerTicketMarks + getAllPrizeProgress
 *
 * Gate 8's count is over ALL prior claims for the pair regardless of gate 7
 * (a CONFIRMED/PENDING claim would already have been rejected by gate 7, so
 * gate 8 only ever runs against a history of REJECTED-only claims plus this
 * new attempt) — exactly one prior REJECTED claim is allowed through as a
 * resubmission (Req 4.3); a second prior REJECTED claim blocks further
 * submission (Req 4.4).
 */
export function validatePrizeClaim(input: {
  game?: Game
  player?: Player
  ticket?: Ticket
  marks: readonly Mark[]
  prizeId: PrizeId
  winners: readonly Winner[]
  existingClaims: readonly PrizeClaim[]
}): ClaimValidationResult {
  const { game, player, ticket, marks, prizeId, winners, existingClaims } = input

  if (!game) return { valid: false, reason: 'GAME_NOT_FOUND' }
  if (!player) return { valid: false, reason: 'PLAYER_NOT_FOUND' }
  if (player.gameId !== game.id) {
    return { valid: false, reason: 'PLAYER_NOT_IN_GAME' }
  }
  if (!ticket) return { valid: false, reason: 'TICKET_NOT_FOUND' }
  if (ticket.playerId !== player.id || ticket.id !== player.ticketId) {
    return { valid: false, reason: 'TICKET_NOT_OWNED_BY_PLAYER' }
  }
  if (!PRIZES.some((p) => p.id === prizeId)) {
    return { valid: false, reason: 'PRIZE_NOT_FOUND' }
  }

  const priorForPair = existingClaims.filter(
    (c) => c.playerId === player.id && c.prizeId === prizeId,
  )
  const hasActiveOrWon = priorForPair.some(
    (c) => c.hostDecision === 'PENDING' || c.hostDecision === 'CONFIRMED',
  )
  if (hasActiveOrWon) {
    return { valid: false, reason: 'DUPLICATE_ACTIVE_CLAIM' }
  }
  const rejectedCount = priorForPair.filter(
    (c) => c.hostDecision === 'REJECTED',
  ).length
  if (rejectedCount >= 2) {
    return { valid: false, reason: 'RESUBMISSION_LIMIT_REACHED' }
  }

  if (isPrizeClosed(winners, game.id, prizeId)) {
    return { valid: false, reason: 'PRIZE_CLOSED' }
  }

  const validMarks = getPlayerTicketMarks(marks, player.id, ticket.id)
  const progress = getAllPrizeProgress(ticket, validMarks).find(
    (p) => p.id === prizeId,
  )!
  if (!isPrizeEligible(progress)) {
    return { valid: false, reason: 'NOT_ELIGIBLE' }
  }

  return { valid: true }
}
