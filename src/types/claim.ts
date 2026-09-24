import type { PrizeId } from './prize'

/**
 * The system's own automated verdict on a claim at submission time, set once
 * and never changed afterward (Req 1.2). 'PENDING' is reserved for shape
 * parity — submission validation always runs synchronously, so a stored
 * claim's validationStatus is always 'VALID' or 'INVALID' immediately.
 */
export type ValidationStatus = 'PENDING' | 'VALID' | 'INVALID'

/**
 * The host's manual verdict on a claim (Req 1.3). An INVALID claim's
 * hostDecision starts and stays 'PENDING', but the host is blocked from
 * confirming it (Req 8.1, 10.1) via canConfirmClaim.
 */
export type HostDecision = 'PENDING' | 'CONFIRMED' | 'REJECTED'

/**
 * A record of one player's manual claim attempt for one Prize_Id on one
 * ticket (Req 1.1). Extends the Module 2 shape in place — `prizeLabel`,
 * `playerName`, and `ticketRef` are retained as denormalized display fields
 * resolved at submission time so the Host_Claim_Inbox and history subsection
 * never need to re-join `players`/`tickets` to render (Req 1.5); they are
 * NOT used for any validation or identity decision, which always uses
 * `playerId`/`ticketId`/`prizeId`.
 */
export interface PrizeClaim {
  id: string
  gameId: string
  playerId: string
  ticketId: string
  prizeId: PrizeId
  /** ISO timestamp of submission. */
  submittedAt: string
  validationStatus: ValidationStatus
  hostDecision: HostDecision
  /** System-assigned reason when validationStatus is 'INVALID', or the
   *  host-supplied reason when hostDecision is 'REJECTED' (Req 9.3). */
  rejectionReason?: string
  /** ISO timestamp of the host's confirm/reject decision, if any. */
  decidedAt?: string

  // --- Denormalized display fields, resolved once at submission time ---
  prizeLabel: string
  playerName: string
  ticketRef: string

  /** @deprecated Superseded by validationStatus + hostDecision (Req 1.5).
   *  Retained only as an optional field so no existing import of the old
   *  Module 2 `ClaimStatus`-shaped literal fails to type-check; no code in
   *  this module reads or writes it. */
  status?: ClaimStatus
}

/** @deprecated Module 2's original single-field status. Superseded by
 *  ValidationStatus + HostDecision (Req 1.2, 1.3). Retained only for
 *  backwards-compatible re-export; see PrizeClaim.status. */
export type ClaimStatus = 'VALID' | 'PENDING' | 'CONFIRMED' | 'REJECTED'
