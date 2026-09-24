// Feature: winner-history-and-game-reset — task 14.1
//
// Integration test simulating two independently-mounted GameSessionProvider
// instances (standing in for two open browser tabs -- e.g. a Host Dashboard
// tab and a Presentation View tab) that both resolve and follow the SAME
// Active_Game via a single SHARED mock Supabase client instance, exactly as
// they would in production by both subscribing to the one singleton
// `active_game_pointer` row over Realtime.
//
// This drives GameSessionContext.tsx's pointer-follow mount effect (design.md's
// "Client: resolving and following the Active_Game" section) through a
// simulated Reset: a `reset_game_to_new` RPC response followed by the
// corresponding `active_game_pointer` row-change event, and asserts BOTH
// provider instances converge on the new game (same id/code) with no stale
// per-game data (players/tickets/marks/claims/winners) surviving from the old
// game in either instance.
//
// Mirrors GameSessionContext.pointerFollow.integration.test.tsx's (task 7.3)
// exact mocking approach: realtimeClient.ts's exported functions
// (getActiveGame, subscribeToGame, subscribeToActiveGamePointer,
// resetGameToNew) each close over that module's OWN private
// getSupabaseClient singleton, so `vi.mock`'s factory replacing the exported
// binding does not change what those already-defined functions close over
// internally -- they are reimplemented below as thin pass-throughs against
// `mockClient`, matching the real implementations' request/response shapes
// exactly (verified against realtimeClient.ts's source), rather than
// rediscovered from scratch here.
//
// Validates: Requirements 6.1, 6.2, 6.4, 6.5
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
          // Reproduce real Postgres Changes' per-game-id filter scoping at
          // the listener level, since the shared mock fixture's
          // fireRemoteChange matches by table only (its own documented
          // contract) -- this ensures a superseded channel never forwards
          // an event whose row does not belong to the game THIS specific
          // channel is scoped to.
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
// Test harness (mirrors GameSessionContext.pointerFollow.integration.test.tsx's
// existing convention). Each mounted provider gets its own sink so the two
// simulated tabs' resolved state can be asserted independently.
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

