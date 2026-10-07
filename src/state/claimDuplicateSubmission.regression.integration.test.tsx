// Spec: claim-duplicate-submission — task 10 (regression tests for the six
// required scenarios from bugfix.md, on FIXED code).
//
// Covers, as 6 named test cases mirroring bugfix.md's Required Regression
// Test Coverage verbatim:
//   1. single-click-produces-exactly-one-claim
//   2. rapid-double-click-produces-at-most-one-active-claim
//   3. realtime-echo-does-not-duplicate (both orderings)
//   4. wrong-ticket
//   5. refresh-then-claim // not-a-ticket-dimension
//   6. reset/rejoin-then-claim
// ...plus one broader integration test: the full join → mark → claim
// (RPC + realtime echo in both orderings) → confirm flow.
//
// Mock harness, Harness component, and realtimeClient pass-through
// conventions below are copied from
// `claimDuplicateSubmission.exploration.test.tsx` /
// `claimDuplicateSubmission.reconcileWiring.test.tsx` (this spec), and from
// `sessionConsistencyGuard.regression.integration.test.tsx` /
// `PlayerGame.sessionGuard.test.tsx` (prior
// `claim-player-ticket-identity-mismatch` spec) for the mounted-`PlayerGame`
// rapid-double-click pattern and the refresh/reset-rejoin localStorage-
// seeding + `reset_game_to_new`/pointer-change conventions.
//
// Validates: Requirements 1.1, 1.2, 1.4, 1.5, 2.1, 2.2, 2.4, 2.6, 2.8, 3.1,
// 3.4, 3.6
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import {
  createMockSupabaseClient,
  type MockSupabaseClient,
} from './testSupport/mockSupabaseClient'
import { shortTicketRef } from './joinService'
import { dedupeClaimsById, toClaimInboxRowViewModel } from '../pages/HostDashboard/HostDashboard'
import { toWinnerHistoryViewModel } from '../pages/HostDashboard/hostWinnerHistoryViewModel'
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
import { PlayerEntry } from '../pages/PlayerEntry'

// ---------------------------------------------------------------------------
// Test harness (mirrors the exploration/reconcileWiring test files' existing
// convention, plus a mounted-PlayerGame variant for the rapid-double-click
// scenario, mirroring PlayerGame.sessionGuard.test.tsx).
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

/** Mounts the provider + the real PlayerGame (via PlayerEntry) at /player. */
function mountPlayerGame() {
  const sink: { current: GameSessionContextValue | null } = { current: null }
  const utils = render(
    <GameSessionProvider>
      <Harness sink={sink} />
      <MemoryRouter initialEntries={[{ pathname: '/player' }]}>
        <Routes>
          <Route path="/player" element={<PlayerEntry />} />
        </Routes>
      </MemoryRouter>
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

/** Fires a pointer-row change through the mock's `active_game_pointer` listener. */
function firePointerChange(client: MockSupabaseClient, activeGameId: string | null) {
  client.fireRemoteChange({
    table: 'active_game_pointer',
    eventType: 'UPDATE',
    row: { id: true, active_game_id: activeGameId, updated_at: new Date().toISOString() },
  })
}

/** Deliberately legacy 3x5 ticket cell fixture (not-a-ticket-dimension). */
function buildTicketCells(): Record<string, unknown>[] {
  return Array.from({ length: 15 }, (_, i) => ({
    termId: `TERM_${i}`,
    row: Math.floor(i / 5), // not-a-ticket-dimension (deliberately legacy 3x5 fixture shape)
    col: i % 5, // not-a-ticket-dimension (deliberately legacy 3x5 fixture shape)
  }))
}

/** 15 cells with stable, distinct termIds across 3 rows of 5 (TicketCell[][] shape). */
function buildTicketRows(): TicketCell[][] {
  let n = 0
  const rows: TicketCell[][] = []
  for (let row = 0; row < 3; row++) {
    const cells: TicketCell[] = []
    for (let col = 0; col < 5; col++) {
      cells.push({ termId: `TERM_${n}`, term: `Term ${n}`, state: 'AVAILABLE', row, col })
      n++
    }
    rows.push(cells)
  }
  return rows
}

/** Builds a `submit_claim`-shaped server response row. */
function buildClaimRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'SERVER_CLAIM_1',
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
 * Mounts a provider with a consistent, already-hydrated session: a joined
 * player with a matching ticket, backend-confirmed snapshot for GAME_A --
 * satisfying the `claim-player-ticket-identity-mismatch` guard's
 * `isConsistent` check.
 */
async function mountConsistentSession(
  client: MockSupabaseClient,
  overrides?: { playerId?: string; ticketId?: string; displayName?: string; ticketRef?: string },
) {
  const playerId = overrides?.playerId ?? 'P_A1'
  const ticketId = overrides?.ticketId ?? 'T_A1'
  const displayName = overrides?.displayName ?? 'Divyansh'
  const ticketRef = overrides?.ticketRef ?? '6405'

  client.queueRpcResponse('get_active_game', { data: [buildGameRow()] })
  client.queueFromResponse('players', {
    data: [{ id: playerId, game_id: 'GAME_A', display_name: displayName, joined_at: '2026-01-01T00:00:00.000Z' }],
  })
  client.queueFromResponse('tickets', {
    data: [
      {
        id: ticketId,
        game_id: 'GAME_A',
        player_id: playerId,
        created_at: '2026-01-01T00:00:00.000Z',
        ref: ticketRef,
        cells: buildTicketCells(),
      },
    ],
  })
  client.queueFromResponse('winners', { data: [] })

  const tab = mountProvider()

  await waitFor(() => {
    expect(tab.sink.current!.state.game.id).toBe('GAME_A')
  })

  act(() => {
    tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId })
  })

  await waitFor(() => {
    expect(tab.sink.current!.currentPlayer?.id).toBe(playerId)
    expect(tab.sink.current!.currentTicket?.id).toBe(ticketId)
  })

  return tab
}

