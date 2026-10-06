// Spec: claim-player-ticket-identity-mismatch — task 10 (unit tests for the
// pre-submission guard in `wrappedDispatch`).
//
// Covers the guard added to `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` case
// (GameSessionContext.tsx, task 5.2): immediately before calling
// `rpcSubmitClaim`, the guard calls `getActivePlayerSession(before,
// isBackendConfirmed)`. If `isConsistent` is false, it must NOT call
// `rpcSubmitClaim`, must roll back the optimistic claim entry added earlier
// in the same dispatch (via the same `rollback()`/`resolveRollbackTarget`
// machinery `MARK_TERM`/`CONFIRM_CLAIM` already use), must set
// `lastSessionGuardFailure` with the correct `inconsistencyReason`, and (in
// DEV) must log exactly the four allowed non-sensitive fields
// (`ACTIVE_GAME_ID`, `CURRENT_PLAYER_ID`, `ACTIVE_TICKET_ID`,
// `inconsistencyReason`). If `isConsistent` is true, behavior must be
// byte-for-byte identical to the pre-fix baseline captured by task 2's
// `sessionConsistencyGuard.preservation.test.tsx`.
//
// Reachable failure branches only (per task 9's own finding, documented in
// `getActivePlayerSession.test.ts`): given the resolver's single
// deterministic `.find()` for `activeTicket` (`t.playerId ===
// activePlayer?.id && t.gameId === activeGame.id`), a ticket whose
// `playerId` disagrees with the active player never resolves at all — it
// surfaces as `TICKET_NOT_FOUND`, not `TICKET_NOT_OWNED_BY_PLAYER`. There is
// no reachable input shape (through the public resolver contract exercised
// via `wrappedDispatch`) that produces a ticket which both resolves AND
// independently fails the ownership re-check. `TICKET_NOT_OWNED_BY_PLAYER`
// is therefore NOT separately tested here as a `wrappedDispatch` guard
// branch — doing so would require fabricating a scenario the resolver can
// never actually produce, which would just be testing the test, not the
// guard. The four reachable branches (not backend confirmed, player not
// found, player not in game, ticket not found) are each covered below.
//
// Mock harness, Harness component, and realtimeClient pass-through
// conventions below are copied from `sessionConsistencyGuard.exploration
// .test.tsx` (task 1) / `sessionConsistencyGuard.preservation.test.tsx`
// (task 2) for consistency.
//
// Validates: Requirements 2.2, 2.3, 2.7, 3.1, 3.5
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
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

  // MARK_TERM's optimistic dispatch calls rpcSubmitMark for every mark the
  // passing-branch test makes while reaching Cyber Five eligibility -- this
  // must resolve successfully (mirroring a backend that accepts the mark),
  // same convention as submitClaim above, so this test's own MARK_TERM
  // dispatches don't spuriously reject (and trigger the now-correctly-wired
  // rollback) through `actual.submitMark`'s un-mocked internal
  // `getSupabaseClient()` call.
  async function submitMark(playerId: string, termId: string) {
    const supabase = getSupabaseClient()
    if (!supabase) throw new Error('no mock client configured')
    const { data, error } = await supabase.rpc('submit_mark', {
      p_player_id: playerId,
      p_term_id: termId,
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
    submitClaim,
    submitMark,
  }
})

import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from './GameSessionContext'
import type { TicketCell } from '../types/ticket'

// ---------------------------------------------------------------------------
// Test harness (mirrors sessionConsistencyGuard.exploration.test.tsx's /
// sessionConsistencyGuard.preservation.test.tsx's existing convention).
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

function buildTicketCells(): TicketCell[] {
  return Array.from({ length: 15 }, (_, i) => ({
    termId: `TERM_${i}`,
    term: `Term ${i}`,
    row: Math.floor(i / 5),
    col: i % 5,
    state: 'AVAILABLE' as const,
  }))
}

