import type { PrizeClaim, PrizeId, Winner } from '../types/prize'

/** True exactly when a Winner exists for this prizeId within this game (Req 5.1, 11.1). */
export function isPrizeClosed(
  winners: readonly Winner[],
  gameId: string,
  prizeId: PrizeId,
): boolean {
  return winners.some((w) => w.gameId === gameId && w.prizeId === prizeId)
}

/** The Winner record for this prizeId within this game, or undefined (Req 11.2). */
export function getWinnerForPrize(
  winners: readonly Winner[],
  gameId: string,
  prizeId: PrizeId,
): Winner | undefined {
  return winners.find((w) => w.gameId === gameId && w.prizeId === prizeId)
}

/**
 * True exactly when a host confirm action on this claim is currently
 * permitted (Req 8.1, 10.1, 11.3): validationStatus is 'VALID', hostDecision
 * is 'PENDING', and the claim's prize is not already closed.
 */
export function canConfirmClaim(
  claim: PrizeClaim,
  winners: readonly Winner[],
): boolean {
  return (
    claim.validationStatus === 'VALID' &&
    claim.hostDecision === 'PENDING' &&
    !isPrizeClosed(winners, claim.gameId, claim.prizeId)
  )
}

/** The list of Prize_Ids for which this player has a confirmed Winner (Req 11.4). */
export function getPlayerWinningPrizes(
  winners: readonly Winner[],
  playerId: string,
): PrizeId[] {
  return winners.filter((w) => w.playerId === playerId).map((w) => w.prizeId)
}

/**
 * Sort claims for display: hostDecision 'PENDING' before any other
 * hostDecision, and within each group by submittedAt ascending (Req 6.2,
 * 7.4). Never mutates the input array.
 */
export function sortClaimsForInbox(
  claims: readonly PrizeClaim[],
): PrizeClaim[] {
  return [...claims].sort((a, b) => {
    const aPending = a.hostDecision === 'PENDING' ? 0 : 1
    const bPending = b.hostDecision === 'PENDING' ? 0 : 1
    if (aPending !== bPending) return aPending - bPending
    return a.submittedAt.localeCompare(b.submittedAt)
  })
}

/**
 * Partition claims into the three Host_Claim_Inbox history groups (Req 7.5,
 * 10.2): PENDING, CONFIRMED, and REJECTED_OR_INVALID (every REJECTED claim,
 * plus every INVALID claim regardless of its still-PENDING hostDecision, so
 * a submitted-but-invalid claim is never silently dropped from history).
 */
export function groupClaimsForHistory(claims: readonly PrizeClaim[]): {
  pending: PrizeClaim[]
  confirmed: PrizeClaim[]
  rejectedOrInvalid: PrizeClaim[]
} {
  const pending: PrizeClaim[] = []
  const confirmed: PrizeClaim[] = []
  const rejectedOrInvalid: PrizeClaim[] = []
  for (const claim of claims) {
    if (claim.validationStatus === 'INVALID' || claim.hostDecision === 'REJECTED') {
      rejectedOrInvalid.push(claim)
    } else if (claim.hostDecision === 'CONFIRMED') {
      confirmed.push(claim)
    } else {
      pending.push(claim)
    }
  }
  return { pending, confirmed, rejectedOrInvalid }
}

/** The one derived status a player sees for one of their own prize categories (Req 12.1). */
export type PlayerClaimStatus =
  | 'NOT_ELIGIBLE'
  | 'ELIGIBLE'
  | 'PENDING'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'CLOSED_BY_OTHER_WINNER'

/**
 * Derive the single Player_Claim_Status for one Prize_Id from that prize's
 * live progress, the player's own most recent claim for it (if any), and the
 * confirmed Winner for it (if any) (Req 12.1-12.8). Total and unambiguous:
 * every combination of inputs maps to exactly one status.
 *
 * Precedence (checked in order):
 *  1. A Winner exists for this prize, for someone OTHER than this player
 *     -> CLOSED_BY_OTHER_WINNER (Req 12.8)
 *  2. A Winner exists for this prize, for THIS player -> CONFIRMED (Req 12.6)
 *  3. The player's own latest claim for this prize has hostDecision
 *     'PENDING' -> PENDING (Req 12.5)
 *  4. The player's own latest claim for this prize has hostDecision
 *     'REJECTED' -> REJECTED (Req 12.7)
 *  5. Otherwise, eligible now -> ELIGIBLE (Req 12.4)
 *  6. Otherwise -> NOT_ELIGIBLE (Req 12.3)
 */
export function derivePlayerClaimStatus(input: {
  progress: import('../types/prize').PrizeProgress
  /** This player's own most recent claim for this prizeId, if any. */
  ownLatestClaim?: PrizeClaim
  /** The confirmed Winner for this prizeId in this game, if any. */
  winner?: Winner
  playerId: string
}): PlayerClaimStatus {
  const { progress, ownLatestClaim, winner, playerId } = input

  if (winner) {
    return winner.playerId === playerId ? 'CONFIRMED' : 'CLOSED_BY_OTHER_WINNER'
  }
  if (ownLatestClaim?.hostDecision === 'PENDING') return 'PENDING'
  if (ownLatestClaim?.hostDecision === 'REJECTED') return 'REJECTED'

  return isEligible(progress) ? 'ELIGIBLE' : 'NOT_ELIGIBLE'
}

function isEligible(progress: import('../types/prize').PrizeProgress): boolean {
  return progress.current >= progress.target
}
