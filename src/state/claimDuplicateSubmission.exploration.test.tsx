// Spec: claim-duplicate-submission — task 1 (bug condition exploration test,
// written BEFORE the fix per bugfix workflow).
//
// Property 1: Bug Condition - Single Submission Produces Exactly One
// Reconciled Claim Entry (design.md Correctness Properties).
//
// Reproduces the reported incident: a Player clicks "Claim [Prize]" once.
// `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` case (`GameSessionContext.tsx`)
// mints an optimistic `PrizeClaim` with a client-local id and dispatches it
// immediately, then calls `rpcSubmitClaim(...).catch(rollback)` with NO
// `.then` -- the RPC's resolved `ClaimRow` (server `id`) is read nowhere.
// Separately, a realtime `claims` INSERT event for that same row is folded
// in via `SYNC_REMOTE` -> `upsertById`, which matches purely by `.id` and
// therefore appends a second, differently-id'd entry rather than replacing
// the optimistic one.
//
// Uses the same mock Supabase client harness and `vi.mock('./realtimeClient',
// ...)` thin-pass-through convention established by
// `GameSessionContext.multiTabReset.integration.test.tsx` and
// `sessionConsistencyGuard.exploration.test.tsx` (prior
// `claim-player-ticket-identity-mismatch` spec).
//
// Originally run on UNFIXED code, where these assertions demonstrated the
// duplicate-entry counterexample. Per task 12.1, this file's assertions have
// now been updated IN PLACE to verify the FIXED code: `wrappedDispatch`'s
// `SUBMIT_PRIZE_CLAIM` case now chains a `.then` on `rpcSubmitClaim` that
// dispatches `RECONCILE_CLAIM_ID`, swapping the optimistic entry for the
// server-confirmed `ClaimRow` in place before any realtime echo's
// `SYNC_REMOTE` -> `upsertById` lookup runs. These same scenarios now assert
// exactly ONE reconciled entry survives in both echo orderings (design.md
// Property 1: Single Submission Produces Exactly One Reconciled Claim
// Entry). The rapid-double-click-race case is unchanged: it only tests the
// raw `rpcSubmitClaim` call count at the `wrappedDispatch` level, which is
// still ungated there (the `isSubmittingClaim` lock added by task 5/6 only
// disables the Claim button in `PlayerGame.tsx`, not this dispatch path) --
// so this one still demonstrates the same client-side RPC-call-count
// behavior as before.
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.8
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

/** Builds a `submit_claim`/claims-row-shaped server response. */
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
 * for GAME_A -- satisfying the `claim-player-ticket-identity-mismatch`
 * guard's `isConsistent` check so a dispatched SUBMIT_PRIZE_CLAIM actually
 * reaches `rpcSubmitClaim` rather than being blocked by the guard.
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

