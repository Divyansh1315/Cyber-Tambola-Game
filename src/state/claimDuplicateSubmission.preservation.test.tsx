// Spec: claim-duplicate-submission — task 2 (preservation property tests,
// written BEFORE the fix, per the bugfix workflow).
//
// Property 2: Preservation - Unaffected Submissions and Guards Unchanged
// (design.md Correctness Properties).
//
// For any claim submission where `isBugCondition(X)` does NOT hold (Local
// Fallback with no RPC/echo at all, a consistent single-claim submission
// with no realtime echo configured at all, cross-player isolation, or a
// submission already blocked earlier by the `claim-player-ticket-identity-
// mismatch` consistency guard), the fixed system must produce exactly the
// same result as the original (unfixed) system. This file OBSERVES that
// baseline on the CURRENT (unfixed) code; once the fix (tasks 3-8) lands,
// re-running this exact file (task 12.2) proves none of these scenarios
// were altered by it.
//
// Mock harness, Harness component, and realtimeClient pass-through
// conventions below are copied from
// `claimDuplicateSubmission.exploration.test.tsx` (task 1) /
// `sessionConsistencyGuard.preservation.test.tsx` (prior spec, task 2) for
// consistency.
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import fc from 'fast-check'
import {
  createMockSupabaseClient,
  type MockSupabaseClient,
} from './testSupport/mockSupabaseClient'
import type { TicketCell } from '../types/ticket'
import type { Player } from '../types/player'
import type { Ticket } from '../types/ticket'

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

  return {
    ...actual,
    getSupabaseClient,
    getActiveGame,
    subscribeToGame,
    subscribeToActiveGamePointer,
    submitClaim,
  }
})

import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from './GameSessionContext'

// ---------------------------------------------------------------------------
// Test harness (mirrors claimDuplicateSubmission.exploration.test.tsx's /
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
    status: 'WORD_ACTIVE',
    current_round: 1,
    current_term_id: null,
    previous_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function buildTicketCells(): Record<string, unknown>[] {
  return Array.from({ length: 12 }, (_, i) => ({
    termId: `TERM_${i}`,
    row: Math.floor(i / 4),
    col: i % 4,
  }))
}

/** `TicketCell[][]` builder, mirroring the sibling exploration/preservation tests' own helper. */
function buildTicketRows(): TicketCell[][] {
  const cells: TicketCell[] = Array.from({ length: 12 }, (_, i) => ({
    termId: `TERM_${i}`,
    term: `TERM_${i}`,
    row: Math.floor(i / 4),
    col: i % 4,
    state: 'AVAILABLE' as const,
  }))
  return [cells.slice(0, 4), cells.slice(4, 8), cells.slice(8, 12)]
}

/**
 * Builds a `submit_claim`-shaped server response row, mirroring
 * `claimDuplicateSubmission.exploration.test.tsx`'s own `buildClaimRow`
 * helper. Needed now that `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` case
 * consumes `rpcSubmitClaim`'s resolved value via `.then(... mapRowToClaim
 * ...)` (task 4) -- a `{ data: null }` response is no longer a safe stand-in
 * for "the RPC succeeds" in these preservation baselines, since
 * `mapRowToClaim(null)` would throw and be caught by the existing
 * `.catch(rollback)`, incorrectly rolling back a claim this test asserts
 * should succeed.
 */
function buildClaimRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'SERVER_CLAIM_PRESERVED',
    game_id: 'GAME_A',
    player_id: 'P_A1',
    ticket_id: 'T_A1',
    prize_id: 'CYBER_FIVE',
    submitted_at: '2026-01-01T00:05:00.000Z',
    validation_status: 'VALID',
    host_decision: 'PENDING',
    rejection_reason: null,
    decided_at: null,
    prize_label: 'Cyber Five',
    player_name: 'Divyansh',
    ticket_ref: '6405',
    ...overrides,
  }
}

/**
 * Mounts a provider with a consistent, already-hydrated session for the
 * given player/ticket ids: a joined player with a matching ticket,
 * backend-confirmed snapshot for GAME_A -- satisfying the
 * `claim-player-ticket-identity-mismatch` guard's `isConsistent` check so a
 * dispatched SUBMIT_PRIZE_CLAIM actually reaches `rpcSubmitClaim` rather
 * than being blocked by the guard.
 */
