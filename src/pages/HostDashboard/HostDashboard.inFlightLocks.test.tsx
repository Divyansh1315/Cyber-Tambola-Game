// Feature: G1 (Reveal in-flight lock) + G6 (Confirm/Reject in-flight lock)
// -- multiplayer-reliability fix pass.
//
// G1 verifies the "Next Cyber Word" button is now a genuine promise-based
// in-flight lock (GameSessionContext.tsx's wrappedDispatch returning a
// Promise<void> that settles with the real call_next_word RPC), replacing
// the previous fixed 800ms cooldown: the button must stay disabled for
// exactly the RPC's actual duration, re-enable on both success and failure,
// and never allow a second RPC call while the first is still pending.
//
// G6 verifies the same pattern for Confirm/Reject, scoped PER CLAIM id so
// unrelated claims are never blocked.
//
// Mirrors realtimeConnectionRecovery.integration.test.tsx's exact mocking
// convention: realtimeClient.ts's exported functions close over that
// module's own private getSupabaseClient singleton, so they are
// reimplemented below as thin pass-throughs against `mockClient`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import {
  createMockSupabaseClient,
  type MockSupabaseClient,
} from '../../state/testSupport/mockSupabaseClient'

let mockClient: MockSupabaseClient | null = null

vi.mock('../../state/realtimeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/realtimeClient')>()

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

  async function rejectClaim(claimId: string, hostSecret: string, reason?: string) {
    const supabase = getSupabaseClient()
    if (!supabase) throw new Error('no mock client configured')
    const { data, error } = await supabase.rpc('reject_claim', {
      p_claim_id: claimId,
      p_host_secret: hostSecret,
      p_reason: reason,
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
    confirmClaim,
    rejectClaim,
  }
})

import { GameSessionProvider } from '../../state/GameSessionContext'
import { HostDashboard } from './HostDashboard'

function buildGameRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'GAME_A',
    code: 'CYBER24',
    host_secret: 'secret-a',
    status: 'WORD_ACTIVE',
    current_round: 1,
    current_term_id: 'TERM_001',
    previous_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <GameSessionProvider>
        <HostDashboard />
      </GameSessionProvider>
    </MemoryRouter>,
  )
}

/** Resolves one microtask/pending-timer tick without advancing real time. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  mockClient = createMockSupabaseClient()
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')
})

afterEach(() => {
  // Several tests deliberately leave an RPC call unresolved (to assert the
  // in-flight disabled state) -- explicitly unmount the previous test's
  // component tree before the next test's beforeEach swaps in a fresh
  // mockClient, so a late-settling promise from an abandoned component
  // instance can never bleed a stray act()/state-update into a later test.
  cleanup()
  vi.unstubAllEnvs()
  mockClient = null
})

/** Mounts HostDashboard against a hydrated WORD_ACTIVE game with no claims. */
async function mountHydratedDashboard() {
  mockClient!.queueRpcResponse('get_active_game', { data: [buildGameRow()], error: null })
  mockClient!.queueFromResponse('players', { data: [], error: null })
  mockClient!.queueFromResponse('tickets', { data: [], error: null })
  mockClient!.queueFromResponse('marks', { data: [], error: null })
  mockClient!.queueFromResponse('claims', { data: [], error: null })
  mockClient!.queueFromResponse('winners', { data: [], error: null })
  mockClient!.queueFromResponse('called_terms', { data: [{ term_id: 'TERM_001' }], error: null })
  const utils = renderDashboard()
  await flush()
  await waitFor(() => expect(screen.getAllByText('CYBER24').length).toBeGreaterThan(0))
  return utils
}

/** Mounts HostDashboard against a hydrated game with one PENDING valid claim. */
async function mountHydratedDashboardWithClaim(claimId: string) {
  mockClient!.queueRpcResponse('get_active_game', { data: [buildGameRow()], error: null })
  mockClient!.queueFromResponse('players', {
    data: [{ id: 'P_1', game_id: 'GAME_A', display_name: 'Alex' }],
    error: null,
  })
  mockClient!.queueFromResponse('tickets', {
    data: [
      {
        id: 'T_1',
        game_id: 'GAME_A',
        player_id: 'P_1',
        ref: 'AB12',
        signature: 'TERM_001',
        cells: [{ termId: 'TERM_001', row: 0, col: 0 }],
      },
    ],
    error: null,
  })
  mockClient!.queueFromResponse('marks', { data: [], error: null })
  mockClient!.queueFromResponse('claims', {
    data: [
      {
        id: claimId,
        game_id: 'GAME_A',
        player_id: 'P_1',
        ticket_id: 'T_1',
        prize_id: 'CYBER_FIVE',
        submitted_at: '2026-01-01T10:00:00.000Z',
        validation_status: 'VALID',
        host_decision: 'PENDING',
        rejection_reason: null,
        decided_at: null,
        prize_label: 'Cyber Five',
        player_name: 'Alex',
        ticket_ref: 'AB12',
      },
    ],
    error: null,
  })
  mockClient!.queueFromResponse('winners', { data: [], error: null })
  mockClient!.queueFromResponse('called_terms', { data: [{ term_id: 'TERM_001' }], error: null })
  const utils = renderDashboard()
  await flush()
  await waitFor(() => expect(screen.getAllByText('Cyber Five').length).toBeGreaterThan(0))
  return utils
}

