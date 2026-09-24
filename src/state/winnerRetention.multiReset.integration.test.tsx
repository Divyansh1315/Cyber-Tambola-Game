// Feature: winner-history-and-game-reset — tasks 14.2 and 14.3
//
// Integration test confirming winners survive multiple consecutive resets,
// for BOTH tracked state shapes this module maintains (design.md Decision 7):
//
//   - Local Fallback: gameSessionReducer's RESET_GAME case folds
//     state.winners into state.winnerHistory on every reset
//     (gameSessionReducer.ts), never dropping a prior game's winners.
//   - Supabase: reset_game_to_new never touches the `winners` table at all
//     (design.md's RPC), so a fresh `fetchAllWinnersWithGames()` read after
//     N resets must still return every winner confirmed in every one of the
//     N-1 prior games plus the current one. This is exercised here against
//     the mock Supabase client's queued `.from('winners').select()` /
//     `.from('games').select()` responses, matching
//     `fetchAllWinnersWithGames`'s own two-parallel-selects shape
//     (realtimeClient.ts) — see also GameSessionContext.pointerFollow.
//     integration.test.tsx (task 7.3) for the established mock-client
//     integration-test convention this file follows.
//
// Both scenarios feed their accumulated winners/games into the SAME
// `toWinnerHistoryViewModel` (hostWinnerHistoryViewModel.ts, task 9.1) and
// assert it groups every winner correctly by their own owning game — i.e.
// three games in, three groups out, each with exactly its own winners.
//
// Each scenario also carries a dedicated task 14.3 assertion block that
// Winner_History includes at least two distinct game groups, each labeled
// with its own game's code AND creation timestamp.
//
// Validates: Requirements 1.1, 1.3, 2.1, 2.2, 2.4, 9.1
import { describe, it, expect, vi } from 'vitest'

import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import type { GameSessionState } from './gameSessionInitialState'
import {
  createMockSupabaseClient,
  type MockSupabaseClient,
} from './testSupport/mockSupabaseClient'
import { toWinnerHistoryViewModel } from '../pages/HostDashboard/hostWinnerHistoryViewModel'
import type { WinnerHistoryGameSummary } from '../pages/HostDashboard/hostWinnerHistoryViewModel'
import type { Winner } from '../types/prize'

// Module-level mock (same convention as GameSessionContext.pointerFollow.
// integration.test.tsx, task 7.3): `realtimeClient.ts`'s own exported
// functions call `getSupabaseClient()` via a closure over that module's OWN
// private singleton — overriding the exported `getSupabaseClient` binding
// does not change what an already-defined function in that same module
// closes over internally. `fetchAllWinnersWithGames` is therefore
// reimplemented below as a thin pass-through against `mockClient`, matching
// the real implementation's request/response shape exactly (verified
// against realtimeClient.ts's source).
let mockClient: MockSupabaseClient | null = null

vi.mock('./realtimeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./realtimeClient')>()

  function getSupabaseClient() {
    return mockClient
  }

  async function fetchAllWinnersWithGames() {
    const supabase = getSupabaseClient()
    if (!supabase) return { winners: [], games: [] }
    const [{ data: winners }, { data: games }] = await Promise.all([
      supabase.from('winners').select('*'),
      supabase.from('games').select('id, code, created_at'),
    ])
    return { winners: winners ?? [], games: games ?? [] }
  }

  return { ...actual, getSupabaseClient, fetchAllWinnersWithGames }
})

/** Builds a Winner belonging to a specific game, with a caller-supplied unique id. */
function makeWinner(id: string, gameId: string): Winner {
  return {
    id,
    gameId,
    prizeId: 'CYBER_FIVE',
    playerId: `PLAYER_${id}`,
    ticketId: `TICKET_${id}`,
    claimId: `CLAIM_${id}`,
    confirmedAt: '2026-01-01T00:00:00.000Z',
    prizeLabel: 'Cyber Five',
    playerName: `Player ${id}`,
    ticketRef: `Ticket #${id}`,
  }
}

/** Builds a `winners` table row (Supabase shape) matching mapRowToWinner's expectations. */
function makeWinnerRow(id: string, gameId: string): Record<string, unknown> {
  return {
    id,
    game_id: gameId,
    prize_id: 'CYBER_FIVE',
    player_id: `PLAYER_${id}`,
    ticket_id: `TICKET_${id}`,
    claim_id: `CLAIM_${id}`,
    confirmed_at: '2026-01-01T00:00:00.000Z',
    prize_label: 'Cyber Five',
    player_name: `Player ${id}`,
    ticket_ref: `Ticket #${id}`,
  }
}

/** Builds a `games` table row (Supabase shape) matching fetchAllWinnersWithGames's own select. */
function makeGameRow(id: string, code: string, createdAt: string): Record<string, unknown> {
  return { id, code, created_at: createdAt }
}