async function mountConsistentSession(
  client: MockSupabaseClient,
  opts: { playerId: string; ticketId: string; displayName: string; ticketRef: string },
) {
  client.queueRpcResponse('get_active_game', { data: [buildGameRow()] })
  const playerRow = {
    id: opts.playerId,
    game_id: 'GAME_A',
    display_name: opts.displayName,
    joined_at: '2026-01-01T00:00:00.000Z',
  }
  const ticketRow = {
    id: opts.ticketId,
    game_id: 'GAME_A',
    player_id: opts.playerId,
    created_at: '2026-01-01T00:00:00.000Z',
    ref: opts.ticketRef,
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
    tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: opts.playerId })
  })

  await waitFor(() => {
    expect(tab.sink.current!.currentPlayer?.id).toBe(opts.playerId)
    expect(tab.sink.current!.currentTicket?.id).toBe(opts.ticketId)
  })

  return tab
}

describe('Preservation: unaffected claim submissions and guards unchanged (unfixed code)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = null
  })

  it('1. Local Fallback claim flow: full join -> mark -> claim -> confirm produces exactly one claim entry', async () => {
    // No mockClient assigned -- getSupabaseClient() returns null, exactly
    // like a dev environment with no VITE_SUPABASE_* env vars configured.
    // wrappedDispatch's local-only branch never calls rpcSubmitClaim and
    // never receives a realtime echo at all -- nothing to duplicate
    // against, by construction (Req 3.7).
    mockClient = null

    const tab = mountProvider()

    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBeTruthy()
    })
    expect(tab.sink.current!.remoteSyncStatus).toBe('not-configured')

    const activeGameId = tab.sink.current!.state.game.id
    const player: Player = {
      id: 'LOCAL_P_1',
      gameId: activeGameId,
      displayName: 'Divyansh',
      ticketId: 'LOCAL_T_1',
      joinedAt: '2026-01-01T00:00:00.000Z',
      name: 'Divyansh',
      ticketRef: 'Ticket #LOC01',
    }
    const ticket: Ticket = {
      id: 'LOCAL_T_1',
      playerId: 'LOCAL_P_1',
      gameId: activeGameId,
      createdAt: '2026-01-01T00:00:00.000Z',
      ref: 'Ticket #LOC01',
      rows: buildTicketRows(),
    }

    // Join.
    act(() => {
      tab.sink.current!.dispatch({ type: 'JOIN_PLAYER', player, ticket })
    })

    await waitFor(() => {
      expect(tab.sink.current!.currentPlayer?.id).toBe('LOCAL_P_1')
    })

    // Reveal the 5 Cyber-Five cells (first cell of each of the 3 rows plus
    // 2 more, spread so no single Line_Prize row is also completed) so
    // marking is permitted and Cyber Five eligibility is reached cleanly.
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

    // Mark.
    for (const termId of cyberFiveTermIds) {
      act(() => {
        tab.sink.current!.dispatch({
          type: 'HYDRATE_FROM_REMOTE',
          snapshot: {
            game: { ...tab.sink.current!.state.game, currentTermId: termId },
            players: tab.sink.current!.state.players,
            tickets: tab.sink.current!.state.tickets,
            marks: tab.sink.current!.state.marks,
            claims: tab.sink.current!.state.claims,
            winners: tab.sink.current!.state.winners,
          },
        })
      })
      act(() => {
        tab.sink.current!.dispatch({ type: 'MARK_TERM', termId })
      })
    }

    await waitFor(() => {
      expect(tab.sink.current!.currentPrizeProgress.find((p) => p.id === 'CYBER_FIVE')?.current).toBe(5)
    })

    const claimsBefore = tab.sink.current!.state.claims.length

    // Claim.
    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'LOCAL_P_1',
        ticketId: 'LOCAL_T_1',
        prizeId: 'CYBER_FIVE',
      })
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.claims.length).toBe(claimsBefore + 1)
    })

    // Exactly one entry -- nothing to duplicate against in this mode.
    expect(tab.sink.current!.state.claims.length).toBe(claimsBefore + 1)
    const recordedClaim = tab.sink.current!.state.claims.at(-1)!
    expect(recordedClaim.playerId).toBe('LOCAL_P_1')
    expect(recordedClaim.ticketId).toBe('LOCAL_T_1')

    // Confirm.
    act(() => {
      tab.sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: recordedClaim.id })
    })

    await waitFor(() => {
      expect(
        tab.sink.current!.state.claims.find((c) => c.id === recordedClaim.id)?.hostDecision,
      ).toBe('CONFIRMED')
    })

    // Still exactly one claim entry for this submission throughout the full
    // join -> mark -> claim -> confirm flow.
    const claimsForPlayer = tab.sink.current!.state.claims.filter(
      (c) => c.playerId === 'LOCAL_P_1' && c.prizeId === 'CYBER_FIVE',
    )
    expect(claimsForPlayer.length).toBe(1)
    expect(tab.sink.current!.state.winners.filter((w) => w.playerId === 'LOCAL_P_1').length).toBe(1)

    tab.unmount()
  })

  it('2. Genuinely consistent single-claim flow with no echo configured produces exactly 1 entry', async () => {
    const client = createMockSupabaseClient()
    mockClient = client

    const tab = await mountConsistentSession(client, {
      playerId: 'P_A1',
      ticketId: 'T_A1',
      displayName: 'Divyansh',
      ticketRef: '6405',
    })

    const claimsBefore = tab.sink.current!.state.claims.length
    const rpcCallsBefore = client.rpcCalls.length

    // Queue a successful submit_claim RPC response, but NEVER fire a
    // realtime echo for it at all in this test -- the baseline being
    // observed here is "no echo at all configured", distinct from task 1's
    // echo-arrives scenarios. The server row's id ('SERVER_CLAIM_PRESERVED')
    // is deliberately distinct from the client-minted optimistic id so
    // reconciliation (task 4's new `.then`) is genuinely exercised here,
    // not accidentally already-matching.
    // Unwrapped single row -- matches `submitClaim`'s real
    // `Promise<ClaimRow>` contract (realtimeClient.ts); the mock
    // `submitClaim` override here resolves to `data` as-is with no array
    // unwrapping, so an array would make `mapRowToClaim` read undefined
    // fields off the array object instead of the row.
    client.queueRpcResponse('submit_claim', {
      data: buildClaimRow({ id: 'SERVER_CLAIM_PRESERVED' }),
    })

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
    })

    await waitFor(() => {
      expect(client.rpcCalls.length).toBeGreaterThan(rpcCallsBefore)
    })

    const submitCall = client.rpcCalls.find((c) => c.name === 'submit_claim')
    expect(submitCall).toBeDefined()
    expect(submitCall!.args).toEqual({ p_player_id: 'P_A1', p_prize_id: 'CYBER_FIVE' })

    // Without an echo, there is nothing to produce a duplicate yet, even on
    // unfixed code -- exactly 1 entry. On fixed code, the RPC's resolution
    // reconciles the optimistic entry in place (still exactly 1 entry),
    // now carrying the server row's id instead of the optimistic one.
    await waitFor(() => {
      expect(tab.sink.current!.state.claims.length).toBe(claimsBefore + 1)
    })
    const recordedClaim = tab.sink.current!.state.claims.at(-1)!
    expect(recordedClaim.playerId).toBe('P_A1')
    expect(recordedClaim.ticketId).toBe('T_A1')
    expect(recordedClaim.ticketRef).toBe('6405')
    expect(recordedClaim.playerName).toBe('Divyansh')

    tab.unmount()
  })

  it('3. Cross-player isolation: two different players\' claims never cross-contaminate', async () => {
    const client = createMockSupabaseClient()
    mockClient = client

    // Seed both players/tickets in the same initial hydration so a single
    // provider instance observes both submitters -- mirrors a single Host
    // tab's shared GAME_A state seeing two different Player tabs' claims
    // land via realtime, without needing two separate provider mounts.
    client.queueRpcResponse('get_active_game', { data: [buildGameRow()] })
    client.queueFromResponse('players', {
      data: [
        { id: 'P_A1', game_id: 'GAME_A', display_name: 'Divyansh', joined_at: '2026-01-01T00:00:00.000Z' },
        { id: 'P_B1', game_id: 'GAME_A', display_name: 'Rohan', joined_at: '2026-01-01T00:00:01.000Z' },
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
          cells: buildTicketCells(),
        },
        {
          id: 'T_B1',
          game_id: 'GAME_A',
          player_id: 'P_B1',
          created_at: '2026-01-01T00:00:01.000Z',
          ref: '7711',
          cells: buildTicketCells(),
        },
      ],
    })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()

    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBe('GAME_A')
      expect(tab.sink.current!.state.players.length).toBe(2)
    })

    const claimsBefore = tab.sink.current!.state.claims.length

    // Player A submits a claim for one prize. The session-consistency
    // guard (prior spec, unmodified by this one) resolves the submitting
    // player against `currentPlayerId` -- restore A's own identity on this
    // (shared) tab first, exactly as A's own device would have it set,
    // satisfying the guard so the claim actually reaches rpcSubmitClaim.
    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_A1' })
    })
    await waitFor(() => {
      expect(tab.sink.current!.currentPlayer?.id).toBe('P_A1')
    })
    // Server row id ('SERVER_CLAIM_A') deliberately distinct from the
    // optimistic id so reconciliation is genuinely exercised, not
    // accidentally already-matching.
    // Unwrapped single row (see note above re: ClaimRow contract).
    client.queueRpcResponse('submit_claim', {
      data: buildClaimRow({
        id: 'SERVER_CLAIM_A',
        player_id: 'P_A1',
        ticket_id: 'T_A1',
        prize_id: 'CYBER_FIVE',
        player_name: 'Divyansh',
        ticket_ref: '6405',
      }),
    })
    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.claims.length).toBe(claimsBefore + 1)
    })

    // Player B submits a claim for a different prize -- restore B's own
    // identity (as B's own device/tab would have it set) before
    // submitting.
    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_B1' })
    })
    await waitFor(() => {
      expect(tab.sink.current!.currentPlayer?.id).toBe('P_B1')
    })
    client.queueRpcResponse('submit_claim', {
      data: buildClaimRow({
        id: 'SERVER_CLAIM_B',
        player_id: 'P_B1',
        ticket_id: 'T_B1',
        prize_id: 'FIREWALL_LINE',
        player_name: 'Rohan',
        ticket_ref: '7711',
        prize_label: 'Firewall Line',
      }),
    })
    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_B1',
        ticketId: 'T_B1',
        prizeId: 'FIREWALL_LINE',
      })
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.claims.length).toBe(claimsBefore + 2)
    })

    const claimA = tab.sink.current!.state.claims.find((c) => c.playerId === 'P_A1')!
    const claimB = tab.sink.current!.state.claims.find((c) => c.playerId === 'P_B1')!

    expect(claimA).toBeDefined()
    expect(claimB).toBeDefined()
    // No cross-contamination: each claim's playerId/ticketId/ticketRef
    // stays tied exclusively to its own submitter.
    expect(claimA.ticketId).toBe('T_A1')
    expect(claimA.ticketRef).toBe('6405')
    expect(claimA.playerName).toBe('Divyansh')
    expect(claimA.prizeId).toBe('CYBER_FIVE')

    expect(claimB.ticketId).toBe('T_B1')
    expect(claimB.ticketRef).toBe('7711')
    expect(claimB.playerName).toBe('Rohan')
    expect(claimB.prizeId).toBe('FIREWALL_LINE')

    expect(claimA.id).not.toBe(claimB.id)
    expect(claimA.ticketId).not.toBe(claimB.ticketId)
    expect(claimA.ticketRef).not.toBe(claimB.ticketRef)

    tab.unmount()
  })

  it('4. Session-guard-blocked submission: rpcSubmitClaim is never called when the guard blocks it', async () => {
    const client = createMockSupabaseClient()
    mockClient = client

    // GAME_A confirmed, with no players/tickets at all -- any attempt to
    // resolve a currentPlayerId against this snapshot leaves
    // activePlayer/activeTicket undefined, matching the prior spec's
    // PLAYER_NOT_FOUND inconsistency path (reused here, unmodified, per
    // design.md's Preservation Requirements: "the claim-player-ticket-
    // identity-mismatch guard ... is read and run exactly as it is today").
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
    client.queueFromResponse('players', { data: [] })
    client.queueFromResponse('tickets', { data: [] })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()

    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBe('GAME_A')
    })
    expect(tab.sink.current!.isBackendConfirmed).toBe(true)
    expect(tab.sink.current!.state.players).toEqual([])

    const claimsBefore = tab.sink.current!.state.claims.length
    const rpcCallsBefore = client.rpcCalls.length

    // Dispatch JOIN_PLAYER and SUBMIT_PRIZE_CLAIM together in the same
    // synchronous batch for a player id that does not exist in `before`'s
    // players array by the time the guard resolves it -- mirroring the
    // prior spec's own exploration/regression test convention for
    // exercising the guard directly, now re-confirmed as a preservation
    // baseline for THIS spec too.
    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_UNKNOWN',
        ticketId: 'T_UNKNOWN',
        prizeId: 'CYBER_FIVE',
      })
    })

    // Give any (incorrect) async RPC call a chance to land before asserting
    // it never does.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    // The guard blocks the submission BEFORE any RPC call is made.
    expect(client.rpcCalls.length).toBe(rpcCallsBefore)
    expect(client.rpcCalls.some((c) => c.name === 'submit_claim')).toBe(false)

    // The optimistic claim entry is rolled back rather than left dangling.
    expect(tab.sink.current!.state.claims.length).toBe(claimsBefore)

    expect(tab.sink.current!.lastSessionGuardFailure).toEqual({
      prizeId: 'CYBER_FIVE',
      reason: 'PLAYER_NOT_FOUND',
    })

    tab.unmount()
  })
})

