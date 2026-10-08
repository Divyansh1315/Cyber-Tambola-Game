import type { Game } from '../types/game'
import type { Mark } from '../types/mark'
import type { Prize, PrizeProgress, Winner } from '../types/prize'
import type { Ticket } from '../types/ticket'
import { TICKET_COLUMNS, TICKET_SIZE } from './ticketGenerator'

/** The five prizes and their fixed targets/labels (Req 7.4, 8, 9, 10). */
export const PRIZES: readonly Prize[] = [
  { id: 'CYBER_FIVE', label: 'Cyber Five', target: 5 },
  { id: 'FIREWALL_LINE', label: 'Firewall Line', target: TICKET_COLUMNS },
  { id: 'SECURITY_LINE', label: 'Security Line', target: TICKET_COLUMNS },
  { id: 'DATA_DEFENDER_LINE', label: 'Data Defender Line', target: TICKET_COLUMNS },
  { id: 'CYBER_FULL_HOUSE', label: 'Cyber Full House', target: TICKET_SIZE },
]

/** Row index (0-2) backing each Line_Prize; used by getAllPrizeProgress. */
export const LINE_PRIZE_ROWS: Record<
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
 * (Req 9, 21). `prizeId`/`label` select which of the three line prizes this
 * is. The target is derived from the row's own length (falling back to
 * `TICKET_COLUMNS` only if the row is empty), so a legacy 3x5 ticket still
 * reports a 5-cell target with no branching on ticket format (Req 4.3, 7.3).
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
  const target = rowCells.length || TICKET_COLUMNS
  return { id: prizeId, label, current, target }
}

/**
 * Cyber Full House progress: every one of the ticket's terms (Req 10, 22).
 * The target is derived from the ticket's own cell count (falling back to
 * `TICKET_SIZE` only if the ticket has no cells), so a legacy 15-cell ticket
 * still reports a 15-cell target with no branching on ticket format
 * (Req 7.3).
 */
export function getFullHouseProgress(
  ticket: Ticket,
  validMarks: readonly Mark[],
): PrizeProgress {
  const markedTermIds = getMarkedTermIds(validMarks)
  const ticketTermIds = ticket.rows.flat().map((cell) => cell.termId)
  const current = ticketTermIds.filter((id) => markedTermIds.has(id)).length
  const target = ticketTermIds.length || TICKET_SIZE
  return {
    id: 'CYBER_FULL_HOUSE',
    label: 'Cyber Full House',
    current,
    target,
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
 *  4. TERM_NOT_REVEALED   - termId is not present in game.revealedTermIds
 *  5. GAME_COMPLETED      - game.status === 'COMPLETED' // not-a-ticket-dimension
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

/** The four Fixed_Pattern_Prizes with a determinable, fixed cell set (Req 12). CYBER_FIVE is deliberately excluded — it has no fixed cell set (Req 12.3). */
const FIXED_PATTERN_PRIZE_IDS = [
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
] as const

export function getAwardedCellTermIds(
  ticket: Ticket,
  winners: readonly Winner[],
  playerId: string,
  gameId: string,
): Set<string> {
  const result = new Set<string>()

  for (const prizeId of FIXED_PATTERN_PRIZE_IDS) {
    const won = winners.some(
      (w) => w.gameId === gameId && w.playerId === playerId && w.prizeId === prizeId,
    )
    if (!won) continue

    const cells =
      prizeId === 'CYBER_FULL_HOUSE'
        ? ticket.rows.flat()
        : ticket.rows[LINE_PRIZE_ROWS[prizeId]] ?? []

    for (const cell of cells) {
      result.add(cell.termId)
    }
  }

  return result
}
