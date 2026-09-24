/** The prize categories available in a Cyber Tambola game. */
export type PrizeId =
  | 'CYBER_FIVE'
  | 'FIREWALL_LINE'
  | 'SECURITY_LINE'
  | 'DATA_DEFENDER_LINE'
  | 'CYBER_FULL_HOUSE'

/** A prize definition: its code and the display label used across screens. */
export interface Prize {
  id: PrizeId
  label: string
  /** Total cells needed to complete this prize. */
  target: number
}

/** Progress indicator for a single prize on the player screen. */
export interface PrizeProgress {
  id: PrizeId
  label: string
  /** How many required cells the player has marked so far. */
  current: number
  /** Total cells needed to complete this prize. */
  target: number
}

/**
 * A record created only when a host confirms a VALID, still-PENDING claim
 * for a still-open prize (Req 1.4). Extends the Module 2 shape in place —
 * `prizeLabel`/`playerName` are retained as denormalized display fields,
 * resolved once at confirmation time from the confirmed claim, so
 * HostDashboard's Winner Panel and PresentationView's announcement never
 * need to re-join `claims`/`players` to render (Req 1.5).
 */
export interface Winner {
  id: string
  gameId: string
  prizeId: PrizeId
  playerId: string
  ticketId: string
  /** The PrizeClaim.id this Winner was created from. */
  claimId: string
  /** ISO timestamp of confirmation. */
  confirmedAt: string

  // --- Denormalized display fields, resolved once at confirmation time ---
  prizeLabel: string
  playerName: string
  /**
   * The winning Ticket's own reference (e.g. "Ticket #021"), denormalized
   * onto `winners.ticket_ref` at confirmation time (winner-history-and-
   * game-reset) so Winner_History can render it with no join to `tickets`,
   * matching the existing prizeLabel/playerName convention above.
   */
  ticketRef: string
}

// Claim types live in ./claim; re-exported here for backwards compatibility
// with Module 1 imports (`import type { PrizeClaim } from '../types/prize'`).
export type { ClaimStatus, PrizeClaim, ValidationStatus, HostDecision } from './claim'