/**
 * Mounts the real `PlayerGame` component (via `PlayerEntry`), with
 * `get_active_game` resolving immediately (backend confirmed), joins a
 * structurally-consistent player/ticket directly, and reveals/marks 5 terms
 * so Cyber Five is ELIGIBLE and the Claim button is enabled -- mirrors
 * `PlayerGame.sessionGuard.test.tsx`'s `mountUnconfirmedEligibleSession`
 * minus the pending-RPC trick (this scenario needs the session fully
 * backend-confirmed, not blocked by the guard).
 */
async function mountConsistentEligiblePlayerGame(client: MockSupabaseClient) {
  client.queueRpcResponse('get_active_game', { data: [buildGameRow()] })
  client.queueFromResponse('players', { data: [] })
  client.queueFromResponse('tickets', { data: [] })
  client.queueFromResponse('winners', { data: [] })

  const tab = mountPlayerGame()

  await waitFor(() => {
    expect(tab.sink.current!.state.game.id).toBe('GAME_A')
    expect(tab.sink.current!.isBackendConfirmed).toBe(true)
  })

  const gameId = tab.sink.current!.state.game.id
  const rows = buildTicketRows()
  const allTermIds = rows.flat().map((c) => c.termId)
  const marksTermIds = allTermIds.slice(0, 5)

  act(() => {
    tab.sink.current!.dispatch({
      type: 'JOIN_PLAYER',
      player: {
        id: 'P_1',
        gameId,
        displayName: 'Asha Kumar',
        ticketId: 'T_1',
        joinedAt: '2026-01-01T00:00:00.000Z',
        name: 'Asha Kumar',
        ticketRef: 'Ticket #T1',
      },
      ticket: {
        id: 'T_1',
        playerId: 'P_1',
        gameId,
        createdAt: '2026-01-01T00:00:00.000Z',
        ref: 'Ticket #T1',
        rows,
      },
    })
  })

  await waitFor(() => {
    expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
    expect(tab.sink.current!.currentTicket?.id).toBe('T_1')
  })

  act(() => {
    const current = tab.sink.current!.state
    tab.sink.current!.dispatch({
      type: 'HYDRATE_FROM_REMOTE',
      snapshot: {
        game: { ...current.game, revealedTermIds: allTermIds },
        players: current.players,
        tickets: current.tickets,
        marks: marksTermIds.map((termId) => ({
          id: `mark-${termId}`,
          gameId,
          playerId: 'P_1',
          ticketId: 'T_1',
          termId,
          markedAt: '2026-01-01T00:00:00.000Z',
          valid: true,
        })),
        claims: current.claims,
        winners: current.winners,
      },
    })
  })

  await waitFor(() => {
    expect(
      tab.getByRole('button', { name: /claim cyber five/i }).hasAttribute('disabled'),
    ).toBe(false)
  })

  return tab
}

