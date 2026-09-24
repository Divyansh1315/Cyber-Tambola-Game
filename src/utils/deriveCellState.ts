import type { TicketCellState } from '../types/ticket'

/**
 * Derive a ticket cell's visual state purely from the game's reveal history
 * and the player's Valid_Marks for this term (Req 4.1-4.3).
 *
 * Rules:
 * - termId NOT in revealedTermIds -> LOCKED (Req 4.1)
 * - present AND no Valid_Mark for this termId -> AVAILABLE (Req 4.2)
 * - present AND a Valid_Mark exists for this termId -> MARKED (Req 4.3)
 *
 * `markedTermIds` is the caller's precomputed Marked_Term_Ids for the
 * Current_Player + Current_Ticket (via getMarkedTermIds(getPlayerTicketMarks(...))),
 * so this function stays a pure lookup with no Session_Store access and never
 * mutates its inputs.
 *
 * @param termId The CyberTerm id this cell represents.
 * @param revealedTermIds The game's live reveal history (read-only).
 * @param markedTermIds The Current_Player's Marked_Term_Ids for the Current_Ticket.
 * @returns The derived cell state.
 */
export function deriveCellState(
  termId: string,
  revealedTermIds: readonly string[],
  markedTermIds: ReadonlySet<string>,
): TicketCellState {
  if (!revealedTermIds.includes(termId)) {
    return 'LOCKED'
  }
  return markedTermIds.has(termId) ? 'MARKED' : 'AVAILABLE'
}
