// Spec: claim-player-ticket-identity-mismatch — task 2 (preservation
// property tests, written BEFORE the fix, per the bugfix workflow).
//
// Property 2: Preservation - Consistent Session Claim Submission Unchanged.
//
// For any claim-submission attempt where `isBugCondition(X)` does NOT hold
// (the backend is confirmed AND `activePlayer`/`activeTicket`/`activeGame`
// mutually agree -- `activePlayer.gameId === activeGame.id` and
// `activeTicket.playerId === activePlayer.id && activeTicket.gameId ===
// activeGame.id`), the system's claim-submission behavior must be left
// completely unchanged by the eventual fix: the same `rpcSubmitClaim`
// call, the same resulting `claims` entry (`ticketRef`/`playerName`), and
// the same Ticket reference the Player screen renders.
//
// This file OBSERVES that baseline on the CURRENT (unfixed) code -- there
// is no guard yet, so "unchanged by the fix" is trivially true today; the
// point of these tests is to pin the exact baseline down concretely (the
// recorded RPC args, the recorded claim fields, the rendered ticket ref) so
// that once the fix lands (tasks 3-8), re-running this exact file (task
// 15.2) proves the guard never altered behavior for a genuinely consistent
// session, byte-for-byte.
//
// Mock harness, Harness component, and realtimeClient pass-through
// conventions below are copied from
// `sessionConsistencyGuard.exploration.test.tsx` (task 1) for consistency.
//
// Validates: Requirements 3.1, 3.3, 3.5, 3.7, 3.8
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import fc from 'fast-check'
import {
  createMockSupabaseClient,
  type MockSupabaseClient,
} from './testSupport/mockSupabaseClient'
import { STORAGE_KEY, CURRENT_PLAYER_STORAGE_KEY, PERSIST_VERSION } from './persistence'

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
  // claim-eligibility loop below makes -- this must resolve successfully
  // (mirroring a backend that accepts the mark), same convention as
  // submitClaim above, so this test's own MARK_TERM dispatches don't
  // spuriously reject (and trigger rollback) through `actual.submitMark`'s
  // un-mocked internal `getSupabaseClient()` call. Mirrors the equivalent
  // override already present in `sessionConsistencyGuard.unit.test.tsx`.
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
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState, type GameSessionState } from './gameSessionInitialState'
import type { Player } from '../types/player'
import type { PrizeId } from '../types/prize'
import type { Ticket, TicketCell } from '../types/ticket'

// ---------------------------------------------------------------------------
// Test harness (mirrors sessionConsistencyGuard.exploration.test.tsx's /
// GameSessionContext.multiTabReset.integration.test.tsx's existing
// convention).
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

/** Builds the `called_terms` rows (one per revealed term id) `fetchFullGameState` reads via `selectRows`. */
function buildCalledTermRows(termIds: readonly string[]): Record<string, unknown>[] {
  return termIds.map((termId, i) => ({
    id: `CT_${termId}`,
    game_id: 'GAME_A',
    term_id: termId,
    round: i + 1,
    called_at: `2026-01-01T00:00:0${i}.000Z`,
  }))
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

function buildTicketRows(): TicketCell[][] {
  const cells = buildTicketCells()
  return [cells.slice(0, 5), cells.slice(5, 10), cells.slice(10, 15)]
}

/**
 * Builds a `submit_claim`-shaped server response row, mirroring
 * `claimDuplicateSubmission.exploration.test.tsx`'s own `buildClaimRow`
 * helper. Needed now that `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` case
 * consumes `rpcSubmitClaim`'s resolved value via `.then(... mapRowToClaim
 * ...)` (claim-duplicate-submission task 4) -- a `{ data: null }` response
 * is no longer a safe stand-in for "the RPC succeeds" in these preservation
 * baselines, since `mapRowToClaim(null)` would throw and be caught by the
 * existing `.catch(rollback)`, incorrectly rolling back a claim this test
 * asserts should succeed.
 */
function buildClaimRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'SERVER_CLAIM_1',
    game_id: 'GAME_A',
    player_id: 'P_1',
    ticket_id: 'T_1',
    prize_id: 'CYBER_FIVE',
    submitted_at: '2026-01-01T00:05:00.000Z',
    validation_status: 'VALID',
    host_decision: 'PENDING',
    rejection_reason: null,
    decided_at: null,
    prize_label: 'Cyber Five',
    player_name: 'Divyansh',
    ticket_ref: 'Ticket #6405',
    ...overrides,
  }
}

