import type { Game, GameStatus } from '../types/game'
import type { Mark } from '../types/mark'
import type { Player } from '../types/player'
import type { PrizeClaim, ValidationStatus, HostDecision } from '../types/claim'
import type { PrizeId, Winner } from '../types/prize'
import type { Ticket, TicketCell } from '../types/ticket'

/**
 * Pure, one-row-at-a-time mappers from a Postgres row (as delivered by a
 * `RemoteChange` from `realtimeClient.ts`, or read directly via a `SELECT`)
 * onto the existing TypeScript domain types Modules 3-5 already established.
 * Each mapper reads snake_case column names off `Record<string, unknown>`
 * and writes the camelCase domain shape - see design.md's "Data Models"
 * table (Components and Interfaces #5) for the exact field mapping this
 * mirrors.
 *
 * These are intentionally dumb 1:1 field mappers: no validation, no
 * business logic, no defaulting beyond what's needed to satisfy the
 * TypeScript shape (e.g. null -> undefined for optional fields). All
 * business rules already live in `prizeEngine.ts`/`claimEngine.ts`/
 * `winnerEngine.ts` and are re-validated server-side by the RPCs - by the
 * time a row reaches one of these mappers it is already authoritative.
 */

function str(row: Record<string, unknown>, key: string): string {
  return row[key] as string
}

function optStr(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key]
  return value === null || value === undefined ? undefined : (value as string)
}

function num(row: Record<string, unknown>, key: string): number {
  return row[key] as number
}

/**
 * Maps a `games` row onto the existing `Game` type. `revealedTermIds` is not
 * a column on this table - it is folded in from `called_terms` rows
 * separately, in the reducer's `SYNC_REMOTE` case - so this mapper always
 * returns an empty array for it and callers are responsible for preserving/
 * merging the existing value (exactly as `SYNC_REMOTE`'s `games` case does
 * by spreading `state.game` after calling this mapper only for the other
 * fields, or as `HYDRATE_FROM_REMOTE` does by deriving it from the fetched
 * `called_terms` rows directly).
 */
export function mapRowToGame(row: Record<string, unknown>): Game {
  return {
    id: str(row, 'id'),
    code: str(row, 'code'),
    status: str(row, 'status') as GameStatus,
    createdAt: str(row, 'created_at'),
    startedAt: optStr(row, 'started_at'),
    endedAt: optStr(row, 'ended_at'),
    currentRound: num(row, 'current_round'),
    currentTermId: optStr(row, 'current_term_id'),
    revealedTermIds: [],
    previousStatus: optStr(row, 'previous_status') as GameStatus | undefined,
  }
}

/**
 * Maps a `players` row onto the existing `Player` type. The `players` table
 * itself carries no `ticket_id`/`ticket_ref` column (a player's ticket is
 * looked up via `tickets.player_id`, the inverse foreign key) - callers that
 * have already resolved this player's `Ticket` (e.g. during the mount-time
 * full-state fetch, or by cross-referencing `state.tickets` in `SYNC_REMOTE`)
 * pass it as `ticket` so the denormalized `ticketId`/`ticketRef` UI aliases
 * stay populated; omitted when no matching ticket is available yet.
 */
export function mapRowToPlayer(row: Record<string, unknown>, ticket?: Ticket): Player {
  const displayName = str(row, 'display_name')
  const employeeDemoId = str(row, 'employee_demo_id')
  return {
    id: str(row, 'id'),
    gameId: str(row, 'game_id'),
    displayName,
    employeeDemoId,
    ticketId: ticket?.id ?? '',
    joinedAt: str(row, 'joined_at'),
    name: displayName,
    employeeId: employeeDemoId,
    ticketRef: ticket?.ref ?? '',
  }
}

/**
 * Maps a `tickets` row onto the existing `Ticket` type.
 *
 * `cells` (jsonb) is stored server-side as a FLAT array of 15
 * `{termId, row, col}` objects (see assign_ticket in
 * 0003_rpc_join_and_tickets.sql - jsonb_agg over generate_series(1, 15)
 * never nests), not the `TicketCell[][]` shape `Ticket.rows` requires. This
 * mapper reshapes that flat array into 3 rows of 5 using each cell's own
 * `row`/`col` fields. `term` (display label) and `state` are not stored
 * server-side either - every consumer (PlayerGame.tsx's `renderedTicket`)
 * already re-resolves both from the local cyberTerms bank / revealedTermIds
 * on every render, so the placeholder values written here are never read as
 * final.
 */
export function mapRowToTicket(row: Record<string, unknown>): Ticket {
  const flatCells = row.cells as Array<{ termId: string; row: number; col: number }>
  const rows: TicketCell[][] = [[], [], []]
  for (const cell of flatCells) {
    rows[cell.row][cell.col] = {
      termId: cell.termId,
      term: cell.termId,
      state: 'LOCKED',
      row: cell.row,
      col: cell.col,
    }
  }
  return {
    id: str(row, 'id'),
    playerId: str(row, 'player_id'),
    gameId: str(row, 'game_id'),
    createdAt: str(row, 'created_at'),
    ref: str(row, 'ref'),
    rows,
  }
}

/** Maps a `marks` row onto the existing `Mark` type. */
export function mapRowToMark(row: Record<string, unknown>): Mark {
  return {
    id: str(row, 'id'),
    gameId: str(row, 'game_id'),
    playerId: str(row, 'player_id'),
    ticketId: str(row, 'ticket_id'),
    termId: str(row, 'term_id'),
    markedAt: str(row, 'marked_at'),
    valid: true,
  }
}

/** Maps a `claims` row onto the existing `PrizeClaim` type. */
export function mapRowToClaim(row: Record<string, unknown>): PrizeClaim {
  return {
    id: str(row, 'id'),
    gameId: str(row, 'game_id'),
    playerId: str(row, 'player_id'),
    ticketId: str(row, 'ticket_id'),
    prizeId: str(row, 'prize_id') as PrizeId,
    submittedAt: str(row, 'submitted_at'),
    validationStatus: str(row, 'validation_status') as ValidationStatus,
    hostDecision: str(row, 'host_decision') as HostDecision,
    rejectionReason: optStr(row, 'rejection_reason'),
    decidedAt: optStr(row, 'decided_at'),
    prizeLabel: str(row, 'prize_label'),
    playerName: str(row, 'player_name'),
    ticketRef: str(row, 'ticket_ref'),
  }
}

/** Maps a `winners` row onto the existing `Winner` type. */
export function mapRowToWinner(row: Record<string, unknown>): Winner {
  return {
    id: str(row, 'id'),
    gameId: str(row, 'game_id'),
    prizeId: str(row, 'prize_id') as PrizeId,
    playerId: str(row, 'player_id'),
    ticketId: str(row, 'ticket_id'),
    claimId: str(row, 'claim_id'),
    confirmedAt: str(row, 'confirmed_at'),
    prizeLabel: str(row, 'prize_label'),
    playerName: str(row, 'player_name'),
    ticketRef: str(row, 'ticket_ref'),
  }
}

/**
 * Insert-or-replace a single item by `id` into an array. Distinct from the
 * old `mergeById` (which unioned two whole collections for `SYNC_STATE`):
 * `upsertById` only ever handles one incoming row at a time, matching
 * `SYNC_REMOTE`'s one-row-per-event contract (Components and Interfaces #5).
 */
export function upsertById<T extends { id: string }>(collection: T[], item: T): T[] {
  const index = collection.findIndex((existing) => existing.id === item.id)
  if (index === -1) return [...collection, item]
  const next = [...collection]
  next[index] = item
  return next
}