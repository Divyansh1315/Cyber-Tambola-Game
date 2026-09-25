import { cyberTerms } from '../data/cyberTerms'
import type { Game } from '../types/game'
import type { Mark } from '../types/mark'
import type { Player } from '../types/player'
import type { PrizeClaim, PrizeId, Winner } from '../types/prize'
import type { Ticket } from '../types/ticket'
import { validatePrizeClaim } from '../utils/claimEngine'
import { selectNextTerm } from '../utils/gameEngine'
import { PRIZES, validateMarkAttempt } from '../utils/prizeEngine'
import { canConfirmClaim } from '../utils/winnerEngine'
import {
  createSeedGame,
  gameSessionInitialState,
  generateLocalGameCode,
  type GameSessionState,
} from './gameSessionInitialState'
import { localId } from './joinService'
import type { RemoteChange } from './realtimeClient'
import {
  mapRowToClaim,
  mapRowToGame,
  mapRowToMark,
  mapRowToPlayer,
  mapRowToTicket,
  mapRowToWinner,
  upsertById,
} from './remoteRowMappers'

/**
 * A full fetch of one game's current authoritative state, as assembled by
 * `GameSessionContext.tsx`'s mount/reconnect effect from a set of read-only
 * `SELECT`s (game, called_terms -> revealedTermIds, players, tickets, marks,
 * claims, winners). Passed to `HYDRATE_FROM_REMOTE` as a one-shot whole-slice
 * replace — see that action's case below.
 */
export interface RemoteSnapshot {
  game: Game
  players: Player[]
  tickets: Ticket[]
  marks: Mark[]
  claims: PrizeClaim[]
  winners: Winner[]
}

/** The local collections `ROLLBACK_OPTIMISTIC` is permitted to remove an entry from. */
export type RollbackCollection = 'players' | 'tickets' | 'marks' | 'claims' | 'winners'

/**
 * The slice of SHARED session state broadcast across same-browser tabs over
 * BroadcastChannel and persisted to localStorage as a dev/offline-render
 * convenience (design.md Decision 7). Host-only demo data (prizeProgress) is
 * intentionally excluded — it is local UI state, not shared game state.
 *
 * `currentPlayerId` is deliberately NOT part of this payload. It answers
 * "which player is THIS browser tab," which is client-local identity, not
 * shared game state — it must never be broadcast or adopted from an incoming
 * payload (see the `SYNC_LOCAL` case below, and GameSessionContext.tsx for
 * how it's persisted separately).
 */
export interface SharedStatePayload {
  game: Game
  players: Player[]
  tickets: Ticket[]
  marks: Mark[]
  claims: PrizeClaim[]
  winners: Winner[]
}

/** True when a value has the minimum shape of a shared-state payload (fail-safe). */
export function isValidSharedStatePayload(value: unknown): value is SharedStatePayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const game = v.game as Record<string, unknown> | undefined
  return (
    typeof game === 'object' &&
    game !== null &&
    typeof game.id === 'string' &&
    typeof game.status === 'string' &&
    Array.isArray(game.revealedTermIds) &&
    Array.isArray(v.players) &&
    Array.isArray(v.tickets)
    // `marks`, `claims`, and `winners` are intentionally NOT required here —
    // SYNC_LOCAL normalizes each of them itself so a payload missing/
    // malformed only on one of those fields isn't rejected.
  )
}

/**
 * Actions the host (and dev tools) can dispatch against the central session.
 * Invalid actions for the current status are ignored safely by the reducer,
 * so double-clicks and out-of-order clicks never corrupt state.
 */