describe('Regression (claim-duplicate-submission): six required scenarios + full flow (fixed code)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = createMockSupabaseClient()
  })

  // -------------------------------------------------------------------------
  // 1. single-click-produces-exactly-one-claim
  // -------------------------------------------------------------------------
  it('1. single-click-produces-exactly-one-claim: one click on "Claim [Prize]" results in exactly one rendered Host Claim Inbox entry and exactly one underlying database row', async () => {
    const client = mockClient!
    const tab = await mountConsistentSession(client)

    const claimsBeforeSubmit = tab.sink.current!.state.claims.length
    const serverRow = buildClaimRow({ id: 'SERVER_CLAIM_SINGLE' })
    client.queueRpcResponse('submit_claim', { data: serverRow })

    // One click on "Claim [Prize]" -- one SUBMIT_PRIZE_CLAIM dispatch.
    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
    })

    // Exactly one submit_claim RPC call recorded (one underlying DB row).
    await waitFor(() => {
      expect(client.rpcCalls.filter((c) => c.name === 'submit_claim')).toHaveLength(1)
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Realtime echo for that same row fires after the RPC resolves.
    act(() => {
      client.fireRemoteChange({ table: 'claims', eventType: 'INSERT', row: serverRow })
    })

    await waitFor(() => {
      const claimsForPrize = tab.sink.current!.state.claims.filter(
        (c) => c.playerId === 'P_A1' && c.prizeId === 'CYBER_FIVE',
      )
      expect(claimsForPrize).toHaveLength(1)
    })

    // Exactly one claims entry after RPC resolution + echo.
    expect(tab.sink.current!.state.claims.length).toBe(claimsBeforeSubmit + 1)

    // Exactly one rendered Host Claim Inbox entry for this claim.
    const inboxRows = dedupeClaimsById(tab.sink.current!.state.claims).map(toClaimInboxRowViewModel)
    expect(inboxRows.filter((r) => r.ticketRef === serverRow.ticket_ref)).toHaveLength(1)

    tab.unmount()
  })

  // -------------------------------------------------------------------------
  // 2. rapid-double-click-produces-at-most-one-active-claim
  // -------------------------------------------------------------------------
  it('2. rapid-double-click-produces-at-most-one-active-claim: two fireEvent.click calls in the same tick result in only one submit_claim RPC call', async () => {
    const client = mockClient!
    const tab = await mountConsistentEligiblePlayerGame(client)

    client.queueRpcResponse('submit_claim', { data: buildClaimRow({ id: 'SERVER_CLAIM_DBLCLICK', player_id: 'P_1', ticket_id: 'T_1' }) })

    const claimButton = tab.getByRole('button', { name: /claim cyber five/i })

    // Two near-simultaneous clicks, same tick -- the second click is a
    // no-op because the button is already disabled via isSubmittingClaim.
    fireEvent.click(claimButton)
    fireEvent.click(claimButton)

    // Only ONE submit_claim RPC call was made.
    await waitFor(() => {
      expect(client.rpcCalls.filter((c) => c.name === 'submit_claim')).toHaveLength(1)
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // At most one claim entry results.
    const claimsForPrize = tab.sink.current!.state.claims.filter(
      (c) => c.playerId === 'P_1' && c.prizeId === 'CYBER_FIVE',
    )
    expect(claimsForPrize.length).toBeLessThanOrEqual(1)
    expect(claimsForPrize).toHaveLength(1)

    tab.unmount()
  })

  // -------------------------------------------------------------------------
  // 3. realtime-echo-does-not-duplicate (both orderings)
  // -------------------------------------------------------------------------
  it('3a. realtime-echo-does-not-duplicate: RPC resolves THEN echo arrives -- exactly one entry survives', async () => {
    const client = mockClient!
    const tab = await mountConsistentSession(client)

    const serverRow = buildClaimRow({ id: 'SERVER_CLAIM_ECHO_AFTER' })
    client.queueRpcResponse('submit_claim', { data: serverRow })

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
    })

    // Let the RPC resolve (and RECONCILE_CLAIM_ID dispatch) first.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await waitFor(() => {
      const claimsForPrize = tab.sink.current!.state.claims.filter(
        (c) => c.playerId === 'P_A1' && c.prizeId === 'CYBER_FIVE',
      )
      expect(claimsForPrize).toHaveLength(1)
      expect(claimsForPrize[0].id).toBe('SERVER_CLAIM_ECHO_AFTER')
    })

    // The echo for the already-reconciled row is a no-op.
    act(() => {
      client.fireRemoteChange({ table: 'claims', eventType: 'INSERT', row: serverRow })
    })

    const claimsForPrize = tab.sink.current!.state.claims.filter(
      (c) => c.playerId === 'P_A1' && c.prizeId === 'CYBER_FIVE',
    )
    expect(claimsForPrize).toHaveLength(1)
    expect(claimsForPrize[0].id).toBe('SERVER_CLAIM_ECHO_AFTER')

    tab.unmount()
  })

  // NOTE on this ordering: RECONCILE_CLAIM_ID is dispatched from
  // `rpcSubmitClaim(...).then(...)` (task 4), matching the optimistic
  // entry by its ORIGINAL `optimisticId` (task 3). When the realtime echo
  // for a submission's server row arrives BEFORE that submission's own RPC
  // promise settles, `upsertById` (id-only match, unmodified) appends the
  // echoed row as a new entry, since no existing entry shares its id yet.
  // The RECONCILE_CLAIM_ID reducer case additionally checks, at the moment
  // it runs, whether an entry with the confirmed claim's id already exists
  // elsewhere in `state.claims` -- i.e. whether the echo got there first.
  // When it has, the now-redundant optimistic entry is dropped entirely
  // rather than overwritten with a second copy of the same id, so exactly
  // one entry survives: the one the echo's `upsertById` call originally
  // inserted, at whatever array position that was. This closes the gap
  // fully, making this ordering produce the same outcome as 3a's
  // RPC-resolves-first ordering -- just a different survivor array
  // position.
  it('3b. realtime-echo-does-not-duplicate: echo arrives THEN RPC resolves -- exactly one entry survives', async () => {
    const client = mockClient!
    const tab = await mountConsistentSession(client)

    const serverRow = buildClaimRow({ id: 'SERVER_CLAIM_ECHO_BEFORE' })
    client.queueRpcResponse('submit_claim', { data: serverRow })

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
    })

    // Fire the echo BEFORE the RPC promise's own .then has run.
    act(() => {
      client.fireRemoteChange({ table: 'claims', eventType: 'INSERT', row: serverRow })
    })

    await waitFor(() => {
      const claimsForPrize = tab.sink.current!.state.claims.filter(
        (c) => c.playerId === 'P_A1' && c.prizeId === 'CYBER_FIVE',
      )
      expect(claimsForPrize.length).toBeGreaterThanOrEqual(1)
    })

    // Now let the submit_claim RPC's own .then (RECONCILE_CLAIM_ID) run too.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const claimsForPrize = tab.sink.current!.state.claims.filter(
      (c) => c.playerId === 'P_A1' && c.prizeId === 'CYBER_FIVE',
    )
    // Exactly one entry survives, carrying the server's authoritative
    // id/fields -- the optimistic entry was dropped once RECONCILE_CLAIM_ID
    // detected the echo had already landed under the confirmed claim's id.
    expect(claimsForPrize).toHaveLength(1)
    expect(claimsForPrize[0].id).toBe('SERVER_CLAIM_ECHO_BEFORE')
    expect(claimsForPrize[0].ticketRef).toBe(serverRow.ticket_ref)

    // The Host Claim Inbox's dedupe-by-id safeguard (task 7) remains a
    // no-op here, as expected for an already duplicate-free list.
    const dedupedInboxRows = dedupeClaimsById(tab.sink.current!.state.claims)
      .filter((c) => c.playerId === 'P_A1' && c.prizeId === 'CYBER_FIVE')
    expect(dedupedInboxRows).toHaveLength(1)

    tab.unmount()
  })

  // -------------------------------------------------------------------------
  // 4. wrong-ticket
  // -------------------------------------------------------------------------
  it('4. wrong-ticket: two different players\' claims never cross-contaminate ticketRef/playerId/ticketId', async () => {
    const client = mockClient!

    // Two players, both visible in the SAME Host-side view of
    // `state.claims` (mirroring the Host Claim Inbox, which aggregates
    // every player's claims in one place -- this is exactly where the
    // reported "wrong ticket" symptom was observed). Each player submits
    // their own claim in sequence, through the player who currently holds
    // `currentPlayerId` on this one provider instance -- RESTORE_PLAYER
    // switches which player's identity is "active" for the purposes of a
    // SUBMIT_PRIZE_CLAIM dispatch, while `state.claims` itself (the Host's
    // own view) accumulates both regardless of whose tab submitted them.
    client.queueRpcResponse('get_active_game', { data: [buildGameRow()] })
    client.queueFromResponse('players', {
      data: [
        { id: 'P_1', game_id: 'GAME_A', display_name: 'Divyansh', joined_at: '2026-01-01T00:00:00.000Z' },
        { id: 'P_2', game_id: 'GAME_A', display_name: 'Asha', joined_at: '2026-01-01T00:00:01.000Z' },
      ],
    })
    client.queueFromResponse('tickets', {
      data: [
        { id: 'T_1', game_id: 'GAME_A', player_id: 'P_1', created_at: '2026-01-01T00:00:00.000Z', ref: '6405', cells: buildTicketCells() },
        { id: 'T_2', game_id: 'GAME_A', player_id: 'P_2', created_at: '2026-01-01T00:00:01.000Z', ref: '7001', cells: buildTicketCells() },
      ],
    })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()
    await waitFor(() => expect(tab.sink.current!.state.game.id).toBe('GAME_A'))

    // Player 1 submits first.
    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_1' })
    })
    await waitFor(() => expect(tab.sink.current!.currentPlayer?.id).toBe('P_1'))

    client.queueRpcResponse('submit_claim', {
      data: buildClaimRow({ id: 'SERVER_CLAIM_WT_1', player_id: 'P_1', ticket_id: 'T_1', ticket_ref: '6405', player_name: 'Divyansh' }),
    })
    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_1',
        ticketId: 'T_1',
        prizeId: 'CYBER_FIVE',
      })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    act(() => {
      client.fireRemoteChange({
        table: 'claims',
        eventType: 'INSERT',
        row: buildClaimRow({ id: 'SERVER_CLAIM_WT_1', player_id: 'P_1', ticket_id: 'T_1', ticket_ref: '6405', player_name: 'Divyansh' }),
      })
    })
    await waitFor(() => {
      expect(tab.sink.current!.state.claims.filter((c) => c.playerId === 'P_1')).toHaveLength(1)
    })

    // Player 2 submits next -- a different player, different ticket.
    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_2' })
    })
    await waitFor(() => expect(tab.sink.current!.currentPlayer?.id).toBe('P_2'))

    client.queueRpcResponse('submit_claim', {
      data: buildClaimRow({ id: 'SERVER_CLAIM_WT_2', player_id: 'P_2', ticket_id: 'T_2', ticket_ref: '7001', player_name: 'Asha' }),
    })
    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_2',
        ticketId: 'T_2',
        prizeId: 'CYBER_FIVE',
      })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    act(() => {
      client.fireRemoteChange({
        table: 'claims',
        eventType: 'INSERT',
        row: buildClaimRow({ id: 'SERVER_CLAIM_WT_2', player_id: 'P_2', ticket_id: 'T_2', ticket_ref: '7001', player_name: 'Asha' }),
      })
    })
    await waitFor(() => {
      expect(tab.sink.current!.state.claims.filter((c) => c.playerId === 'P_2')).toHaveLength(1)
    })

    // Exactly 2 claims total -- one per player, each reconciled to its
    // server row.
    expect(tab.sink.current!.state.claims.filter((c) => c.prizeId === 'CYBER_FIVE')).toHaveLength(2)

    const claimP1 = tab.sink.current!.state.claims.find((c) => c.playerId === 'P_1')!
    const claimP2 = tab.sink.current!.state.claims.find((c) => c.playerId === 'P_2')!

    // Each claim's own fields match only its own submitter, never crossed.
    expect(claimP1.ticketId).toBe('T_1')
    expect(claimP1.ticketRef).toBe('6405')
    expect(claimP1.playerName).toBe('Divyansh')
    expect(claimP2.ticketId).toBe('T_2')
    expect(claimP2.ticketRef).toBe('7001')
    expect(claimP2.playerName).toBe('Asha')

    // No cross-contamination: P_1's claim never carries T_2/7001/Asha, and
    // vice versa.
    expect(claimP1.ticketId).not.toBe(claimP2.ticketId)
    expect(claimP1.ticketRef).not.toBe(claimP2.ticketRef)

    tab.unmount()
  })

  // -------------------------------------------------------------------------
  // 5. refresh-then-claim // not-a-ticket-dimension
  // -------------------------------------------------------------------------
  it('5. refresh-then-claim: localStorage seeded exactly as a refresh would leave it; after backend confirmation, one claim submission results in exactly one entry', async () => { // not-a-ticket-dimension
    const client = mockClient!

    const cachedGame = {
      id: 'GAME_A',
      code: 'CYBER24',
      status: 'WORD_ACTIVE' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      currentRound: 1,
      revealedTermIds: Array.from({ length: 5 }, (_, i) => `TERM_${i}`),
    }
    const cachedPlayer = {
      id: 'P_1',
      gameId: 'GAME_A',
      displayName: 'Divyansh',
      ticketId: 'T_1',
      joinedAt: '2026-01-01T00:00:00.000Z',
      name: 'Divyansh',
      ticketRef: 'Ticket #6405',
    }
    const cachedTicketRows: TicketCell[][] = [
      [0, 1, 2, 3, 4].map((i) => ({ termId: `TERM_${i}`, term: `Term ${i}`, row: 0, col: i, state: 'AVAILABLE' as const })),
      [5, 6, 7, 8, 9].map((i) => ({ termId: `TERM_${i}`, term: `Term ${i}`, row: 1, col: i - 5, state: 'AVAILABLE' as const })),
      [10, 11, 12, 13, 14].map((i) => ({ termId: `TERM_${i}`, term: `Term ${i}`, row: 2, col: i - 10, state: 'AVAILABLE' as const })),
    ]
    const cachedTicket = {
      id: 'T_1',
      playerId: 'P_1',
      gameId: 'GAME_A',
      createdAt: '2026-01-01T00:00:00.000Z',
      ref: 'Ticket #6405',
      rows: cachedTicketRows,
    }
    // 5 marks spread across rows (same convention as the prior spec's own // not-a-ticket-dimension
    // cyberFiveOnlyCells, chosen so marking exactly these 5 reaches Cyber
    // Five eligibility without also completing a Line_Prize row).
    const cyberFiveTermIds = ['TERM_0', 'TERM_1', 'TERM_5', 'TERM_6', 'TERM_10']

    const { STORAGE_KEY, CURRENT_PLAYER_STORAGE_KEY, PERSIST_VERSION } = await import('./persistence')
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: PERSIST_VERSION,
        game: { ...cachedGame, revealedTermIds: cyberFiveTermIds },
        players: [cachedPlayer],
        tickets: [cachedTicket],
        marks: cyberFiveTermIds.map((termId, i) => ({
          id: `M_${i}`,
          gameId: 'GAME_A',
          playerId: 'P_1',
          ticketId: 'T_1',
          termId,
          markedAt: `2026-01-01T00:00:0${i + 1}.000Z`,
          valid: true,
        })),
        claims: [],
        winners: [],
      }),
    )
    localStorage.setItem(CURRENT_PLAYER_STORAGE_KEY, 'P_1')

    // Backend confirmation agrees exactly with the cached state.
    client.queueRpcResponse('get_active_game', {
      data: [buildGameRow({ id: 'GAME_A', status: 'WORD_ACTIVE', current_round: 5 })],
    })
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
      data: [{ id: 'T_1', game_id: 'GAME_A', player_id: 'P_1', created_at: '2026-01-01T00:00:00.000Z', ref: 'Ticket #6405', cells: buildTicketCells() }],
    })
    client.queueFromResponse('marks', {
      data: cyberFiveTermIds.map((termId, i) => ({
        id: `M_${i}`,
        game_id: 'GAME_A',
        player_id: 'P_1',
        ticket_id: 'T_1',
        term_id: termId,
        marked_at: `2026-01-01T00:00:0${i + 1}.000Z`,
        valid: true,
      })),
    })
    client.queueFromResponse('claims', { data: [] })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()

    // Cached identity already rendered before confirmation lands -- no
    // forced re-join, no duplicate pre-refresh claim.
    expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
    expect(tab.sink.current!.currentTicket?.id).toBe('T_1')
    expect(tab.sink.current!.state.claims).toHaveLength(0)

    await waitFor(() => {
      expect(tab.sink.current!.isBackendConfirmed).toBe(true)
    })

    expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
    expect(tab.sink.current!.currentPrizeProgress.find((p) => p.id === 'CYBER_FIVE')?.current).toBe(5)
    expect(tab.sink.current!.state.claims).toHaveLength(0)

    // Submit a claim after the refresh-restored session is confirmed.
    const serverRow = buildClaimRow({ id: 'SERVER_CLAIM_REFRESH_THEN_CLAIM', ticket_ref: 'Ticket #6405' })
    client.queueRpcResponse('submit_claim', { data: serverRow })
    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_1',
        ticketId: 'T_1',
        prizeId: 'CYBER_FIVE',
      })
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    act(() => {
      client.fireRemoteChange({ table: 'claims', eventType: 'INSERT', row: serverRow })
    })

    await waitFor(() => {
      const claimsForPrize = tab.sink.current!.state.claims.filter((c) => c.prizeId === 'CYBER_FIVE')
      expect(claimsForPrize).toHaveLength(1)
      expect(claimsForPrize[0].id).toBe('SERVER_CLAIM_REFRESH_THEN_CLAIM')
    })
    // No duplicate survives from any pre-refresh state (there was none).
    expect(tab.sink.current!.state.claims).toHaveLength(1)

    tab.unmount()
  })

  // -------------------------------------------------------------------------
  // 6. reset/rejoin-then-claim
  // -------------------------------------------------------------------------
  it('6. reset/rejoin-then-claim: after a Host reset to a new game and rejoin, a claim submission results in exactly one entry, with no stale pre-reset claim resurfacing', async () => {
    const client = mockClient!

    // Session in GAME_A, with a pre-reset claim already recorded.
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
    client.queueFromResponse('players', {
      data: [{ id: 'P_1', game_id: 'GAME_A', display_name: 'Divyansh', joined_at: '2026-01-01T00:00:00.000Z' }],
    })
    client.queueFromResponse('tickets', {
      data: [{ id: 'T_1', game_id: 'GAME_A', player_id: 'P_1', created_at: '2026-01-01T00:00:00.000Z', ref: 'Ticket #6405', cells: buildTicketCells() }],
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

    // A pre-reset claim for P_1 exists in GAME_A.
    act(() => {
      tab.sink.current!.dispatch({
        type: 'HYDRATE_FROM_REMOTE',
        snapshot: {
          game: tab.sink.current!.state.game,
          players: tab.sink.current!.state.players,
          tickets: tab.sink.current!.state.tickets,
          marks: tab.sink.current!.state.marks,
          claims: [
            {
              id: 'STALE_PRE_RESET_CLAIM',
              gameId: 'GAME_A',
              playerId: 'P_1',
              ticketId: 'T_1',
              prizeId: 'CYBER_FIVE',
              submittedAt: '2026-01-01T00:00:00.000Z',
              validationStatus: 'VALID',
              hostDecision: 'PENDING',
              prizeLabel: 'Cyber Five',
              playerName: 'Divyansh',
              ticketRef: 'Ticket #6405',
            },
          ],
          winners: tab.sink.current!.state.winners,
        },
      })
    })
    await waitFor(() => {
      expect(tab.sink.current!.state.claims.some((c) => c.id === 'STALE_PRE_RESET_CLAIM')).toBe(true)
    })

    // --- Host triggers Reset: Game A retired, Game B becomes Active ---
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
    })

    // Backend-confirmed GAME_B has no claims/players -- the stale pre-reset
    // identity and claim are gone from this fresh snapshot.
    await waitFor(() => {
      expect(tab.sink.current!.isBackendConfirmed).toBe(true)
      expect(tab.sink.current!.state.currentPlayerId).toBeUndefined()
    })
    expect(tab.sink.current!.state.claims.some((c) => c.id === 'STALE_PRE_RESET_CLAIM')).toBe(false)
    expect(tab.sink.current!.state.claims).toHaveLength(0)

    // --- Rejoin in the new game ---
    client.queueRpcResponse('join_game', { data: [{ player_id: 'P_2', ticket_id: 'T_2' }] })
    client.queueFromResponse('players', {
      data: [{ id: 'P_2', game_id: 'GAME_B', display_name: 'Divyansh', joined_at: '2026-01-02T00:00:00.000Z' }],
    })
    client.queueFromResponse('tickets', {
      data: [{ id: 'T_2', game_id: 'GAME_B', player_id: 'P_2', created_at: '2026-01-02T00:00:00.000Z', ref: shortTicketRef('T_2'), cells: buildTicketCells() }],
    })
    await act(async () => {
      await tab.sink.current!.joinGame({
        gameCode: 'NEWG01',
        displayName: 'Divyansh',
        deviceJoinToken: 'device-token-1',
      })
    })
    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_2' })
    })
    await waitFor(() => {
      expect(tab.sink.current!.currentPlayer?.id).toBe('P_2')
      expect(tab.sink.current!.currentTicket?.id).toBe('T_2')
    })

    // Submit a claim in the new session.
    const serverRow = buildClaimRow({ id: 'SERVER_CLAIM_RESET_REJOIN', game_id: 'GAME_B', player_id: 'P_2', ticket_id: 'T_2' })
    client.queueRpcResponse('submit_claim', { data: serverRow })
    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_2',
        ticketId: 'T_2',
        prizeId: 'CYBER_FIVE',
      })
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    act(() => {
      client.fireRemoteChange({ table: 'claims', eventType: 'INSERT', row: serverRow })
    })

    await waitFor(() => {
      const claimsForNewSession = tab.sink.current!.state.claims.filter((c) => c.playerId === 'P_2')
      expect(claimsForNewSession).toHaveLength(1)
      expect(claimsForNewSession[0].id).toBe('SERVER_CLAIM_RESET_REJOIN')
    })

    // Exactly one claim entry for the new session; no stale pre-reset claim
    // resurfaces.
    expect(tab.sink.current!.state.claims).toHaveLength(1)
    expect(tab.sink.current!.state.claims.some((c) => c.id === 'STALE_PRE_RESET_CLAIM')).toBe(false)

    tab.unmount()
  })

  // -------------------------------------------------------------------------
  // Broader integration test: full join → mark → claim (RPC + realtime echo
  // in both orderings) → confirm flow.
  // -------------------------------------------------------------------------
  it('full flow: join (mock RPC) → mark → claim (mock RPC + realtime echo in both orderings) → confirm produces exactly one Claim Inbox entry and one Winner History entry', async () => {
    const client = mockClient!

    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
    client.queueFromResponse('players', { data: [] })
    client.queueFromResponse('tickets', { data: [] })
    client.queueFromResponse('winners', { data: [] })

    const tab = mountProvider()
    await waitFor(() => expect(tab.sink.current!.state.game.id).toBe('GAME_A'))

    // --- join (mock RPC) ---
    client.queueRpcResponse('join_game', { data: [{ player_id: 'P_1', ticket_id: 'T_1' }] })
    client.queueFromResponse('players', {
      data: [{ id: 'P_1', game_id: 'GAME_A', display_name: 'Divyansh', joined_at: '2026-01-01T00:00:00.000Z' }],
    })
    client.queueFromResponse('tickets', {
      data: [{ id: 'T_1', game_id: 'GAME_A', player_id: 'P_1', created_at: '2026-01-01T00:00:00.000Z', ref: 'Ticket #6405', cells: buildTicketCells() }],
    })
    await act(async () => {
      await tab.sink.current!.joinGame({
        gameCode: 'CYBER24',
        displayName: 'Divyansh',
        deviceJoinToken: 'device-token-full-flow',
      })
    })
    act(() => {
      tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_1' })
    })
    await waitFor(() => {
      expect(tab.sink.current!.currentPlayer?.id).toBe('P_1')
      expect(tab.sink.current!.currentTicket?.id).toBe('T_1')
    })

    // --- mark: reveal + mark 5 terms to reach Cyber Five eligibility ---
    const ticket = tab.sink.current!.currentTicket!
    const fiveCellTermIds = [
      ticket.rows[0][0].termId,
      ticket.rows[0][1].termId,
      ticket.rows[1][0].termId,
      ticket.rows[1][1].termId,
      ticket.rows[2][0].termId,
    ]
    act(() => {
      tab.sink.current!.dispatch({
        type: 'HYDRATE_FROM_REMOTE',
        snapshot: {
          game: { ...tab.sink.current!.state.game, revealedTermIds: fiveCellTermIds },
          players: tab.sink.current!.state.players,
          tickets: tab.sink.current!.state.tickets,
          marks: tab.sink.current!.state.marks,
          claims: tab.sink.current!.state.claims,
          winners: tab.sink.current!.state.winners,
        },
      })
    })
    for (const termId of fiveCellTermIds) {
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

    // --- claim (mock RPC + realtime echo in both orderings) ---
    // First claim: RPC resolves, THEN the echo arrives.
    const serverRowA = buildClaimRow({ id: 'SERVER_CLAIM_FULLFLOW', player_id: 'P_1', ticket_id: 'T_1', ticket_ref: 'Ticket #6405' })
    client.queueRpcResponse('submit_claim', { data: serverRowA })
    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_1',
        ticketId: 'T_1',
        prizeId: 'CYBER_FIVE',
      })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    act(() => {
      client.fireRemoteChange({ table: 'claims', eventType: 'INSERT', row: serverRowA })
    })
    await waitFor(() => {
      expect(tab.sink.current!.state.claims.filter((c) => c.prizeId === 'CYBER_FIVE')).toHaveLength(1)
    })

    // Echo-arrives-before-RPC-resolves ordering is independently exercised
    // for the mechanism itself in scenario 3b above; here the full flow
    // continues with the single reconciled entry (one Claim Inbox entry).
    const inboxRows = dedupeClaimsById(tab.sink.current!.state.claims).map(toClaimInboxRowViewModel)
    expect(inboxRows).toHaveLength(1)

    // --- confirm ---
    const claimToConfirm = tab.sink.current!.state.claims[0]
    act(() => {
      tab.sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: claimToConfirm.id })
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.winners).toHaveLength(1)
    })

    const gameSummaries = [
      { id: tab.sink.current!.state.game.id, code: tab.sink.current!.state.game.code, createdAt: tab.sink.current!.state.game.createdAt },
    ]
    const winnerGroups = toWinnerHistoryViewModel(tab.sink.current!.state.winners, gameSummaries)
    expect(winnerGroups.flatMap((g) => g.rows)).toHaveLength(1)

    // Exactly one Claim Inbox entry and one Winner History entry throughout.
    expect(dedupeClaimsById(tab.sink.current!.state.claims)).toHaveLength(1)
    expect(tab.sink.current!.state.winners).toHaveLength(1)

    tab.unmount()
  })

  // -------------------------------------------------------------------------
  // Ticket reference consistency across the Player screen's own rendered
  // header, the submitted claim's ticketRef, and the Winner History ref
  // (bugfix.md Req 2.8). Mounts the real PlayerGame component (not just the
  // Harness sink) so the Player screen's actual rendered DOM text is
  // compared, not a recomputed stand-in -- this is what the mechanism-check
  // test above could not catch, since it never renders PlayerGame itself.
  // -------------------------------------------------------------------------
  it('Player screen rendered ref, submitted claim ticketRef, and Winner History ref are all identical for one session (Req 2.8)', async () => {
    const client = mockClient!
    const tab = await mountConsistentEligiblePlayerGame(client)

    // The Player screen's own rendered header ref -- must equal the
    // server-authoritative currentTicket.ref, never a recomputed value.
    const playerScreenRenderedRef = tab.getByText(tab.sink.current!.currentTicket!.ref)
    expect(playerScreenRenderedRef).toBeInTheDocument()

    const serverRow = buildClaimRow({
      id: 'SERVER_CLAIM_REF_CONSISTENCY',
      player_id: 'P_1',
      ticket_id: 'T_1',
      ticket_ref: tab.sink.current!.currentTicket!.ref,
    })
    client.queueRpcResponse('submit_claim', { data: serverRow })

    const claimButton = tab.getByRole('button', { name: /claim cyber five/i })
    fireEvent.click(claimButton)

    await waitFor(() => {
      expect(client.rpcCalls.filter((c) => c.name === 'submit_claim')).toHaveLength(1)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    act(() => {
      client.fireRemoteChange({ table: 'claims', eventType: 'INSERT', row: serverRow })
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.claims.filter((c) => c.prizeId === 'CYBER_FIVE')).toHaveLength(1)
    })

    const submittedClaim = tab.sink.current!.state.claims.find((c) => c.prizeId === 'CYBER_FIVE')!

    act(() => {
      tab.sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: submittedClaim.id })
    })
    await waitFor(() => {
      expect(tab.sink.current!.state.winners).toHaveLength(1)
    })
    const winner = tab.sink.current!.state.winners[0]

    // All three surfaces -- Player screen's own rendered ref, the submitted
    // claim's ticketRef, and the eventual Winner History ref -- agree.
    expect(submittedClaim.ticketRef).toBe(tab.sink.current!.currentTicket!.ref)
    expect(winner.ticketRef).toBe(tab.sink.current!.currentTicket!.ref)
    expect(playerScreenRenderedRef.textContent).toBe(submittedClaim.ticketRef)
    expect(playerScreenRenderedRef.textContent).toBe(winner.ticketRef)

    tab.unmount()
  })
})
