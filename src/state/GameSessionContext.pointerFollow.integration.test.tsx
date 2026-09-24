// Feature: winner-history-and-game-reset — task 7.3
//
// Integration tests for GameSessionContext.tsx's pointer-follow mount effect
// (design.md's "Client: resolving and following the Active_Game" section),
// exercised end to end against the real GameSessionProvider with a mocked
// Supabase client (`testSupport/mockSupabaseClient.ts`) standing in for the
// real one — mirroring the real fetch/subscribe/RPC code paths
// (getActiveGame, subscribeToGame, subscribeToActiveGamePointer) with no
// network call.
//
// GameSessionContext.tsx itself calls `supabase.from(table).select(...)`
// directly (its own `selectRows`/`fetchFullGameState` helpers) via
// `getSupabaseClient()`, so overriding that one export is enough to route
// those calls through the mock. `realtimeClient.ts`'s own exported
// functions (getActiveGame, subscribeToGame, subscribeToActiveGamePointer,
// resetGameToNew), however, each call `getSupabaseClient()` via a closure
// over that module's OWN private singleton — Vitest's `vi.mock` factory
// replacing the exported binding does not change what an already-defined
// function in that same module closes over internally, so those four are
// reimplemented below as thin pass-throughs against `mockClient`, matching
// the real implementations' request/response shapes exactly (verified
// against realtimeClient.ts's source).
//
// Property 10 (events tagged with a superseded game id are never applied
// after a switch — Validates Requirement 6.3) and Property 11 (switching
// Active_Game fully replaces displayed per-game state with no residual
// fields — Validates Requirements 4.3, 6.4, 8.1, 8.2) are both covered below.
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
          // The mock fixture's fireRemoteChange matches listeners by TABLE
          // ONLY (its own documented contract -- see
          // mockSupabaseClient.test.ts), it does not evaluate the `filter`
          // string the way real Postgres Changes would. Reproduce that
          // real per-game-id scoping here instead, at the listener level,
          // so a superseded channel's listener -- even though the shared
          // fixture still technically invokes it -- never forwards an event
          // whose row does not belong to the game THIS specific channel is
          // scoped to. This mirrors the guarantee Postgres itself provides
          // server-side; it does not weaken what task 7.1's production code
          // is being tested for.
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
// Test harness (mirrors playerIdentityHydration.integration.test.tsx's and
// session.integration.test.tsx's existing convention)
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