export type GameSessionAction =
  | { type: 'START_GAME' }
  | { type: 'CALL_NEXT_WORD' }
  | { type: 'PAUSE_GAME' }
  | { type: 'RESUME_GAME' }
  | { type: 'END_GAME' }
  | { type: 'RESET_GAME' }
  // A pre-built player + ticket join the session (built by the join service
  // before dispatch — the reducer stays pure and never generates a ticket).
  | { type: 'JOIN_PLAYER'; player: Player; ticket: Ticket }
  // Restore an existing player as the current player (no records created).
  | { type: 'RESTORE_PLAYER'; playerId: string }
  // Apply a shared-state slice received from another tab of THIS browser
  // over BroadcastChannel (same-tab convenience, zero authority — design.md
  // Decision 7). Unlike the old SYNC_STATE, there is no `rev` to compare:
  // same-tab BroadcastChannel delivery has no cross-client staleness problem
  // to solve (there is no third client Postgres already arbitrates for), so
  // each collection is simply upserted-by-id (same convention as
  // SYNC_REMOTE) and `game` is replaced outright, matching Postgres's own
  // "last write wins, no authority claimed" treatment of this path.
  | { type: 'SYNC_LOCAL'; payload: SharedStatePayload }
  // A player taps an AVAILABLE cell; validated against Requirement 2's gates.
  | { type: 'MARK_TERM'; termId: string }
  // A player submits a claim for one specific prize (Req 2.3, 2.4): only
  // playerId/ticketId/prizeId are carried; there is no eligibility flag on
  // this action's shape, so there is nothing for the reducer to trust.
  | { type: 'SUBMIT_PRIZE_CLAIM'; playerId: string; ticketId: string; prizeId: PrizeId }
  // The host confirms a specific claim (Req 8).
  | { type: 'CONFIRM_CLAIM'; claimId: string }
  // The host rejects a specific claim, with an optional reason (Req 9).
  | { type: 'REJECT_CLAIM'; claimId: string; rejectionReason?: string }
  // NEW (Module 6) — replaces SYNC_STATE's role for every Supabase-backed
  // field. Applies exactly one authoritative row change received from a
  // Realtime subscription (or synthesized from a fetch), upserted or folded
  // in by id/table — never a whole-collection replace. There is no `rev` to
  // compare: the row from Postgres always wins outright, because Postgres is
  // the single writer of record for every field it touches (an optimistic
  // local entry for the same id is simply replaced). `currentPlayerId` is
  // never read from or written by this action, for any table, under any
  // eventType (Req 15.2).
  | { type: 'SYNC_REMOTE'; change: RemoteChange }
  // NEW (Module 6) — one-shot whole-slice replace of game/players/tickets/
  // marks/claims/winners from a freshly fetched snapshot, dispatched only on
  // mount/reconnect (GameSessionContext.tsx). Unlike SYNC_STATE this is never
  // gated by a revision comparison: at the moment of mount/reconnect there is
  // no local state worth preserving that Postgres doesn't already have more
  // current. `currentPlayerId` is left untouched (Req 15.3).
  | { type: 'HYDRATE_FROM_REMOTE'; snapshot: RemoteSnapshot }
  // NEW (Module 6) — removes a single optimistic-only entry from the
  // relevant local collection when its matching RPC call is rejected (e.g. a
  // MARK_TERM whose submit_mark RPC came back DUPLICATE_MARK, or a
  // CALL_NEXT_WORD whose call_next_word RPC lost a race). `currentPlayerId`
  // is left untouched (Req 16.1, 16.3).
  | { type: 'ROLLBACK_OPTIMISTIC'; collection: RollbackCollection; id: string }
  // NEW (winner-history-and-game-reset) — dispatched by the context's
  // pointer-follow effect when get_active_game() resolves no row (Req 3.4)
  // or a pointer-change event announces active_game_id = null: resets the
  // shared game/players/tickets/marks/claims/winners slice to the initial
  // empty/falsy game.id sentinel (the same convention every screen's render
  // already guards on), so no stale data from a previously resolved game
  // survives. `currentPlayerId` is deliberately left untouched -- this is
  // "no active game," not "log this device's player out" (Req 3.4, 4.3).
  | { type: 'NO_ACTIVE_GAME' }

function now(): string {
  return new Date().toISOString()
}

