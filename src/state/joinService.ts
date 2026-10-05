import type { Game } from '../types/game'
import type { JoinFormValues, Player } from '../types/player'
import type { Ticket } from '../types/ticket'
import type { CyberTerm } from '../types/cyberTerm'
import { computeSignature, generateTicket } from '../utils/ticketGenerator'

/**
 * The outcome of a join attempt.
 * - `new`: a brand-new player + freshly generated ticket to dispatch.
 * - `restore`: an existing player (by device join token) to restore as current.
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
  requiredFields: 'Please fill in the game code and your name to join.',
  gameNotFound: 'Game not found or no longer available.',
  gameCompleted: 'This game has ended and is no longer available.',
} as const

/**
 * Dedicated localStorage key for this device's join-identity token --
 * separate from both the shared envelope key and `currentPlayerId`'s own
 * key (persistence.ts), for the same reason `currentPlayerId` is separate:
 * this answers "which browser/device is this," which must never be
 * overwritten by a remote sync/hydration and must never be shared across
 * tabs on different devices. Unlike `currentPlayerId` it is NOT tied to any
 * one game/session -- it is created once per browser and reused for every
 * future join (including in a different, later game), so a returning
 * player on the same device is recognized without asking for a name-based
 * or ID-based match.
 */
const DEVICE_JOIN_TOKEN_STORAGE_KEY = 'cyber-tambola-v2:deviceJoinToken'

/**
 * Returns this browser's device join token, generating and persisting one
 * on first use. This is an opaque, non-personal identifier -- it carries no
 * employee/demo ID and is never displayed anywhere in the UI. It exists
 * solely so `join_game` can recognize "this device already has a player in
 * this game" (Req: duplicate-join restoration) without collecting an
 * Employee ID and without matching on `displayName` (different employees
 * can share a name).
 */
export function readOrCreateDeviceJoinToken(): string {
  if (typeof window === 'undefined' || !window.localStorage) return localId()
  try {
    const existing = window.localStorage.getItem(DEVICE_JOIN_TOKEN_STORAGE_KEY)
    if (existing) return existing
    const token = localId()
    window.localStorage.setItem(DEVICE_JOIN_TOKEN_STORAGE_KEY, token)
    return token
  } catch {
    // localStorage unavailable/full/blocked (e.g. private browsing) --
    // fail open with a fresh, non-persisted token rather than blocking the
    // join; this device just won't be recognized as "returning" next time.
    return localId()
  }
}

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
 * `Player` no longer carries the device join token used to recognize a
 * returning player (it's an internal join-time signal, never a domain
 * field shown/stored on the player record) -- restore-matching therefore
 * cannot be done by scanning `players` for a field the type doesn't have.
 * Callers pass the game's own locally-tracked map from device token to
 * player id instead. In the local-fallback path (no Supabase configured)
 * this is threaded through as `deviceJoinTokensByPlayerId` (see
 * `PlayerJoin.tsx`), a small player-id -> token side table maintained
 * client-side alongside `players`, exactly the same way `currentPlayerId`
 * is kept alongside but outside of `players`.
 */
export function findExistingPlayer(
  players: Player[],
  deviceJoinTokensByPlayerId: Record<string, string>,
  deviceJoinToken: string,
): Player | undefined {
  const target = normalizeId(deviceJoinToken)
  return players.find(
    (p) => normalizeId(deviceJoinTokensByPlayerId[p.id] ?? '') === target,
  )
}

/**
 * Pure validation + routing decision. Does NOT generate a ticket.
 * All fields are trimmed before validation (Req 3.3).
 */
export function validateJoin(
  form: JoinFormValues,
  game: Game,
  players: Player[],
  deviceJoinTokensByPlayerId: Record<string, string>,
  deviceJoinToken: string,
):
  | { kind: 'error'; message: string }
  | { kind: 'restore'; playerId: string }
  | {
      kind: 'new'
      trimmed: { gameCode: string; displayName: string }
    } {
  const gameCode = form.gameCode.trim()
  const displayName = form.employeeName.trim()

  // Any required field empty after trim → error (Req 3.4).
  if (!gameCode || !displayName) {
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

  // Same device already has a player in this game → restore, never a
  // fresh join (Req 5.2). Matched by device join token, never by name:
  // two different employees typing the same display name must never be
  // merged into one player.
  const existing = findExistingPlayer(
    players,
    deviceJoinTokensByPlayerId,
    deviceJoinToken,
  )
  if (existing) {
    return { kind: 'restore', playerId: existing.id }
  }

  return { kind: 'new', trimmed: { gameCode, displayName } }
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
  deviceJoinTokensByPlayerId: Record<string, string>
  deviceJoinToken: string
}): JoinOutcome {
  const {
    form,
    game,
    players,
    tickets,
    terms,
    deviceJoinTokensByPlayerId,
    deviceJoinToken,
  } = args

  const decision = validateJoin(
    form,
    game,
    players,
    deviceJoinTokensByPlayerId,
    deviceJoinToken,
  )
  if (decision.kind !== 'new') {
    return decision
  }

  const { displayName } = decision.trimmed
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
    ticketId,
    joinedAt: now,
    // UI-facing alias retained from Module 1 (Req 4.1–4.3).
    name: displayName,
    ticketRef: ticket.ref,
  }

  return { kind: 'new', player, ticket }
}
