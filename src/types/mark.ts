/**
 * One player's authoritative, validated act of marking one term on one
 * ticket (Req 1.1). Marks live in the central Session_Store's `marks`
 * collection and are the single source of truth for ticket-cell MARKED state
 * and prize progress — never a component-local flag.
 */
export interface Mark {
  id: string
  gameId: string
  playerId: string
  ticketId: string
  termId: string
  /** ISO timestamp of when the mark was created. */
  markedAt: string
  /**
   * Always true for marks created by MARK_TERM (Req 2.8); reserved for future
   * invalidation (e.g. host-side dispute resolution) without changing shape.
   */
  valid: boolean
}
