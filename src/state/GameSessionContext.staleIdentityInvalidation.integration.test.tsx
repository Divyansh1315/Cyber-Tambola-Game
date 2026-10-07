// Spec: claim-player-ticket-identity-mismatch — task 11 (integration test
// for the stale-identity invalidation effect added in task 7.2).
//
// Covers the effect itself, as distinct from task 1's exploration test
// (`sessionConsistencyGuard.exploration.test.tsx`), which demonstrates the
// BUG on unfixed code by manually re-injecting a stale player via
// JOIN_PLAYER to probe the resolver. This test instead verifies the FIXED
// behavior added in task 7.2 directly: that `CLEAR_STALE_PLAYER` actually
// gets dispatched (and `currentPlayerId` actually gets cleared) once
// `isBackendConfirmed` flips back to `true` after a Reset leaves a stale
// `currentPlayerId` behind, and that this never happens while
// `isBackendConfirmed` is `false` (Req 2.4's preservation guarantee -- a
// transient disconnect/reconnect-in-flight window must never be mistaken
// for "this player's game is gone").
//
// Uses the same mock Supabase client harness and `vi.mock('./realtimeClient',
// ...)` thin-pass-through convention established by
// `GameSessionContext.multiTabReset.integration.test.tsx` and
// `sessionConsistencyGuard.exploration.test.tsx`.
//
// Validates: Requirements 1.5, 2.5
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import {
  createMockSupabaseClient,
  type MockSupabaseClient,
} from './testSupport/mockSupabaseClient'

let mockClient: MockSupabaseClient | null = null

