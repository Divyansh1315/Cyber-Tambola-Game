// Feature: winner-history-and-game-reset
// Unit tests for the four realtimeClient.ts exports added for the
// Active_Game pointer and winner history (Task 4.1): getActiveGame,
// resetGameToNew, subscribeToActiveGamePointer, and fetchAllWinnersWithGames.
// Uses the existing Module 6 mock Supabase client fixture
// (testSupport/mockSupabaseClient.ts). realtimeClient.ts's exported
// functions call its own module-private `getSupabaseClient()`, which in
// turn calls `@supabase/supabase-js`'s `createClient`, so the seam this
// suite mocks is `createClient` itself -- returning the mock client in its
// place lets every RPC/channel/from call inside realtimeClient.ts flow
// through the fixture unmodified, with no change to realtimeClient.ts's
// own source needed.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockSupabaseClient } from './testSupport/mockSupabaseClient'

const mockClient = createMockSupabaseClient()

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => mockClient,
}))

// Supabase config env vars must be present for getSupabaseConfig() to
// return non-null, or realtimeClient.ts's exports short-circuit to their
// "unconfigured" fallback (undefined/null/empty) before ever calling
// createClient.
vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')

const { getActiveGame, resetGameToNew, subscribeToActiveGamePointer, fetchAllWinnersWithGames } =
  await import('./realtimeClient')

beforeEach(() => {
  mockClient.rpcCalls.length = 0
  mockClient.fromCalls.length = 0
  mockClient.channels.length = 0
})

describe('getActiveGame', () => {
  it('returns undefined when get_active_game resolves with zero rows', async () => {
    mockClient.queueRpcResponse('get_active_game', { data: [], error: null })

    const result = await getActiveGame()

    expect(result).toBeUndefined()
  })

  it('returns undefined when get_active_game resolves with null data', async () => {
    mockClient.queueRpcResponse('get_active_game', { data: null, error: null })

    const result = await getActiveGame()

    expect(result).toBeUndefined()
  })

  it('returns the row when get_active_game resolves with one queued row', async () => {
    const row = { id: 'game-1', code: 'CYBER24', status: 'LOBBY' }
    mockClient.queueRpcResponse('get_active_game', { data: [row], error: null })

    const result = await getActiveGame()

    expect(result).toEqual(row)
  })
})

describe('resetGameToNew', () => {
  it('calls reset_game_to_new with p_old_game_id/p_host_secret and unwraps the first row', async () => {
    const newGame = { id: 'game-2', code: 'QXKD47', status: 'LOBBY' }
    mockClient.queueRpcResponse('reset_game_to_new', {
      data: [{ old_game_id: 'game-1', new_game: newGame }],
      error: null,
    })

    const result = await resetGameToNew('game-1', 'secret-abc')

    expect(mockClient.rpcCalls).toEqual([
      { name: 'reset_game_to_new', args: { p_old_game_id: 'game-1', p_host_secret: 'secret-abc' } },
    ])
    expect(result).toEqual({ old_game_id: 'game-1', new_game: newGame })
  })
})

describe('subscribeToActiveGamePointer', () => {
  it('registers exactly one postgres_changes listener on active_game_pointer with no filter', () => {
    subscribeToActiveGamePointer(() => {})

    expect(mockClient.channels).toHaveLength(1)
    expect(mockClient.channels[0].name).toBe('active-game-pointer')
  })

  it('invokes the callback with the new row active_game_id when a change fires', () => {
    const received: (string | null)[] = []
    subscribeToActiveGamePointer((activeGameId) => {
      received.push(activeGameId)
    })

    mockClient.fireRemoteChange({
      // active_game_pointer is not part of MockRemoteChange's declared table
      // union (it only lists the six Module 6 tables), but fireRemoteChange
      // dispatches purely on the string value of `filter.table`, so this
      // still exercises subscribeToActiveGamePointer's listener exactly as
      // a real postgres_changes event on that table would.
      table: 'active_game_pointer' as unknown as Parameters<
        typeof mockClient.fireRemoteChange
      >[0]['table'],
      eventType: 'UPDATE',
      row: { id: true, active_game_id: 'game-2', updated_at: '2024-01-01T00:00:00Z' },
    })

    expect(received).toEqual(['game-2'])
  })
})

describe('fetchAllWinnersWithGames', () => {
  it('issues one unfiltered select against winners and one against games, returning both result sets', async () => {
    const winnerRows = [{ id: 'w1', game_id: 'game-1', prize_label: 'Full House' }]
    const gameRows = [{ id: 'game-1', code: 'CYBER24', created_at: '2024-01-01T00:00:00Z' }]
    mockClient.queueFromResponse('winners', { data: winnerRows, error: null })
    mockClient.queueFromResponse('games', { data: gameRows, error: null })

    const result = await fetchAllWinnersWithGames()

    expect(mockClient.fromCalls).toEqual(['winners', 'games'])
    expect(result).toEqual({ winners: winnerRows, games: gameRows })
  })

  it('returns empty arrays for winners/games missing from a response', async () => {
    mockClient.queueFromResponse('winners', { data: null, error: null })
    mockClient.queueFromResponse('games', { data: null, error: null })

    const result = await fetchAllWinnersWithGames()

    expect(result).toEqual({ winners: [], games: [] })
  })
})
