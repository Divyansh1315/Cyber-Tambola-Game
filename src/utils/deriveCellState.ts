import type { TicketCellState } from '../types/ticket'

/**
 * Derive a ticket cell's visual state purely from the game's call history
 * and the player's Valid_Marks for this term (Req 13.5, 14.1, 14.3, 16.1).
 *
 * Rules (MARKED is checked first so a term that was called, got marked, and
 * is no longer the latest call still reports MARKED, never LOCKED — marks
 * are permanent per Requirement 16.1):
 * - a Valid_Mark exists for this termId -> MARKED
 * - no Valid_Mark AND termId has been called (is in revealedTermIds) -> AVAILABLE (Req 14.1)
 * - no Valid_Mark AND termId has never been called -> LOCKED (Req 14.2, 14.3)
 *
 * Once a term is called it stays markable for the rest of the game — a
 * player who misses marking it immediately can still catch up later.
 *
 * `markedTermIds` is the caller's precomputed Marked_Term_Ids for the
 * Current_Player + Current_Ticket (via getMarkedTermIds(getPlayerTicketMarks(...))),
 * so this function stays a pure lookup with no Session_Store access and never
 * mutates its inputs.
 *
 * @param termId The CyberTerm id this cell represents.
 * @param revealedTermIds The game's append-only call history (`Game.revealedTermIds`);
 *   any term in this list is markable, regardless of whether it is still current.
 * @param markedTermIds The Current_Player's Marked_Term_Ids for the Current_Ticket.
 * @returns The derived cell state.
 */
export function deriveCellState(
  termId: string,
  revealedTermIds: readonly string[],
  markedTermIds: ReadonlySet<string>,
): TicketCellState {
  if (markedTermIds.has(termId)) {
    return 'MARKED'
  }
  return revealedTermIds.includes(termId) ? 'AVAILABLE' : 'LOCKED'
}