describe('G1 — Host Reveal (Next Cyber Word) in-flight protection', () => {
  it('1. Two rapid clicks invoke call_next_word only once', async () => {
    await mountHydratedDashboard()

    // call_next_word is left unresolved deliberately (no queued response),
    // so the lock stays set across both clicks within this synchronous
    // act() block -- fireEvent.click (unlike userEvent.click) dispatches
    // synchronously with no internal await between the two clicks, exactly
    // simulating two rapid taps before any RPC round trip could settle.
    const button = screen.getByRole('button', { name: /next cyber word|calling/i })
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })

    const callNextWordCalls = mockClient!.rpcCalls.filter((c) => c.name === 'call_next_word')
    expect(callNextWordCalls).toHaveLength(1)
  })

  it('2. The button remains disabled while the RPC is pending', async () => {
    await mountHydratedDashboard()

    const button = screen.getByRole('button', { name: /next cyber word/i })
    expect(button).not.toBeDisabled()

    act(() => {
      fireEvent.click(button)
    })

    expect(button).toBeDisabled()
    expect(button).toHaveTextContent(/calling/i)
  })

  it('3. The button becomes enabled after success when gameplay permits', async () => {
    await mountHydratedDashboard()

    const button = screen.getByRole('button', { name: /next cyber word/i })
    mockClient!.queueRpcResponse('call_next_word', {
      data: buildGameRow({ current_round: 2, current_term_id: 'TERM_012' }),
      error: null,
    })

    act(() => {
      fireEvent.click(button)
    })
    expect(button).toBeDisabled()

    await flush()

    await waitFor(() => expect(button).not.toBeDisabled())
    expect(button).toHaveTextContent(/next cyber word/i)
  })

  it('4. The button becomes enabled after failure', async () => {
    await mountHydratedDashboard()

    const button = screen.getByRole('button', { name: /next cyber word/i })
    mockClient!.queueRpcError('call_next_word', 'nope', 'NOT_AUTHORIZED')

    act(() => {
      fireEvent.click(button)
    })
    expect(button).toBeDisabled()

    await flush()

    await waitFor(() => expect(button).not.toBeDisabled())
  })

  it('5. An RPC failure does not advance the displayed word falsely', async () => {
    await mountHydratedDashboard()

    const roundBefore = screen.getByText(/1 \//).textContent
    const button = screen.getByRole('button', { name: /next cyber word/i })
    mockClient!.queueRpcError('call_next_word', 'nope', 'NOT_AUTHORIZED')

    act(() => {
      fireEvent.click(button)
    })
    await flush()

    // Round/term must still read exactly what it did before the failed
    // attempt -- CALL_NEXT_WORD never optimistically applies locally when
    // Supabase is configured (unchanged GameSessionContext.tsx behavior),
    // so a rejected RPC must never have advanced anything to roll back.
    expect(screen.getByText(/1 \//).textContent).toBe(roundBefore)
  })

  it('6. Existing canCallNext behaviour remains unchanged (disabled when not WORD_ACTIVE)', async () => {
    mockClient!.queueRpcResponse('get_active_game', {
      data: [buildGameRow({ status: 'LOBBY', current_term_id: null })],
      error: null,
    })
    mockClient!.queueFromResponse('players', { data: [], error: null })
    mockClient!.queueFromResponse('tickets', { data: [], error: null })
    mockClient!.queueFromResponse('marks', { data: [], error: null })
    mockClient!.queueFromResponse('claims', { data: [], error: null })
    mockClient!.queueFromResponse('winners', { data: [], error: null })
    mockClient!.queueFromResponse('called_terms', { data: [], error: null })
    renderDashboard()
    await flush()
    await waitFor(() => expect(screen.getAllByText('CYBER24').length).toBeGreaterThan(0))

    const button = screen.getByRole('button', { name: /next cyber word/i })
    expect(button).toBeDisabled() // LOBBY status -> canCallNext is false, unchanged
  })
})

describe('G6 — Host Confirm/Reject in-flight protection', () => {
  it('1. Two rapid Confirm clicks produce only one RPC call', async () => {
    await mountHydratedDashboardWithClaim('CLAIM_1')

    const confirmButton = screen.getByRole('button', { name: /confirm winner|processing/i })
    act(() => {
      fireEvent.click(confirmButton)
      fireEvent.click(confirmButton)
    })

    const confirmCalls = mockClient!.rpcCalls.filter((c) => c.name === 'confirm_claim')
    expect(confirmCalls).toHaveLength(1)
  })

  it('2. Two rapid Reject clicks produce only one RPC call', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Duplicate / already won')
    await mountHydratedDashboardWithClaim('CLAIM_1')

    const rejectButton = screen.getByRole('button', { name: /^reject$|processing/i })
    act(() => {
      fireEvent.click(rejectButton)
      fireEvent.click(rejectButton)
    })

    const rejectCalls = mockClient!.rpcCalls.filter((c) => c.name === 'reject_claim')
    expect(rejectCalls).toHaveLength(1)
  })

  it('3. Clicking Confirm then Reject rapidly on the same claim produces only one decision request', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Duplicate / already won')
    await mountHydratedDashboardWithClaim('CLAIM_1')

    const confirmButton = screen.getByRole('button', { name: /confirm winner|processing/i })
    const rejectButtonBefore = screen.getByRole('button', { name: /^reject$|processing/i })
    act(() => {
      fireEvent.click(confirmButton)
      // Reject is now disabled too (same claim id's lock) -- clicking it is
      // a no-op, in the SAME synchronous act() block as the Confirm click
      // above, simulating a user clicking both rapidly.
      fireEvent.click(rejectButtonBefore)
    })

    const confirmCalls = mockClient!.rpcCalls.filter((c) => c.name === 'confirm_claim')
    const rejectCalls = mockClient!.rpcCalls.filter((c) => c.name === 'reject_claim')
    expect(confirmCalls).toHaveLength(1)
    expect(rejectCalls).toHaveLength(0)
  })

  it('4. The affected claim\'s buttons remain disabled while pending', async () => {
    await mountHydratedDashboardWithClaim('CLAIM_1')

    const confirmButton = screen.getByRole('button', { name: /confirm winner/i })
    const rejectButton = screen.getByRole('button', { name: /^reject$/i })
    expect(confirmButton).not.toBeDisabled()
    expect(rejectButton).not.toBeDisabled()

    act(() => {
      fireEvent.click(confirmButton)
    })

    // Both buttons for this row show the Processing label while pending.
    const processingButtons = screen.getAllByRole('button', { name: /processing/i })
    expect(processingButtons).toHaveLength(2)
    for (const btn of processingButtons) {
      expect(btn).toBeDisabled()
    }
  })

  it('5. The lock clears after success', async () => {
    await mountHydratedDashboardWithClaim('CLAIM_1')

    mockClient!.queueRpcResponse('confirm_claim', {
      data: {
        id: 'W_1',
        game_id: 'GAME_A',
        prize_id: 'CYBER_FIVE',
        player_id: 'P_1',
        ticket_id: 'T_1',
        claim_id: 'CLAIM_1',
        confirmed_at: '2026-01-01T10:05:00.000Z',
        prize_label: 'Cyber Five',
        player_name: 'Alex',
        ticket_ref: 'AB12',
      },
      error: null,
    })

    const confirmButton = screen.getByRole('button', { name: /confirm winner/i })
    act(() => {
      fireEvent.click(confirmButton)
    })
    await flush()

    // Once resolved, the claim moves out of "Pending Claims" into
    // "Confirmed" -- its Confirm/Reject buttons there are naturally
    // disabled by canConfirmClaim/hostDecision gating, not by a stuck lock.
    // What matters here is that no button is left showing "Processing…".
    await waitFor(() => expect(screen.queryByText(/processing/i)).toBeNull())
  })

  it('6. The lock clears after failure', async () => {
    await mountHydratedDashboardWithClaim('CLAIM_1')

    mockClient!.queueRpcError('confirm_claim', 'already confirmed', 'CLAIM_NOT_CONFIRMABLE')

    const confirmButton = screen.getByRole('button', { name: /confirm winner/i })
    act(() => {
      fireEvent.click(confirmButton)
    })
    expect(screen.getAllByRole('button', { name: /processing/i })).toHaveLength(2)

    await flush()

    // The lock itself clears regardless of outcome -- no button is left
    // reading "Processing…" once the rejected RPC settles. (Separately,
    // pre-existing/unchanged behavior: CONFIRM_CLAIM's optimistic dispatch
    // marks the claim CONFIRMED immediately, and ROLLBACK_OPTIMISTIC on
    // rejection only removes the optimistic Winner row -- it does not
    // revert the claim's hostDecision back to PENDING. That gap predates
    // this fix and is out of scope for G6, which only adds the in-flight
    // lock; it does not alter existing rollback/reconciliation behavior.)
    await waitFor(() => expect(screen.queryByText(/processing/i)).toBeNull())
  })

  it('7. Actions on unrelated claims are not unnecessarily blocked', async () => {
    mockClient!.queueRpcResponse('get_active_game', { data: [buildGameRow()], error: null })
    mockClient!.queueFromResponse('players', {
      data: [
        { id: 'P_1', game_id: 'GAME_A', display_name: 'Alex' },
        { id: 'P_2', game_id: 'GAME_A', display_name: 'Sam' },
      ],
      error: null,
    })
    mockClient!.queueFromResponse('tickets', {
      data: [
        {
          id: 'T_1',
          game_id: 'GAME_A',
          player_id: 'P_1',
          ref: 'AB12',
          signature: 'TERM_001',
          cells: [{ termId: 'TERM_001', row: 0, col: 0 }],
        },
        {
          id: 'T_2',
          game_id: 'GAME_A',
          player_id: 'P_2',
          ref: 'CD34',
          signature: 'TERM_012',
          cells: [{ termId: 'TERM_012', row: 0, col: 0 }],
        },
      ],
      error: null,
    })
    mockClient!.queueFromResponse('marks', { data: [], error: null })
    mockClient!.queueFromResponse('claims', {
      data: [
        {
          id: 'CLAIM_1',
          game_id: 'GAME_A',
          player_id: 'P_1',
          ticket_id: 'T_1',
          prize_id: 'CYBER_FIVE',
          submitted_at: '2026-01-01T10:00:00.000Z',
          validation_status: 'VALID',
          host_decision: 'PENDING',
          rejection_reason: null,
          decided_at: null,
          prize_label: 'Cyber Five',
          player_name: 'Alex',
          ticket_ref: 'AB12',
        },
        {
          id: 'CLAIM_2',
          game_id: 'GAME_A',
          player_id: 'P_2',
          ticket_id: 'T_2',
          prize_id: 'FIREWALL_LINE',
          submitted_at: '2026-01-01T10:01:00.000Z',
          validation_status: 'VALID',
          host_decision: 'PENDING',
          rejection_reason: null,
          decided_at: null,
          prize_label: 'Firewall Line',
          player_name: 'Sam',
          ticket_ref: 'CD34',
        },
      ],
      error: null,
    })
    mockClient!.queueFromResponse('winners', { data: [], error: null })
    mockClient!.queueFromResponse('called_terms', { data: [{ term_id: 'TERM_001' }], error: null })
    renderDashboard()
    await flush()
    await waitFor(() => expect(screen.getAllByText('Cyber Five').length).toBeGreaterThan(0))

    const confirmButtons = screen.getAllByRole('button', { name: /confirm winner/i })
    expect(confirmButtons).toHaveLength(2)

    // Confirm claim 1 only -- leave its RPC pending.
    act(() => {
      fireEvent.click(confirmButtons[0])
    })

    // Claim 2's buttons must remain fully enabled.
    const stillEnabled = screen.getAllByRole('button', { name: /confirm winner/i })
    expect(stillEnabled).toHaveLength(1) // claim 1's button now reads "Processing…"
    expect(stillEnabled[0]).not.toBeDisabled()
  })

  it('8. Existing winner uniqueness and claim reconciliation behaviour remains unchanged', async () => {
    await mountHydratedDashboardWithClaim('CLAIM_1')

    // confirm_claim itself still enforces PRIZE_CLOSED/uniqueness server
    // side (unchanged RPC); the client-side lock added here does not alter
    // that outcome -- a failed confirm (e.g. already-closed prize) still
    // surfaces via the existing rollback path, unchanged by this fix.
    mockClient!.queueRpcError('confirm_claim', 'already closed', 'PRIZE_CLOSED')

    const confirmButton = screen.getByRole('button', { name: /confirm winner/i })
    act(() => {
      fireEvent.click(confirmButton)
    })
    await flush()

    const rpcArgs = mockClient!.rpcCalls.find((c) => c.name === 'confirm_claim')?.args
    expect(rpcArgs).toEqual({ p_claim_id: 'CLAIM_1', p_host_secret: 'secret-a' })
    // No Winner was created from the failed confirm.
    expect(screen.queryByText(/Alex —/)).toBeNull()
  })
})
