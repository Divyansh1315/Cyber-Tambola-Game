// Feature: E6 — Realtime connection recovery (multiplayer-reliability fix pass).
//
// Verifies GameSessionContext.tsx's realtimeConnectionStatus state machine:
// bounded-exponential-backoff reconnect on CHANNEL_ERROR/TIMED_OUT, no
// reconnect on an intentional CLOSED (unmount/game-change/reset), retry
// counter reset on SUBSCRIBED, state reconciliation (a fresh fetchFullGameState
// round trip) after a successful reconnect, and that a valid player session
// is never cleared/redirected purely because of a transient connection
// failure.
//
// Mirrors GameSessionContext.pointerSwap.test.ts's exact mocking convention:
// realtimeClient.ts's exported functions close over that module's own
// private getSupabaseClient singleton, so `vi.mock`'s factory replacing the
// exported binding does not change what those already-defined functions
// close over internally -- they are reimplemented below as thin
// pass-throughs against `mockClient`, now ALSO forwarding the status
// callback exactly as the real (post-E6) subscribeToGame/
// subscribeToActiveGamePointer implementations do.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render } from '@testing-library/react'
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
    onStatusChange?: (status: string, err?: Error) => void,
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
          onChange({ table, eventType: payload.eventType, row })
        },
      )
    }
    channel.subscribe((status, err) => onStatusChange?.(status, err))
    return channel
  }

  function subscribeToActiveGamePointer(
    onChange: (activeGameId: string | null) => void,
    onStatusChange?: (status: string, err?: Error) => void,
  ) {
    const supabase = getSupabaseClient()
    if (!supabase) return null
    const channel = supabase.channel('active-game-pointer')
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'active_game_pointer' },
      (payload) => onChange((payload.new as { active_game_id: string | null }).active_game_id),
    )
    channel.subscribe((status, err) => onStatusChange?.(status, err))
    return channel
  }

  return {
    ...actual,
    getSupabaseClient,
    getActiveGame,
    subscribeToGame,
    subscribeToActiveGamePointer,
  }
})

import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from './GameSessionContext'

// ---------------------------------------------------------------------------
// Test harness (mirrors GameSessionContext.staleIdentityInvalidation
// .integration.test.tsx's existing convention).
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

/** Finds the live (not-yet-unsubscribed) per-game channel, if any. */
function findGameChannelName(client: MockSupabaseClient): string | undefined {
  return client.channels.map((c) => c.name).find((n) => n.startsWith('game:'))
}

/** `Ticket.rows` builder, mirroring sessionConsistencyGuard.exploration.test.tsx's own helper. */
function buildTicketRows() {
  const cells = Array.from({ length: 15 }, (_, i) => ({
    termId: `TERM_${i}`,
    term: `TERM_${i}`,
    row: Math.floor(i / 5),
    col: i % 5,
    state: 'AVAILABLE' as const,
  }))
  return [cells.slice(0, 5), cells.slice(5, 10), cells.slice(10, 15)]
}

beforeEach(() => {
  mockClient = createMockSupabaseClient()
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  mockClient = null
})

/**
 * Flushes pending microtasks AND any timers that are already due, repeated
 * a few times -- the standard pattern for draining a promise chain that
 * alternates `await somePromise()` with `setTimeout`-scheduled continuations
 * under `vi.useFakeTimers()`. A bare `await Promise.resolve()` is not
 * sufficient once a `setTimeout(..., 0)`-equivalent or React's own scheduler
 * is in the chain; `vi.runOnlyPendingTimersAsync()` advances exactly the
 * timers already scheduled (never fast-forwarding ahead of them), so this
 * never skips past a delay this test means to assert against.
 */
async function flushMicrotasksAndDueTimers(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
      await Promise.resolve()
    })
  }
}

/** Resolves the initial mount hydration (one get_active_game RPC round trip). */
async function settleInitialHydration() {
  await flushMicrotasksAndDueTimers()
}