describe('Reset propagates live to multiple open Host/Presentation clients (Req 6.1, 6.2, 6.4, 6.5)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = createMockSupabaseClient()
  })

  it('both independently-mounted provider instances converge on the same new game with no stale per-game data after a simulated Reset', async () => {
    const client = mockClient!

    // Both simulated tabs (Host + Presentation) resolve the SAME initial
    // Active_Game on mount -- two FIFO responses queued, one consumed by
    // each provider's own mount-time getActiveGame() call.
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })

    const gameAPlayers = [
      {
        id: 'P_A1',
        game_id: 'GAME_A',
        display_name: 'Alice',
        employee_demo_id: 'E1',
        joined_at: '2026-01-01T00:00:00.000Z',
      },
    ]
    const gameATickets = [
      {
        id: 'T_A1',
        game_id: 'GAME_A',
        player_id: 'P_A1',
        created_at: '2026-01-01T00:00:00.000Z',
        ref: 'A1-REF',
        cells: Array.from({ length: 15 }, (_, i) => ({
          termId: `TERM_${i}`,
          row: Math.floor(i / 5),
          col: i % 5,
        })),
      },
    ]
    const gameAWinners = [
      {
        id: 'W_A1',
        game_id: 'GAME_A',
        prize_id: 'CYBER_FIVE',
        player_id: 'P_A1',
        ticket_id: 'T_A1',
        claim_id: 'C_A1',
        confirmed_at: '2026-01-01T00:05:00.000Z',
        prize_label: 'Cyber Five',
        player_name: 'Alice',
        ticket_ref: 'A1-REF',
      },
    ]

    // Each provider's mount-time fetchFullGameState issues its own parallel
    // selects -- queue one response per table per tab (two tabs = two
    // queued responses per table), so both resolve to the SAME old game's
    // data.
    for (let i = 0; i < 2; i += 1) {
      client.queueFromResponse('players', { data: gameAPlayers })
      client.queueFromResponse('tickets', { data: gameATickets })
      client.queueFromResponse('winners', { data: gameAWinners })
    }

    const hostTab = mountProvider()
    const presentationTab = mountProvider()

    await waitFor(() => {
      expect(hostTab.sink.current!.state.game.id).toBe('GAME_A')
      expect(presentationTab.sink.current!.state.game.id).toBe('GAME_A')
    })
    expect(hostTab.sink.current!.state.players).toHaveLength(1)
    expect(hostTab.sink.current!.state.winners).toHaveLength(1)
    expect(presentationTab.sink.current!.state.players).toHaveLength(1)
    expect(presentationTab.sink.current!.state.winners).toHaveLength(1)

    // Each tab has its own per-game channel scoped to GAME_A.
    expect(client.channels.filter((c) => c.name === 'game:GAME_A')).toHaveLength(2)
    // Both tabs share the SAME active_game_pointer subscription mechanism
    // -- each opens its own pointer channel (one per provider instance),
    // exactly mirroring two real, independently-open browser tabs both
    // subscribed to the one singleton pointer row via the shared client.
    expect(client.channels.filter((c) => c.name === 'active-game-pointer')).toHaveLength(2)

    // --- Simulate the Host clicking Reset ---
    // 1. The `reset_game_to_new` RPC resolves with the new game's row.
    const newGameRow = buildGameRow({ id: 'GAME_B', code: 'NEWG01', host_secret: 'secret-b' })
    client.queueRpcResponse('reset_game_to_new', {
      data: [{ old_game_id: 'GAME_A', new_game: newGameRow }],
    })

    await act(async () => {
      await client.rpc('reset_game_to_new', { p_old_game_id: 'GAME_A', p_host_secret: 'secret-a' })
    })

    // 2. Both tabs' pointer-follow effects will each re-resolve via
    // getActiveGame() once the pointer-change event fires below -- queue
    // one response per tab, both pointing at the new game, and an empty
    // per-table snapshot for the brand-new game (it genuinely has no
    // players/tickets/marks/claims/winners yet).
    for (let i = 0; i < 2; i += 1) {
      client.queueRpcResponse('get_active_game', { data: [newGameRow] })
      client.queueFromResponse('players', { data: [] })
      client.queueFromResponse('tickets', { data: [] })
      client.queueFromResponse('winners', { data: [] })
    }

    // 3. The corresponding active_game_pointer row-change event announcing
    // the new game id, delivered to BOTH tabs simultaneously via the one
    // shared mock client (exactly as real Realtime would deliver one
    // Postgres row-change event to every subscribed client).
    act(() => {
      firePointerChange(client, 'GAME_B')
    })

    await waitFor(() => {
      expect(hostTab.sink.current!.state.game.id).toBe('GAME_B')
      expect(presentationTab.sink.current!.state.game.id).toBe('GAME_B')
    })

    // Both instances converge on the SAME new game id/code (Req 6.1, 6.4, 6.5).
    const hostState = hostTab.sink.current!.state
    const presentationState = presentationTab.sink.current!.state
    expect(hostState.game.id).toBe('GAME_B')
    expect(hostState.game.code).toBe('NEWG01')
    expect(presentationState.game.id).toBe('GAME_B')
    expect(presentationState.game.code).toBe('NEWG01')

    // No stale per-game data (players/tickets/marks/claims/winners) from the
    // OLD game remains in either instance (Req 6.4).
    for (const state of [hostState, presentationState]) {
      expect(state.players).toEqual([])
      expect(state.tickets).toEqual([])
      expect(state.marks).toEqual([])
      expect(state.claims).toEqual([])
      expect(state.winners).toEqual([])
    }

    // Each tab's OLD per-game channel (scoped to GAME_A) was torn down
    // before/while the new one (scoped to GAME_B) was established (Req
    // 6.2) -- exactly one live per-game channel per tab remains, and it is
    // scoped to the new game.
    expect(client.channels.filter((c) => c.name === 'game:GAME_B')).toHaveLength(2)

    // A stale event tagged with the superseded GAME_A id must not be
    // applied to either tab's now-GAME_B-scoped state.
    act(() => {
      client.fireRemoteChange({
        table: 'games',
        eventType: 'UPDATE',
        row: {
          id: 'GAME_A',
          code: 'CYBER24',
          status: 'WORD_ACTIVE',
          current_round: 1,
          current_term_id: 'STALE_TERM',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      })
    })

    expect(hostTab.sink.current!.state.game.id).toBe('GAME_B')
    expect(hostTab.sink.current!.state.game.status).toBe('LOBBY')
    expect(presentationTab.sink.current!.state.game.id).toBe('GAME_B')
    expect(presentationTab.sink.current!.state.game.status).toBe('LOBBY')

    hostTab.unmount()
    presentationTab.unmount()
  })
})
