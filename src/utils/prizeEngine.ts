import type { Game } from '../types/game'
import type { Mark } from '../types/mark'
import type { Prize, PrizeProgress } from '../types/prize'
import type { Ticket } from '../types/ticket'

/** The five prizes and their fixed targets/labels (Req 7.4, 8, 9, 10). */
export const PRIZES: readonly Prize[] = [
  { id: 'CYBER_FIVE', label: 'Cyber Five', target: 5 },
  { id: 'FIREWALL_LINE', label: 'Firewall Line', target: 5 },
  { id: 'SECURITY_LINE', label: 'Security Line', target: 5 },
  { id: 'DATA_DEFENDER_LINE', label: 'Data Defender Line', target: 5 },
  { id: 'CYBER_FULL_HOUSE', label: 'Cyber Full House', target: 15 },
]

/** Row index (0-2) backing each Line_Prize; used by getAllPrizeProgress. */
const LINE_PRIZE_ROWS: Record<
  'FIREWALL_LINE' | 'SECURITY_LINE' | 'DATA_DEFENDER_LINE',
  number
> = {
  FIREWALL_LINE: 0,
  SECURITY_LINE: 1,
  DATA_DEFENDER_LINE: 2,
}

/**
 * Filter the full `marks` collection down to one player's Valid_Marks for one
 * ticket (Req 7.2). Never mutates `marks`.
 */
export function getPlayerTicketMarks(
  marks: readonly Mark[],
  playerId: string,
  ticketId: string,
): Mark[] {
  return marks.filter(
    (m) => m.valid && m.playerId === playerId && m.ticketId === ticketId,
  )
}

/**
 * The distinct set of Marked_Term_Ids present across a collection of
 * Valid_Marks (Req 7.3). Guards by checking `valid` itself so callers cannot
 * accidentally count an invalid mark even if they forgot to pre-filter.
 */
export function getMarkedTermIds(validMarks: readonly Mark[]): Set<string> {
  const ids = new Set<string>()
  for (const mark of validMarks) {
    if (mark.valid) ids.add(mark.termId)
  }
  return ids
}

/** Cyber Five progress: any 5 marked terms regardless of row (Req 8). */
export function getCyberFiveProgress(
  ticket: Ticket,
  validMarks: readonly Mark[],
): PrizeProgress {
  const markedTermIds = getMarkedTermIds(validMarks)
  const ticketTermIds = new Set(
    ticket.rows.flat().map((cell) => cell.termId),
  )
  const markedOnTicket = [...markedTermIds].filter((id) =>
    ticketTermIds.has(id),
  ).length
  return {
    id: 'CYBER_FIVE',
    label: 'Cyber Five',
    current: Math.min(markedOnTicket, 5),
    target: 5,
  }
}

/**
 * One Line_Prize's progress: only marks whose Ticket_Cell is in `row` count
 * (Req 9). `prizeId`/`label` select which of the three line prizes this is.
 */
export function getLineProgress(
  ticket: Ticket,
  validMarks: readonly Mark[],
  row: number,
  prizeId: 'FIREWALL_LINE' | 'SECURITY_LINE' | 'DATA_DEFENDER_LINE',
  label: string,
): PrizeProgress {
  const markedTermIds = getMarkedTermIds(validMarks)
  const rowCells = ticket.rows[row] ?? []
  const current = rowCells.filter((cell) => markedTermIds.has(cell.termId))
    .length
  return { id: prizeId, label, current, target: 5 }
}

/** Cyber Full House progress: every one of the ticket's 15 terms (Req 10). */
export function getFullHouseProgress(
  ticket: Ticket,
  validMarks: readonly Mark[],
): PrizeProgress {
  const markedTermIds = getMarkedTermIds(validMarks)
  const ticketTermIds = ticket.rows.flat().map((cell) => cell.termId)
  const current = ticketTermIds.filter((id) => markedTermIds.has(id)).length
  return {
    id: 'CYBER_FULL_HOUSE',
    label: 'Cyber Full House',
    current,
    target: 15,
  }
}

/**
 * All 5 Prize_Progress entries for a ticket, in PRIZES order (Req 7.4, 11).
 * A single marked term contributes to every prize whose criteria it
 * satisfies simultaneously — none of the per-prize functions above remove or
 * consume a Marked_Term_Id, so calling them all against the same
 * `validMarks` naturally yields non-exclusive counting (Req 11.1, 11.2).
 */