// ---------------------------------------------------------------------------
// Property-based test: non-bug-condition region exercised directly at the
// reducer level, mirroring sessionConsistencyGuard.preservation.test.tsx's
// own PBT convention. For any consistent (player, ticket, game) tuple with
// no realtime echo folded in, SUBMIT_PRIZE_CLAIM always results in exactly
// one new claims entry, carrying the resolved player/ticket's own fields --
// this is the baseline Property 2 says must never change once the fix
// lands.
// ---------------------------------------------------------------------------

import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState, type GameSessionState } from './gameSessionInitialState'
import type { PrizeId } from '../types/prize'

/** A small closed pool of ids so this property is exercised across several concrete id choices, not just one. */
const idPoolArb = fc.constantFrom('GAME_X', 'GAME_Y', 'GAME_Z')
const prizePoolArb = fc.constantFrom<PrizeId>('CYBER_FIVE', 'FIREWALL_LINE', 'CYBER_FULL_HOUSE')

const consistentSubmissionArb = fc.record({
  activeGameId: idPoolArb,
  prizeId: prizePoolArb,
  displayName: fc.constantFrom('Divyansh', 'Rohan', 'Kavya'),
  ticketRef: fc.stringMatching(/^[0-9]{4}$/),
})

describe('Property 2 (PBT): for every consistent (player, ticket, game) tuple with no echo folded in, SUBMIT_PRIZE_CLAIM results in exactly one new claims entry carrying the resolved player/ticket fields', () => {
  it('matches the observed baseline across many generated consistent tuples', () => {
    fc.assert(
      fc.property(consistentSubmissionArb, ({ activeGameId, prizeId, displayName, ticketRef }) => {
        const player: Player = {
          id: 'PLAYER_X',
          gameId: activeGameId,
          displayName,
          ticketId: 'TICKET_X',
          joinedAt: '2026-01-01T00:00:00.000Z',
          name: displayName,
          ticketRef,
        }
        const ticket: Ticket = {
          id: 'TICKET_X',
          playerId: 'PLAYER_X',
          gameId: activeGameId,
          createdAt: '2026-01-01T00:00:00.000Z',
          ref: ticketRef,
          rows: buildTicketRows(),
        }

        const state: GameSessionState = {
          ...gameSessionInitialState,
          game: { ...gameSessionInitialState.game, id: activeGameId, status: 'WORD_ACTIVE' },
          players: [player],
          tickets: [ticket],
          marks: [],
          claims: [],
          winners: [],
          currentPlayerId: player.id,
        }

        const claimsBefore = state.claims.length

        // No realtime echo/SYNC_REMOTE action is ever dispatched here --
        // this isolates the no-echo baseline at the reducer level, exactly
        // matching scenario 2's integration-level observation above.
        const nextState = gameSessionReducer(state, {
          type: 'SUBMIT_PRIZE_CLAIM',
          playerId: player.id,
          ticketId: ticket.id,
          prizeId,
        })

        // Exactly one new entry, regardless of which consistent tuple was
        // generated.
        expect(nextState.claims.length).toBe(claimsBefore + 1)
        const recordedClaim = nextState.claims.at(-1)!
        expect(recordedClaim.playerId).toBe(player.id)
        expect(recordedClaim.ticketId).toBe(ticket.id)
        expect(recordedClaim.ticketRef).toBe(ticketRef)
        expect(recordedClaim.playerName).toBe(displayName)
        expect(recordedClaim.prizeId).toBe(prizeId)

        // Idempotent-at-this-level sanity: dispatching another
        // SUBMIT_PRIZE_CLAIM from nextState (e.g. a second, independent
        // submission) never disturbs the first claim's own fields --
        // isolation at the reducer level, the same property scenario 3
        // observes at the integration level.
        const afterSecond = gameSessionReducer(nextState, {
          type: 'SUBMIT_PRIZE_CLAIM',
          playerId: player.id,
          ticketId: ticket.id,
          prizeId,
        })
        const firstClaimStillIntact = afterSecond.claims.find((c) => c.id === recordedClaim.id)
        expect(firstClaimStillIntact).toEqual(recordedClaim)
      }),
      { numRuns: 200 },
    )
  })
})
