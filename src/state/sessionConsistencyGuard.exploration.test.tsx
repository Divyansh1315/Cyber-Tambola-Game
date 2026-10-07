// Spec: claim-player-ticket-identity-mismatch — task 1 (bug condition
// exploration test, written BEFORE the fix per bugfix workflow), updated by
// task 15.1 to assert the FIXED/expected behavior now that the fix
// (tasks 3-8) has landed in `GameSessionContext.tsx`/`gameSessionReducer.ts`.
//
// Property 1: Expected Behavior - Stale Player/Ticket Identity Submission Is
// Now Blocked.
//
// Reproduces the reported incident shape: a Player tab joins Game A, the
// Host triggers a Reset (Game B becomes the confirmed Active Game), and the
// Player tab's `currentPlayerId` -- which Reset deliberately leaves
// untouched -- is never invalidated against the new Active Game by Reset
// itself. On the FIXED `GameSessionContext.tsx`/`gameSessionReducer.ts`:
//   (a) `currentPlayer`/`currentTicket` are STILL rendered using the stale
//       Game-A-tagged data -- this part of the design is UNCHANGED by the
//       fix: `getActivePlayerSession()`'s `activePlayer`/`activeTicket` are
//       used unconditionally for rendering (Req 2.4's no-flicker guarantee),
//       even when `isConsistent` is false. Only *submission* is gated.
//   (b) Submitting a prize claim from that stale state is now BLOCKED by
//       the pre-submission session consistency guard inside
//       `wrappedDispatch`: `rpcSubmitClaim`/the mock's `submit_claim` is
//       never called, the optimistic claim entry is rolled back, and
//       `lastSessionGuardFailure` is set with `reason: 'PLAYER_NOT_IN_GAME'`
//       -- exactly the server-side rejection this client-side guard now
//       preempts.
//   (c) A claim submitted before the backend snapshot has been confirmed at
//       all (`isBackendConfirmed = false`) is likewise now blocked, with
//       `lastSessionGuardFailure.reason` set to `'NOT_BACKEND_CONFIRMED'`.
//
// Uses the same mock Supabase client harness and `vi.mock('./realtimeClient',
// ...)` thin-pass-through convention established by
// `GameSessionContext.multiTabReset.integration.test.tsx` and exercised at
// the realtimeClient-export level by `realtimeClient.activeGamePointer.test.ts`.
//
// Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.7
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import {
  createMockSupabaseClient,
  type MockSupabaseClient,
} from './testSupport/mockSupabaseClient'
import { STORAGE_KEY, CURRENT_PLAYER_STORAGE_KEY, PERSIST_VERSION } from './persistence'
import type { TicketCell } from '../types/ticket'

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

  async function submitClaim(playerId: string, prizeId: string) {
    const supabase = getSupabaseClient()
    if (!supabase) throw new Error('no mock client configured')
    const { data, error } = await supabase.rpc('submit_claim', {
      p_player_id: playerId,
      p_prize_id: prizeId,
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
    resetGameToNew,
    submitClaim,
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

function buildTicketCells(): Record<string, unknown>[] {
  return Array.from({ length: 15 }, (_, i) => ({
    termId: `TERM_${i}`,
    row: Math.floor(i / 5), // not-a-ticket-dimension (deliberately legacy 3x5 fixture shape)
    col: i % 5, // not-a-ticket-dimension (deliberately legacy 3x5 fixture shape)
  }))
}

/**
 * `TicketCell[][]` builder for `Ticket.rows` construction sites in this
 * file -- mirrors `sessionConsistencyGuard.preservation.test.tsx`'s own
 * `buildTicketCells(): TicketCell[]` / `buildTicketRows()` pair. Kept
 * separate from `buildTicketCells()` above (which stays untyped/raw for the
 * mock DB row shape used by `queueFromResponse('tickets', ...)`).
 */
function buildTicketRows(): TicketCell[][] {
  const cells: TicketCell[] = Array.from({ length: 15 }, (_, i) => ({
    termId: `TERM_${i}`,
    term: `TERM_${i}`,
    row: Math.floor(i / 5), // not-a-ticket-dimension (deliberately legacy 3x5 fixture shape)
    col: i % 5, // not-a-ticket-dimension (deliberately legacy 3x5 fixture shape)
    state: 'AVAILABLE' as const,
  }))
  return [cells.slice(0, 5), cells.slice(5, 10), cells.slice(10, 15)]
}

describe('Fixed: stale Player/Ticket identity after Reset is blocked at submission (Req 2.2, 2.3, 2.4, 2.5, 2.7)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = createMockSupabaseClient()
  })

  it('fixed: stale currentPlayer/currentTicket submission is blocked after a Reset to a new Active Game', async () => {
    const client = mockClient!

    // Mount: resolve the initial Active Game (GAME_A) and its full snapshot
    // -- this player (P_A1) already exists in GAME_A with ticket T_A1.
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
      cells: buildTicketCells(),
    }
    client.queueFromResponse('players', { data: [playerARow] })
    client.queueFromResponse('tickets', { data: [ticketARow] })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()

    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBe('GAME_A')
    })

    // Simulate this device's own join having already happened on a prior
    // mount: set currentPlayerId directly (RESTORE_PLAYER), exactly as a
    // refresh would restore it from localStorage.
    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_A1' })
    })

    await waitFor(() => {
      expect(tab.sink.current!.currentPlayer?.id).toBe('P_A1')
      expect(tab.sink.current!.currentTicket?.id).toBe('T_A1')
    })

    // --- Host triggers Reset: Game A is retired, Game B becomes Active ---
    const newGameRow = buildGameRow({ id: 'GAME_B', code: 'NEWG01', host_secret: 'secret-b' })
    client.queueRpcResponse('reset_game_to_new', {
      data: [{ old_game_id: 'GAME_A', new_game: newGameRow }],
    })
    await act(async () => {
      await client.rpc('reset_game_to_new', { p_old_game_id: 'GAME_A', p_host_secret: 'secret-a' })
    })

    // This tab's own pointer-follow effect re-resolves via getActiveGame()
    // once the pointer-change event fires -- Game B genuinely has no
    // players/tickets yet (a brand-new game).
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

    // The confirmed Active Game is now GAME_B, and GAME_B's players/tickets
    // snapshot is empty -- P_A1/T_A1 no longer exist in state at all.
    expect(tab.sink.current!.state.players).toEqual([])
    expect(tab.sink.current!.state.tickets).toEqual([])

    // *** COUNTEREXAMPLE (a) ***
    // currentPlayerId ('P_A1') was left untouched by Reset (by design, so a
    // genuinely active tab isn't logged out). On the unfixed code, nothing
    // re-validates it against the new Active Game, so currentPlayer /
    // currentTicket should be undefined now that P_A1/T_A1 are gone from
    // state -- but the actual bug is broader than a simple "undefined"
    // case: the defect is that NOTHING ever checks `activePlayer.gameId ===
    // activeGame.id` before treating a resolved player/ticket as
    // authoritative for rendering or submission. To demonstrate this with a
    // player that DOES still structurally resolve (the harder, more
    // dangerous variant of the bug -- not just "player vanished from the
    // array"), re-add a player/ticket row shaped exactly like a stale
    // local-cache leftover: same id, but still tagged with the OLD
    // game_id, and manually fold it into state the way a stale localStorage
    // envelope would (never overwritten here, since HYDRATE_FROM_REMOTE for
    // GAME_B only ever supplies GAME_B-scoped rows and would never add a
    // GAME_A-scoped row itself).
    // *** Rendering remains unconditional on the FIXED code (unchanged) ***
    // `getActivePlayerSession()`'s activePlayer/activeTicket are used
    // unconditionally for currentPlayer/currentTicket -- even when
    // isConsistent is false -- per design.md's Req 2.4 no-flicker
    // guarantee. The stale-identity invalidation effect (task 7.2) also now
    // exists and runs once isBackendConfirmed is true for GAME_B, clearing
    // currentPlayerId as soon as it finds no matching GAME_B player -- so a
    // stale resolved player/ticket is only observable in the SAME dispatch
    // batch that (re-)introduces it, before that effect gets a chance to
    // flush. JOIN_PLAYER and SUBMIT_PRIZE_CLAIM are therefore dispatched
    // together here, exactly as a stale-identity resubmission from this
    // tab's own in-flight claim UI would race the invalidation effect in
    // the real app.
    const claimsBefore = tab.sink.current!.state.claims.length
    const rpcCallsBefore = client.rpcCalls.length
    act(() => {
      tab.sink.current!.dispatch({
        type: 'JOIN_PLAYER',
        player: {
          id: 'P_A1',
          gameId: 'GAME_A',
          displayName: 'Divyansh',
          ticketId: 'T_A1',
          joinedAt: '2026-01-01T00:00:00.000Z',
          name: 'Divyansh',
          ticketRef: '6405',
        },
        ticket: {
          id: 'T_A1',
          playerId: 'P_A1',
          gameId: 'GAME_A',
          createdAt: '2026-01-01T00:00:00.000Z',
          ref: '6405',
          rows: buildTicketRows(),
        },
      })
      // *** COUNTEREXAMPLE (b), FIXED ***
      // Dispatched in the same batch, against the stale P_A1/T_A1 just
      // joined above: the pre-submission session consistency guard inside
      // wrappedDispatch resolves this against `before` (the snapshot
      // captured at the top of THIS dispatch, which already includes the
      // stale P_A1/T_A1 rows and currentPlayerId from the JOIN_PLAYER
      // dispatch immediately preceding it) and blocks it BEFORE any RPC
      // call is made -- the exact precursor of the incident's server-side
      // PLAYER_NOT_IN_GAME rejection is now preempted client-side.
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
    })

    // state.game.id is confirmed as GAME_B throughout.
    expect(tab.sink.current!.state.game.id).toBe('GAME_B')

    // Give any (incorrect) async RPC call a chance to land before asserting
    // it never does -- waitFor-style negative assertions must not resolve
    // the instant the condition is checked once; flush microtasks/a short
    // wait instead of waiting for rpcCalls.length to increase.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    const submitCall = client.rpcCalls.find((c) => c.name === 'submit_claim')
    // *** Counterexample (b): fixed ***
    // The guard intercepted this call -- the stale playerId ('P_A1', which
    // belongs to the retired GAME_A) was never sent to submit_claim.
    expect(client.rpcCalls.length).toBe(rpcCallsBefore)
    expect(submitCall).toBeUndefined()

    // The optimistic claim entry added earlier in wrappedDispatch is rolled
    // back rather than left dangling as a phantom PENDING claim the backend
    // never saw.
    expect(tab.sink.current!.state.claims.length).toBe(claimsBefore)

    // lastSessionGuardFailure records the blocked attempt with the correct
    // inconsistencyReason -- P_A1 resolves (it exists in state), but its
    // gameId ('GAME_A') disagrees with the confirmed Active Game
    // ('GAME_B'), so getActivePlayerSession() attributes this to
    // PLAYER_NOT_IN_GAME (resolution order: not-backend-confirmed, player
    // not found, player not in game, ticket not found, ticket not owned).
    expect(tab.sink.current!.lastSessionGuardFailure).toEqual({
      prizeId: 'CYBER_FIVE',
      reason: 'PLAYER_NOT_IN_GAME',
    })

    tab.unmount()
  })

  it('fixed: claim submission is blocked while the backend snapshot is still unconfirmed (isHydrated=true, backendConfirmed=false)', async () => {
    const client = mockClient!

    // Mount the provider but do NOT resolve the queued get_active_game
    // response yet -- the mount-time effect's resolveInitialGame() promise
    // is left pending, simulating the window between first synchronous
    // render (isHydrated hardcoded true) and the first HYDRATE_FROM_REMOTE
    // actually landing (backendConfirmed = false in design.md's terms).
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
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })

    // Pre-seed localStorage with a cached envelope + currentPlayerId, as a
    // device that already had a session before this mount would have --
    // this is read synchronously by initState() before any network call.
    const cachedPlayer = {
      id: 'P_A1',
      gameId: 'GAME_A',
      displayName: 'Divyansh',
      ticketId: 'T_A1',
      joinedAt: '2026-01-01T00:00:00.000Z',
      name: 'Divyansh',
      ticketRef: '6405',
    }
    const cachedTicket = {
      id: 'T_A1',
      playerId: 'P_A1',
      gameId: 'GAME_A',
      createdAt: '2026-01-01T00:00:00.000Z',
      ref: '6405',
      rows: buildTicketRows(),
    }
    const cachedGame = {
      id: 'GAME_A',
      code: 'CYBER24',
      status: 'LOBBY' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      currentRound: 0,
      revealedTermIds: [] as string[],
    }
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: PERSIST_VERSION,
        game: cachedGame,
        players: [cachedPlayer],
        tickets: [cachedTicket],
        marks: [],
        claims: [],
        winners: [],
      }),
    )
    localStorage.setItem(CURRENT_PLAYER_STORAGE_KEY, 'P_A1')

    const tab = mountProvider()

    // isHydrated is hardcoded true from the very first render (unfixed
    // behavior) -- confirm the stale cached identity is already fully
    // resolved and rendered despite the backend fetch still being pending.
    expect(tab.sink.current!.isHydrated).toBe(true)
    expect(tab.sink.current!.currentPlayer?.id).toBe('P_A1')
    expect(tab.sink.current!.currentTicket?.id).toBe('T_A1')

    // *** COUNTEREXAMPLE (c), FIXED ***
    // Attempt claim submission NOW, before get_active_game's promise has
    // settled (isBackendConfirmed = false in design.md's
    // ClaimSubmissionContext terms). The guard now reads isBackendConfirmed
    // via getActivePlayerSession() and blocks submission before any RPC
    // call is made.
    client.queueRpcResponse('submit_claim', { data: null, error: null })
    const rpcCallsBefore = client.rpcCalls.length
    const claimsBefore = tab.sink.current!.state.claims.length

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
    })

    // Flush microtasks/a short wait and assert the RPC call count never
    // increases, rather than waiting for it to increase.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    const submitCall = client.rpcCalls.find((c) => c.name === 'submit_claim')
    // *** Counterexample (c): fixed ***
    // The claim was NOT submitted while the backend snapshot for the live
    // Active Game had not yet been confirmed for this device.
    expect(client.rpcCalls.length).toBe(rpcCallsBefore)
    expect(submitCall).toBeUndefined()
    expect(tab.sink.current!.state.claims.length).toBe(claimsBefore)
    expect(tab.sink.current!.lastSessionGuardFailure).toEqual({
      prizeId: 'CYBER_FIVE',
      reason: 'NOT_BACKEND_CONFIRMED',
    })

    // Let the pending getActiveGame() resolve so the effect can clean up
    // without an unhandled rejection/dangling timer.
    resolveGetActiveGame?.()
    client.queueFromResponse('players', { data: [] })
    client.queueFromResponse('tickets', { data: [] })
    client.queueFromResponse('winners', { data: [] })
    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBe('GAME_A')
    })

    tab.unmount()
  })
})