export function gameSessionReducer(
  state: GameSessionState,
  action: GameSessionAction,
): GameSessionState {
  const { game } = state

  switch (action.type) {
    case 'START_GAME': {
      // Only valid from the lobby; ignore repeat clicks.
      if (game.status !== 'LOBBY') return state

      const first = selectNextTerm(cyberTerms, game.revealedTermIds)
      // Defensive: with a populated bank this cannot happen, but stay safe.
      if (!first) return state

      // Calling a word and displaying it are the same action (Module 5): the
      // first term is immediately official — no separate reveal step.
      const started: Game = {
        ...game,
        status: 'WORD_ACTIVE',
        startedAt: now(),
        currentRound: 1,
        currentTermId: first.id,
        revealedTermIds: [...game.revealedTermIds, first.id],
      }
      return { ...state, game: started }
    }

    case 'CALL_NEXT_WORD': {
      // Only valid while a word is currently active.
      if (game.status !== 'WORD_ACTIVE') return state

      const next = selectNextTerm(cyberTerms, game.revealedTermIds)
      // Bank exhausted: do not call another word; end the game safely.
      if (!next) {
        return {
          ...state,
          game: { ...game, status: 'COMPLETED', endedAt: now() },
        }
      }

      // Calling the next word makes it official immediately, folding in what
      // used to be a separate reveal step (Module 5).
      return {
        ...state,
        game: {
          ...game,
          currentRound: game.currentRound + 1,
          currentTermId: next.id,
          revealedTermIds: [...game.revealedTermIds, next.id],
        },
      }
    }

    case 'PAUSE_GAME': {
      // Only valid while a word is active; ignore if already paused/other.
      if (game.status !== 'WORD_ACTIVE') return state
      return {
        ...state,
        game: { ...game, status: 'PAUSED', previousStatus: game.status },
      }
    }

    case 'RESUME_GAME': {
      // Only valid while paused; return to the pre-pause gameplay status.
      if (game.status !== 'PAUSED') return state
      const resumeTo = game.previousStatus ?? 'WORD_ACTIVE'
      return {
        ...state,
        game: { ...game, status: resumeTo, previousStatus: undefined },
      }
    }

    case 'END_GAME': {
      // Any state except an already-completed game can end.
      if (game.status === 'COMPLETED') return state
      return {
        ...state,
        game: {
          ...game,
          status: 'COMPLETED',
          endedAt: now(),
          previousStatus: undefined,
        },
      }
    }

    case 'JOIN_PLAYER': {
      // Append the pre-built player + ticket and mark them as current.
      // Pure: no ticket generation, no randomness (Req 14.2, 14.4).
      return {
        ...state,
        players: [...state.players, action.player],
        tickets: [...state.tickets, action.ticket],
        currentPlayerId: action.player.id,
      }
    }

    case 'RESTORE_PLAYER': {
      // Point at an existing player without creating any records (Req 14.3).
      // Ignore safely if no such player exists (matches the "ignore invalid
      // actions" convention used by the lifecycle cases above).
      if (!state.players.some((p) => p.id === action.playerId)) return state
      return { ...state, currentPlayerId: action.playerId }
    }

    case 'SYNC_LOCAL': {
      // Apply a shared-state payload broadcast from another tab of THIS
      // browser. Malformed payloads are ignored so a corrupt broadcast can
      // never crash or blank the session (fail-safe).
      if (!isValidSharedStatePayload(action.payload)) return state

      const { game } = action.payload

      // Default missing/invalid incoming collections to [] rather than
      // rejecting the whole payload — mirrors persistence's fail-safe
      // convention.
      const incomingPlayers = Array.isArray(action.payload.players)
        ? action.payload.players
        : []
      const incomingTickets = Array.isArray(action.payload.tickets)
        ? action.payload.tickets
        : []
      const incomingMarks = Array.isArray(action.payload.marks)
        ? action.payload.marks
        : []
      const incomingClaims = Array.isArray(action.payload.claims)
        ? action.payload.claims
        : []
      const incomingWinners = Array.isArray(action.payload.winners)
        ? action.payload.winners
        : []

      // Upsert each collection by id, the same convention SYNC_REMOTE uses —
      // there is no cross-tab staleness-ordering problem to solve for a
      // purely same-tab, no-authority convenience (design.md Decision 7), so
      // a simple id-keyed upsert of every incoming record is always safe and
      // never drops a record either side already has.
      let players = state.players
      for (const player of incomingPlayers) players = upsertById(players, player)
      let tickets = state.tickets
      for (const ticket of incomingTickets) tickets = upsertById(tickets, ticket)
      let marks = state.marks
      for (const mark of incomingMarks) marks = upsertById(marks, mark)
      let claims = state.claims
      for (const claim of incomingClaims) claims = upsertById(claims, claim)
      let winners = state.winners
      for (const winner of incomingWinners) winners = upsertById(winners, winner)

      // `currentPlayerId` is intentionally left untouched here. It is
      // client-local identity ("which player is THIS tab"), never part of
      // `SharedStatePayload`, and must survive a broadcast from another tab
      // regardless of what that tab's own `players` array looked like when it
      // broadcast (e.g. a Host tab whose local `players` is empty or stale
      // must never log a Player tab out).
      return {
        ...state,
        game,
        players,
        tickets,
        marks,
        claims,
        winners,
      }
    }

    case 'SYNC_REMOTE': {
      // Applies exactly one authoritative row change (never a whole
      // collection) into the local optimistic projection. `currentPlayerId`
      // is never read from or written by this case, for any table, under
      // any eventType — the one guarantee this action exists to make
      // airtight (Req 15.2: shared updates must never erase currentPlayerId).
      const { table, eventType, row } = action.change

      switch (table) {
        case 'games':
          return { ...state, game: { ...mapRowToGame(row), revealedTermIds: state.game.revealedTermIds } }

        case 'called_terms': {
          // Folded into `game.revealedTermIds` for compatibility with every
          // existing selector (deriveCellState, prizeEngine, etc.) that
          // already reads that field — called_terms is what made
          // revealedTermIds authoritative server-side, but the client-facing
          // shape is unchanged (Req 16.1).
          const termId = row.term_id as string
          return {
            ...state,
            game: {
              ...state.game,
              revealedTermIds: [...new Set([...state.game.revealedTermIds, termId])],
            },
          }
        }

        case 'tickets': {
          // A brand-new player's ticket can arrive before or after their
          // players row over Realtime (server commits both in one
          // transaction, but delivers them as independent events) -- so
          // this also backfills the matching player's ticketId/ticketRef UI
          // aliases if that player row is already present (Req 3.1, 3.6).
          const ticket = mapRowToTicket(row)
          const players = state.players.map((p) =>
            p.id === ticket.playerId ? { ...p, ticketId: ticket.id, ticketRef: ticket.ref } : p,
          )
          return { ...state, players, tickets: upsertById(state.tickets, ticket) }
        }

        case 'players': {
          // players is not part of the six-table Realtime subscription list
          // called out in earlier reviews of this file, but the Host
          // Dashboard's participant count/roster reads state.players
          // directly (Req 6.1, 6.2) -- without this case, a new join from
          // another device never appears there until the next full
          // reconnect/HYDRATE_FROM_REMOTE. A DELETE here is a defensive
          // no-op, matching the marks case above: this design never
          // deletes a players row once a game is underway.
          if (eventType === 'DELETE') return state
          const existingTicket = state.tickets.find((t) => t.playerId === (row.id as string))
          return { ...state, players: upsertById(state.players, mapRowToPlayer(row, existingTicket)) }
        }

        case 'marks':
          // Marks are never deleted in this design; a DELETE event is a
          // defensive no-op rather than removing a persisted Mark (Req 16.3).
          return eventType === 'DELETE'
            ? state
            : { ...state, marks: upsertById(state.marks, mapRowToMark(row)) }

        case 'claims':
          return { ...state, claims: upsertById(state.claims, mapRowToClaim(row)) }

        case 'winners':
          return { ...state, winners: upsertById(state.winners, mapRowToWinner(row)) }

        default:
          return state
      }
    }

    case 'HYDRATE_FROM_REMOTE': {
      // One-shot whole-slice replace on mount/reconnect (Req 14.1, 14.2,
      // 14.3): unlike SYNC_STATE there is no revision comparison here — at
      // this moment there is no local state worth preserving that Postgres
      // doesn't already have more current. `currentPlayerId` is left
      // untouched (Req 15.3).
      const { snapshot } = action
      return {
        ...state,
        game: snapshot.game,
        players: snapshot.players,
        tickets: snapshot.tickets,
        marks: snapshot.marks,
        claims: snapshot.claims,
        winners: snapshot.winners,
      }
    }

    case 'ROLLBACK_OPTIMISTIC': {
      // Removes a single optimistic-only entry when its matching RPC call is
      // rejected, so a failed write never permanently shows a state the
      // database refused to accept. `currentPlayerId` is left untouched
      // (Req 16.1, 16.3).
      const { collection, id } = action
      switch (collection) {
        case 'players':
          return { ...state, players: state.players.filter((p) => p.id !== id) }
        case 'tickets':
          return { ...state, tickets: state.tickets.filter((t) => t.id !== id) }
        case 'marks':
          return { ...state, marks: state.marks.filter((m) => m.id !== id) }
        case 'claims':
          return { ...state, claims: state.claims.filter((c) => c.id !== id) }
        case 'winners':
          return { ...state, winners: state.winners.filter((w) => w.id !== id) }
        default:
          return state
      }
    }

    case 'MARK_TERM': {
      const result = validateMarkAttempt(state, action.termId)
      if (!result.valid) return state // Req 2.7, 3.4 — same reference, no side effects

      const player = state.players.find((p) => p.id === state.currentPlayerId)!
      const newMark: Mark = {
        id: localId(),
        gameId: state.game.id,
        playerId: player.id,
        ticketId: player.ticketId,
        termId: action.termId,
        markedAt: now(),
        valid: true,
      }
      return { ...state, marks: [...state.marks, newMark] } // Req 2.8, 3.3
    }

    case 'SUBMIT_PRIZE_CLAIM': {
      const player = state.players.find((p) => p.id === action.playerId)
      const ticket = state.tickets.find((t) => t.id === action.ticketId)

      const result = validatePrizeClaim({
        game: state.game,
        player,
        ticket,
        marks: state.marks,
        prizeId: action.prizeId,
        winners: state.winners,
        existingClaims: state.claims,
      })

      const prizeMeta = PRIZES.find((p) => p.id === action.prizeId)!
      const newClaim: PrizeClaim = {
        id: localId(),
        gameId: state.game.id,
        playerId: action.playerId,
        ticketId: action.ticketId,
        prizeId: action.prizeId,
        submittedAt: now(),
        validationStatus: result.valid ? 'VALID' : 'INVALID',
        hostDecision: 'PENDING',
        rejectionReason: result.valid ? undefined : result.reason,
        prizeLabel: prizeMeta.label,
        playerName: player?.displayName ?? 'Unknown player',
        ticketRef: ticket?.ref ?? 'Unknown ticket',
      }
      // Every submission — VALID or INVALID — is recorded (Req 3.3, 3.4); an
      // INVALID claim is never silently dropped, so the host's history and
      // the player's own progress-based feedback (Req 10.3) both have a
      // record to read.
      return {
        ...state,
        claims: [...state.claims, newClaim],
      }
    }

    case 'CONFIRM_CLAIM': {
      const claim = state.claims.find((c) => c.id === action.claimId)
      if (!claim || !canConfirmClaim(claim, state.winners)) return state // Req 8.7, 8.8 — no-op

      const decidedAt = now()
      const updatedClaims = state.claims.map((c) =>
        c.id === claim.id ? { ...c, hostDecision: 'CONFIRMED' as const, decidedAt } : c,
      )
      const newWinner: Winner = {
        id: localId(),
        gameId: claim.gameId,
        prizeId: claim.prizeId,
        playerId: claim.playerId,
        ticketId: claim.ticketId,
        claimId: claim.id,
        confirmedAt: decidedAt,
        prizeLabel: claim.prizeLabel,
        playerName: claim.playerName,
        ticketRef: claim.ticketRef,
      }
      return {
        ...state,
        claims: updatedClaims,
        winners: [...state.winners, newWinner],
      } // Req 8.2, 8.3, 8.4, 8.6 — only claims/winners change
    }

    case 'REJECT_CLAIM': {
      const claim = state.claims.find((c) => c.id === action.claimId)
      if (!claim || claim.hostDecision !== 'PENDING') return state // Req 9.1 — no-op

      const decidedAt = now()
      const updatedClaims = state.claims.map((c) =>
        c.id === claim.id
          ? {
              ...c,
              hostDecision: 'REJECTED' as const,
              decidedAt,
              rejectionReason: action.rejectionReason ?? c.rejectionReason,
            }
          : c,
      )
      return { ...state, claims: updatedClaims } // Req 9.2, 9.3, 9.4
    }

    case 'RESET_GAME': {
      // Local Fallback reset (Req 9.1, 9.3): players/tickets/currentPlayerId/
      // marks/claims are cleared exactly as before, and the game returns to
      // LOBBY (round 0, no current term, empty reveals) — but unlike the old
      // behavior, this session's winners are never dropped. They are folded
      // into winnerHistory (appended onto whatever has already accumulated
      // there from earlier resets, never dropping prior entries), mirroring
      // the server-side split between the permanent `winners` table and the
      // pointer that moves on reset (design.md Decision 7). The reseeded
      // game gets a freshly generated local code, the client-local
      // equivalent of a New_Game_Code (Req 9.3).
      return {
        ...gameSessionInitialState,
        game: createSeedGame(generateLocalGameCode()),
        winnerHistory: [...state.winnerHistory, ...state.winners],
      }
    }

    case 'NO_ACTIVE_GAME': {
      // Reset the shared game/players/tickets/marks/claims/winners slice to
      // the initial empty/falsy game.id sentinel -- unlike RESET_GAME this
      // is not a host-triggered lifecycle transition, it is the client
      // discovering there is currently no Active_Game to follow at all (Req
      // 3.4, 4.3). `currentPlayerId` is preserved: this device's player
      // identity is unrelated to whether a game happens to be active right
      // now.
      return { ...gameSessionInitialState, currentPlayerId: state.currentPlayerId }
    }

    default:
      return state
  }
}
