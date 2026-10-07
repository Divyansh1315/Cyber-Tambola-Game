import type { TicketCellState } from '../types/ticket'

/**
 * Derive a ticket cell's visual state purely from the game's single current
 * term and the player's Valid_Marks for this term (Req 13.5, 14.1, 14.3, 16.1).
 *
 * Rules (MARKED is checked first so a term that was current, got marked, and
 * is no longer current still reports MARKED, never LOCKED — marks are
 * permanent per Requirement 16.1):
 * - a Valid_Mark exists for this termId -> MARKED
 * - no Valid_Mark AND termId === currentTermId -> AVAILABLE (Req 14.1)
 * - no Valid_Mark AND termId !== currentTermId -> LOCKED (Req 14.2, 14.3)
 *
 * `markedTermIds` is the caller's precomputed Marked_Term_Ids for the
 * Current_Player + Current_Ticket (via getMarkedTermIds(getPlayerTicketMarks(...))),
 * so this function stays a pure lookup with no Session_Store access and never
 * mutates its inputs.
 *
 * @param termId The CyberTerm id this cell represents.
 * @param currentTermId The game's single current term (`Game.currentTermId`); only
 *   this term is newly markable. `Game.revealedTermIds` (call history) is
 *   intentionally not consulted here (Req 14.3).
 * @param markedTermIds The Current_Player's Marked_Term_Ids for the Current_Ticket.
 * @returns The derived cell state.
 */
export function deriveCellState(
  termId: string,
  currentTermId: string | undefined,
  markedTermIds: ReadonlySet<string>,
): TicketCellState {
  if (markedTermIds.has(termId)) {
    return 'MARKED'
  }
  return termId === currentTermId ? 'AVAILABLE' : 'LOCKED'
}
