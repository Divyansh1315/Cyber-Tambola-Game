/** Visual/interaction state of a single ticket cell. */
export type TicketCellState = 'LOCKED' | 'AVAILABLE' | 'MARKED'

/** A single cell on a player's cyber-word ticket. */
export interface TicketCell {
  /** References the CyberTerm this cell represents. */
  termId: string
  /** Display term for the cell, e.g. "Phishing". */
  term: string
  state: TicketCellState
  /** Row index within the 3x5 grid. */
  row: number // NEW 0..2 (Req 7.5)
  /** Column index within the 3x5 grid. */
  col: number // NEW 0..4 (Req 7.5)
}

/**
 * A 3 x 5 cyber-word ticket (15 terms).
 * `id`, `playerId`, `gameId`, and `createdAt` are part of the Module 2 domain
 * model; `ref` and `rows` remain for the existing ticket UI.
 */
export interface Ticket {
  id: string
  playerId: string
  gameId: string
  createdAt: string
  /** Human-friendly reference shown in the UI, e.g. "Ticket #021". */
  ref: string
  /** Rows of cells; 3 rows of 5 for the prototype. */
  rows: TicketCell[][]
}
