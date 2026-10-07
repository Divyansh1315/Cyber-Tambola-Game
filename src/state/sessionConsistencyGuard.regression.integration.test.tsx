// Spec: claim-player-ticket-identity-mismatch — task 13 (regression tests for
// each required preserved/fixed scenario).
//
// This file is the end-to-end regression suite proving the fix holds across
// every scenario design.md/bugfix.md call out as required, as 6 named test
// cases:
//   1. Exact ticket match (consistent session)              -- Property 4
//   2. Reset/rejoin uses new ticket only                     -- Property 3; Req 3.2
//   3. Refresh preserves same identity                       -- Req 3.3
//   4. Duplicate name, different devices, never merges        -- Req 3.4
//   5. Genuinely stale player from a different game is // not-a-ticket-dimension
//      still rejected server-side (client blocks first)      -- Req 3.5
//   6. Ticket reference consistency across surfaces           -- Req 2.8, 3.1, 3.6
//
// Mock harness, Harness component, and realtimeClient pass-through
// conventions below are copied from `sessionConsistencyGuard.exploration
// .test.tsx` (task 1), `sessionConsistencyGuard.preservation.test.tsx`
// (task 2), `sessionConsistencyGuard.unit.test.tsx` (task 10), and
// `GameSessionContext.multiTabReset.integration.test.tsx` for consistency.
//
// Validates: Requirements 1.5, 2.2, 2.5, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import {
  createMockSupabaseClient,
  type MockSupabaseClient,
} from './testSupport/mockSupabaseClient'
import { shortTicketRef } from './joinService'
import { validatePrizeClaim } from '../utils/claimEngine'
import { toClaimInboxRowViewModel } from '../pages/HostDashboard/HostDashboard'
import { toWinnerHistoryViewModel } from '../pages/HostDashboard/hostWinnerHistoryViewModel'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'

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

  // Matches the real `joinGame`'s positional signature (realtimeClient.ts) --
  // `GameSessionContext.tsx`'s own `joinGame()` calls `rpcJoinGame(gameCode,
  // displayName, deviceJoinToken, activeTermIds)` positionally, so an
  // override taking a single `args` object would silently receive
  // `undefined` for every field.
  async function joinGame(
    gameCode: string,
    displayName: string,
    deviceJoinToken: string,
    activeTermIds: string[],
  ) {
    const supabase = getSupabaseClient()
    if (!supabase) throw new Error('no mock client configured')
    const { data, error } = await supabase.rpc('join_game', {
      p_game_code: gameCode,
      p_display_name: displayName,
      p_device_join_token: deviceJoinToken,
      p_active_term_ids: activeTermIds,
    })
    if (error) throw new actual.RpcError(error.code ?? 'UNKNOWN', error.message)
    const rows = (data as unknown[] | null) ?? []
    const row = rows[0] as { player_id: string; ticket_id: string } | undefined
    if (!row) throw new Error('join_game returned no row')
    return row
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
  // eligibility loop below makes -- this must resolve successfully
  // (mirroring a backend that accepts the mark), same convention as
  // submitClaim above, so this test's own MARK_TERM dispatches don't
  // spuriously reject (and trigger rollback) through `actual.submitMark`'s
  // un-mocked internal `getSupabaseClient()` call (discovered in task 10).
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

  async function confirmClaim(claimId: string, hostSecret: string) {
    const supabase = getSupabaseClient()
    if (!supabase) throw new Error('no mock client configured')
    const { data, error } = await supabase.rpc('confirm_claim', {
      p_claim_id: claimId,
      p_host_secret: hostSecret,
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
    joinGame,
    submitClaim,
    submitMark,
    confirmClaim,
  }
})

import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from './GameSessionContext'

// ---------------------------------------------------------------------------
// Test harness (mirrors the exploration/preservation/unit test files' existing
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

function buildTicketCells(): TicketCell[] {
  return Array.from({ length: 12 }, (_, i) => ({
    termId: `TERM_${i}`,
    term: `Term ${i}`,
    row: Math.floor(i / 4),
    col: i % 4,
    state: 'AVAILABLE' as const,
  }))
}

/**
 * 5 cells spread across all 3 rows (2 + 2 + 1), chosen so marking exactly // not-a-ticket-dimension
 * these 5 reaches Cyber Five eligibility (any 5) WITHOUT also completing any
 * single Line_Prize row -- same convention as the preservation test's
 * `cyberFiveOnlyCells`.
 */
function cyberFiveOnlyCells(): TicketCell[] {
  const cells = buildTicketCells()
  return [cells[0], cells[1], cells[5], cells[6], cells[10]]
}

/**
 * Builds a `submit_claim`-shaped server response row, mirroring
 * `claimDuplicateSubmission.exploration.test.tsx`'s own `buildClaimRow`
 * helper. Needed now that `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` case
 * consumes `rpcSubmitClaim`'s resolved value via `.then(... mapRowToClaim
 * ...)` (claim-duplicate-submission task 4) -- a `{ data: null }` response
 * is no longer a safe stand-in for "the RPC succeeds" in these regression
 * scenarios, since `mapRowToClaim(null)` would throw and be caught by the
 * existing `.catch(rollback)`, incorrectly rolling back a claim these
 * scenarios assert should succeed.
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

describe('Regression: required preserved/fixed scenarios (Req 1.5, 2.2, 2.5, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = createMockSupabaseClient()
  })

  // -------------------------------------------------------------------------
  // 1. Exact ticket match (consistent session) -- Property 4
  // -------------------------------------------------------------------------
  it('1. exact ticket match (consistent session): Player screen ref, submitted claim ref, and Winner History ref are identical', async () => {
    const client = mockClient!
    const cyberFiveCells = cyberFiveOnlyCells()

    const cyberFiveTermIds = cyberFiveCells.map((c) => c.termId)
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A', status: 'WORD_ACTIVE', current_round: cyberFiveTermIds.length })] })
    client.queueFromResponse('called_terms', {
      data: cyberFiveTermIds.map((termId, i) => ({
        id: `CT_${termId}`,
        game_id: 'GAME_A',
        term_id: termId,
        round: i + 1,
        called_at: `2026-01-01T00:00:0${i}.000Z`,
      })),
    })
    client.queueFromResponse('players', {
      data: [{ id: 'P_1', game_id: 'GAME_A', display_name: 'Divyansh', joined_at: '2026-01-01T00:00:00.000Z' }],
    })
    client.queueFromResponse('tickets', {
      data: [
        {
          id: 'T_1',
          game_id: 'GAME_A',
          player_id: 'P_1',
          created_at: '2026-01-01T00:00:00.000Z',
          ref: shortTicketRef('T_1'),
          cells: buildTicketCells(),
        },
      ],
    })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()
    await waitFor(() => expect(tab.sink.current!.state.game.id).toBe('GAME_A'))

    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_1' })
    })
    await waitFor(() => {
      expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
      expect(tab.sink.current!.currentTicket?.id).toBe('T_1')
    })

    // Player screen's rendered reference, derived exactly how PlayerGame.tsx
    // would (shortTicketRef(currentTicket.id)).
    const playerScreenRef = shortTicketRef(tab.sink.current!.currentTicket!.id)
    expect(playerScreenRef).toBe(tab.sink.current!.currentTicket!.ref)

    // Mark to Cyber Five eligibility.
    for (const cell of cyberFiveCells) {
      act(() => {
        tab.sink.current!.dispatch({
          type: 'HYDRATE_FROM_REMOTE',
          snapshot: {
            game: { ...tab.sink.current!.state.game, currentTermId: cell.termId },
            players: tab.sink.current!.state.players,
            tickets: tab.sink.current!.state.tickets,
            marks: tab.sink.current!.state.marks,
            claims: tab.sink.current!.state.claims,
            winners: tab.sink.current!.state.winners,
          },
        })
      })
      act(() => {
        tab.sink.current!.dispatch({ type: 'MARK_TERM', termId: cell.termId })
      })
    }
    await waitFor(() => {
      expect(tab.sink.current!.currentPrizeProgress.find((p) => p.id === 'CYBER_FIVE')?.current).toBe(5)
    })

    // Server row id ('SERVER_CLAIM_1') deliberately distinct from the
    // client-minted optimistic id so claim-duplicate-submission's
    // reconciliation is genuinely exercised; ticket_ref matches
    // playerScreenRef so this scenario's own "same ref everywhere"
    // assertion continues to hold once the entry is reconciled.
    // Unwrapped single row -- matches `submitClaim`'s real
    // `Promise<ClaimRow>` contract; the mock override here resolves to
    // `data` as-is with no array unwrapping.
    client.queueRpcResponse('submit_claim', { data: buildClaimRow({ ticket_ref: playerScreenRef }) })
    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_1',
        ticketId: 'T_1',
        prizeId: 'CYBER_FIVE',
      })
    })
    await waitFor(() => {
      expect(client.rpcCalls.some((c) => c.name === 'submit_claim')).toBe(true)
    })

    let submittedClaim = tab.sink.current!.state.claims.at(-1)!
    await waitFor(() => {
      submittedClaim = tab.sink.current!.state.claims.at(-1)!
      expect(submittedClaim.ticketRef).toBe(playerScreenRef)
    })

    // Host confirms the claim -> a Winner History entry is produced.
    act(() => {
      tab.sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: submittedClaim.id })
    })
    const confirmedWinner = tab.sink.current!.state.winners.at(-1)!

    // Player screen ref, submitted claim ref, and Winner History ref are
    // identical (Property 4).
    expect(playerScreenRef).toBe(submittedClaim.ticketRef)
    expect(submittedClaim.ticketRef).toBe(confirmedWinner.ticketRef)
    expect(confirmedWinner.ticketRef).toBe(playerScreenRef)

    tab.unmount()
  })

  // -------------------------------------------------------------------------
  // 2. Reset/rejoin uses new ticket only -- Property 3; Req 3.2
  // -------------------------------------------------------------------------
  it('2. reset/rejoin: stale currentPlayerId is cleared once backend confirms the new Active Game, Player screen redirects, rejoin issues a brand-new ticket', async () => {
    const client = mockClient!

    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
    client.queueFromResponse('players', {
      data: [{ id: 'P_1', game_id: 'GAME_A', display_name: 'Divyansh', joined_at: '2026-01-01T00:00:00.000Z' }],
    })
    client.queueFromResponse('tickets', {
      data: [
        {
          id: 'T_1',
          game_id: 'GAME_A',
          player_id: 'P_1',
          created_at: '2026-01-01T00:00:00.000Z',
          ref: 'Ticket #6405',
          cells: buildTicketCells(),
        },
      ],
    })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()
    await waitFor(() => expect(tab.sink.current!.state.game.id).toBe('GAME_A'))

    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_1' })
    })
    await waitFor(() => {
      expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
      expect(tab.sink.current!.currentTicket?.id).toBe('T_1')
    })

    // --- Host triggers Reset: Game A retired, Game B becomes Active ---
    const newGameRow = buildGameRow({ id: 'GAME_B', code: 'NEWG01', host_secret: 'secret-b' })
    client.queueRpcResponse('reset_game_to_new', {
      data: [{ old_game_id: 'GAME_A', new_game: newGameRow }],
    })
    await act(async () => {
      await client.rpc('reset_game_to_new', { p_old_game_id: 'GAME_A', p_host_secret: 'secret-a' })
    })

    // This tab's pointer-follow effect re-resolves via getActiveGame() --
    // Game B genuinely has no players/tickets yet. This tab's own
    // currentPlayerId ('P_1') deliberately survives Reset (by design, Req
    // 3.2's "reset leaves active tabs' local id untouched" semantics) --
    // the fix is that it gets invalidated once the backend confirms P_1 is
    // not part of the new Active Game, not that Reset itself clears it.
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

    // *** Property 3: fixed behavior ***
    // Once isBackendConfirmed flips back to true for GAME_B, the
    // stale-identity invalidation effect (task 7.2) clears currentPlayerId
    // because P_1 no longer resolves to a player in GAME_B at all.
    await waitFor(() => {
      expect(tab.sink.current!.isBackendConfirmed).toBe(true)
      expect(tab.sink.current!.state.currentPlayerId).toBeUndefined()
    })
    expect(tab.sink.current!.currentPlayer).toBeUndefined()
    expect(tab.sink.current!.currentTicket).toBeUndefined()

    // This is exactly the input PlayerGame.tsx's existing `!currentPlayer ||
    // !currentTicket` redirect-to-join guard fires on, unchanged (Req 3.2).

    // --- Rejoin issues a brand-new ticket, never reusing the retired one ---
    client.queueRpcResponse('join_game', {
      data: [{ player_id: 'P_2', ticket_id: 'T_2' }],
    })
    // The real `joinGame()` (GameSessionContext.tsx) follows the RPC with
    // its own `.from('players')...`/`.from('tickets')...` reads of the
    // just-joined player/ticket rows, to dispatch JOIN_PLAYER immediately
    // rather than waiting on a separate SYNC_REMOTE/HYDRATE round trip.
    client.queueFromResponse('players', {
      data: [{ id: 'P_2', game_id: 'GAME_B', display_name: 'Divyansh', joined_at: '2026-01-02T00:00:00.000Z' }],
    })
    client.queueFromResponse('tickets', {
      data: [{ id: 'T_2', game_id: 'GAME_B', player_id: 'P_2', created_at: '2026-01-02T00:00:00.000Z', ref: shortTicketRef('T_2'), cells: buildTicketCells() }],
    })
    let joinResult: { playerId: string; ticketId: string } | undefined
    await act(async () => {
      joinResult = await tab.sink.current!.joinGame({
        gameCode: 'NEWG01',
        displayName: 'Divyansh',
        deviceJoinToken: 'device-token-1',
      })
    })

    expect(joinResult).toEqual({ playerId: 'P_2', ticketId: 'T_2' })
    // The new ticket id is never the retired T_1.
    expect(joinResult!.ticketId).not.toBe('T_1')
    expect(joinResult!.playerId).not.toBe('P_1')

    tab.unmount()
  })

  // -------------------------------------------------------------------------
  // 3. Refresh preserves same identity -- Req 3.3
  // -------------------------------------------------------------------------
  it('3. refresh mid-session: currentPlayerId restores from localStorage, guard passes trivially once confirmed, no redirect, claim behaves exactly as pre-refresh', async () => {
    const client = mockClient!
    const cyberFiveCells = cyberFiveOnlyCells()

    const cachedGame = {
      id: 'GAME_A',
      code: 'CYBER24',
      status: 'WORD_ACTIVE' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      currentRound: 1,
      revealedTermIds: cyberFiveCells.map((c) => c.termId),
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
      rows: [buildTicketCells().slice(0, 4), buildTicketCells().slice(4, 8), buildTicketCells().slice(8, 12)],
    }

    const { STORAGE_KEY, CURRENT_PLAYER_STORAGE_KEY, PERSIST_VERSION } = await import('./persistence')
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: PERSIST_VERSION,
        game: cachedGame,
        players: [cachedPlayer],
        tickets: [cachedTicket],
        marks: cyberFiveCells.map((cell, i) => ({
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

    // The confirmed backend snapshot agrees exactly with the cached state --
    // the overwhelmingly common refresh case (nothing changed server-side).
    client.queueRpcResponse('get_active_game', {
      data: [buildGameRow({ id: 'GAME_A', status: 'WORD_ACTIVE', current_round: 1 })],
    })
    client.queueFromResponse('called_terms', {
      data: cyberFiveCells.map((cell, i) => ({
        id: `CT_${cell.termId}`,
        game_id: 'GAME_A',
        term_id: cell.termId,
        round: i + 1,
        called_at: `2026-01-01T00:00:0${i}.000Z`,
      })),
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

    // Before backend confirmation lands, the cached identity is already
    // rendered -- no forced re-join, no redirect (Req 3.3).
    expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
    expect(tab.sink.current!.currentTicket?.id).toBe('T_1')

    await waitFor(() => {
      expect(tab.sink.current!.isBackendConfirmed).toBe(true)
      expect(tab.sink.current!.state.players.some((p) => p.id === 'P_1')).toBe(true)
    })

    // Same identity restored post-confirmation, unchanged -- guard's checks
    // pass trivially, no redirect, no guard failure.
    expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
    expect(tab.sink.current!.currentTicket?.id).toBe('T_1')
    expect(tab.sink.current!.lastSessionGuardFailure).toBeUndefined()
    expect(tab.sink.current!.currentPrizeProgress.find((p) => p.id === 'CYBER_FIVE')?.current).toBe(5)

    // Claim submission behaves exactly as pre-refresh: same RPC call shape,
    // same resulting claim. Server row id ('SERVER_CLAIM_REFRESH')
    // deliberately distinct from the client-minted optimistic id so
    // reconciliation is genuinely exercised, not accidentally
    // already-matching.
    client.queueRpcResponse('submit_claim', { data: buildClaimRow({ id: 'SERVER_CLAIM_REFRESH' }) })
    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_1',
        ticketId: 'T_1',
        prizeId: 'CYBER_FIVE',
      })
    })

    await waitFor(() => {
      expect(client.rpcCalls.some((c) => c.name === 'submit_claim')).toBe(true)
    })
    const submitCall = client.rpcCalls.find((c) => c.name === 'submit_claim')!
    expect(submitCall.args).toEqual({ p_player_id: 'P_1', p_prize_id: 'CYBER_FIVE' })
    expect(tab.sink.current!.lastSessionGuardFailure).toBeUndefined()

    let recordedClaim = tab.sink.current!.state.claims.at(-1)!
    await waitFor(() => {
      recordedClaim = tab.sink.current!.state.claims.at(-1)!
      expect(recordedClaim.ticketRef).toBe('Ticket #6405')
    })
    expect(recordedClaim.validationStatus).toBe('VALID')

    tab.unmount()
  })

  // -------------------------------------------------------------------------
  // 4. Duplicate name, different devices, never merges sessions -- Req 3.4
  // -------------------------------------------------------------------------
  it('4. duplicate display name on two devices: each gets a distinct playerId/ticketId; getActivePlayerSession resolves independently and never crosses over', async () => {
    const client = mockClient!

    // Both devices' providers resolve the SAME Active Game on mount.
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
    for (let i = 0; i < 2; i += 1) {
      client.queueFromResponse('players', { data: [] })
      client.queueFromResponse('tickets', { data: [] })
      client.queueFromResponse('winners', { data: [] })
    }

    const deviceOne = mountProvider()
    const deviceTwo = mountProvider()

    await waitFor(() => {
      expect(deviceOne.sink.current!.state.game.id).toBe('GAME_A')
      expect(deviceTwo.sink.current!.state.game.id).toBe('GAME_A')
    })

    // Device 1 joins with displayName "Divyansh", via its own distinct
    // device join token -- resolved via join_game to a distinct playerId/
    // ticketId.
    client.queueRpcResponse('join_game', { data: [{ player_id: 'P_D1', ticket_id: 'T_D1' }] })
    // The real `joinGame()` (GameSessionContext.tsx) follows the RPC with
    // its own `.from('players')...`/`.from('tickets')...` reads of the
    // just-joined player/ticket rows.
    client.queueFromResponse('players', {
      data: [{ id: 'P_D1', game_id: 'GAME_A', display_name: 'Divyansh', joined_at: '2026-01-01T00:00:00.000Z' }],
    })
    client.queueFromResponse('tickets', {
      data: [{ id: 'T_D1', game_id: 'GAME_A', player_id: 'P_D1', created_at: '2026-01-01T00:00:00.000Z', ref: shortTicketRef('T_D1'), cells: buildTicketCells() }],
    })
    let joinOne: { playerId: string; ticketId: string } | undefined
    await act(async () => {
      joinOne = await deviceOne.sink.current!.joinGame({
        gameCode: 'CYBER24',
        displayName: 'Divyansh',
        deviceJoinToken: 'device-token-ONE',
      })
    })
    expect(joinOne).toEqual({ playerId: 'P_D1', ticketId: 'T_D1' })
    act(() => {
      deviceOne.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_D1' })
    })

    // Device 2 joins with the SAME displayName "Divyansh", via a DIFFERENT
    // device join token -- resolved to a DIFFERENT playerId/ticketId
    // (duplicate names never merge; matched only via the opaque per-device
    // token, never via displayName, Req 3.4).
    client.queueRpcResponse('join_game', { data: [{ player_id: 'P_D2', ticket_id: 'T_D2' }] })
    client.queueFromResponse('players', {
      data: [{ id: 'P_D2', game_id: 'GAME_A', display_name: 'Divyansh', joined_at: '2026-01-01T00:00:01.000Z' }],
    })
    client.queueFromResponse('tickets', {
      data: [{ id: 'T_D2', game_id: 'GAME_A', player_id: 'P_D2', created_at: '2026-01-01T00:00:01.000Z', ref: shortTicketRef('T_D2'), cells: buildTicketCells() }],
    })
    let joinTwo: { playerId: string; ticketId: string } | undefined
    await act(async () => {
      joinTwo = await deviceTwo.sink.current!.joinGame({
        gameCode: 'CYBER24',
        displayName: 'Divyansh',
        deviceJoinToken: 'device-token-TWO',
      })
    })
    expect(joinTwo).toEqual({ playerId: 'P_D2', ticketId: 'T_D2' })
    act(() => {
      deviceTwo.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_D2' })
    })

    expect(joinOne!.playerId).not.toBe(joinTwo!.playerId)
    expect(joinOne!.ticketId).not.toBe(joinTwo!.ticketId)

    // Each device's own HYDRATE_FROM_REMOTE/SYNC_REMOTE eventually catches
    // up with both players/tickets rows (both devices see the full shared
    // roster, mirroring realtime fan-out) -- simulate that here by directly
    // seeding both players/tickets into each device's own state via
    // JOIN_PLAYER-equivalent rows, consistent with how SYNC_REMOTE would
    // fold in the other device's row.
    const playerOne: Player = {
      id: 'P_D1',
      gameId: 'GAME_A',
      displayName: 'Divyansh',
      ticketId: 'T_D1',
      joinedAt: '2026-01-01T00:00:00.000Z',
      name: 'Divyansh',
      ticketRef: shortTicketRef('T_D1'),
    }
    const ticketOne: Ticket = {
      id: 'T_D1',
      playerId: 'P_D1',
      gameId: 'GAME_A',
      createdAt: '2026-01-01T00:00:00.000Z',
      ref: shortTicketRef('T_D1'),
      rows: [buildTicketCells().slice(0, 4), buildTicketCells().slice(4, 8), buildTicketCells().slice(8, 12)],
    }
    const playerTwo: Player = {
      id: 'P_D2',
      gameId: 'GAME_A',
      displayName: 'Divyansh',
      ticketId: 'T_D2',
      joinedAt: '2026-01-01T00:00:01.000Z',
      name: 'Divyansh',
      ticketRef: shortTicketRef('T_D2'),
    }
    const ticketTwo: Ticket = {
      id: 'T_D2',
      playerId: 'P_D2',
      gameId: 'GAME_A',
      createdAt: '2026-01-01T00:00:01.000Z',
      ref: shortTicketRef('T_D2'),
      rows: [buildTicketCells().slice(0, 4), buildTicketCells().slice(4, 8), buildTicketCells().slice(8, 12)],
    }

    act(() => {
      deviceOne.sink.current!.dispatch({
        type: 'HYDRATE_FROM_REMOTE',
        snapshot: {
          game: deviceOne.sink.current!.state.game,
          players: [playerOne, playerTwo],
          tickets: [ticketOne, ticketTwo],
          marks: [],
          claims: [],
          winners: [],
        },
      })
      deviceOne.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_D1' })
    })
    act(() => {
      deviceTwo.sink.current!.dispatch({
        type: 'HYDRATE_FROM_REMOTE',
        snapshot: {
          game: deviceTwo.sink.current!.state.game,
          players: [playerOne, playerTwo],
          tickets: [ticketOne, ticketTwo],
          marks: [],
          claims: [],
          winners: [],
        },
      })
      deviceTwo.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_D2' })
    })

    // Even though BOTH devices now hold the full roster (both players/
    // tickets present in state, same displayName "Divyansh" on both), each
    // device's own getActivePlayerSession()/currentPlayer/currentTicket
    // resolves to its OWN player/ticket, never the other device's.
    expect(deviceOne.sink.current!.currentPlayer?.id).toBe('P_D1')
    expect(deviceOne.sink.current!.currentTicket?.id).toBe('T_D1')
    expect(deviceOne.sink.current!.currentPlayer?.id).not.toBe('P_D2')
    expect(deviceOne.sink.current!.currentTicket?.id).not.toBe('T_D2')

    expect(deviceTwo.sink.current!.currentPlayer?.id).toBe('P_D2')
    expect(deviceTwo.sink.current!.currentTicket?.id).toBe('T_D2')
    expect(deviceTwo.sink.current!.currentPlayer?.id).not.toBe('P_D1')
    expect(deviceTwo.sink.current!.currentTicket?.id).not.toBe('T_D1')

    // Both display the same displayName -- the names are allowed to collide,
    // only the underlying ids never do.
    expect(deviceOne.sink.current!.currentPlayer?.displayName).toBe('Divyansh')
    expect(deviceTwo.sink.current!.currentPlayer?.displayName).toBe('Divyansh')

    deviceOne.unmount()
    deviceTwo.unmount()
  })

  // -------------------------------------------------------------------------
  // 5. Genuinely stale player from a different game still rejected // not-a-ticket-dimension
  //    server-side -- Req 3.5
  // -------------------------------------------------------------------------
  it('5. a playerId whose gameId belongs to a different (non-Active) game is blocked client-side BEFORE any RPC call; submit_claim remains an intact backstop', async () => {
    const client = mockClient!

    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_ACTIVE' })] })
    client.queueFromResponse('players', { data: [] })
    client.queueFromResponse('tickets', { data: [] })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()
    await waitFor(() => {
      expect(tab.sink.current!.state.game.id).toBe('GAME_ACTIVE')
      expect(tab.sink.current!.isBackendConfirmed).toBe(true)
    })

    // Construct a playerId whose gameId genuinely belongs to a different,
    // non-Active game -- GAME_RETIRED, not GAME_ACTIVE. This is folded
    // directly into state (equivalent to a stale localStorage envelope
    // leftover from before a Reset -- the exact reported incident shape),
    // and currentPlayerId is pointed at it in the SAME act() as the claim
    // dispatch below, so the pre-submission guard observes it before the
    // separate stale-identity invalidation effect (task 7.2, covered by
    // task 11) has a chance to clear it first -- this test is scoped to
    // proving the GUARD blocks it, independent of that other effect.
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
          rows: [buildTicketCells().slice(0, 4), buildTicketCells().slice(4, 8), buildTicketCells().slice(8, 12)],
        },
      })
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_STALE',
        ticketId: 'T_STALE',
        prizeId: 'CYBER_FIVE',
      })
    })

    // *** Client-side guard blocks it BEFORE any RPC call is made. ***
    // No submit_claim call was ever issued -- rpcCalls count is completely
    // unchanged (not just "no submit_claim entry," but no RPC call AT ALL
    // was attempted for this dispatch).
    expect(client.rpcCalls.length).toBe(rpcCallsBefore)
    expect(client.rpcCalls.some((c) => c.name === 'submit_claim')).toBe(false)

    // The optimistic claim entry was rolled back -- never left dangling.
    expect(tab.sink.current!.state.claims.length).toBe(claimsBefore)

    // The guard's recovery-message state is set with the correct reason.
    expect(tab.sink.current!.lastSessionGuardFailure).toEqual({
      prizeId: 'CYBER_FIVE',
      reason: 'PLAYER_NOT_IN_GAME',
    })

    // -----------------------------------------------------------------
    // Separately: confirm `submit_claim`'s existing (UNCHANGED) SQL
    // validation gate order still independently rejects this exact
    // playerId/gameId mismatch with PLAYER_NOT_IN_GAME, proving the
    // server-side backstop remains intact and was not weakened by this
    // fix. This suite does not spin up or require a live Postgres
    // instance (consistent with `supabase/migrations/*.integration
    // .test.ts`'s existing skip-when-no-SUPABASE_TEST_DB_URL pattern) --
    // instead this exercises the EXACT SAME client-side validation
    // function (`validatePrizeClaim` from `src/utils/claimEngine.ts`)
    // the SQL `submit_claim` function's gate order mirrors (per that
    // file's own doc comment: "mirrors claimEngine.ts's existing gate
    // vocabulary, reused for consistency, not re-invented"), confirming
    // that if this stale playerId/gameId pair were ever submitted
    // anyway (bypassing the client guard entirely), gate #3
    // (PLAYER_NOT_IN_GAME) still independently fires. The SQL
    // structure/behavior itself is covered by
    // `supabase/migrations/*.structure.test.ts` and is NOT modified,
    // duplicated, or weakened by this spec (design.md Fix Implementation
    // point 10 -- "No changes" to claimEngine.ts or any submit_claim gate).
    // -----------------------------------------------------------------
    const serverSideResult = validatePrizeClaim({
      game: { id: 'GAME_ACTIVE', code: 'CYBER24', status: 'WORD_ACTIVE', createdAt: '2026-01-01T00:00:00.000Z', currentRound: 1, revealedTermIds: [] },
      player: { id: 'P_STALE', gameId: 'GAME_RETIRED', displayName: 'Divyansh', ticketId: 'T_STALE', joinedAt: '2026-01-01T00:00:00.000Z', name: 'Divyansh', ticketRef: 'Ticket #6405' },
      ticket: { id: 'T_STALE', playerId: 'P_STALE', gameId: 'GAME_RETIRED', createdAt: '2026-01-01T00:00:00.000Z', ref: 'Ticket #6405', rows: [] },
      marks: [],
      prizeId: 'CYBER_FIVE',
      winners: [],
      existingClaims: [],
    })
    expect(serverSideResult).toEqual({ valid: false, reason: 'PLAYER_NOT_IN_GAME' })

    tab.unmount()
  })

  // -------------------------------------------------------------------------
  // 6. Ticket reference consistency across surfaces -- Req 2.8, 3.1, 3.6
  // -------------------------------------------------------------------------
  it('6. for a single confirmed claim, Ticket reference is identical across Player screen, Host Claim Inbox row, and Winner History entry', async () => {
    const client = mockClient!
    const cyberFiveCells = cyberFiveOnlyCells()
    const cyberFiveTermIds = cyberFiveCells.map((c) => c.termId)

    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A', status: 'WORD_ACTIVE', current_round: cyberFiveTermIds.length })] })
    client.queueFromResponse('called_terms', {
      data: cyberFiveTermIds.map((termId, i) => ({
        id: `CT_${termId}`,
        game_id: 'GAME_A',
        term_id: termId,
        round: i + 1,
        called_at: `2026-01-01T00:00:0${i}.000Z`,
      })),
    })
    client.queueFromResponse('players', {
      data: [{ id: 'P_1', game_id: 'GAME_A', display_name: 'Divyansh', joined_at: '2026-01-01T00:00:00.000Z' }],
    })
    client.queueFromResponse('tickets', {
      data: [
        {
          id: 'T_1',
          game_id: 'GAME_A',
          player_id: 'P_1',
          created_at: '2026-01-01T00:00:00.000Z',
          ref: shortTicketRef('T_1'),
          cells: buildTicketCells(),
        },
      ],
    })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()
    await waitFor(() => expect(tab.sink.current!.state.game.id).toBe('GAME_A'))

    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_1' })
    })
    await waitFor(() => {
      expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
      expect(tab.sink.current!.currentTicket?.id).toBe('T_1')
    })

    // Player screen header reference.
    const playerScreenRef = shortTicketRef(tab.sink.current!.currentTicket!.id)

    for (const cell of cyberFiveCells) {
      act(() => {
        tab.sink.current!.dispatch({
          type: 'HYDRATE_FROM_REMOTE',
          snapshot: {
            game: { ...tab.sink.current!.state.game, currentTermId: cell.termId },
            players: tab.sink.current!.state.players,
            tickets: tab.sink.current!.state.tickets,
            marks: tab.sink.current!.state.marks,
            claims: tab.sink.current!.state.claims,
            winners: tab.sink.current!.state.winners,
          },
        })
      })
      act(() => {
        tab.sink.current!.dispatch({ type: 'MARK_TERM', termId: cell.termId })
      })
    }
    await waitFor(() => {
      expect(tab.sink.current!.currentPrizeProgress.find((p) => p.id === 'CYBER_FIVE')?.current).toBe(5)
    })

    // Server row id ('SERVER_CLAIM_1') deliberately distinct from the
    // client-minted optimistic id so reconciliation is genuinely exercised;
    // ticket_ref matches playerScreenRef so this scenario's own
    // "same ref everywhere" assertion continues to hold once reconciled.
    client.queueRpcResponse('submit_claim', { data: buildClaimRow({ ticket_ref: playerScreenRef }) })
    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_1',
        ticketId: 'T_1',
        prizeId: 'CYBER_FIVE',
      })
    })
    await waitFor(() => {
      expect(client.rpcCalls.some((c) => c.name === 'submit_claim')).toBe(true)
    })

    let submittedClaim = tab.sink.current!.state.claims.at(-1)!
    await waitFor(() => {
      submittedClaim = tab.sink.current!.state.claims.at(-1)!
      expect(submittedClaim.ticketRef).toBe(playerScreenRef)
    })

    // Host Claim Inbox row for this claim -- via the REAL view-model
    // function the Host Dashboard renders through (toClaimInboxRowViewModel),
    // not a re-derivation.
    const inboxRow = toClaimInboxRowViewModel(submittedClaim)
    expect(inboxRow.ticketRef).toBe(playerScreenRef)

    // Host confirms -> Winner History entry for this confirmed claim, via
    // the REAL view-model function (toWinnerHistoryViewModel).
    client.queueRpcResponse('confirm_claim', { data: null, error: null })
    act(() => {
      tab.sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: submittedClaim.id })
    })

    const historyGroups = toWinnerHistoryViewModel(tab.sink.current!.state.winners, [
      { id: 'GAME_A', code: 'CYBER24', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    const historyRow = historyGroups
      .find((g) => g.gameId === 'GAME_A')
      ?.rows.find((r) => r.playerName === 'Divyansh')
    expect(historyRow).toBeDefined()
    expect(historyRow!.ticketRef).toBe(playerScreenRef)

    // All three surfaces agree.
    expect(playerScreenRef).toBe(inboxRow.ticketRef)
    expect(inboxRow.ticketRef).toBe(historyRow!.ticketRef)

    tab.unmount()
  })
})
