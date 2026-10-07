// Spec: claim-duplicate-submission — task 9 (unit tests for the
// RECONCILE_CLAIM_ID .then/.catch wiring and the isSubmittingClaim lock, on
// FIXED code).
//
// Covers:
//  1. wrappedDispatch's SUBMIT_PRIZE_CLAIM .then: RECONCILE_CLAIM_ID is
//     dispatched with the correct optimisticId/confirmedClaim on RPC
//     success -- asserted via the end state after resolution carrying the
//     server's id/fields.
//  2. the existing rollback still fires unchanged on RPC rejection (claim
//     removed from state.claims).
//  3. isSubmittingClaim per-prize state transitions: set at dispatch start,
//     cleared on both .then and .catch, independent per prizeId.
//
// Uses the same mock Supabase client harness and vi.mock('./realtimeClient',
// ...) thin-pass-through convention established by
// claimDuplicateSubmission.exploration.test.tsx.
//
// Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.6, 2.7
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
// Test harness (mirrors claimDuplicateSubmission.exploration.test.tsx's
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
  return Array.from({ length: 15 }, (_, i) => ({
    termId: `TERM_${i}`,
    row: Math.floor(i / 5),
    col: i % 5,
  }))
}

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
 * player (P_A1) with a matching ticket (T_A1), backend-confirmed snapshot
 * for GAME_A.
 */
async function mountConsistentSession(client: MockSupabaseClient) {
  client.queueRpcResponse('get_active_game', { data: [buildGameRow()] })
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

  act(() => {
    tab.sink.current!.dispatch({ type: 'RESTORE_PLAYER', playerId: 'P_A1' })
  })

  await waitFor(() => {
    expect(tab.sink.current!.currentPlayer?.id).toBe('P_A1')
    expect(tab.sink.current!.currentTicket?.id).toBe('T_A1')
  })

  return tab
}

describe('RECONCILE_CLAIM_ID wiring: SUBMIT_PRIZE_CLAIM .then/.catch (fixed code)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = createMockSupabaseClient()
  })

  it('dispatches RECONCILE_CLAIM_ID with the correct optimisticId/confirmedClaim on RPC success, leaving exactly one entry with the server id/fields', async () => {
    const client = mockClient!
    const tab = await mountConsistentSession(client)

    const claimsBeforeSubmit = tab.sink.current!.state.claims.length
    const serverRow = buildClaimRow({ id: 'SERVER_CLAIM_RECONCILED', ticket_ref: '6405' })
    client.queueRpcResponse('submit_claim', { data: serverRow })

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
    })

    // Optimistic entry dispatched synchronously.
    expect(tab.sink.current!.state.claims.length).toBe(claimsBeforeSubmit + 1)
    const optimisticEntry =
      tab.sink.current!.state.claims[tab.sink.current!.state.claims.length - 1]
    const optimisticId = optimisticEntry.id
    expect(optimisticId).not.toBe('SERVER_CLAIM_RECONCILED')

    // Let the queued submit_claim RPC resolve and its .then run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Exactly one entry survives -- the optimistic entry has been replaced
    // in place with the server's authoritative row (id and fields).
    const claimsForPrize = tab.sink.current!.state.claims.filter(
      (c) => c.playerId === 'P_A1' && c.prizeId === 'CYBER_FIVE',
    )
    expect(claimsForPrize).toHaveLength(1)
    expect(claimsForPrize[0].id).toBe('SERVER_CLAIM_RECONCILED')
    expect(claimsForPrize[0].id).not.toBe(optimisticId)
    expect(claimsForPrize[0].ticketRef).toBe('6405')

    // A later realtime echo for the same server row is a no-op (upsertById
    // finds the matching id immediately) -- confirms reconciliation
    // happened BEFORE the echo could have appended a second entry.
    act(() => {
      client.fireRemoteChange({ table: 'claims', eventType: 'INSERT', row: serverRow })
    })

    await waitFor(() => {
      const after = tab.sink.current!.state.claims.filter(
        (c) => c.playerId === 'P_A1' && c.prizeId === 'CYBER_FIVE',
      )
      expect(after).toHaveLength(1)
    })

    tab.unmount()
  })

  it('still fires rollback unchanged on RPC rejection: the optimistic claim is removed from state.claims', async () => {
    const client = mockClient!
    const tab = await mountConsistentSession(client)

    const claimsBeforeSubmit = tab.sink.current!.state.claims.length
    client.queueRpcError('submit_claim', 'duplicate active claim', 'DUPLICATE_ACTIVE_CLAIM')

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'FIREWALL_LINE',
      })
    })

    expect(tab.sink.current!.state.claims.length).toBe(claimsBeforeSubmit + 1)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Rollback removed the optimistic entry -- no claim survives for this
    // rejected submission.
    await waitFor(() => {
      expect(tab.sink.current!.state.claims.length).toBe(claimsBeforeSubmit)
    })
    const claimsForPrize = tab.sink.current!.state.claims.filter(
      (c) => c.prizeId === 'FIREWALL_LINE',
    )
    expect(claimsForPrize).toHaveLength(0)

    tab.unmount()
  })
})

describe('isSubmittingClaim: per-prize submission lock state transitions (fixed code)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = createMockSupabaseClient()
  })

  it('is false before submission, true immediately after dispatch, and cleared again after the .then resolves (success)', async () => {
    const client = mockClient!
    const tab = await mountConsistentSession(client)

    expect(tab.sink.current!.isSubmittingClaim('CYBER_FIVE')).toBe(false)

    client.queueRpcResponse('submit_claim', {
      data: buildClaimRow({ id: 'SERVER_CLAIM_LOCK_OK' }),
    })

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
    })

    // Set true at the start of the dispatch, before the RPC resolves.
    expect(tab.sink.current!.isSubmittingClaim('CYBER_FIVE')).toBe(true)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Cleared again once the .then continuation runs.
    await waitFor(() => {
      expect(tab.sink.current!.isSubmittingClaim('CYBER_FIVE')).toBe(false)
    })

    tab.unmount()
  })

  it('is cleared again after the .catch rejection continuation runs (failure)', async () => {
    const client = mockClient!
    const tab = await mountConsistentSession(client)

    client.queueRpcError('submit_claim', 'validation failed', 'NOT_ELIGIBLE')

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'SECURITY_LINE',
      })
    })

    expect(tab.sink.current!.isSubmittingClaim('SECURITY_LINE')).toBe(true)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await waitFor(() => {
      expect(tab.sink.current!.isSubmittingClaim('SECURITY_LINE')).toBe(false)
    })

    tab.unmount()
  })

  it('is independent per prizeId: submitting for one prize does not report true for a different prize', async () => {
    const client = mockClient!
    const tab = await mountConsistentSession(client)

    // Queue a response for the RPC call (assertions below run
    // synchronously, before this promise has a chance to settle, so the
    // lock for CYBER_FIVE is still set at the point they run).
    client.queueRpcResponse('submit_claim', { data: buildClaimRow({ id: 'SERVER_CLAIM_INDEP' }) })

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
    })

    expect(tab.sink.current!.isSubmittingClaim('CYBER_FIVE')).toBe(true)
    // A different prize's lock is independently false.
    expect(tab.sink.current!.isSubmittingClaim('FIREWALL_LINE')).toBe(false)
    expect(tab.sink.current!.isSubmittingClaim('SECURITY_LINE')).toBe(false)
    expect(tab.sink.current!.isSubmittingClaim('DATA_DEFENDER_LINE')).toBe(false)
    expect(tab.sink.current!.isSubmittingClaim('CYBER_FULL_HOUSE')).toBe(false)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    tab.unmount()
  })
})