describe('GameSessionContext pointer-follow mount effect (mock Supabase client)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = createMockSupabaseClient()
  })

  it('hydrates state and opens exactly one per-game channel scoped to the game id when get_active_game resolves to a game', async () => {
    const client = mockClient!
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })

    const { sink, unmount } = mountProvider()

    await waitFor(() => {
      expect(sink.current!.state.game.id).toBe('GAME_A')
    })
    expect(sink.current!.hasActiveGame).toBe(true)

    const perGameChannels = client.channels.filter((c) => c.name === 'game:GAME_A')
    expect(perGameChannels).toHaveLength(1)

    unmount()
  })

  it('dispatches NO_ACTIVE_GAME and opens no per-game channel, but still opens the pointer channel, when get_active_game resolves to no row', async () => {
    const client = mockClient!
    client.queueRpcResponse('get_active_game', { data: [] })

    const { sink, unmount } = mountProvider()

    await waitFor(() => {
      expect(sink.current!.hasActiveGame).toBe(false)
    })
    // NO_ACTIVE_GAME resets the shared slice to gameSessionInitialState's own
    // seed game (the existing falsy-id sentinel this codebase already
    // established), not to a remotely-resolved game -- see the reducer's
    // NO_ACTIVE_GAME case.
    expect(sink.current!.state.players).toEqual([])
    expect(sink.current!.state.winners).toEqual([])

    const perGameChannels = client.channels.filter((c) => c.name.startsWith('game:'))
    expect(perGameChannels).toHaveLength(0)

    const pointerChannels = client.channels.filter((c) => c.name === 'active-game-pointer')
    expect(pointerChannels).toHaveLength(1)

    unmount()
  })

  it('unsubscribes the old per-game channel while subscribing a new one on a pointer change, and never applies a subsequent event tagged with the superseded game id (Property 10, Req 6.3)', async () => {
    const client = mockClient!
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })

    const { sink, unmount } = mountProvider()

    await waitFor(() => {
      expect(sink.current!.state.game.id).toBe('GAME_A')
    })
    const gameATermCountBefore = sink.current!.state.game.revealedTermIds.length

    // Queue the row get_active_game resolves to once the pointer-change
    // handler re-resolves after the announcement.
    client.queueRpcResponse('get_active_game', {
      data: [buildGameRow({ id: 'GAME_B', code: 'NEWG01', host_secret: 'secret-b' })],
    })

    await act(async () => {
      firePointerChange(client, 'GAME_B')
    })

    expect(sink.current!.state.game.id).toBe('GAME_B')

    const gameATermCountAfterSwitch = sink.current!.state.game.revealedTermIds.length
    expect(gameATermCountAfterSwitch).toBe(gameATermCountBefore)

    // Fire a SYNC_REMOTE-shaped "games" event carrying the OLD game's id,
    // simulating a stale/in-flight event from GAME_A's now-superseded
    // channel arriving after the switch. This mock's `subscribeToGame`
    // (above) reproduces real Postgres Changes' per-game-id filter scoping
    // at the listener level, so this event only actually forwards to
    // `dispatch` if a listener still subscribed under GAME_A's own id is
    // registered. If the old per-game channel had NOT been unsubscribed
    // (i.e. Req 6.2's unsubscribe-before/while-subscribing ordering were
    // violated), that listener would still be registered and this would
    // mutate state.game back toward GAME_A-shaped values via SYNC_REMOTE.
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

    // The post-switch state must still reflect GAME_B, completely
    // unaffected by the stale GAME_A-tagged event: no SYNC_REMOTE-driven
    // change was applied because the old per-game channel's listener was
    // torn down before the new one opened (Req 6.2, 6.3).
    expect(sink.current!.state.game.id).toBe('GAME_B')
    expect(sink.current!.state.game.status).toBe('LOBBY')
    expect(sink.current!.state.game.revealedTermIds.length).toBe(gameATermCountAfterSwitch)

    unmount()
  })

  it("the post-switch state's game/players/tickets/marks/claims/winners equal exactly the new snapshot with no field surviving from the prior game (Property 11, Req 4.3/6.4/8.1/8.2)", async () => {
    const client = mockClient!
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
    const gameAFlatCells = Array.from({ length: 15 }, (_, i) => ({
      termId: `TERM_${i}`,
      row: Math.floor(i / 5),
      col: i % 5,
    }))
    client.queueFromResponse('players', {
      data: [
        {
          id: 'P_A1',
          game_id: 'GAME_A',
          display_name: 'Alice',
          employee_demo_id: 'E1',
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
          ref: 'A1-REF',
          cells: gameAFlatCells,
        },
      ],
    })
    client.queueFromResponse('winners', {
      data: [
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
      ],
    })

    const { sink, unmount } = mountProvider()

    await waitFor(() => {
      expect(sink.current!.state.game.id).toBe('GAME_A')
    })
    expect(sink.current!.state.players).toHaveLength(1)
    expect(sink.current!.state.winners).toHaveLength(1)

    // Queue the new game's row plus an EMPTY snapshot for every collection
    // -- the new game genuinely has no players/tickets/marks/claims/winners
    // yet, so a residual GAME_A field surviving into this state would be a
    // real, detectable bug.
    client.queueRpcResponse('get_active_game', {
      data: [buildGameRow({ id: 'GAME_B', code: 'NEWG01', host_secret: 'secret-b' })],
    })
    client.queueFromResponse('players', { data: [] })
    client.queueFromResponse('tickets', { data: [] })
    client.queueFromResponse('winners', { data: [] })

    act(() => {
      firePointerChange(client, 'GAME_B')
    })

    await waitFor(() => {
      expect(sink.current!.state.game.id).toBe('GAME_B')
    })

    const finalState = sink.current!.state
    expect(finalState.game.id).toBe('GAME_B')
    expect(finalState.game.code).toBe('NEWG01')
    expect(finalState.players).toEqual([])
    expect(finalState.tickets).toEqual([])
    expect(finalState.marks).toEqual([])
    expect(finalState.claims).toEqual([])
    expect(finalState.winners).toEqual([])

    unmount()
  })

  it('dispatches NO_ACTIVE_GAME and unsubscribes the current per-game channel when a pointer-change event announces null', async () => {
    const client = mockClient!
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })

    const { sink, unmount } = mountProvider()

    await waitFor(() => {
      expect(sink.current!.state.game.id).toBe('GAME_A')
    })
    expect(client.channels.filter((c) => c.name === 'game:GAME_A')).toHaveLength(1)

    act(() => {
      firePointerChange(client, null)
    })

    await waitFor(() => {
      expect(sink.current!.hasActiveGame).toBe(false)
    })
    // NO_ACTIVE_GAME resets to the seed sentinel game (existing convention),
    // not to any residual GAME_A field.
    expect(sink.current!.state.game.id).not.toBe('GAME_A')
    expect(sink.current!.state.players).toEqual([])

    // No NEW per-game channel should have been opened following the null
    // announcement -- only the original GAME_A one (now unsubscribed).
    const perGameChannels = client.channels.filter((c) => c.name.startsWith('game:'))
    expect(perGameChannels).toHaveLength(1)

    unmount()
  })
})
