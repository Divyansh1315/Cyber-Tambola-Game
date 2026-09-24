import type { Game } from '../types/game'
import type { JoinFormValues, Player } from '../types/player'
import type { Ticket } from '../types/ticket'
import type { CyberTerm } from '../types/cyberTerm'
import { computeSignature, generateTicket } from '../utils/ticketGenerator'

/**
 * The outcome of a join attempt.
 * - `new`: a brand-new player + freshly generated ticket to dispatch.
 * - `restore`: an existing player (by normalized id) to restore as current.
 * - `error`: a validation failure with a user-facing message.
 */
export type JoinOutcome =
  | { kind: 'new'; player: Player; ticket: Ticket }
  | { kind: 'restore'; playerId: string }
  | { kind: 'error'; message: string }

/** Statuses that permit joining (Req 3.7). */
export const JOINABLE_STATUSES = [
  'LOBBY',
  'WORD_ACTIVE',
  'PAUSED',
] as const

/** User-facing validation messages (exact strings per Req 3.4, 3.6, 3.8). */
export const MESSAGES = {
  requiredFields:
    'Please fill in the game code, your name, and your ID to join.',
  gameNotFound: 'Game not found or no longer available.',
  gameCompleted: 'This game has ended and is no longer available.',
} as const

/** The single active prototype game code, in normalized form. */
const EXPECTED_GAME_CODE = 'cyber24'

/** Trim + lowercase for identity comparison (Req 5.1). Idempotent. */
export function normalizeId(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Generate a local unique identifier.
 * Uses `crypto.randomUUID()` when available and falls back to a
 * timestamp + random token otherwise (Req 4.4).
 */
export function localId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }
  const time = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return `id-${time}-${rand}`
}

/**
 * Short header ref derived from a ticket id, e.g. "Ticket #A72F" (Req 10.2).
 * Deterministic (same id yields the same ref); the full id is never a
 * substring of the produced ref (Req 10.3).
 */
export function shortTicketRef(ticketId: string): string {
  // Derive a short token from the id. Keep only alphanumerics so separators in
  // the source id (e.g. UUID hyphens) never survive into the token, then take a
  // handful of trailing characters and uppercase them. Uppercasing plus the
  // short length keeps the token compact and stable across renders (Req 10.2).
  const alnum = ticketId.replace(/[^0-9a-zA-Z]/g, '')
  const base = alnum.length > 0 ? alnum.toUpperCase() : 'TICKET'
  // Cap the token so it is strictly shorter than the full id for any id of
  // length >= 2 (Req 10.3): at most 4 chars, and never longer than id.length-1.
  const maxLen = Math.max(1, Math.min(4, ticketId.length - 1))
  const token = base.slice(-maxLen)
  return `Ticket #${token}`
}

/**
 * Find an existing player in the current game whose employeeDemoId normalizes
 * to the same value as the submitted id (Req 5.2).
 */
export function findExistingPlayer(
  players: Player[],
  employeeDemoId: string,
): Player | undefined {
  const target = normalizeId(employeeDemoId)
  return players.find((p) => normalizeId(p.employeeDemoId) === target)
}

/**
 * Pure validation + routing decision. Does NOT generate a ticket.
 * All fields are trimmed before validation (Req 3.3).
 */
export function validateJoin(
  form: JoinFormValues,
  game: Game,
  players: Player[],
):
  | { kind: 'error'; message: string }
  | { kind: 'restore'; playerId: string }
  | {
      kind: 'new'
      trimmed: { gameCode: string; displayName: string; employeeDemoId: string }
    } {
  const gameCode = form.gameCode.trim()
  const displayName = form.employeeName.trim()
  const employeeDemoId = form.employeeId.trim()

  // Any required field empty after trim → error (Req 3.4).
  if (!gameCode || !displayName || !employeeDemoId) {
    return { kind: 'error', message: MESSAGES.requiredFields }
  }

  // Game code must match CYBER24 case-insensitively (Req 3.5, 3.6).
  if (normalizeId(gameCode) !== EXPECTED_GAME_CODE) {
    return { kind: 'error', message: MESSAGES.gameNotFound }
  }

  // Completed games are no longer joinable (Req 3.8).
  if (game.status === 'COMPLETED') {
    return { kind: 'error', message: MESSAGES.gameCompleted }
  }

  // Duplicate identity → restore existing player (Req 5.2).
  const existing = findExistingPlayer(players, employeeDemoId)
  if (existing) {
    return { kind: 'restore', playerId: existing.id }
  }

  return { kind: 'new', trimmed: { gameCode, displayName, employeeDemoId } }
}

/**
 * Orchestrates validation and (for new players) ticket generation.
 * `terms` and `tickets` are passed in so the function stays testable.
 * Returns error/restore outcomes unchanged; for a new participant it builds
 * ids, a timestamp, a unique ticket, and a well-formed Player record.
 */
export function buildJoinOutcome(args: {
  form: JoinFormValues
  game: Game
  players: Player[]
  tickets: Ticket[]
  terms: CyberTerm[]
}): JoinOutcome {
  const { form, game, players, tickets, terms } = args

  const decision = validateJoin(form, game, players)
  if (decision.kind !== 'new') {
    return decision
  }

  const { displayName, employeeDemoId } = decision.trimmed
  const playerId = localId()
  const ticketId = localId()
  const now = new Date().toISOString()

  const existingSignatures = tickets.map((t) =>
    computeSignature(t.rows.flat().map((c) => c.termId)),
  )

  const ticket = generateTicket(terms, existingSignatures, {
    id: ticketId,
    playerId,
    gameId: game.id,
    createdAt: now,
    ref: shortTicketRef(ticketId),
  })

  const player: Player = {
    id: playerId,
    gameId: game.id,
    displayName,
    employeeDemoId,
    ticketId,
    joinedAt: now,
    // UI-facing aliases retained from Module 1 (Req 4.1–4.3).
    name: displayName,
    employeeId: employeeDemoId,
    ticketRef: ticket.ref,
  }

  return { kind: 'new', player, ticket }
}