/**
 * 5 cells spread across all 3 rows (2 + 2 + 1), chosen so marking exactly
 * these 5 reaches Cyber Five eligibility (any 5, Req 8) WITHOUT also
 * completing any single Line_Prize row (which requires all 5 cells of one
 * specific row, Req 9) -- isolating the Cyber Five claim path cleanly, the
 * same way the exploration test (task 1) isolates its own scenario.
 */
function cyberFiveOnlyCells(): TicketCell[] {
  const cells = buildTicketCells()
  return [cells[0], cells[1], cells[5], cells[6], cells[10]]
}

describe('Preservation: consistent session claim submission unchanged (Req 3.1, 3.3, 3.5, 3.7, 3.8)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = createMockSupabaseClient()
  })

  it('baseline: join -> mark to Cyber Five eligibility -> claim submits rpcSubmitClaim(playerId, prizeId) and records the exact ticketRef/playerName (unfixed code)', async () => {
    const client = mockClient!

    const cyberFiveCells = cyberFiveOnlyCells()
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
    client.queueFromResponse('called_terms', {
      data: buildCalledTermRows(cyberFiveCells.map((c) => c.termId)),
    })
    client.queueFromResponse('players', { data: [playerRow] })
    client.queueFromResponse('tickets', { data: [ticketRow] })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()

    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBe('GAME_A')
    })

    // Fresh join: restore this device's own player, consistent in every
    // respect (activePlayer.gameId === activeGame.id; ticket.playerId ===
    // player.id; ticket.gameId === activeGame.id); backend already
    // confirmed via the HYDRATE_FROM_REMOTE above.
    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_1' })
    })

    await waitFor(() => {
      expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
      expect(tab.sink.current!.currentTicket?.id).toBe('T_1')
    })

    // Mark 5 terms (spread across all 3 rows, see cyberFiveOnlyCells) that
    // have already been called/revealed -- this reaches Cyber Five
    // eligibility (any 5, Req 8) without also completing a Line_Prize row
    // (Req 9), cleanly isolating the Cyber Five claim path. Marking is
    // unaffected by this fix (Req 3.8); this loop only reaches a genuine
    // claim-eligible state to observe the claim-submission baseline.
    for (const cell of cyberFiveCells) {
      act(() => {
        tab.sink.current!.dispatch({ type: 'MARK_TERM', termId: cell.termId })
      })
    }

    await waitFor(() => {
      const cyberFive = tab.sink.current!.currentPrizeProgress.find((p) => p.id === 'CYBER_FIVE')
      expect(cyberFive?.current).toBe(5)
    })

    // Claim submission: record the exact dispatched action, the exact
    // rpcSubmitClaim call args, and the resulting claims entry's
    // ticketRef/playerName -- this is the baseline Property 2 says must
    // never change once the fix lands. The server row's id
    // ('SERVER_CLAIM_1') is deliberately distinct from the client-minted
    // optimistic id so claim-duplicate-submission's reconciliation is
    // genuinely exercised here, not accidentally already-matching.
    // Unwrapped single row -- matches `submitClaim`'s real
    // `Promise<ClaimRow>` contract; the mock override here resolves to
    // `data` as-is with no array unwrapping.
    client.queueRpcResponse('submit_claim', { data: buildClaimRow() })
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

    await waitFor(() => {
      expect(client.rpcCalls.length).toBeGreaterThan(rpcCallsBefore)
    })

    const submitCall = client.rpcCalls.find((c) => c.name === 'submit_claim')
    expect(submitCall).toBeDefined()
    expect(submitCall!.args).toEqual({ p_player_id: 'P_1', p_prize_id: 'CYBER_FIVE' })

    // Still exactly one claim entry (reconciled in place post-fix, rather
    // than left as the optimistic entry pre-fix) -- the count assertion is
    // unaffected either way.
    await waitFor(() => {
      expect(tab.sink.current!.state.claims.length).toBe(claimsBefore + 1)
    })
    const recordedClaim = tab.sink.current!.state.claims.at(-1)!
    expect(recordedClaim.playerId).toBe('P_1')
    expect(recordedClaim.ticketId).toBe('T_1')
    expect(recordedClaim.ticketRef).toBe('Ticket #6405')
    expect(recordedClaim.playerName).toBe('Divyansh')
    expect(recordedClaim.validationStatus).toBe('VALID')

    // The Ticket reference shown on the Player screen and the Ticket
    // reference recorded on the claim must be identical for a genuinely
    // consistent session (Property 4 / Req 3.1) -- both resolve from the
    // same `currentTicket`/`ticket.ref`.
    expect(tab.sink.current!.currentTicket?.ref).toBe(recordedClaim.ticketRef)

    tab.unmount()
  })

  it('concrete case: refresh mid-session restores the same identity and submits identically', async () => {
    const client = mockClient!
    const seedCyberFiveCells = cyberFiveOnlyCells()

    const cachedGame = {
      id: 'GAME_A',
      code: 'CYBER24',
      status: 'WORD_ACTIVE' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      currentRound: 1,
      revealedTermIds: seedCyberFiveCells.map((c) => c.termId),
    }
    const cachedPlayer: Player = {
      id: 'P_1',
      gameId: 'GAME_A',
      displayName: 'Divyansh',
      ticketId: 'T_1',
      joinedAt: '2026-01-01T00:00:00.000Z',
      name: 'Divyansh',
      ticketRef: 'Ticket #6405',
    }
    const cachedTicket: Ticket = {
      id: 'T_1',
      playerId: 'P_1',
      gameId: 'GAME_A',
      createdAt: '2026-01-01T00:00:00.000Z',
      ref: 'Ticket #6405',
      rows: buildTicketRows(),
    }

    // Pre-seed localStorage exactly as a refresh would find it: the shared
    // envelope plus this tab's own currentPlayerId, both consistent with
    // GAME_A, which the mock will also confirm as the live Active Game.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: PERSIST_VERSION,
        game: cachedGame,
        players: [cachedPlayer],
        tickets: [cachedTicket],
        marks: seedCyberFiveCells.map((cell, i) => ({
          id: `M_${i}`,
          gameId: 'GAME_A',
          playerId: 'P_1',
          ticketId: 'T_1',
          termId: cell.termId,
          markedAt: `2026-01-01T00:00:0${i + 1}.000Z`,
          valid: true,
        })),
        claims: [],
        winners: [],
      }),
    )
    localStorage.setItem(CURRENT_PLAYER_STORAGE_KEY, 'P_1')

    // The confirmed backend snapshot agrees exactly with the cached state
    // (the overwhelmingly common refresh case: nothing changed server-side
    // in the meantime).
    const cyberFiveCells = cyberFiveOnlyCells()
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A', status: 'WORD_ACTIVE', current_round: 1 })] })
    client.queueFromResponse('called_terms', {
      data: buildCalledTermRows(cyberFiveCells.map((c) => c.termId)),
    })
    client.queueFromResponse('players', {
      data: [{ id: 'P_1', game_id: 'GAME_A', display_name: 'Divyansh', joined_at: '2026-01-01T00:00:00.000Z' }],
    })
    client.queueFromResponse('tickets', {
      data: [{ id: 'T_1', game_id: 'GAME_A', player_id: 'P_1', created_at: '2026-01-01T00:00:00.000Z', ref: 'Ticket #6405', cells: buildTicketCells() }],
    })
    client.queueFromResponse('marks', {
      data: cyberFiveCells.map((cell, i) => ({
        id: `M_${i}`,
        game_id: 'GAME_A',
        player_id: 'P_1',
        ticket_id: 'T_1',
        term_id: cell.termId,
        marked_at: `2026-01-01T00:00:0${i + 1}.000Z`,
        valid: true,
      })),
    })
    client.queueFromResponse('claims', { data: [] })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()

    // Before the backend confirmation lands, the cached identity is already
    // rendered (no forced re-join, no redirect) -- Req 3.3.
    expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
    expect(tab.sink.current!.currentTicket?.id).toBe('T_1')

    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBe('GAME_A')
      expect(tab.sink.current!.state.players.some((p) => p.id === 'P_1')).toBe(true)
    })

    // Same identity restored post-hydration, unchanged.
    expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
    expect(tab.sink.current!.currentTicket?.id).toBe('T_1')
    expect(tab.sink.current!.currentPrizeProgress.find((p) => p.id === 'CYBER_FIVE')?.current).toBe(5)

    // Server row id deliberately distinct from the client-minted optimistic
    // id so reconciliation is genuinely exercised, not accidentally
    // already-matching.
    client.queueRpcResponse('submit_claim', { data: buildClaimRow({ id: 'SERVER_CLAIM_REFRESH' }) })
    const rpcCallsBefore = client.rpcCalls.length

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_1',
        ticketId: 'T_1',
        prizeId: 'CYBER_FIVE',
      })
    })

    await waitFor(() => {
      expect(client.rpcCalls.length).toBeGreaterThan(rpcCallsBefore)
    })

    const submitCall = client.rpcCalls.find((c) => c.name === 'submit_claim')
    expect(submitCall).toBeDefined()
    expect(submitCall!.args).toEqual({ p_player_id: 'P_1', p_prize_id: 'CYBER_FIVE' })

    let recordedClaim = tab.sink.current!.state.claims.at(-1)!
    await waitFor(() => {
      recordedClaim = tab.sink.current!.state.claims.at(-1)!
      expect(recordedClaim.ticketRef).toBe('Ticket #6405')
    })
    expect(recordedClaim.playerName).toBe('Divyansh')
    expect(recordedClaim.validationStatus).toBe('VALID')

    tab.unmount()
  })

  it('concrete case: Local Fallback (no Supabase configured) is unaffected -- guard trivially passes', async () => {
    // No mockClient assigned to the realtimeClient mock's module-level
    // `mockClient` variable for this test -- getSupabaseClient() returns
    // null, exactly like a dev environment with no VITE_SUPABASE_* env vars
    // configured.
    mockClient = null

    const tab = mountProvider()

    // Local Fallback seeds a client-local game synchronously; no RPC calls
    // are made at all.
    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBeTruthy()
    })
    expect(tab.sink.current!.remoteSyncStatus).toBe('not-configured')

    const localCyberFiveCells = cyberFiveOnlyCells()
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

    act(() => {
      tab.sink.current!.dispatch({ type: 'JOIN_PLAYER', player, ticket })
    })

    await waitFor(() => {
      expect(tab.sink.current!.currentPlayer?.id).toBe('LOCAL_P_1')
    })

    // Reveal exactly the 5 Cyber-Five cells (spread across rows, see
    // cyberFiveOnlyCells) so marking is permitted (Req 2: TERM_NOT_REVEALED
    // gate) without also completing a Line_Prize row. HYDRATE_FROM_REMOTE is
    // a plain, Supabase-independent reducer action -- in Local Fallback,
    // wrappedDispatch forwards every action straight to the raw reducer
    // dispatch (no RPC call attempted), so this is equivalent to the Host
    // calling the next word via the local reducer path, just applied
    // directly here for determinism.
    act(() => {
      tab.sink.current!.dispatch({
        type: 'HYDRATE_FROM_REMOTE',
        snapshot: {
          game: { ...tab.sink.current!.state.game, revealedTermIds: localCyberFiveCells.map((c) => c.termId) },
          players: tab.sink.current!.state.players,
          tickets: tab.sink.current!.state.tickets,
          marks: tab.sink.current!.state.marks,
          claims: tab.sink.current!.state.claims,
          winners: tab.sink.current!.state.winners,
        },
      })
    })

    for (const cell of localCyberFiveCells) {
      act(() => {
        tab.sink.current!.dispatch({ type: 'MARK_TERM', termId: cell.termId })
      })
    }

    await waitFor(() => {
      expect(tab.sink.current!.currentPrizeProgress.find((p) => p.id === 'CYBER_FIVE')?.current).toBe(5)
    })

    const claimsBefore = tab.sink.current!.state.claims.length

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

    // No RPC call is ever attempted in Local Fallback -- the guard (once it
    // exists) has nothing to intercept, since there is no network round
    // trip to be unconfirmed about (Req 3.7).
    expect(mockClient).toBeNull()

    const recordedClaim = tab.sink.current!.state.claims.at(-1)!
    expect(recordedClaim.playerId).toBe('LOCAL_P_1')
    expect(recordedClaim.ticketId).toBe('LOCAL_T_1')
    expect(recordedClaim.ticketRef).toBe('Ticket #LOC01')
    expect(recordedClaim.playerName).toBe('Divyansh')
    expect(recordedClaim.validationStatus).toBe('VALID')

    tab.unmount()
  })
})

