import type { CyberTerm } from '../types/cyberTerm'
import type { Ticket, TicketCell } from '../types/ticket'

export const TICKET_ROWS = 3
export const TICKET_COLS = 5
export const TICKET_SIZE = TICKET_ROWS * TICKET_COLS // 15
export const MAX_UNIQUE_ATTEMPTS = 50

/** Metadata needed to build the Ticket record around the generated cells. */
export interface TicketGenOptions {
  id: string
  playerId: string
  gameId: string
  createdAt: string // ISO string, supplied by caller
  ref: string // human-friendly ref, supplied by caller
  /** Injectable RNG in [0,1) for deterministic tests; defaults to Math.random. */
  rng?: () => number
}

/**
 * Only terms with `active === true` (strict boolean) are eligible (Req 7.2).
 * Terms whose `active` is `false`, `null`, `undefined`, or absent are excluded.
 * The input array is never mutated.
 */
export function getActiveTerms(terms: CyberTerm[]): CyberTerm[] {
  return terms.filter((t) => t.active === true)
}

/**
 * Canonical Ticket_Signature: the termIds sorted ascending, joined by a single
 * `|`. Deterministic and order-independent (Req 7.7). The input array is copied
 * before sorting so the caller's array is not mutated.
 */
export function computeSignature(termIds: string[]): string {
  return [...termIds].sort().join('|')
}

/**
 * Fisher-Yates shuffle over a copy of `source` using the supplied RNG.
 * Does not mutate `source`.
 */
function shuffle<T>(source: readonly T[], rng: () => number): T[] {
  const arr = [...source]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/**
 * Build a new Ticket with 15 distinct active terms arranged 3x5 whose
 * signature is not present in `existingSignatures` (Req 7).
 * Throws when fewer than 15 active terms (Req 7.10) or when 50 attempts
 * fail to find a unique signature (Req 7.9). Inputs are never mutated.
 */
export function generateTicket(
  terms: CyberTerm[],
  existingSignatures: readonly string[],
  options: TicketGenOptions,
): Ticket {
  const active = getActiveTerms(terms)
  if (active.length < TICKET_SIZE) {
    throw new Error(
      `ticketGenerator: insufficient active terms (need ${TICKET_SIZE}).`,
    )
  }

  const rng = options.rng ?? Math.random
  const existing = new Set(existingSignatures)

  for (let attempt = 0; attempt < MAX_UNIQUE_ATTEMPTS; attempt++) {
    const chosen = shuffle(active, rng).slice(0, TICKET_SIZE)
    const signature = computeSignature(chosen.map((t) => t.id))

    if (!existing.has(signature)) {
      const rows: TicketCell[][] = []
      for (let i = 0; i < TICKET_SIZE; i++) {
        const row = Math.floor(i / TICKET_COLS)
        const col = i % TICKET_COLS
        const term = chosen[i]
        const cell: TicketCell = {
          termId: term.id,
          term: term.term,
          state: 'LOCKED',
          row,
          col,
        }
        if (!rows[row]) rows[row] = []
        rows[row][col] = cell
      }

      return {
        id: options.id,
        playerId: options.playerId,
        gameId: options.gameId,
        createdAt: options.createdAt,
        ref: options.ref,
        rows,
      }
    }
  }

  throw new Error(
    `ticketGenerator: could not generate a unique ticket after ${MAX_UNIQUE_ATTEMPTS} attempts.`,
  )
}