describe('E6 — Realtime connection recovery', () => {
  it('1. CHANNEL_ERROR initiates only one reconnect sequence (one scheduled timer, one resubscribe)', async () => {
    mockClient!.queueRpcResponse('get_active_game', { data: [buildGameRow()], error: null })
    const { sink } = mountProvider()
    await settleInitialHydration()
    expect(sink.current!.realtimeConnectionStatus).toBe('connecting')

    const channelName = findGameChannelName(mockClient!)!
    const rpcCallsBeforeReconnect = mockClient!.rpcCalls.length

    // Queue the response the reconnect's reconciliation fetch will consume.
    mockClient!.queueRpcResponse('get_active_game', { data: [buildGameRow()], error: null })

    act(() => {
      mockClient!.fireChannelStatus(channelName, 'CHANNEL_ERROR')
    })
    expect(sink.current!.realtimeConnectionStatus).toBe('reconnecting')

    // Firing CHANNEL_ERROR a second time immediately must NOT schedule a
    // second, independent timer -- scheduleReconnect always clears any
    // existing timer first, so advancing time once resolves at most one
    // reconnect attempt's worth of RPC calls.
    act(() => {
      mockClient!.fireChannelStatus(channelName, 'CHANNEL_ERROR')
    })

    await act(async () => {
      await vi.advanceTimersByTime(1000) // base delay for attempt 0
    })
    await flushMicrotasksAndDueTimers()

    const rpcCallsAfterReconnect = mockClient!.rpcCalls.length
    // Exactly one additional get_active_game call from the single
    // reconciliation fetch -- not two.
    expect(rpcCallsAfterReconnect - rpcCallsBeforeReconnect).toBe(1)
  })

  it('2. TIMED_OUT initiates bounded retries (stops at failed, never loops forever)', async () => {
    mockClient!.queueRpcResponse('get_active_game', { data: [buildGameRow()], error: null })
    const { sink } = mountProvider()
    await settleInitialHydration()

    const channelName = findGameChannelName(mockClient!)!

    // Always fail the reconciliation fetch so the retry counter keeps
    // climbing instead of resetting via a SUBSCRIBED.
    for (let i = 0; i < 8; i += 1) {
      mockClient!.queueRpcResponse('get_active_game', {
        data: null,
        error: { message: 'DOWN' },
      })
    }

    act(() => {
      mockClient!.fireChannelStatus(channelName, 'TIMED_OUT')
    })
    expect(sink.current!.realtimeConnectionStatus).toBe('reconnecting')

    // Advance through every bounded backoff delay (1000, 2000, 4000, 8000,
    // 16000, 30000-capped...) -- 6 attempts max per the implementation. Each
    // failed reconciliation re-fires CHANNEL_ERROR-equivalent behavior by
    // scheduling the next attempt directly (reconcileAfterReconnect itself
    // does not re-trigger scheduleReconnect on failure in this
    // implementation -- the channel's own next status event does). To
    // directly exercise the bounded-attempts ceiling without depending on
    // a real channel re-reporting CHANNEL_ERROR after every resubscribe,
    // re-fire CHANNEL_ERROR after each attempt's delay elapses, mirroring a
    // socket that keeps failing to (re)establish.
    for (let i = 0; i < 7; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTime(31000)
      })
      await flushMicrotasksAndDueTimers()
      if (sink.current!.realtimeConnectionStatus === 'failed') break
      const currentChannelName = findGameChannelName(mockClient!)
      if (currentChannelName) {
        act(() => {
          mockClient!.fireChannelStatus(currentChannelName, 'CHANNEL_ERROR')
        })
      }
    }

    expect(sink.current!.realtimeConnectionStatus).toBe('failed')
  })

  it('3. A successful SUBSCRIBED resets the retry counter', async () => {
    mockClient!.queueRpcResponse('get_active_game', { data: [buildGameRow()], error: null })
    const { sink } = mountProvider()
    await settleInitialHydration()

    const channelName = findGameChannelName(mockClient!)!

    mockClient!.queueRpcResponse('get_active_game', { data: [buildGameRow()], error: null })
    act(() => {
      mockClient!.fireChannelStatus(channelName, 'CHANNEL_ERROR')
    })
    expect(sink.current!.realtimeConnectionStatus).toBe('reconnecting')

    // The channel itself reports SUBSCRIBED again (e.g. the socket actually
    // recovered on its own before the scheduled attempt even fired).
    act(() => {
      mockClient!.fireChannelStatus(channelName, 'SUBSCRIBED')
    })
    expect(sink.current!.realtimeConnectionStatus).toBe('connected')

    // Because the counter was reset, the NEXT error starts again at the
    // base (1000ms) delay rather than a larger backed-off delay -- verified
    // indirectly: advancing by exactly the base delay is enough to resolve
    // one more reconnect attempt.
    const rpcCallsBefore = mockClient!.rpcCalls.length
    mockClient!.queueRpcResponse('get_active_game', { data: [buildGameRow()], error: null })
    act(() => {
      mockClient!.fireChannelStatus(channelName, 'CHANNEL_ERROR')
    })
    await act(async () => {
      await vi.advanceTimersByTime(1000)
    })
    await flushMicrotasksAndDueTimers()
    expect(mockClient!.rpcCalls.length - rpcCallsBefore).toBe(1)
  })

  it('4. Intentional unsubscription (CLOSED from a deliberate teardown) does not reconnect', async () => {
    mockClient!.queueRpcResponse('get_active_game', { data: [buildGameRow()], error: null })
    const { sink } = mountProvider()
    await settleInitialHydration()

    const channelName = findGameChannelName(mockClient!)!
    const rpcCallsBefore = mockClient!.rpcCalls.length

    // A deliberate CLOSED (as supabase-js reports after .unsubscribe()) must
    // never trigger scheduleReconnect -- the intentionallyClosed guard is
    // set synchronously by every teardown path before unsubscribe() is
    // called in production code; here we simulate the resulting CLOSED
    // event arriving on an already-torn-down channel reference, which the
    // mock's own unsubscribe() already removes listeners for, so firing it
    // is a no-op by construction -- confirming no reconnect timer exists
    // afterward (no additional RPC calls after advancing time).
    act(() => {
      mockClient!.fireChannelStatus(channelName, 'CLOSED')
    })
    await act(async () => {
      await vi.advanceTimersByTime(60000)
    })
    await flushMicrotasksAndDueTimers()
    expect(mockClient!.rpcCalls.length).toBe(rpcCallsBefore)
    // Status must not have been forced into 'reconnecting'/'failed' by a
    // CLOSED alone.
    expect(sink.current!.realtimeConnectionStatus).not.toBe('reconnecting')
    expect(sink.current!.realtimeConnectionStatus).not.toBe('failed')
  })

  it('5. Component unmount cancels pending reconnect timers', async () => {
    mockClient!.queueRpcResponse('get_active_game', { data: [buildGameRow()], error: null })
    const { sink, unmount } = mountProvider()
    await settleInitialHydration()

    const channelName = findGameChannelName(mockClient!)!
    act(() => {
      mockClient!.fireChannelStatus(channelName, 'CHANNEL_ERROR')
    })
    expect(sink.current!.realtimeConnectionStatus).toBe('reconnecting')

    const rpcCallsBefore = mockClient!.rpcCalls.length
    unmount()

    await act(async () => {
      await vi.advanceTimersByTime(60000)
    })
    await flushMicrotasksAndDueTimers()
    // No reconnect RPC should fire after unmount -- the pending timer was
    // cleared by the effect's cleanup.
    expect(mockClient!.rpcCalls.length).toBe(rpcCallsBefore)
  })

  it('6. Changing games (pointer switch) prevents the previous game channel from reconnecting', async () => {
    mockClient!.queueRpcResponse('get_active_game', {
      data: [buildGameRow({ id: 'GAME_A', host_secret: 'secret-a' })],
      error: null,
    })
    const { sink } = mountProvider()
    await settleInitialHydration()

    const oldChannelName = findGameChannelName(mockClient!)!

    // Host resets: pointer announces GAME_B.
    mockClient!.queueRpcResponse('get_active_game', {
      data: [buildGameRow({ id: 'GAME_B', host_secret: 'secret-b' })],
      error: null,
    })
    act(() => {
      mockClient!.fireRemoteChange({
        table: 'active_game_pointer' as unknown as Parameters<
          MockSupabaseClient['fireRemoteChange']
        >[0]['table'],
        eventType: 'UPDATE',
        row: { id: true, active_game_id: 'GAME_B', updated_at: '2026-01-02T00:00:00.000Z' },
      })
    })
    await flushMicrotasksAndDueTimers()
    expect(sink.current!.state.game.id).toBe('GAME_B')

    const rpcCallsBefore = mockClient!.rpcCalls.length

    // A CHANNEL_ERROR arriving on the OLD (now-replaced) channel reference
    // must not schedule any reconnect -- the old channel was intentionally
    // unsubscribed when hydrateForGame moved to GAME_B.
    act(() => {
      mockClient!.fireChannelStatus(oldChannelName, 'CHANNEL_ERROR')
    })
    await act(async () => {
      await vi.advanceTimersByTime(60000)
    })
    await flushMicrotasksAndDueTimers()
    expect(mockClient!.rpcCalls.length).toBe(rpcCallsBefore)
  })

  it('7. Stale events from an old game are ignored (gameIdRef guard preserved)', async () => {
    mockClient!.queueRpcResponse('get_active_game', {
      data: [buildGameRow({ id: 'GAME_A', host_secret: 'secret-a' })],
      error: null,
    })
    const { sink } = mountProvider()
    await settleInitialHydration()

    const channelName = findGameChannelName(mockClient!)!

    // A games-table UPDATE event claiming to belong to a different game_id
    // than the currently tracked one must be dropped, exactly as the
    // pre-E6 guard already did (unchanged behavior).
    act(() => {
      mockClient!.fireRemoteChange({
        table: 'games',
        eventType: 'UPDATE',
        row: { id: 'GAME_A', game_id: 'GAME_STALE', status: 'WORD_ACTIVE' },
      })
    })
    expect(sink.current!.state.game.status).toBe('LOBBY')
    void channelName // sanity: channel exists; guard is evaluated inside the handler itself
  })

  it('8. A valid player is not redirected to login during temporary connection failure', async () => {
    mockClient!.queueRpcResponse('get_active_game', {
      data: [buildGameRow({ id: 'GAME_A', host_secret: 'secret-a' })],
      error: null,
    })
    mockClient!.queueFromResponse('players', { data: [], error: null })
    mockClient!.queueFromResponse('tickets', { data: [], error: null })
    mockClient!.queueFromResponse('marks', { data: [], error: null })
    mockClient!.queueFromResponse('claims', { data: [], error: null })
    mockClient!.queueFromResponse('winners', { data: [], error: null })
    mockClient!.queueFromResponse('called_terms', { data: [], error: null })

    const { sink } = mountProvider()
    await settleInitialHydration()

    const ticketRows = buildTicketRows()
    const player = {
      id: 'PLAYER_1',
      gameId: 'GAME_A',
      displayName: 'Alex',
      ticketId: 'TICKET_1',
      joinedAt: '2026-01-01T00:00:00.000Z',
      name: 'Alex',
      ticketRef: 'AB12',
    }
    const ticket = {
      id: 'TICKET_1',
      playerId: 'PLAYER_1',
      gameId: 'GAME_A',
      createdAt: '2026-01-01T00:00:00.000Z',
      ref: 'AB12',
      rows: ticketRows,
    }
    act(() => {
      sink.current!.dispatch({ type: 'JOIN_PLAYER', player, ticket })
    })
    expect(sink.current!.currentPlayer?.id).toBe('PLAYER_1')

    const channelName = findGameChannelName(mockClient!)!
    act(() => {
      mockClient!.fireChannelStatus(channelName, 'CHANNEL_ERROR')
    })
    expect(sink.current!.realtimeConnectionStatus).toBe('reconnecting')

    // Session must remain fully intact throughout the connection failure --
    // no CLEAR_STALE_PLAYER, no redirect-worthy state change.
    expect(sink.current!.currentPlayer?.id).toBe('PLAYER_1')
    expect(sink.current!.currentTicket?.id).toBe('TICKET_1')
    expect(sink.current!.state.currentPlayerId).toBe('PLAYER_1')

    // Even after the reconnect attempt resolves, the player must still be
    // present (reconciliation only replaces game/players/etc. with a fresh
    // snapshot -- it does not clear currentPlayerId).
    const playerRow = { id: 'PLAYER_1', game_id: 'GAME_A', display_name: 'Alex' }
    const ticketRow = {
      id: 'TICKET_1',
      game_id: 'GAME_A',
      player_id: 'PLAYER_1',
      ref: 'AB12',
      signature: 'TERM_0|TERM_1',
      cells: Array.from({ length: 15 }, (_, i) => ({
        termId: `TERM_${i}`,
        row: Math.floor(i / 5),
        col: i % 5,
      })),
    }
    mockClient!.queueRpcResponse('get_active_game', {
      data: [buildGameRow({ id: 'GAME_A', host_secret: 'secret-a' })],
      error: null,
    })
    mockClient!.queueFromResponse('players', { data: [playerRow], error: null })
    mockClient!.queueFromResponse('tickets', { data: [ticketRow], error: null })
    mockClient!.queueFromResponse('marks', { data: [], error: null })
    mockClient!.queueFromResponse('claims', { data: [], error: null })
    mockClient!.queueFromResponse('winners', { data: [], error: null })
    mockClient!.queueFromResponse('called_terms', { data: [], error: null })
    await act(async () => {
      await vi.advanceTimersByTime(1000)
    })
    await flushMicrotasksAndDueTimers()
    expect(sink.current!.state.currentPlayerId).toBe('PLAYER_1')
    expect(sink.current!.currentPlayer?.id).toBe('PLAYER_1')
  })

  it('9. Successful reconnection triggers state recovery/reconciliation (full re-fetch)', async () => {
    mockClient!.queueRpcResponse('get_active_game', {
      data: [buildGameRow({ id: 'GAME_A', host_secret: 'secret-a', status: 'LOBBY' })],
      error: null,
    })
    const { sink } = mountProvider()
    await settleInitialHydration()
    expect(sink.current!.state.game.status).toBe('LOBBY')

    const channelName = findGameChannelName(mockClient!)!

    act(() => {
      mockClient!.fireChannelStatus(channelName, 'CHANNEL_ERROR')
    })

    // While disconnected, the game actually advanced server-side (e.g. a
    // word was called) -- the reconnect's reconciliation fetch must pick
    // this up via a fresh get_active_game + full-state re-fetch, not just a
    // resubscribe.
    mockClient!.queueRpcResponse('get_active_game', {
      data: [
        buildGameRow({
          id: 'GAME_A',
          host_secret: 'secret-a',
          status: 'WORD_ACTIVE',
          current_round: 1,
          current_term_id: 'phishing',
        }),
      ],
      error: null,
    })
    mockClient!.queueFromResponse('called_terms', {
      data: [{ term_id: 'phishing' }],
      error: null,
    })
    mockClient!.queueFromResponse('players', { data: [], error: null })
    mockClient!.queueFromResponse('tickets', { data: [], error: null })
    mockClient!.queueFromResponse('marks', { data: [], error: null })
    mockClient!.queueFromResponse('claims', { data: [], error: null })
    mockClient!.queueFromResponse('winners', { data: [], error: null })

    await act(async () => {
      await vi.advanceTimersByTime(1000)
    })
    await flushMicrotasksAndDueTimers()

    expect(sink.current!.state.game.status).toBe('WORD_ACTIVE')
    expect(sink.current!.state.game.currentTermId).toBe('phishing')
    expect(sink.current!.state.game.revealedTermIds).toEqual(['phishing'])
  })

  it('10. Multiple error callbacks do not create duplicate active subscriptions', async () => {
    mockClient!.queueRpcResponse('get_active_game', { data: [buildGameRow()], error: null })
    const { sink } = mountProvider()
    await settleInitialHydration()

    const channelName = findGameChannelName(mockClient!)!
    const channelCountBefore = mockClient!.channels.filter((c) =>
      c.name.startsWith('game:'),
    ).length
    expect(channelCountBefore).toBe(1)

    mockClient!.queueRpcResponse('get_active_game', { data: [buildGameRow()], error: null })
    act(() => {
      mockClient!.fireChannelStatus(channelName, 'CHANNEL_ERROR')
      mockClient!.fireChannelStatus(channelName, 'CHANNEL_ERROR')
      mockClient!.fireChannelStatus(channelName, 'CHANNEL_ERROR')
    })

    await act(async () => {
      await vi.advanceTimersByTime(1000)
    })
    await flushMicrotasksAndDueTimers()

    // Exactly one additional channel: the single resubscribe triggered by
    // the one surviving timer -- three CHANNEL_ERROR callbacks in the same
    // tick must still only ever schedule (and later fire) one reconnect.
    const gameChannelsAfter = mockClient!.channels.filter((c) => c.name.startsWith('game:'))
    expect(gameChannelsAfter.length).toBe(2) // original + the one resubscribe

    // Simulate the new channel's own successful handshake, exactly as a
    // real Supabase socket would report SUBSCRIBED once established.
    const newChannelName = gameChannelsAfter[gameChannelsAfter.length - 1].name
    act(() => {
      mockClient!.fireChannelStatus(newChannelName, 'SUBSCRIBED')
    })
    expect(sink.current!.realtimeConnectionStatus).toBe('connected')
  })
})