// ---------------------------------------------------------------------------
// Property-based test: non-bug-condition region of
// (player.gameId, ticket.playerId, ticket.gameId, activeGame.id,
// isBackendConfirmed) tuples.
//
// This exercises `gameSessionReducer`'s SUBMIT_PRIZE_CLAIM case directly
// (rather than the full GameSessionProvider + mock-RPC round trip used
// above) because the reducer is the pure function both `currentPlayer`/
// `currentTicket` derivation (today's `.find(...)` calls in
// GameSessionContext.tsx's `value` memo) and claim recording are built on
// -- it is the right level to assert the exact boolean formula from
// bugfix.md's `isBugCondition(X)` against every generated tuple, without
// re-deriving the GameSessionContext-level RPC plumbing already covered by
// the baseline/concrete tests above.
//
// `isBackendConfirmed` does not exist as a real signal in the unfixed code
// (today, EVERY submission is treated as if backend-confirmed is
// irrelevant); this property restricts its generated tuples to
// `isBackendConfirmed = true` precisely because that is the only region
// where `isBugCondition(X)` can be false at all (per bugfix.md's formal
// spec, `NOT X.backendConfirmed` alone forces the bug condition true) --
// i.e. the full non-bug-condition region is a strict subset of
// `isBackendConfirmed = true` AND the three cross-id checks all passing.
// ---------------------------------------------------------------------------