/** Mounts a provider with a confirmed Active Game GAME_A and a consistent player P_1/ticket T_1 restored as currentPlayerId. */
async function mountConsistentSession(client: MockSupabaseClient) {
  client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
  const playerRow = {
    id: 'P_1',
    game_id: 'GAME_A',
    display_name: 'Divyansh',
    joined_at: '2026-01-01T00:00:00.000Z',
  }
  const ticketRow = {
    id: 'T_1',
    game_id: 'GAME_A',
    player_id: 'P_1',
    created_at: '2026-01-01T00:00:00.000Z',
    ref: 'Ticket #6405',
    cells: buildTicketCells(),
  }
  client.queueFromResponse('players', { data: [playerRow] })
  client.queueFromResponse('tickets', { data: [ticketRow] })
  client.queueFromResponse('winners', { data: [] })

  const tab = mountProvider()

  await waitFor(() => {
    expect(tab.sink.current!.state.game.id).toBe('GAME_A')
  })

  act(() => {
    tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_1' })
  })

  await waitFor(() => {
    expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
    expect(tab.sink.current!.currentTicket?.id).toBe('T_1')
  })

  return tab
}

describe('Pre-submission session consistency guard in wrappedDispatch (Req 2.2, 2.3, 2.7, 3.1, 3.5)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    localStorage.clear()
    mockClient = createMockSupabaseClient()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  describe('failure branches', () => {
    it('NOT_BACKEND_CONFIRMED: blocks submission, rolls back the optimistic claim, sets lastSessionGuardFailure, logs diagnostics', async () => {
      const client = mockClient!

      // Pending getActiveGame() leaves isBackendConfirmed false while a
      // cached, structurally-consistent identity is already restored from
      // localStorage-equivalent state (RESTORE_PLAYER), exactly like
      // counterexample (c) in the exploration test.
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

      const tab = mountProvider()

      expect(tab.sink.current!.isBackendConfirmed).toBe(false)

      // Seed a player/ticket directly into state (equivalent to a restored
      // cached identity) so the guard's player/ticket existence checks pass
      // and ONLY the backend-confirmation check fails.
      act(() => {
        tab.sink.current!.dispatch({
          type: 'JOIN_PLAYER',
          player: {
            id: 'P_1',
            gameId: tab.sink.current!.state.game.id,
            displayName: 'Divyansh',
            ticketId: 'T_1',
            joinedAt: '2026-01-01T00:00:00.000Z',
            name: 'Divyansh',
            ticketRef: 'Ticket #6405',
          },
          ticket: {
            id: 'T_1',
            playerId: 'P_1',
            gameId: tab.sink.current!.state.game.id,
            createdAt: '2026-01-01T00:00:00.000Z',
            ref: 'Ticket #6405',
            rows: [buildTicketCells().slice(0, 5), buildTicketCells().slice(5, 10), buildTicketCells().slice(10, 15)],
          },
        })
      })

      expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
      expect(tab.sink.current!.currentTicket?.id).toBe('T_1')

      const rpcCallsBefore = client.rpcCalls.length
      const claimsBefore = tab.sink.current!.state.claims.length

      act(() => {
        tab.sink.current!.dispatch({
          type: 'SUBMIT_PRIZE_CLAIM',
          playerId: 'P_1',
          ticketId: 'T_1',
          prizeId: 'CYBER_FIVE',
        })
      })

      // Optimistic entry was added then immediately rolled back -- claims
      // count nets back to its pre-dispatch value.
      expect(tab.sink.current!.state.claims.length).toBe(claimsBefore)

      // rpcSubmitClaim ('submit_claim') is never called.
      expect(client.rpcCalls.length).toBe(rpcCallsBefore)
      expect(client.rpcCalls.some((c) => c.name === 'submit_claim')).toBe(false)

      expect(tab.sink.current!.lastSessionGuardFailure).toEqual({
        prizeId: 'CYBER_FIVE',
        reason: 'NOT_BACKEND_CONFIRMED',
      })

      expect(warnSpy).toHaveBeenCalledWith('[session-guard]', {
        ACTIVE_GAME_ID: tab.sink.current!.state.game.id,
        CURRENT_PLAYER_ID: 'P_1',
        ACTIVE_TICKET_ID: 'T_1',
        inconsistencyReason: 'NOT_BACKEND_CONFIRMED',
      })
      const loggedPayload = warnSpy.mock.calls.at(-1)![1] as Record<string, unknown>
      expect(Object.keys(loggedPayload).sort()).toEqual(
        ['ACTIVE_GAME_ID', 'ACTIVE_TICKET_ID', 'CURRENT_PLAYER_ID', 'inconsistencyReason'].sort(),
      )

      resolveGetActiveGame?.()
      client.queueFromResponse('players', { data: [] })
      client.queueFromResponse('tickets', { data: [] })
      client.queueFromResponse('winners', { data: [] })
      await waitFor(() => {
        expect(tab.sink.current!.isBackendConfirmed).toBe(true)
      })

      tab.unmount()
    })

    it('PLAYER_NOT_FOUND: blocks submission, rolls back the optimistic claim, sets lastSessionGuardFailure, logs diagnostics', async () => {
      const client = mockClient!
      const tab = await mountConsistentSession(client)

      // The guard resolves activePlayer from state.currentPlayerId, not
      // from action.playerId -- so to exercise PLAYER_NOT_FOUND, point
      // currentPlayerId at an id with no matching player row at all
      // (CLEAR_STALE_PLAYER + RESTORE_PLAYER for a never-joined id, issued
      // in the SAME act() as the claim dispatch so the guard observes this
      // BEFORE any other effect could react to the now-undefined-then-
      // ghost currentPlayerId).
      act(() => {
        tab.sink.current!.dispatch({ type: 'CLEAR_STALE_PLAYER' })
        tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'GHOST_PLAYER' })
      })
      expect(tab.sink.current!.currentPlayer).toBeUndefined()
      // RESTORE_PLAYER ignores an id with no matching player row (reducer's
      // "ignore if absent" convention) -- currentPlayerId stays whatever
      // CLEAR_STALE_PLAYER left it (undefined), which still exercises
      // PLAYER_NOT_FOUND (no activePlayer resolves either way).
      expect(tab.sink.current!.state.currentPlayerId).toBeUndefined()

      const rpcCallsBefore = client.rpcCalls.length
      const claimsBefore = tab.sink.current!.state.claims.length

      act(() => {
        tab.sink.current!.dispatch({
          type: 'SUBMIT_PRIZE_CLAIM',
          playerId: 'GHOST_PLAYER',
          ticketId: 'T_1',
          prizeId: 'CYBER_FIVE',
        })
      })

      expect(tab.sink.current!.state.claims.length).toBe(claimsBefore)
      expect(client.rpcCalls.length).toBe(rpcCallsBefore)
      expect(client.rpcCalls.some((c) => c.name === 'submit_claim')).toBe(false)

      expect(tab.sink.current!.lastSessionGuardFailure).toEqual({
        prizeId: 'CYBER_FIVE',
        reason: 'PLAYER_NOT_FOUND',
      })

      expect(warnSpy).toHaveBeenCalledWith('[session-guard]', {
        ACTIVE_GAME_ID: 'GAME_A',
        CURRENT_PLAYER_ID: undefined,
        ACTIVE_TICKET_ID: undefined,
        inconsistencyReason: 'PLAYER_NOT_FOUND',
      })

      tab.unmount()
    })

    it('PLAYER_NOT_IN_GAME: blocks submission, rolls back the optimistic claim, sets lastSessionGuardFailure, logs diagnostics', async () => {
      const client = mockClient!
      const tab = await mountConsistentSession(client)

      // Reproduce the reported incident shape directly: a player row whose
      // gameId belongs to a retired game, re-added to state (mirrors a
      // stale localStorage envelope leftover from before a Reset), while
      // state.game.id ('GAME_A') is the confirmed Active Game. JOIN_PLAYER
      // and the SUBMIT_PRIZE_CLAIM dispatch are issued inside the SAME
      // `act()` so the guard observes this stale player/ticket BEFORE the
      // separate stale-identity invalidation effect (task 7.2) gets a
      // chance to run its own useEffect and dispatch CLEAR_STALE_PLAYER --
      // this test is scoped to the pre-submission guard inside
      // wrappedDispatch specifically, not to that other, already-covered
      // effect (task 11).
      const rpcCallsBefore = client.rpcCalls.length
      const claimsBefore = tab.sink.current!.state.claims.length

      act(() => {
        tab.sink.current!.dispatch({
          type: 'JOIN_PLAYER',
          player: {
            id: 'P_STALE',
            gameId: 'GAME_RETIRED',
            displayName: 'Divyansh',
            ticketId: 'T_STALE',
            joinedAt: '2026-01-01T00:00:00.000Z',
            name: 'Divyansh',
            ticketRef: 'Ticket #6405',
          },
          ticket: {
            id: 'T_STALE',
            playerId: 'P_STALE',
            gameId: 'GAME_RETIRED',
            createdAt: '2026-01-01T00:00:00.000Z',
            ref: 'Ticket #6405',
            rows: [buildTicketCells().slice(0, 5), buildTicketCells().slice(5, 10), buildTicketCells().slice(10, 15)],
          },
        })
        tab.sink.current!.dispatch({
          type: 'SUBMIT_PRIZE_CLAIM',
          playerId: 'P_STALE',
          ticketId: 'T_STALE',
          prizeId: 'CYBER_FIVE',
        })
      })

      // Claims count nets back to its pre-JOIN_PLAYER value: the optimistic
      // claim entry SUBMIT_PRIZE_CLAIM added was rolled back by the guard,
      // and JOIN_PLAYER itself never adds a claims entry.
      //
      // *** This is the exact fix for the reported incident: the stale
      // playerId is blocked client-side BEFORE any RPC call is made,
      // instead of being sent to submit_claim and rejected server-side
      // with PLAYER_NOT_IN_GAME. ***
      expect(tab.sink.current!.state.claims.length).toBe(claimsBefore)
      expect(client.rpcCalls.length).toBe(rpcCallsBefore)
      expect(client.rpcCalls.some((c) => c.name === 'submit_claim')).toBe(false)

      expect(tab.sink.current!.lastSessionGuardFailure).toEqual({
        prizeId: 'CYBER_FIVE',
        reason: 'PLAYER_NOT_IN_GAME',
      })

      expect(warnSpy).toHaveBeenCalledWith('[session-guard]', {
        ACTIVE_GAME_ID: 'GAME_A',
        CURRENT_PLAYER_ID: 'P_STALE',
        ACTIVE_TICKET_ID: undefined,
        inconsistencyReason: 'PLAYER_NOT_IN_GAME',
      })

      tab.unmount()
    })

    it('TICKET_NOT_FOUND: blocks submission, rolls back the optimistic claim, sets lastSessionGuardFailure, logs diagnostics', async () => {
      const client = mockClient!
      const tab = await mountConsistentSession(client)

      // Remove the ticket row while the player row remains consistent with
      // the Active Game -- no ticket resolves for this player at all.
      act(() => {
        tab.sink.current!.dispatch({ type: 'ROLLBACK_OPTIMISTIC', collection: 'tickets', id: 'T_1' })
      })

      expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
      expect(tab.sink.current!.currentTicket).toBeUndefined()

      const rpcCallsBefore = client.rpcCalls.length
      const claimsBefore = tab.sink.current!.state.claims.length

      act(() => {
        tab.sink.current!.dispatch({
          type: 'SUBMIT_PRIZE_CLAIM',
          playerId: 'P_1',
          ticketId: 'T_1',
          prizeId: 'CYBER_FIVE',
        })
      })

      expect(tab.sink.current!.state.claims.length).toBe(claimsBefore)
      expect(client.rpcCalls.length).toBe(rpcCallsBefore)
      expect(client.rpcCalls.some((c) => c.name === 'submit_claim')).toBe(false)

      expect(tab.sink.current!.lastSessionGuardFailure).toEqual({
        prizeId: 'CYBER_FIVE',
        reason: 'TICKET_NOT_FOUND',
      })

      expect(warnSpy).toHaveBeenCalledWith('[session-guard]', {
        ACTIVE_GAME_ID: 'GAME_A',
        CURRENT_PLAYER_ID: 'P_1',
        ACTIVE_TICKET_ID: undefined,
        inconsistencyReason: 'TICKET_NOT_FOUND',
      })

      // NOTE: TICKET_NOT_OWNED_BY_PLAYER is deliberately not covered as a
      // separate wrappedDispatch guard branch here -- see the file-level
      // comment above and getActivePlayerSession.test.ts (task 9) for why
      // it is unreachable given the resolver's single deterministic
      // `.find()` for activeTicket. Any ticket whose playerId or gameId
      // disagrees with the active player/game simply fails to resolve at
      // all, surfacing as TICKET_NOT_FOUND (already covered above), not
      // TICKET_NOT_OWNED_BY_PLAYER.

      tab.unmount()
    })
  })

  describe('passing branch (behaviorally identical to the pre-fix baseline, task 2)', () => {
    it('consistent session: calls rpcSubmitClaim(action.playerId, action.prizeId), retains the optimistic claim entry, matches the pre-fix payload exactly', async () => {
      const client = mockClient!
      const tab = await mountConsistentSession(client)

      // Reach Cyber Five eligibility exactly like the preservation
      // baseline's cyberFiveOnlyCells (5 cells spread across all 3 rows,
      // never completing a Line_Prize row) -- cells 0,1 (row0), 5,6 (row1),
      // 10 (row2) from buildTicketCells().
      const cyberFiveTermIds = ['TERM_0', 'TERM_1', 'TERM_5', 'TERM_6', 'TERM_10']
      act(() => {
        tab.sink.current!.dispatch({
          type: 'HYDRATE_FROM_REMOTE',
          snapshot: {
            game: { ...tab.sink.current!.state.game, revealedTermIds: cyberFiveTermIds },
            players: tab.sink.current!.state.players,
            tickets: tab.sink.current!.state.tickets,
            marks: tab.sink.current!.state.marks,
            claims: tab.sink.current!.state.claims,
            winners: tab.sink.current!.state.winners,
          },
        })
      })
      for (const termId of cyberFiveTermIds) {
        act(() => {
          tab.sink.current!.dispatch({ type: 'MARK_TERM', termId })
        })
      }

      await waitFor(() => {
        expect(tab.sink.current!.currentPrizeProgress.find((p) => p.id === 'CYBER_FIVE')?.current).toBe(5)
      })

      client.queueRpcResponse('submit_claim', { data: null, error: null })
      const rpcCallsBefore = client.rpcCalls.length
      const claimsBefore = tab.sink.current!.state.claims.length

      act(() => {
        tab.sink.current!.dispatch({
          type: 'SUBMIT_PRIZE_CLAIM',
          playerId: 'P_1',
          ticketId: 'T_1',
          prizeId: 'CYBER_FIVE',
        })
      })

      // Optimistic entry retained immediately (not rolled back synchronously).
      expect(tab.sink.current!.state.claims.length).toBe(claimsBefore + 1)

      await waitFor(() => {
        expect(client.rpcCalls.length).toBeGreaterThan(rpcCallsBefore)
      })

      // Same rpcSubmitClaim(action.playerId, action.prizeId) call as today's
      // (pre-fix) baseline -- byte-for-byte, matching task 2's preservation
      // test assertion exactly.
      const submitCall = client.rpcCalls.find((c) => c.name === 'submit_claim')
      expect(submitCall).toBeDefined()
      expect(submitCall!.args).toEqual({ p_player_id: 'P_1', p_prize_id: 'CYBER_FIVE' })

      // Optimistic claim entry retained (never rolled back) once the RPC
      // resolves successfully, same payload as the pre-fix baseline.
      expect(tab.sink.current!.state.claims.length).toBe(claimsBefore + 1)
      const recordedClaim = tab.sink.current!.state.claims.at(-1)!
      expect(recordedClaim.playerId).toBe('P_1')
      expect(recordedClaim.ticketId).toBe('T_1')
      expect(recordedClaim.ticketRef).toBe('Ticket #6405')
      expect(recordedClaim.playerName).toBe('Divyansh')
      expect(recordedClaim.validationStatus).toBe('VALID')

      // The guard never fired for this consistent session.
      expect(tab.sink.current!.lastSessionGuardFailure).toBeUndefined()
      expect(warnSpy).not.toHaveBeenCalled()

      tab.unmount()
    })
  })
})
