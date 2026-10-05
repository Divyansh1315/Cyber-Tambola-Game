// Bugfix regression tests: duplicate/divergent cyber word advancement.
//
// Root cause (see .kiro/specs or the commit message "Fix duplicate cyber
// word advancement" for the full writeup): wrappedDispatch in
// GameSessionContext.tsx used to ALWAYS dispatch START_GAME/CALL_NEXT_WORD
// optimistically against the local reducer (gameSessionReducer.ts), which
// picks its own RANDOM next term via selectNextTerm, in addition to calling
// the call_next_word RPC, which independently picks its OWN random next
// term server-side (0004_rpc_word_and_marks.sql). Both of these are then
// visible: the optimistic pick renders immediately, then ~1 round trip later
// the realtime echo of the `games` row (SYNC_REMOTE, which fully replaces
// currentTermId/currentRound from the server row) overwrites it with the
// server's own, independently-random pick -- a visible word "flash"/skip
// with no second click.
//
// The fix: when Supabase IS configured, wrappedDispatch no longer dispatches
// START_GAME/CALL_NEXT_WORD optimistically at all -- only the RPC is called,
// and the resulting realtime echo is the sole source of truth. Every other
// action, and these two actions when Supabase is NOT configured (local
// fallback), are unaffected.
//
// Mocking approach mirrors GameSessionContext.pointerFollow.integration.test.tsx
// exactly: realtimeClient.ts's exported functions close over that module's
// OWN private getSupabaseClient singleton, so vi.mock's factory replacing
// the exported binding does not change what those already-defined functions
// close over internally -- the ones this suite needs (getSupabaseClient,
// getActiveGame, subscribeToGame, subscribeToActiveGamePointer,
// callNextWord) are reimplemented below as thin pass-throughs against
// `mockClient`, matching the real implementations' request/response shapes
// exactly (verified against realtimeClient.ts's source).
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

  async function callNextWord(gameId: string, hostSecret: string, activeTermIds: string[]) {
    const supabase = getSupabaseClient()
    if (!supabase) throw new Error('no mock client configured')
    const { data, error } = await supabase.rpc('call_next_word', {
      p_game_id: gameId,
      p_host_secret: hostSecret,
      p_active_term_ids: activeTermIds,
    })
    if (error) throw new actual.RpcError(error.code ?? 'UNKNOWN', error.message)
    return data
  }

  return {
    ...actual,
    getSupabaseClient,
    getActiveGame,
    subscribeToGame,
    subscribeToActiveGamePointer,
    callNextWord,
  }
})

import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from './GameSessionContext'

// ---------------------------------------------------------------------------
// Test harness (mirrors GameSessionContext.pointerFollow.integration.test.tsx's
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

/** Builds a `get_active_game`-shaped game row. */
function buildGameRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'GAME_A',
    code: 'CYBER24',
    host_secret: 'secret-a',
    status: 'WORD_ACTIVE',
    current_round: 1,
    current_term_id: 'TERM_INITIAL',
    previous_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Fires a `games` row UPDATE through the mock's realtime channel, as the server's call_next_word commit would. */
function fireGamesUpdate(client: MockSupabaseClient, row: Record<string, unknown>) {
  client.fireRemoteChange({ table: 'games', eventType: 'UPDATE', row })
}