describe('Bug condition exploration: single claim submission reconciles to exactly one entry (fixed code)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = createMockSupabaseClient()
  })

  it('single-click-produces-exactly-one-entry: optimistic entry is reconciled with the realtime echo, not duplicated', async () => {
    const client = mockClient!
    const tab = await mountConsistentSession(client)

    const claimsBeforeSubmit = tab.sink.current!.state.claims.length

    // Queue the submit_claim RPC's eventual response -- the server's
    // authoritative ClaimRow, with an id that structurally differs from the
    // client-minted optimistic id. The mock's thin pass-through `submitClaim`
    // (registered via this file's `vi.mock('./realtimeClient', ...)` above)
    // returns `data` as-is, exactly like the real `callRpc`/`submitClaim` --
    // so `data` must be the single row object itself, not an array, matching
    // the convention already established by
    // `claimDuplicateSubmission.regression.integration.test.tsx`.
    const serverRow = buildClaimRow({ id: 'SERVER_CLAIM_1' })
    client.queueRpcResponse('submit_claim', { data: serverRow })

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
    })

    // The optimistic entry is dispatched synchronously -- read its id now,
    // before the RPC promise has had a chance to settle.
    expect(tab.sink.current!.state.claims.length).toBe(claimsBeforeSubmit + 1)
    const optimisticEntry = tab.sink.current!.state.claims[tab.sink.current!.state.claims.length - 1]
    const optimisticId = optimisticEntry.id
    expect(optimisticId).not.toBe('SERVER_CLAIM_1')

    // Let the queued submit_claim RPC resolve.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // *** Fixed behavior ***
    // On fixed code, rpcSubmitClaim(...)'s `.then` dispatches
    // RECONCILE_CLAIM_ID, which replaces the optimistic entry in place with
    // the server-confirmed ClaimRow -- the entry count does not change, but
    // the surviving entry's id is now the server's id, not the optimistic
    // one.
    expect(tab.sink.current!.state.claims.length).toBe(claimsBeforeSubmit + 1)

    // Now fire the realtime echo for that same server row. Since the entry
    // has already been reconciled to the server's id, SYNC_REMOTE's
    // upsertById finds a match on first lookup and updates in place rather
    // than appending a second entry.
    act(() => {
      client.fireRemoteChange({ table: 'claims', eventType: 'INSERT', row: serverRow })
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.claims.length).toBe(claimsBeforeSubmit + 1)
    })

    const claimsForPrize = tab.sink.current!.state.claims.filter(
      (c) => c.playerId === 'P_A1' && c.prizeId === 'CYBER_FIVE',
    )
    // *** Fix verified: exactly one entry survives for one real-world click ***
    expect(claimsForPrize.length).toBe(1)
    expect(claimsForPrize[0].id).toBe('SERVER_CLAIM_1')
    expect(claimsForPrize[0].id).not.toBe(optimisticId)

    tab.unmount()
  })

  it('realtime-echo-arrives-before-rpc-resolves: duplication does not occur regardless of ordering', async () => {
    const client = mockClient!
    const tab = await mountConsistentSession(client)

    const claimsBeforeSubmit = tab.sink.current!.state.claims.length

    const serverRow = buildClaimRow({ id: 'SERVER_CLAIM_2' })
    // Queue the RPC response but do NOT let it resolve yet -- fire the
    // realtime echo first, simulating Realtime's typical latency advantage
    // over a slower RPC round trip.
    client.queueRpcResponse('submit_claim', { data: serverRow })

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
    })

    expect(tab.sink.current!.state.claims.length).toBe(claimsBeforeSubmit + 1)

    // Fire the realtime echo BEFORE the RPC promise's own .then/.catch has
    // had a chance to run. On fixed code, the optimistic entry has not yet
    // been reconciled at this point, so SYNC_REMOTE's upsertById does not
    // find a matching id and appends the server row as a second entry --
    // momentarily duplicating.
    act(() => {
      client.fireRemoteChange({ table: 'claims', eventType: 'INSERT', row: serverRow })
    })

    await waitFor(() => {
      expect(tab.sink.current!.state.claims.length).toBe(claimsBeforeSubmit + 2)
    })

    // Now let the submit_claim RPC promise itself resolve. Its `.then`
    // dispatches RECONCILE_CLAIM_ID, which replaces the (still-present)
    // optimistic entry in place with the confirmed claim -- since the
    // echoed server row is already present too, this converges back down
    // to a single entry for the submission.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await waitFor(() => {
      const claimsForPrizeNow = tab.sink.current!.state.claims.filter(
        (c) => c.playerId === 'P_A1' && c.prizeId === 'CYBER_FIVE',
      )
      expect(claimsForPrizeNow.length).toBe(1)
    })

    const claimsForPrize = tab.sink.current!.state.claims.filter(
      (c) => c.playerId === 'P_A1' && c.prizeId === 'CYBER_FIVE',
    )
    // *** Fix verified: duplication does not occur regardless of ordering ***
    expect(claimsForPrize.length).toBe(1)
    expect(claimsForPrize[0].id).toBe('SERVER_CLAIM_2')

    tab.unmount()
  })

  it('wrong-ticket-mechanism-check: ticketRef on the single surviving entry is correct', async () => {
    const client = mockClient!
    const tab = await mountConsistentSession(client)

    const claimsBeforeSubmit = tab.sink.current!.state.claims.length
    const serverRow = buildClaimRow({ id: 'SERVER_CLAIM_3', ticket_ref: '6405' })
    client.queueRpcResponse('submit_claim', { data: serverRow })

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
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
      expect(tab.sink.current!.state.claims.length).toBe(claimsBeforeSubmit + 1)
    })

    const claimsForPrize = tab.sink.current!.state.claims.filter(
      (c) => c.playerId === 'P_A1' && c.prizeId === 'CYBER_FIVE',
    )
    // *** Mechanism-check finding, now moot post-fix ***
    // On unfixed code this case originally compared ticketRef across a
    // duplicate pair of entries to determine whether the "wrong ticket"
    // symptom shared the same mechanism as the duplicate-entry bug (it
    // did -- both resolved to the same, correct Ticket row, just rendered
    // twice). Now that RECONCILE_CLAIM_ID (task 3-4) and the echo-ordering
    // fix (task 10) ensure exactly one entry survives, there is no
    // duplicate pair left to compare. The question this case asked is
    // therefore moot. What remains worth asserting is that the ticket
    // reference on the single surviving entry is still correct for this
    // player (Req 2.8).
    expect(claimsForPrize.length).toBe(1)
    expect(claimsForPrize[0].ticketRef).toBe('6405')

    tab.unmount()
  })

  it('rapid-double-click-race: two near-simultaneous dispatches both call rpcSubmitClaim with no client-side guard', async () => {
    const client = mockClient!
    const tab = await mountConsistentSession(client)

    const rpcCallsBefore = client.rpcCalls.filter((c) => c.name === 'submit_claim').length

    // Queue two separate successful submit_claim responses -- simulating
    // both having passed Gate 7 before either commits its INSERT (the
    // actual DB-level race cannot be reproduced against this mock harness,
    // which has no real transactional database; here we are validating the
    // CLIENT's lack of any guard against firing the second call at all).
    client.queueRpcResponse('submit_claim', { data: buildClaimRow({ id: 'SERVER_CLAIM_RACE_1' }) })
    client.queueRpcResponse('submit_claim', { data: buildClaimRow({ id: 'SERVER_CLAIM_RACE_2' }) })

    act(() => {
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
      // Second dispatch for the SAME (player, prize) in the same
      // synchronous tick -- simulating a rapid double-click/double-tap.
      tab.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: 'P_A1',
        ticketId: 'T_A1',
        prizeId: 'CYBER_FIVE',
      })
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const submitClaimCalls = client.rpcCalls.filter((c) => c.name === 'submit_claim')
    // *** Still accurate on fixed code ***
    // The isSubmittingClaim lock added by tasks 5-6 only disables the Claim
    // button in PlayerGame.tsx -- wrappedDispatch's SUBMIT_PRIZE_CLAIM case
    // itself has no client-side guard against a second raw dispatch, so
    // both dispatches here still independently reach rpcSubmitClaim,
    // resulting in two RPC calls for one rapid double-click at this level.
    // The UI-level protection is covered separately by the regression
    // tests in task 10.
    expect(submitClaimCalls.length).toBe(rpcCallsBefore + 2)

    tab.unmount()
  })
})
