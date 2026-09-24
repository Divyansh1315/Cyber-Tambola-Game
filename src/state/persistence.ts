import type { Game } from '../types/game'
import type { Mark } from '../types/mark'
import type { Player } from '../types/player'
import type { PrizeClaim, Winner } from '../types/prize'
import type { Ticket } from '../types/ticket'

/** localStorage key for the versioned Module 3 session envelope (Req 16.1). */
export const STORAGE_KEY = 'cyber-tambola-v2:game'

/**
 * localStorage key for THIS browser tab's client-local player identity.
 * Deliberately separate from `STORAGE_KEY`: `currentPlayerId` answers "which
 * player is this device," which is never shared/synchronized session state
 * (see GameSessionContext.tsx and gameSessionReducer.ts for the full
 * rationale — SYNC_STATE must never adopt or clobber this value).
 */
export const CURRENT_PLAYER_STORAGE_KEY = 'cyber-tambola-v2:currentPlayerId'

/**
 * Version marker written into every persisted envelope (Req 16.3). Bumped to
 * 4 for Module 6's removal of the `rev` cross-tab revision counter (design.md
 * Decision 6/7): the envelope no longer carries a `rev` field, and version
 * mismatch is the safe-fallback mechanism that rejects an older (pre-Module-6)
 * envelope rather than silently loading a shape that no longer matches
 * `PersistedSlice`.
 */
export const PERSIST_VERSION = 4 as const

/**
 * The persisted slice of SHARED session state (Req 16.1, 16.3). Deliberately
 * excludes `currentPlayerId` — that is client-local identity, persisted
 * separately under `CURRENT_PLAYER_STORAGE_KEY` (see readCurrentPlayerId /
 * writeCurrentPlayerId below).
 */
export interface PersistedEnvelope {
  version: 4
  game: Game
  players: Player[]
  tickets: Ticket[]
  marks: Mark[]
  claims: PrizeClaim[]
  winners: Winner[]
}

/** The live slice of SHARED session state that gets persisted / restored. */
export interface PersistedSlice {
  game: Game
  players: Player[]
  tickets: Ticket[]
  marks: Mark[]
  claims: PrizeClaim[]
  winners: Winner[]
}

/** Build the versioned envelope from the live slice. */
export function toEnvelope(slice: PersistedSlice): PersistedEnvelope {
  return {
    version: PERSIST_VERSION,
    game: slice.game,
    players: slice.players,
    tickets: slice.tickets,
    marks: slice.marks,
    claims: slice.claims,
    winners: slice.winners,
  }
}

/** Type guard: the parsed value looks like a Game (Req 16.4 shape validation). */
function isGameShape(value: unknown): value is Game {
  if (typeof value !== 'object' || value === null) return false
  const game = value as Record<string, unknown>
  return (
    typeof game.id === 'string' &&
    typeof game.status === 'string' &&
    Array.isArray(game.revealedTermIds)
  )
}

/**
 * Parse + validate a raw string. Returns a reconciled slice or null.
 * Never throws (Req 16.4). Only describes SHARED state — `currentPlayerId`
 * reconciliation (dangling-id handling included) now lives in
 * GameSessionContext.tsx, operating against the freshly-loaded `players`
 * array and the separately-persisted client-local id.
 */
export function parseEnvelope(raw: string | null): PersistedSlice | null {
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Malformed JSON — fall back to seed (Req 16.4).
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const envelope = parsed as Record<string, unknown>

  // Reject anything without the exact version marker, including the old
  // Module 2 shape that lacked a version (Req 16.4).
  if (envelope.version !== PERSIST_VERSION) return null

  if (!isGameShape(envelope.game)) return null
  if (!Array.isArray(envelope.players)) return null
  if (!Array.isArray(envelope.tickets)) return null

  const game = envelope.game as Game
  const players = envelope.players as Player[]
  const tickets = envelope.tickets as Ticket[]

  // Default missing/null/non-array `marks` to [] rather than rejecting the
  // whole envelope (Req 5.4) — this is what lets a legacy Module 3 envelope
  // (no `marks` key at all) still restore game/players/tickets successfully.
  const marks = Array.isArray(envelope.marks) ? (envelope.marks as Mark[]) : []

  // Default missing/null/non-array `claims`/`winners` to [] rather than
  // rejecting the whole envelope (Req 16.4) — same convention as `marks`
  // above, so a pre-Module-5 envelope (no `claims`/`winners` keys at all)
  // still restores successfully.
  const claims = Array.isArray(envelope.claims) ? (envelope.claims as PrizeClaim[]) : []
  const winners = Array.isArray(envelope.winners) ? (envelope.winners as Winner[]) : []

  return { game, players, tickets, marks, claims, winners }
}

/**
 * Best-effort write to localStorage (Req 16.1). Swallows quota/availability
 * errors so persistence never breaks gameplay.
 */
export function writeEnvelope(slice: PersistedSlice): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toEnvelope(slice)))
  } catch {
    // Persistence is best-effort; ignore quota/availability errors.
  }
}

/** Read + parse the persisted envelope from localStorage. */
export function readEnvelope(): PersistedSlice | null {
  if (typeof window === 'undefined') return null
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    // Reading can throw in some locked-down environments; treat as absent.
    return null
  }
  return parseEnvelope(raw)
}

/**
 * Read this tab's client-local player identity. Never throws (fail-safe,
 * same convention as `readEnvelope`) — returns undefined for an absent key,
 * a locked-down environment, or a non-SSR window that simply hasn't set one
 * yet.
 */
export function readCurrentPlayerId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage.getItem(CURRENT_PLAYER_STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Best-effort write of this tab's client-local player identity. Writing
 * `undefined` removes the key entirely (matches RESET_GAME/no-player
 * semantics). Swallows quota/availability errors, same as `writeEnvelope`.
 */
export function writeCurrentPlayerId(playerId: string | undefined): void {
  if (typeof window === 'undefined') return
  try {
    if (playerId === undefined) {
      window.localStorage.removeItem(CURRENT_PLAYER_STORAGE_KEY)
    } else {
      window.localStorage.setItem(CURRENT_PLAYER_STORAGE_KEY, playerId)
    }
  } catch {
    // Persistence is best-effort; ignore quota/availability errors.
  }
}