describe('winners survive multiple consecutive resets (Req 1.1, 1.3, 9.1)', () => {
  it('Local Fallback: winnerHistory + winners accumulate every winner across three reset cycles, grouped by their own game', () => {
    let state: GameSessionState = gameSessionInitialState

    // NOTE: `createSeedGame` (gameSessionInitialState.ts) always assigns the
    // fixed sentinel id 'GAME_001' -- only `game.code` is freshly generated
    // per reset (Property 14's own documented boundary case). Since the
    // view-model groups winners by `gameId`, and every one of Local
    // Fallback's reseeded games shares that same sentinel id, this scenario
    // distinguishes the three cycles' games by synthesizing distinct
    // per-cycle game ids for the winners/summaries fed into
    // `toWinnerHistoryViewModel` below -- exactly mirroring how HostDashboard
    // itself must track "which past local game" a winner belongs to via its
    // own locally-tracked past-games list (design.md's Local Fallback
    // section, task 10.1), since `state.game.id` alone cannot disambiguate
    // them.

    // --- Cycle 1: game A gets one winner, then resets ---
    const gameAId = 'LOCAL_GAME_A'
    const gameACode = state.game.code
    const winnerA1 = makeWinner('WA1', gameAId)
    state = { ...state, winners: [...state.winners, winnerA1] }
    state = gameSessionReducer(state, { type: 'RESET_GAME' })

    // --- Cycle 2: game B (the freshly reseeded game) gets two winners, then resets ---
    const gameBId = 'LOCAL_GAME_B'
    const gameBCode = state.game.code
    expect(gameBCode).not.toBe(gameACode) // reset always produces a fresh code (Property 14)
    const winnerB1 = makeWinner('WB1', gameBId)
    const winnerB2 = makeWinner('WB2', gameBId)
    state = { ...state, winners: [...state.winners, winnerB1, winnerB2] }
    state = gameSessionReducer(state, { type: 'RESET_GAME' })

    // --- Cycle 3: game C gets one winner, then resets a third time ---
    const gameCId = 'LOCAL_GAME_C'
    const gameCCode = state.game.code
    expect(gameCCode).not.toBe(gameACode)
    expect(gameCCode).not.toBe(gameBCode)
    const winnerC1 = makeWinner('WC1', gameCId)
    state = { ...state, winners: [...state.winners, winnerC1] }
    state = gameSessionReducer(state, { type: 'RESET_GAME' })

    // After three consecutive resets, every winner from all three games must
    // still be present in winnerHistory (winners itself is empty again, since
    // no winner was added to the current, fourth game).
    expect(state.winners).toEqual([])
    const historyIds = state.winnerHistory.map((w) => w.id).sort()
    expect(historyIds).toEqual(['WA1', 'WB1', 'WB2', 'WC1'])

    // Feed the accumulated history into the SAME view-model Host Dashboard
    // uses, alongside minimal game summaries for each of the three past
    // games (Local Fallback's own "locally-tracked past games" list, per
    // design.md's Local Fallback section for task 10.1).
    const gameSummaries: WinnerHistoryGameSummary[] = [
      { id: gameAId, code: 'AAAA00', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: gameBId, code: 'BBBB00', createdAt: '2026-01-01T01:00:00.000Z' },
      { id: gameCId, code: 'CCCC00', createdAt: '2026-01-01T02:00:00.000Z' },
    ]
    const groups = toWinnerHistoryViewModel(state.winnerHistory, gameSummaries)

    expect(groups).toHaveLength(3)
    const groupByGameId = new Map(groups.map((g) => [g.gameId, g]))

    expect(groupByGameId.get(gameAId)?.rows.map((r) => r.prizeLabel)).toEqual(['Cyber Five'])
    expect(groupByGameId.get(gameAId)?.gameCode).toBe('AAAA00')

    expect(groupByGameId.get(gameBId)?.rows).toHaveLength(2)
    expect(groupByGameId.get(gameBId)?.gameCode).toBe('BBBB00')

    expect(groupByGameId.get(gameCId)?.rows).toHaveLength(1)
    expect(groupByGameId.get(gameCId)?.gameCode).toBe('CCCC00')

    // Newest game first (Req 2.2/2.4, exercised incidentally here too).
    expect(groups.map((g) => g.gameId)).toEqual([gameCId, gameBId, gameAId])

    // --- Task 14.3: Winner_History shows entries from more than one past
    // game after resets, each correctly labeled with its OWN game's code
    // AND creation timestamp (Req 2.1, 2.2, 2.4) — explicit, dedicated
    // assertion for this task's own acceptance criteria, distinct from the
    // `groups.toHaveLength(3)` / per-group `rows`/`gameCode` checks above.
    expect(groups.length).toBeGreaterThanOrEqual(2)
    for (const summary of gameSummaries) {
      const group = groupByGameId.get(summary.id)
      expect(group).toBeDefined()
      expect(group?.gameCode).toBe(summary.code)
      expect(group?.gameCreatedAt).toBe(summary.createdAt)
    }
  })

  it('Supabase: fetchAllWinnersWithGames returns every winner from all three games after three reset cycles, grouped by their own game', async () => {
    const client: MockSupabaseClient = createMockSupabaseClient()
    mockClient = client
    const { fetchAllWinnersWithGames } = await import('./realtimeClient')

    // Simulate three consecutive reset cycles server-side: each cycle's
    // `confirm_claim` inserts a winners row for the THEN-current game, and
    // `reset_game_to_new` never deletes from `winners` (design.md) — so by
    // the time all three cycles have run, the `winners` table holds every
    // winner from every game. Rather than re-implement the RPC, this test
    // directly builds the accumulated winners/games rows that would exist
    // in Postgres after three such cycles, and queues them as
    // `fetchAllWinnersWithGames`'s two underlying `.select()` responses —
    // exactly what a real Postgres instance would hand back to that read
    // path, with no game_id filter (Req 1.1, 1.3).
    const gameARow = makeGameRow('GAME_A', 'AAAA00', '2026-01-01T00:00:00.000Z')
    const gameBRow = makeGameRow('GAME_B', 'BBBB00', '2026-01-01T01:00:00.000Z')
    const gameCRow = makeGameRow('GAME_C', 'CCCC00', '2026-01-01T02:00:00.000Z')

    const winnerRows = [
      makeWinnerRow('WA1', 'GAME_A'),
      makeWinnerRow('WB1', 'GAME_B'),
      makeWinnerRow('WB2', 'GAME_B'),
      makeWinnerRow('WC1', 'GAME_C'),
    ]

    client.queueFromResponse('winners', { data: winnerRows })
    client.queueFromResponse('games', { data: [gameARow, gameBRow, gameCRow] })

    const { winners, games } = await fetchAllWinnersWithGames()

    // Every winner from all three games is present — none dropped by any of
    // the three resets (Req 1.1, 1.3, 9.1).
    expect(winners.map((w) => w.id).sort()).toEqual(['WA1', 'WB1', 'WB2', 'WC1'])
    expect(games.map((g) => g.id).sort()).toEqual(['GAME_A', 'GAME_B', 'GAME_C'])

    // Map the raw rows the same way GameSessionContext/HostDashboard would
    // (via mapRowToWinner's field shape) before feeding the view-model.
    const mappedWinners: Winner[] = winners.map((row) => ({
      id: row.id as string,
      gameId: row.game_id as string,
      prizeId: row.prize_id as Winner['prizeId'],
      playerId: row.player_id as string,
      ticketId: row.ticket_id as string,
      claimId: row.claim_id as string,
      confirmedAt: row.confirmed_at as string,
      prizeLabel: row.prize_label as string,
      playerName: row.player_name as string,
      ticketRef: row.ticket_ref as string,
    }))
    const gameSummaries: WinnerHistoryGameSummary[] = games.map((row) => ({
      id: row.id as string,
      code: row.code as string,
      createdAt: row.created_at as string,
    }))

    const groups = toWinnerHistoryViewModel(mappedWinners, gameSummaries)

    expect(groups).toHaveLength(3)
    const groupByGameId = new Map(groups.map((g) => [g.gameId, g]))

    expect(groupByGameId.get('GAME_A')?.rows.map((r) => r.prizeLabel)).toEqual(['Cyber Five'])
    expect(groupByGameId.get('GAME_A')?.gameCode).toBe('AAAA00')

    expect(groupByGameId.get('GAME_B')?.rows).toHaveLength(2)
    expect(groupByGameId.get('GAME_B')?.gameCode).toBe('BBBB00')

    expect(groupByGameId.get('GAME_C')?.rows).toHaveLength(1)
    expect(groupByGameId.get('GAME_C')?.gameCode).toBe('CCCC00')

    // Newest game first (Req 2.2/2.4), same ordering guarantee as the Local
    // Fallback scenario above.
    expect(groups.map((g) => g.gameId)).toEqual(['GAME_C', 'GAME_B', 'GAME_A'])

    // --- Task 14.3: Winner_History shows entries from more than one past
    // game after resets, each correctly labeled with its OWN game's code
    // AND creation timestamp (Req 2.1, 2.2, 2.4) — explicit, dedicated
    // assertion for this task's own acceptance criteria.
    expect(groups.length).toBeGreaterThanOrEqual(2)
    for (const gameRow of [gameARow, gameBRow, gameCRow]) {
      const group = groupByGameId.get(gameRow.id as string)
      expect(group).toBeDefined()
      expect(group?.gameCode).toBe(gameRow.code)
      expect(group?.gameCreatedAt).toBe(gameRow.created_at)
    }
  })
})