export function getAllPrizeProgress(
  ticket: Ticket,
  validMarks: readonly Mark[],
): PrizeProgress[] {
  return [
    getCyberFiveProgress(ticket, validMarks),
    getLineProgress(ticket, validMarks, LINE_PRIZE_ROWS.FIREWALL_LINE, 'FIREWALL_LINE', 'Firewall Line'),
    getLineProgress(ticket, validMarks, LINE_PRIZE_ROWS.SECURITY_LINE, 'SECURITY_LINE', 'Security Line'),
    getLineProgress(ticket, validMarks, LINE_PRIZE_ROWS.DATA_DEFENDER_LINE, 'DATA_DEFENDER_LINE', 'Data Defender Line'),
    getFullHouseProgress(ticket, validMarks),
  ]
}

/** True when a prize's current progress has reached its target (Req 8.3, 9.5, 10.3). */
export function isPrizeEligible(progress: PrizeProgress): boolean {
  return progress.current >= progress.target
}

/** Reason a mark attempt was rejected, or valid when it may proceed. */
export type MarkValidationResult =
  | { valid: true }
  | {
      valid: false
      reason:
        | 'NO_CURRENT_PLAYER'
        | 'TICKET_NOT_FOUND'
        | 'TERM_NOT_ON_TICKET'
        | 'TERM_NOT_REVEALED'
        | 'GAME_COMPLETED'
        | 'DUPLICATE_MARK'
    }

/**
 * The single validation pipeline for Requirement 2, shared by the reducer's
 * MARK_TERM case and by PlayerGame (to decide whether a tap should dispatch
 * and what feedback to show). Never mutates its inputs.
 *
 * Gates, in order (Req 2.1-2.6):
 *  1. NO_CURRENT_PLAYER   - no player has id === currentPlayerId
 *  2. TICKET_NOT_FOUND    - current player's ticketId has no matching Ticket
 *  3. TERM_NOT_ON_TICKET  - termId does not belong to any cell on that Ticket
 *  4. TERM_NOT_REVEALED   - termId is not in game.revealedTermIds
 *  5. GAME_COMPLETED      - game.status === 'COMPLETED'
 *  6. DUPLICATE_MARK      - a Valid_Mark already exists for
 *                           (currentPlayerId, ticketId, termId)
 *
 * Marking is allowed whenever `game.status !== 'COMPLETED'` and the term has
 * been officially called — gate 5 checks only for COMPLETED; none of
 * `LOBBY`/`WORD_ACTIVE`/`PAUSED` block marking on their own (see design.md's
 * resolution of the equivalent ambiguity, carried through Module 5's
 * collapsed status model unchanged).
 */
export function validateMarkAttempt(
  state: {
    game: Game
    players: { id: string; ticketId: string }[]
    tickets: Ticket[]
    marks: Mark[]
    currentPlayerId?: string
  },
  termId: string,
): MarkValidationResult {
  const player = state.players.find((p) => p.id === state.currentPlayerId)
  if (!player) {
    return { valid: false, reason: 'NO_CURRENT_PLAYER' }
  }

  const ticket = state.tickets.find((t) => t.id === player.ticketId)
  if (!ticket) {
    return { valid: false, reason: 'TICKET_NOT_FOUND' }
  }

  const onTicket = ticket.rows.flat().some((cell) => cell.termId === termId)
  if (!onTicket) {
    return { valid: false, reason: 'TERM_NOT_ON_TICKET' }
  }

  if (!state.game.revealedTermIds.includes(termId)) {
    return { valid: false, reason: 'TERM_NOT_REVEALED' }
  }

  if (state.game.status === 'COMPLETED') {
    return { valid: false, reason: 'GAME_COMPLETED' }
  }

  const duplicate = state.marks.some(
    (m) =>
      m.valid &&
      m.playerId === player.id &&
      m.ticketId === ticket.id &&
      m.termId === termId,
  )
  if (duplicate) {
    return { valid: false, reason: 'DUPLICATE_MARK' }
  }

  return { valid: true }
}

/** Convenience boolean wrapper over validateMarkAttempt, for UI tap gating. */
export function canMarkTerm(
  state: Parameters<typeof validateMarkAttempt>[0],
  termId: string,
): boolean {
  return validateMarkAttempt(state, termId).valid
}