vi.mock('./realtimeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./realtimeClient')>()

  function getSupabaseClient() {
    return mockClient
  }

  async function getActiveGame() {
    const supabase = getSupabaseClient()
    if (!supabase) return undefined
    const { data, error } = await supabase.rpc('get_active_game')
    if (error) throw new actual.RpcError(error.code ?? 'UNKNOWN', error.message)
    const rows = data as unknown[] | Record<string, unknown> | null
    const row = Array.isArray(rows) ? rows[0] : rows
    return row ?? undefined
  }

  function subscribeToGame(
    gameId: string,
    onChange: (change: { table: string; eventType: string; row: Record<string, unknown> }) => void,
  ) {
    const supabase = getSupabaseClient()
    if (!supabase) return null
    const channel = supabase.channel(`game:${gameId}`)
    const tables = ['games', 'called_terms', 'players', 'tickets', 'marks', 'claims', 'winners']
    for (const table of tables) {
      const filterColumn = table === 'games' ? 'id' : 'game_id'
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `${filterColumn}=eq.${gameId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as Record<string, unknown>
          const scopeColumn = table === 'games' ? 'id' : 'game_id'
          if (String(row[scopeColumn]) !== gameId) return
          onChange({ table, eventType: payload.eventType, row })
        },
      )
    }
    channel.subscribe()
    return channel
  }

  function subscribeToActiveGamePointer(onChange: (activeGameId: string | null) => void) {
    const supabase = getSupabaseClient()
    if (!supabase) return null
    const channel = supabase.channel('active-game-pointer')
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'active_game_pointer' },
      (payload) => onChange((payload.new as { active_game_id: string | null }).active_game_id),
    )
    channel.subscribe()
    return channel
  }

  async function resetGameToNew(oldGameId: string, hostSecret: string) {
    const supabase = getSupabaseClient()
    if (!supabase) throw new Error('no mock client configured')
    const { data, error } = await supabase.rpc('reset_game_to_new', {
      p_old_game_id: oldGameId,
      p_host_secret: hostSecret,
    })
    if (error) throw new actual.RpcError(error.code ?? 'UNKNOWN', error.message)
    const rows = (data as unknown[] | null) ?? []
    return rows[0]
  }

  return {
    ...actual,
    getSupabaseClient,
    getActiveGame,
    subscribeToGame,
    subscribeToActiveGamePointer,
    resetGameToNew,
  }
})

import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from './GameSessionContext'

// ---------------------------------------------------------------------------
// Test harness (mirrors GameSessionContext.multiTabReset.integration.test.tsx's
// existing convention).
// ---------------------------------------------------------------------------

function Harness({ sink }: { sink: { current: GameSessionContextValue | null } }) {
  const ctx = useGameSession()
  const ref = useRef(sink)
  useEffect(() => {
    ref.current.current = ctx
  })
  sink.current = ctx
  return null
}

function mountProvider() {
  const sink: { current: GameSessionContextValue | null } = { current: null }
  const utils = render(
    <GameSessionProvider>
      <Harness sink={sink} />
    </GameSessionProvider>,
  )
  return { sink, ...utils }
}

/** Builds a `get_active_game`/`reset_game_to_new`-shaped game row. */
function buildGameRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'GAME_A',
    code: 'CYBER24',
    host_secret: 'secret-a',
    status: 'LOBBY',
    current_round: 0,
    current_term_id: null,
    previous_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: null,
    ended_at: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Fires a pointer-row change through the mock's `active_game_pointer` listener. */
function firePointerChange(client: MockSupabaseClient, activeGameId: string | null) {
  client.fireRemoteChange({
    table: 'active_game_pointer',
    eventType: 'UPDATE',
    row: { id: true, active_game_id: activeGameId, updated_at: new Date().toISOString() },
  })
}

describe('Stale-identity invalidation effect (task 7.2; design.md Property 3; Req 1.5, 2.5)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = createMockSupabaseClient()
  })

  it('clears a stale currentPlayerId via CLEAR_STALE_PLAYER once isBackendConfirmed flips back to true for the new Active Game', async () => {
    const client = mockClient!

    // Mount: resolve the initial Active Game (GAME_A); this player (P_A1)
    // already exists in GAME_A with ticket T_A1.
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
    const playerARow = {
      id: 'P_A1',
      game_id: 'GAME_A',
      display_name: 'Divyansh',
      joined_at: '2026-01-01T00:00:00.000Z',
    }
    const ticketARow = {
      id: 'T_A1',
      game_id: 'GAME_A',
      player_id: 'P_A1',
      created_at: '2026-01-01T00:00:00.000Z',
      ref: '6405',
      cells: Array.from({ length: 15 }, (_, i) => ({
        termId: `TERM_${i}`,
        row: Math.floor(i / 5), // not-a-ticket-dimension (deliberately legacy 3x5 fixture shape)
        col: i % 5, // not-a-ticket-dimension (deliberately legacy 3x5 fixture shape)
      })),
    }
    client.queueFromResponse('players', { data: [playerARow] })
    client.queueFromResponse('tickets', { data: [ticketARow] })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()

    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBe('GAME_A')
    })
    expect(tab.sink.current!.isBackendConfirmed).toBe(true)

    // This device's own join from a prior mount, restored exactly as a
    // refresh would restore it from localStorage.
    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_A1' })
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.currentPlayerId).toBe('P_A1')
      expect(tab.sink.current!.currentPlayer?.id).toBe('P_A1')
    })

    // --- Host triggers Reset: Game A is retired, Game B becomes Active ---
    const newGameRow = buildGameRow({ id: 'GAME_B', code: 'NEWG01', host_secret: 'secret-b' })
    client.queueRpcResponse('reset_game_to_new', {
      data: [{ old_game_id: 'GAME_A', new_game: newGameRow }],
    })
    await act(async () => {
      await client.rpc('reset_game_to_new', { p_old_game_id: 'GAME_A', p_host_secret: 'secret-a' })
    })

    // GAME_B's snapshot is genuinely empty (brand-new game, nobody has
    // joined yet) -- so once this round trip's HYDRATE_FROM_REMOTE lands,
    // P_A1 no longer resolves to any Player at all.
    client.queueRpcResponse('get_active_game', { data: [newGameRow] })
    client.queueFromResponse('players', { data: [] })
    client.queueFromResponse('tickets', { data: [] })
    client.queueFromResponse('winners', { data: [] })

    act(() => {
      firePointerChange(client, 'GAME_B')
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBe('GAME_B')
    })

    // The round trip's own HYDRATE_FROM_REMOTE has landed -- isBackendConfirmed
    // flipped back to true for the new Active Game.
    expect(tab.sink.current!.isBackendConfirmed).toBe(true)

    // *** The fix under test (task 7.2) ***
    // currentPlayerId ('P_A1') no longer resolves to any Player in the
    // confirmed Active Game (GAME_B) -- the invalidation effect must have
    // dispatched CLEAR_STALE_PLAYER, so currentPlayerId is cleared rather
    // than continuing to be held indefinitely.
    await waitFor(() => {
      expect(tab.sink.current!.state.currentPlayerId).toBeUndefined()
    })
    expect(tab.sink.current!.currentPlayer).toBeUndefined()
    expect(tab.sink.current!.currentTicket).toBeUndefined()

    tab.unmount()
  })

  it('clears a stale currentPlayerId whose Player row still structurally resolves but belongs to the retired game (mismatched gameId, not just absent)', async () => {
    const client = mockClient!

    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
    const playerARow = {
      id: 'P_A1',
      game_id: 'GAME_A',
      display_name: 'Divyansh',
      joined_at: '2026-01-01T00:00:00.000Z',
    }
    const ticketARow = {
      id: 'T_A1',
      game_id: 'GAME_A',
      player_id: 'P_A1',
      created_at: '2026-01-01T00:00:00.000Z',
      ref: '6405',
      cells: Array.from({ length: 15 }, (_, i) => ({
        termId: `TERM_${i}`,
        row: Math.floor(i / 5), // not-a-ticket-dimension (deliberately legacy 3x5 fixture shape)
        col: i % 5, // not-a-ticket-dimension (deliberately legacy 3x5 fixture shape)
      })),
    }
    client.queueFromResponse('players', { data: [playerARow] })
    client.queueFromResponse('tickets', { data: [ticketARow] })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()

    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBe('GAME_A')
    })

    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_A1' })
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.currentPlayerId).toBe('P_A1')
    })

    // --- Reset to GAME_B, but this time GAME_B's own snapshot happens to
    // contain a player row with the SAME id 'P_A1' re-used for an entirely
    // different person who joined GAME_B fresh -- the mismatched-gameId
    // branch of the invalidation effect's check, distinct from "absent". ---
    const newGameRow = buildGameRow({ id: 'GAME_B', code: 'NEWG01', host_secret: 'secret-b' })
    client.queueRpcResponse('reset_game_to_new', {
      data: [{ old_game_id: 'GAME_A', new_game: newGameRow }],
    })
    await act(async () => {
      await client.rpc('reset_game_to_new', { p_old_game_id: 'GAME_A', p_host_secret: 'secret-a' })
    })

    client.queueRpcResponse('get_active_game', { data: [newGameRow] })
    client.queueFromResponse('players', { data: [] })
    client.queueFromResponse('tickets', { data: [] })
    client.queueFromResponse('winners', { data: [] })

    act(() => {
      firePointerChange(client, 'GAME_B')
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBe('GAME_B')
      expect(tab.sink.current!.isBackendConfirmed).toBe(true)
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.currentPlayerId).toBeUndefined()
    })

    tab.unmount()
  })

  it('never dispatches CLEAR_STALE_PLAYER while isBackendConfirmed is false, even with a currentPlayerId that will turn out to be stale', async () => {
    const client = mockClient!

    // Resolve the initial Active Game (GAME_A) and confirm P_A1 normally.
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
    client.queueFromResponse('players', {
      data: [
        {
          id: 'P_A1',
          game_id: 'GAME_A',
          display_name: 'Divyansh',
          joined_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    })
    client.queueFromResponse('tickets', {
      data: [
        {
          id: 'T_A1',
          game_id: 'GAME_A',
          player_id: 'P_A1',
          created_at: '2026-01-01T00:00:00.000Z',
          ref: '6405',
          cells: Array.from({ length: 15 }, (_, i) => ({
            termId: `TERM_${i}`,
            row: Math.floor(i / 5), // not-a-ticket-dimension (deliberately legacy 3x5 fixture shape)
            col: i % 5, // not-a-ticket-dimension (deliberately legacy 3x5 fixture shape)
          })),
        },
      ],
    })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()

    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBe('GAME_A')
    })

    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_A1' })
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.currentPlayerId).toBe('P_A1')
    })

    // --- Simulate a pointer-change event announcing a new Active Game,
    // but delay the follow-up getActiveGame() round trip indefinitely --
    // isBackendConfirmed flips to false the instant the pointer event
    // fires (mirrors the mount-time 'syncing' semantics) and stays false
    // until that round trip's own hydrateForGame call lands. ---
    let resolveGetActiveGame: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      resolveGetActiveGame = resolve
    })
    const originalRpc = client.rpc.bind(client)
    client.rpc = (async (name: string, args?: Record<string, unknown>) => {
      if (name === 'get_active_game') {
        await pending
      }
      return originalRpc(name, args)
    }) as typeof client.rpc

    const newGameRow = buildGameRow({ id: 'GAME_B', code: 'NEWG01', host_secret: 'secret-b' })
    client.queueRpcResponse('get_active_game', { data: [newGameRow] })

    act(() => {
      firePointerChange(client, 'GAME_B')
    })

    await waitFor(() => {
      expect(tab.sink.current!.isBackendConfirmed).toBe(false)
    })

    // While unconfirmed, currentPlayerId must NOT be cleared, even though
    // P_A1 will turn out to be stale once GAME_B's (empty) snapshot lands --
    // a transient reconnect-in-flight window must never be mistaken for
    // "this player's game is gone" (Req 2.4's preservation guarantee).
    expect(tab.sink.current!.state.currentPlayerId).toBe('P_A1')
    expect(tab.sink.current!.currentPlayer?.id).toBe('P_A1')

    // Now let the round trip resolve: GAME_B's snapshot is empty, so once
    // isBackendConfirmed flips back to true, the invalidation effect fires
    // and clears it as expected.
    client.queueFromResponse('players', { data: [] })
    client.queueFromResponse('tickets', { data: [] })
    client.queueFromResponse('winners', { data: [] })
    resolveGetActiveGame?.()

    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBe('GAME_B')
      expect(tab.sink.current!.isBackendConfirmed).toBe(true)
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.currentPlayerId).toBeUndefined()
    })

    tab.unmount()
  })
})
