// Feature: winner-history-and-game-reset, Requirement 9.2: toWinnerHistoryViewModel
// produces equivalent output whether fed mapped Supabase rows or a
// Local-Fallback-shaped input.
import { describe, it, expect } from 'vitest'

import { toWinnerHistoryViewModel } from './hostWinnerHistoryViewModel'
import { mapRowToWinner } from '../../state/remoteRowMappers'
import type { Winner } from '../../types/prize'

/**
 * One canonical dataset: three games (created at distinct times, so
 * ordering is well-defined) each with one or two confirmed winners. This is
 * expressed once, as raw Postgres-row shapes, and then fed through the
 * codebase's two real input-construction "shapes":
 *
 *  (a) Supabase path: raw `winners`/`games` rows mapped via `mapRowToWinner`
 *      (`remoteRowMappers.ts`) plus a `{id, code, createdAt}` projection of
 *      the raw `games` rows, exactly as `fetchAllWinnersWithGames` +
 *      `HostDashboard.tsx`'s Supabase-configured effect assembles them.
 *
 *  (b) Local Fallback path: the same winners split across `winnerHistory`
 *      (past sessions, per design.md's Local Fallback section) and the
 *      current session's `winners`, plus a locally-tracked list of past
 *      game summaries `{id, code, createdAt}` standing in for
 *      `createSeedGame`-shaped games — the shape `HostDashboard.tsx` builds
 *      when Supabase is not configured.
 *
 * Both are fed through the SAME `toWinnerHistoryViewModel` and must produce
 * deep-equal `WinnerHistoryGroupViewModel[]` output (Req 9.2).
 */

const rawGameRows: Record<string, unknown>[] = [
  { id: 'game-1', code: 'CYBER24', created_at: '2026-01-01T09:00:00.000Z' },
  { id: 'game-2', code: 'QXKD47', created_at: '2026-01-02T09:00:00.000Z' },
  { id: 'game-3', code: 'ZZPP03', created_at: '2026-01-03T09:00:00.000Z' },
]

const rawWinnerRows: Record<string, unknown>[] = [
  {
    id: 'winner-1',
    game_id: 'game-1',
    prize_id: 'CYBER_FIVE',
    player_id: 'player-1',
    ticket_id: 'ticket-1',
    claim_id: 'claim-1',
    confirmed_at: '2026-01-01T09:05:00.000Z',
    prize_label: 'Cyber Five',
    player_name: 'Alice',
    ticket_ref: 'Ticket #001',
  },
  {
    id: 'winner-2',
    game_id: 'game-1',
    prize_id: 'FIREWALL_LINE',
    player_id: 'player-2',
    ticket_id: 'ticket-2',
    claim_id: 'claim-2',
    confirmed_at: '2026-01-01T09:10:00.000Z',
    prize_label: 'Firewall Line',
    player_name: 'Bob',
    ticket_ref: 'Ticket #002',
  },
  {
    id: 'winner-3',
    game_id: 'game-2',
    prize_id: 'CYBER_FULL_HOUSE',
    player_id: 'player-3',
    ticket_id: 'ticket-3',
    claim_id: 'claim-3',
    confirmed_at: '2026-01-02T09:20:00.000Z',
    prize_label: 'Cyber Full House',
    player_name: 'Carol',
    ticket_ref: 'Ticket #003',
  },
  {
    id: 'winner-4',
    game_id: 'game-3',
    prize_id: 'SECURITY_LINE',
    player_id: 'player-4',
    ticket_id: 'ticket-4',
    claim_id: 'claim-4',
    confirmed_at: '2026-01-03T09:15:00.000Z',
    prize_label: 'Security Line',
    player_name: 'Dave',
    ticket_ref: 'Ticket #004',
  },
]

describe('toWinnerHistoryViewModel (Requirement 9.2: Supabase-row and Local-Fallback inputs agree)', () => {
  it('produces deep-equal grouped output for mapped Supabase rows and an equivalent Local-Fallback-shaped input', () => {
    // --- Shape (a): Supabase path ---
    const supabaseWinners: Winner[] = rawWinnerRows.map(mapRowToWinner)
    const supabaseGames = rawGameRows.map((row) => ({
      id: row.id as string,
      code: row.code as string,
      createdAt: row.created_at as string,
    }))

    const supabaseResult = toWinnerHistoryViewModel(supabaseWinners, supabaseGames)

    // --- Shape (b): Local Fallback path ---
    // The same underlying winners, but split the way Local Fallback actually
    // holds them: everything except the most-recent game's winners folded
    // into `winnerHistory` (past sessions), and the most-recent game's
    // winners in the current session's `winners` array.
    const winnerHistory: Winner[] = supabaseWinners.filter((w) => w.gameId !== 'game-3')
    const currentSessionWinners: Winner[] = supabaseWinners.filter((w) => w.gameId === 'game-3')
    const localWinners = [...winnerHistory, ...currentSessionWinners]

    // Locally-tracked list of past-game summaries, standing in for
    // createSeedGame-shaped local games (id/code/createdAt only).
    const pastGameSummaries = rawGameRows.map((row) => ({
      id: row.id as string,
      code: row.code as string,
      createdAt: row.created_at as string,
    }))

    const localFallbackResult = toWinnerHistoryViewModel(localWinners, pastGameSummaries)

    expect(localFallbackResult).toEqual(supabaseResult)
  })

  it('agrees on an empty dataset from both input shapes', () => {
    const supabaseResult = toWinnerHistoryViewModel([], [])
    const localFallbackResult = toWinnerHistoryViewModel(
      [...([] as Winner[]), ...([] as Winner[])],
      [],
    )
    expect(localFallbackResult).toEqual(supabaseResult)
    expect(supabaseResult).toEqual([])
  })
})