describe('CALL_NEXT_WORD/START_GAME no longer race the server with a divergent local random pick', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = createMockSupabaseClient()
  })

  it('Supabase configured: dispatching CALL_NEXT_WORD calls the RPC exactly once and does NOT change currentTermId/currentRound synchronously (no local optimistic term pick)', async () => {
    const client = mockClient!
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A', current_term_id: 'TERM_INITIAL' })] })
    client.queueRpcResponse('call_next_word', { data: buildGameRow({ current_term_id: 'TERM_B', current_round: 2 }) })

    const { sink, unmount } = mountProvider()

    await waitFor(() => {
      expect(sink.current!.state.game.id).toBe('GAME_A')
    })
    expect(sink.current!.state.game.currentTermId).toBe('TERM_INITIAL')

    const rpcCallsBefore = client.rpcCalls.filter((c) => c.name === 'call_next_word').length

    // Dispatch CALL_NEXT_WORD once. This must NOT synchronously change
    // currentTermId/currentRound via a local optimistic reducer dispatch --
    // only the RPC call fires.
    act(() => {
      sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
    })

    // Synchronously after the dispatch (before any realtime echo arrives),
    // the term/round must be completely unchanged -- there is no local
    // random pick to observe.
    expect(sink.current!.state.game.currentTermId).toBe('TERM_INITIAL')
    expect(sink.current!.state.game.currentRound).toBe(1)

    await waitFor(() => {
      expect(client.rpcCalls.filter((c) => c.name === 'call_next_word').length).toBe(
        rpcCallsBefore + 1,
      )
    })

    // Simulate the server's resulting `games` row UPDATE arriving over
    // Realtime -- this is the ONLY event that should ever move
    // currentTermId/currentRound forward.
    act(() => {
      fireGamesUpdate(client, buildGameRow({ current_term_id: 'TERM_B', current_round: 2 }))
    })

    expect(sink.current!.state.game.currentTermId).toBe('TERM_B')
    expect(sink.current!.state.game.currentRound).toBe(2)

    unmount()
  })

  it('Supabase configured: after the realtime echo lands, no further state changes occur without another dispatch or event (no automatic re-advancement)', async () => {
    const client = mockClient!
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A', current_term_id: 'TERM_INITIAL' })] })
    client.queueRpcResponse('call_next_word', { data: buildGameRow({ current_term_id: 'TERM_B', current_round: 2 }) })

    const { sink, unmount } = mountProvider()
    await waitFor(() => {
      expect(sink.current!.state.game.id).toBe('GAME_A')
    })

    act(() => {
      sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
    })
    await waitFor(() => {
      expect(client.rpcCalls.some((c) => c.name === 'call_next_word')).toBe(true)
    })

    act(() => {
      fireGamesUpdate(client, buildGameRow({ current_term_id: 'TERM_B', current_round: 2 }))
    })

    const settled = {
      currentTermId: sink.current!.state.game.currentTermId,
      currentRound: sink.current!.state.game.currentRound,
      revealedTermIds: sink.current!.state.game.revealedTermIds,
    }
    expect(settled.currentTermId).toBe('TERM_B')

    // Wait across a few microtask/macrotask ticks with no further action --
    // nothing should move. (No fake timers are used elsewhere in this
    // codebase's integration suite for this provider, so a short real delay
    // stands in for "no automatic re-advancement over time.")
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(sink.current!.state.game.currentTermId).toBe(settled.currentTermId)
    expect(sink.current!.state.game.currentRound).toBe(settled.currentRound)
    expect(sink.current!.state.game.revealedTermIds).toEqual(settled.revealedTermIds)
    expect(client.rpcCalls.filter((c) => c.name === 'call_next_word')).toHaveLength(1)

    unmount()
  })

  it('Host and Presentation (two independently-mounted providers sharing one mock client) both end up with the identical currentTermId after one dispatch and one realtime echo, with no intermediate mismatch ever observed on either', async () => {
    const client = mockClient!
    // Each provider's own mount-time getActiveGame() consumes one queued
    // response (two tabs = two FIFO responses), mirroring
    // GameSessionContext.multiTabReset.integration.test.tsx's convention.
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A', current_term_id: 'TERM_INITIAL' })] })
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A', current_term_id: 'TERM_INITIAL' })] })
    client.queueRpcResponse('call_next_word', { data: buildGameRow({ current_term_id: 'TERM_B', current_round: 2 }) })

    const host = mountProvider()
    const presentation = mountProvider()

    await waitFor(() => {
      expect(host.sink.current!.state.game.id).toBe('GAME_A')
      expect(presentation.sink.current!.state.game.id).toBe('GAME_A')
    })

    // Host clicks "Call Next Word" once.
    act(() => {
      host.sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
    })

    // Neither tab should show any term other than TERM_INITIAL or TERM_B at
    // any point -- there is no intermediate divergent value to observe.
    expect(host.sink.current!.state.game.currentTermId).toBe('TERM_INITIAL')
    expect(presentation.sink.current!.state.game.currentTermId).toBe('TERM_INITIAL')

    await waitFor(() => {
      expect(client.rpcCalls.some((c) => c.name === 'call_next_word')).toBe(true)
    })

    // Both tabs' realtime subscriptions receive the one server-authoritative
    // `games` row UPDATE.
    act(() => {
      fireGamesUpdate(client, buildGameRow({ current_term_id: 'TERM_B', current_round: 2 }))
    })

    expect(host.sink.current!.state.game.currentTermId).toBe('TERM_B')
    expect(presentation.sink.current!.state.game.currentTermId).toBe('TERM_B')
    expect(host.sink.current!.state.game.currentTermId).toBe(
      presentation.sink.current!.state.game.currentTermId,
    )

    host.unmount()
    presentation.unmount()
  })

  it('Local fallback (no Supabase configured): CALL_NEXT_WORD/START_GAME still dispatch optimistically and synchronously via the real random reducer selection, exactly as before this fix', async () => {
    mockClient = null // no Supabase client configured -- local fallback mode

    const { sink, unmount } = mountProvider()

    // No RPC round trip to wait for in local fallback -- the lobby seed game
    // is available synchronously.
    expect(sink.current!.state.game.status).toBe('LOBBY')

    act(() => {
      sink.current!.dispatch({ type: 'START_GAME' })
    })

    // Unlike the Supabase-configured path, this MUST change synchronously:
    // local fallback has no server to diverge from, so the optimistic
    // dispatch is still the whole story.
    expect(sink.current!.state.game.status).toBe('WORD_ACTIVE')
    expect(sink.current!.state.game.currentRound).toBe(1)
    expect(sink.current!.state.game.currentTermId).toBeTruthy()

    const termAfterStart = sink.current!.state.game.currentTermId

    act(() => {
      sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
    })

    expect(sink.current!.state.game.currentRound).toBe(2)
    expect(sink.current!.state.game.currentTermId).toBeTruthy()
    expect(sink.current!.state.game.revealedTermIds).toContain(termAfterStart)

    unmount()
  })
})
