/**
 * Lifecycle state of a game session.
 *   LOBBY       - created, not yet started; players can join
 *   WORD_ACTIVE - a Cyber Word has been officially called; its word,
 *                 definition, and awareness tip are all shown at once
 *   PAUSED      - gameplay temporarily halted by the host
 *   COMPLETED   - the session has ended and is read-only
 *
 * There is no longer a separate "clue shown, answer hidden" phase — calling a
 * word and displaying its full content are the same action (Module 5).
 */
export type GameStatus = 'LOBBY' | 'WORD_ACTIVE' | 'PAUSED' | 'COMPLETED'

/**
 * The central game model — single source of truth for a session.
 * All timestamps are ISO strings kept locally (no backend).
 */
export interface Game {
  id: string
  code: string
  status: GameStatus
  createdAt: string
  startedAt?: string
  endedAt?: string
  /** 0 in the lobby, then 1..N as Cyber Words are called. */
  currentRound: number
  /** The term currently in play (officially called), if any. */
  currentTermId?: string
  /**
   * Every Cyber_Term id the host has officially called this game, in call
   * order. Kept under its original name for compatibility with
   * deriveCellState, prizeEngine.validateMarkAttempt, and persistence — only
   * its English meaning changed, from "revealed" to "officially called"
   * (Module 5). This is the field that makes a matching ticket term
   * AVAILABLE to mark.
   */
  revealedTermIds: string[]
  /** The gameplay status to return to after a pause. */
  previousStatus?: GameStatus
  /**
   * The id of the most recently confirmed Winner that has not yet been
   * superseded by a Next-Cyber-Word or Start-Game action
   * (presenter-realtime-winner-sync fix). `undefined` means no active
   * announcement. Shared/authoritative -- never Presenter-local-only state --
   * so every Presenter instance (any tab, any refresh) renders identically.
   */
  latestWinnerAnnouncementId?: string
}

// Ticket types live in ./ticket; re-exported here for backwards compatibility
// with Module 1 imports (`import type { Ticket } from '../types/game'`).
export type { Ticket, TicketCell, TicketCellState } from './ticket'