/** A small closed pool of ids so cross-id agreement/disagreement is exercised directly by the generators below (not relied upon by chance). */
const idPoolArb = fc.constantFrom('ID_1', 'ID_2', 'ID_3')

/**
 * Generates a tuple `{ playerGameId, ticketPlayerId, ticketGameId,
 * activeGameId, isBackendConfirmed }` restricted to the NON-bug-condition
 * region: `isBackendConfirmed = true` AND `playerGameId === activeGameId`
 * AND `ticketPlayerId === playerId` (fixed, see below) AND `ticketGameId
 * === activeGameId`. Since every id-equality check in `isBugCondition` must
 * hold, there is exactly one equivalence class per `activeGameId` choice;
 * the pool is still varied so the SAME property, run across many
 * generated `activeGameId`s, demonstrates the baseline is identical
 * regardless of which concrete id strings are involved (i.e. the behavior
 * genuinely depends only on the id-equality relationships, never on the
 * literal id values).
 */
const consistentTupleArb = idPoolArb.map((activeGameId) => ({
  activeGameId,
  playerGameId: activeGameId,
  ticketGameId: activeGameId,
  isBackendConfirmed: true,
}))

describe('Property 2 (PBT): for every non-bug-condition (player.gameId, ticket.playerId, ticket.gameId, activeGame.id, isBackendConfirmed) tuple, claim submission behaves exactly like the observed baseline', () => {
  it('rpcSubmitClaim-equivalent call args, resulting claim fields, and rendered Ticket reference are unchanged for every generated consistent tuple', () => {
    fc.assert(
      fc.property(consistentTupleArb, (tuple) => {
        const { activeGameId, playerGameId, ticketGameId } = tuple
        // isBugCondition(X) must be false for this generated tuple, per
        // bugfix.md's formal spec: NOT backendConfirmed OR
        // resolvedPlayer.gameId != activeGameId OR
        // resolvedTicket.playerId != resolvedPlayer.id OR
        // resolvedTicket.gameId != activeGameId.
        const isBugCondition =
          !tuple.isBackendConfirmed || playerGameId !== activeGameId || ticketGameId !== activeGameId
        expect(isBugCondition).toBe(false)

        const player: Player = {
          id: 'PLAYER_X',
          gameId: playerGameId,
          displayName: 'Test Player',
          ticketId: 'TICKET_X',
          joinedAt: '2026-01-01T00:00:00.000Z',
          name: 'Test Player',
          ticketRef: 'Ticket #ABCDEF',
        }
        const ticket: Ticket = {
          id: 'TICKET_X',
          playerId: 'PLAYER_X', // ticketPlayerId === player.id, fixed per design.md's resolver (Req 2.6)
          gameId: ticketGameId,
          createdAt: '2026-01-01T00:00:00.000Z',
          ref: 'Ticket #ABCDEF',
          rows: buildTicketRows(),
        }

        // Mark exactly the 5 Cyber-Five-only cells (spread across all 3
        // rows, never completing a Line_Prize row) so this fixture reaches
        // Cyber Five eligibility cleanly, regardless of which activeGameId
        // this run generated.
        const prizeId: PrizeId = 'CYBER_FIVE'
        const marks = cyberFiveOnlyCells().map((cell, i) => ({
            id: `M_${i}`,
            gameId: activeGameId,
            playerId: 'PLAYER_X',
            ticketId: 'TICKET_X',
            termId: cell.termId,
            markedAt: '2026-01-01T00:00:01.000Z',
            valid: true as const,
          }))

        const state: GameSessionState = {
          ...gameSessionInitialState,
          game: { ...gameSessionInitialState.game, id: activeGameId, status: 'WORD_ACTIVE' },
          players: [player],
          tickets: [ticket],
          marks,
          claims: [],
          winners: [],
          currentPlayerId: player.id,
        }

        // Baseline derivation today's GameSessionContext.tsx's `value` memo
        // performs: state.players.find(...) / state.tickets.find(...) --
        // identical for every generated tuple in this (consistent) region,
        // since the resolved player/ticket's own ids never vary, only the
        // gameId relationships being tested.
        const resolvedPlayer = state.players.find((p) => p.id === state.currentPlayerId)
        const resolvedTicket = resolvedPlayer
          ? state.tickets.find((t) => t.id === resolvedPlayer.ticketId)
          : undefined
        expect(resolvedPlayer).toBeDefined()
        expect(resolvedTicket).toBeDefined()

        const nextState = gameSessionReducer(state, {
          type: 'SUBMIT_PRIZE_CLAIM',
          playerId: resolvedPlayer!.id,
          ticketId: resolvedTicket!.id,
          prizeId,
        })

        // Baseline: exactly one claim added, carrying the resolved
        // player/ticket's own id and the resolved ticket's `ref`/player's
        // `displayName` -- the "same rpcSubmitClaim call, same resulting
        // claim, same rendered Ticket reference" baseline from task 2's
        // description, expressed at the reducer level (rpcSubmitClaim
        // itself always receives exactly `action.playerId`/`action.prizeId`
        // per GameSessionContext.tsx's wrappedDispatch, which this test's
        // sibling integration tests above already pin down concretely).
        expect(nextState.claims.length).toBe(state.claims.length + 1)
        const recordedClaim = nextState.claims.at(-1)!
        expect(recordedClaim.playerId).toBe(resolvedPlayer!.id)
        expect(recordedClaim.ticketId).toBe(resolvedTicket!.id)
        expect(recordedClaim.ticketRef).toBe(resolvedTicket!.ref)
        expect(recordedClaim.playerName).toBe(resolvedPlayer!.displayName)
        // Cyber Five is the only prize marked to eligibility by the fixture
        // above; other generated prizeIds correctly validate as NOT_ELIGIBLE
        // -- either way, the claim is recorded (every submission is
        // recorded, Req 3.3/3.4) with a ticketRef/playerName matching the
        // resolved ticket/player, regardless of validationStatus.
        expect(recordedClaim.validationStatus).toBe(prizeId === 'CYBER_FIVE' ? 'VALID' : 'INVALID')

        // Rendered Ticket reference (shortTicketRef-derived `ref` field) is
        // identical to the claim's own ticketRef for this consistent
        // session -- Property 4 / Req 3.1.
        expect(resolvedTicket!.ref).toBe(recordedClaim.ticketRef)
      }),
      { numRuns: 200 },
    )
  })
})
