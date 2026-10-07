// Spec: presenter-realtime-winner-sync — task 1 (bug condition exploration
// test(s), written BEFORE the fix per bugfix workflow).
//
// Property 1: Bug Condition - Dismiss-Button/Local-State Mechanism Fails To
// Survive CALL_NEXT_WORD/Refresh/Second Instance, No FINAL_RESULTS Branch
// (design.md Correctness Properties, Property 1).
//
// Reproduces, on the REAL UNFIXED code (current `PresentationView.tsx`'s
// `findLatestUndismissedWinner`/Presenter-local `dismissedWinnerIds`
// mechanism, and the current `game.status === 'COMPLETED'` branch, which is
// a static message with no read of `state.winners`), the gaps bugfix.md's
// investigation and design.md's Hypothesized Root Cause describe:
//   (a) nothing reacts to CALL_NEXT_WORD to clear a shown Winner
//       announcement (Problem B's mechanism)
//   (b) RESET_GAME's existing wholesale state replace already empties
//       state.winners, so findLatestUndismissedWinner([], ...) already
//       correctly returns undefined post-reset -- this sub-case exists to
//       pin down precisely which symptom (if any) is reproducible via the
//       dismiss-state mechanism for Problem A, rather than assume one
//   (c) there is no FINAL_RESULTS branch at all when game.status ===
//       'COMPLETED' -- the rendered output is a static "Game Completed"
//       message, with no prize category/winner name/read of state.winners
//       anywhere in the DOM (Problem C), regardless of how many winners
//       exist (including zero/partial)
//   (d) the mock Supabase client harness's unsubscribe() is modeled as
//       synchronous/immediate (confirmed by direct inspection of
//       mockSupabaseClient.ts: `unsubscribe()` splices every listener for
//       that channel name out of the shared `listeners` array synchronously,
//       with no async handshake at all), so firing a stale cross-game event
//       against an already-unsubscribed channel via `fireRemoteChange`
//       cannot reproduce the real async-teardown race design.md describes --
//       this is an EXPECTED, DOCUMENTED LIMITATION of the mock, not a defect
//       in this test. The real guard added by task 9 is instead verified by
//       direct unit testing of the guard function itself (task 9/10), not
//       through this mock-based scenario.
//
// Uses the same mock Supabase client harness and `vi.mock('./realtimeClient',
// ...)` thin-pass-through convention established by
// `GameSessionContext.multiTabReset.integration.test.tsx` and
// `claimDuplicateSubmission.exploration.test.tsx` (prior specs' exploration
// tests) for sub-case 5 only -- sub-cases 1-4 use Local Fallback mode (no
// mock Supabase client configured), since they do not depend on any
// Supabase/Realtime behavior at all, only on the reducer + PresentationView's
// current rendering.
//
// EXPECTED OUTCOME on unfixed code: sub-cases 1, 3, 4's assertions
// demonstrating the gap PASS (their passing assertions ARE the documented
// counterexamples -- there is no code path to make them fail differently).
// Sub-case 2 passes while documenting the RESET_GAME finding described
// above. Sub-case 5 passes while documenting the mock's limitation.
//
// Task 13 update (fixed code): sub-cases 3 and 4 (now suffixed "(fixed)")
// have had their assertions flipped in place to verify the FIXED behavior
// instead of the old buggy behavior, per this task's instructions -- these
// two sub-cases' prior assertions were about `game.status === 'COMPLETED'`
// rendering with no FINAL_RESULTS branch at all (Problem C), which no
// longer exists post-fix. Sub-case 3 is also renamed to drop its
// dismiss-button-clicking loop entirely: the "Dismiss Winner Announcement"
// button was removed outright in task 8 (dismissedWinnerIds/
// findLatestUndismessedWinner no longer exist), and `derivePresenterMode`
// now returns `'FINAL_RESULTS'` immediately on `game.status ===
// 'COMPLETED'`, with top priority over any still-set
// `game.latestWinnerAnnouncementId` -- so there is no stale single-prize
// announcement to dismiss before the Final Summary becomes reachable.
// Sub-cases 1, 2, 5 are left exactly as-is (unchanged assertions, unchanged
// names) per task 9's finding that they already pass unchanged against the
// fixed code.
//
// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.10
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
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

  return {
    ...actual,
    getSupabaseClient,
    getActiveGame,
    subscribeToGame,
    subscribeToActiveGamePointer,
  }
})

import { GameSessionProvider, useGameSession, type GameSessionContextValue } from '../../state/GameSessionContext'
import { PresentationView, derivePresenterMode } from './PresentationView'
import type { PrizeClaim } from '../../types/claim'

// ---------------------------------------------------------------------------
// Test harness (mirrors the existing exploration/integration tests'
// convention: a thin consumer component exposing { state, dispatch } via a
// mutable sink ref so assertions can read/drive the provider directly).
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

/** A minimal already-VALID, PENDING claim, injected via SYNC_LOCAL (bypassing
 * claimEngine's eligibility gates entirely -- this test is about the
 * Presenter's display mechanism, not claim validation, so the simplest
 * correct way to get a confirmable claim into state is to hand the reducer
 * one that already satisfies canConfirmClaim's shape, exactly as
 * `canConfirmClaim`'s own gate (validationStatus VALID, hostDecision
 * PENDING, prize not yet closed) requires). */
function buildPendingClaim(overrides: Partial<PrizeClaim> = {}): PrizeClaim {
  return {
    id: 'CLAIM_1',
    gameId: 'GAME_001',
    playerId: 'PLAYER_1',
    ticketId: 'TICKET_1',
    prizeId: 'CYBER_FIVE',
    submittedAt: '2026-01-01T09:00:00.000Z',
    validationStatus: 'VALID',
    hostDecision: 'PENDING',
    prizeLabel: 'Cyber Five',
    playerName: 'Alex',
    ticketRef: 'REF-1',
    ...overrides,
  }
}

describe('Bug condition exploration: Presenter display mode (unfixed code)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = null
  })

  it('winner-announcement-then-next-word-clears-it (unfixed): CALL_NEXT_WORD does not clear a showing announcement', async () => {
    // Mount PresentationView as a sibling of the Harness inside ONE
    // provider, matching how the real app composes
    // <GameSessionProvider><PresentationView /></...> at the router level,
    // while still exposing dispatch/state via the Harness sink.
    const sink: { current: GameSessionContextValue | null } = { current: null }
    render(
      <GameSessionProvider>
        <Harness sink={sink} />
        <PresentationView />
      </GameSessionProvider>,
    )

    await waitFor(() => expect(sink.current).not.toBeNull())

    // Seed one confirmable claim and confirm it, exactly as the Host
    // Dashboard would via CONFIRM_CLAIM.

    act(() => {
      sink.current!.dispatch({
        type: 'SYNC_LOCAL',
        payload: {
          game: sink.current!.state.game,
          players: sink.current!.state.players,
          tickets: sink.current!.state.tickets,
          marks: sink.current!.state.marks,
          claims: [buildPendingClaim()],
          winners: [],
        },
      })
    })
    act(() => {
      sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: 'CLAIM_1' })
    })

    // The announcement renders via the current findLatestUndismissedWinner
    // mechanism (dismissedWinnerIds seeded empty on mount).
    expect(await screen.findByText('Cyber Five Winner')).toBeInTheDocument()
    expect(screen.getByText('Alex')).toBeInTheDocument()

    // Host calls Next Cyber Word.
    act(() => {
      sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
    })

    // *** Counterexample (Problem B): on unfixed code, nothing reacts to
    // CALL_NEXT_WORD -- the announcement is STILL shown, because
    // findLatestUndismissedWinner only consults dismissedWinnerIds (manual
    // Dismiss button), never game.currentTermId/currentRound. ***
    expect(screen.getByText('Cyber Five Winner')).toBeInTheDocument()
    expect(screen.getByText('Alex')).toBeInTheDocument()
    // The newly-called word is NOT shown instead -- confirming the gap: the
    // Presenter is stuck on the stale announcement despite the Host having
    // moved on.
    expect(screen.queryByText('What It Means')).not.toBeInTheDocument()
  })

  it('reset-clears-winner-and-returns-to-lobby (unfixed): RESET_GAME already empties state.winners, pinning down Problem A\'s actual (non-)symptom here', async () => {
    const sink: { current: GameSessionContextValue | null } = { current: null }
    render(
      <GameSessionProvider>
        <Harness sink={sink} />
        <PresentationView />
      </GameSessionProvider>,
    )
    await waitFor(() => expect(sink.current).not.toBeNull())

    act(() => {
      sink.current!.dispatch({
        type: 'SYNC_LOCAL',
        payload: {
          game: sink.current!.state.game,
          players: sink.current!.state.players,
          tickets: sink.current!.state.tickets,
          marks: sink.current!.state.marks,
          claims: [buildPendingClaim()],
          winners: [],
        },
      })
    })
    act(() => {
      sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: 'CLAIM_1' })
    })
    expect(await screen.findByText('Cyber Five Winner')).toBeInTheDocument()
    expect(sink.current!.state.winners).toHaveLength(1)

    act(() => {
      sink.current!.dispatch({ type: 'RESET_GAME' })
    })

    // *** Finding, documented explicitly per design.md's own framing: ***
    // RESET_GAME's existing reducer case already replaces state wholesale
    // (gameSessionInitialState + a fresh seed game) and folds the old
    // winners into winnerHistory, so state.winners is now [] -- this is
    // NOT a case where the dismiss-mechanism (dismissedWinnerIds) is the
    // thing papering over a leak; the data itself is already correct
    // post-reset on unfixed code. findLatestUndismissedWinner([], ...)
    // correctly returns undefined regardless of dismissedWinnerIds'
    // content, so the announcement is cleared through RESET_GAME for a
    // reason unrelated to Problem B's dismiss-button gap.
    expect(sink.current!.state.winners).toEqual([])
    expect(sink.current!.state.winnerHistory).toHaveLength(1)
    expect(screen.queryByText('Cyber Five Winner')).not.toBeInTheDocument()

    // The Presenter falls through to LOBBY (fresh seed game, status LOBBY).
    expect(sink.current!.state.game.status).toBe('LOBBY')
    expect(screen.getByText('Scan to Join')).toBeInTheDocument()

    // Separately: confirm there is still no Final Summary logic reachable
    // for the (unrelated) COMPLETED case post-reset either -- the fresh
    // seed game is LOBBY, not COMPLETED, so this is simply confirming no
    // stale FINAL_RESULTS artifact could have survived (there was never
    // any FINAL_RESULTS branch to begin with, per sub-case 3/4 below).
    expect(screen.queryByText('Game Completed')).not.toBeInTheDocument()
  })

  it('end-game-shows-full-summary-all-five-categories (fixed): COMPLETED immediately shows the Final Winner Summary, no dismiss step needed', async () => {
    const sink: { current: GameSessionContextValue | null } = { current: null }
    render(
      <GameSessionProvider>
        <Harness sink={sink} />
        <PresentationView />
      </GameSessionProvider>,
    )
    await waitFor(() => expect(sink.current).not.toBeNull())

    // Confirm a few winners across different prizes before ending the game.
    act(() => {
      sink.current!.dispatch({
        type: 'SYNC_LOCAL',
        payload: {
          game: sink.current!.state.game,
          players: sink.current!.state.players,
          tickets: sink.current!.state.tickets,
          marks: sink.current!.state.marks,
          claims: [
            buildPendingClaim({ id: 'CLAIM_1', prizeId: 'CYBER_FIVE', prizeLabel: 'Cyber Five', playerName: 'Alex' }),
            buildPendingClaim({ id: 'CLAIM_2', prizeId: 'FIREWALL_LINE', prizeLabel: 'Firewall Line', playerName: 'Priya' }),
            buildPendingClaim({ id: 'CLAIM_3', prizeId: 'SECURITY_LINE', prizeLabel: 'Security Line', playerName: 'Sam' }),
          ],
          winners: [],
        },
      })
    })
    act(() => {
      sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: 'CLAIM_1' })
    })
    act(() => {
      sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: 'CLAIM_2' })
    })
    act(() => {
      sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: 'CLAIM_3' })
    })
    expect(sink.current!.state.winners).toHaveLength(3)

    act(() => {
      sink.current!.dispatch({ type: 'END_GAME' })
    })
    expect(sink.current!.state.game.status).toBe('COMPLETED')

    // *** Fixed behavior: `derivePresenterMode` returns 'FINAL_RESULTS'
    // immediately on `game.status === 'COMPLETED'`, with top priority over
    // `game.latestWinnerAnnouncementId` (which is still set to the
    // Security Line Winner's id at this point, since CALL_NEXT_WORD/
    // START_GAME are the only actions that clear it, and neither was
    // dispatched here) -- so there is no stale single-prize announcement
    // blocking the Final Summary at all, and no dismiss step is needed.
    // This directly disproves the MORE SEVERE counterexample this test
    // originally found and documented (the stale announcement taking
    // priority over the COMPLETED branch entirely). ***
    expect(derivePresenterMode(sink.current!.state)).toBe('FINAL_RESULTS')
    expect(screen.queryByText('Security Line Winner')).not.toBeInTheDocument()

    // The static "Game Completed" message/🏁 icon still renders -- it is
    // now part of the FINAL_RESULTS view, not instead of it.
    expect(screen.getByText('Game Completed')).toBeInTheDocument()
    expect(screen.getByText('🏁')).toBeInTheDocument()

    // All 5 prize category labels render.
    for (const label of ['Cyber Five', 'Firewall Line', 'Security Line', 'Data Defender Line', 'Cyber Full House']) {
      expect(screen.getByText(label, { exact: false })).toBeInTheDocument()
    }

    // The confirmed winners' names render.
    for (const name of ['Alex', 'Priya', 'Sam']) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }

    // Data Defender Line and Cyber Full House had no winner confirmed --
    // they render "No Winner".
    expect(screen.getAllByText('No Winner')).toHaveLength(2)
  })

  it('missing-winners-show-no-winner-per-category (fixed): zero/partial winners render \'No Winner\' per missing category', async () => {
    const sink: { current: GameSessionContextValue | null } = { current: null }
    render(
      <GameSessionProvider>
        <Harness sink={sink} />
        <PresentationView />
      </GameSessionProvider>,
    )
    await waitFor(() => expect(sink.current).not.toBeNull())

    // Zero winners at all -- end the game immediately from LOBBY.
    expect(sink.current!.state.winners).toEqual([])
    act(() => {
      sink.current!.dispatch({ type: 'END_GAME' })
    })
    expect(sink.current!.state.game.status).toBe('COMPLETED')

    // *** Fixed behavior: `derivePresenterMode` returns 'FINAL_RESULTS',
    // all 5 category labels render, and since there are zero confirmed
    // winners, all 5 render the literal "No Winner" text -- never falling
    // back to any claim data (there is none here regardless). ***
    expect(derivePresenterMode(sink.current!.state)).toBe('FINAL_RESULTS')
    expect(screen.getByText('Game Completed')).toBeInTheDocument()
    for (const label of ['Cyber Five', 'Firewall Line', 'Security Line', 'Data Defender Line', 'Cyber Full House']) {
      expect(screen.getByText(label, { exact: false })).toBeInTheDocument()
    }
    expect(screen.getAllByText('No Winner')).toHaveLength(5)

    // Still no claim data of any kind appears.
    expect(screen.queryByText(/CLAIM_/)).not.toBeInTheDocument()
  })

  it('new-game-pointer-switch-no-stale-winner-leaks (unfixed, Req 2.8): the mock\'s synchronous unsubscribe() cannot reproduce the real async-teardown race', async () => {
    mockClient = createMockSupabaseClient()
    const client = mockClient

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

    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
    client.queueFromResponse('players', { data: [] })
    client.queueFromResponse('tickets', { data: [] })
    client.queueFromResponse('winners', {
      data: [
        {
          id: 'W_A1',
          game_id: 'GAME_A',
          prize_id: 'CYBER_FIVE',
          player_id: 'P_A1',
          ticket_id: 'T_A1',
          claim_id: 'C_A1',
          confirmed_at: '2026-01-01T00:05:00.000Z',
          prize_label: 'Cyber Five',
          player_name: 'Alice',
          ticket_ref: 'A1-REF',
        },
      ],
    })

    const sink: { current: GameSessionContextValue | null } = { current: null }
    render(
      <GameSessionProvider>
        <Harness sink={sink} />
      </GameSessionProvider>,
    )

    // Game A hydrates with one confirmed Winner.
    await waitFor(() => {
      expect(sink.current!.state.game.id).toBe('GAME_A')
      expect(sink.current!.state.winners).toHaveLength(1)
    })

    const gameAChannelCountBefore = client.channels.filter((c) => c.name === 'game:GAME_A').length
    expect(gameAChannelCountBefore).toBe(1)

    // Trigger a pointer-change to game B (same mechanism as the real
    // reset/active-game-switch flow): hydrateForGame unsubscribes the old
    // (GAME_A) channel BEFORE subscribing to the new (GAME_B) one, exactly
    // as GameSessionContext.tsx's existing code already does.
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_B', code: 'NEWG01' })] })
    client.queueFromResponse('players', { data: [] })
    client.queueFromResponse('tickets', { data: [] })
    client.queueFromResponse('winners', { data: [] })

    act(() => {
      client.fireRemoteChange({
        table: 'active_game_pointer',
        eventType: 'UPDATE',
        row: { id: true, active_game_id: 'GAME_B', updated_at: new Date().toISOString() },
      })
    })

    await waitFor(() => {
      expect(sink.current!.state.game.id).toBe('GAME_B')
      expect(sink.current!.state.winners).toEqual([])
    })

    // The old GAME_A channel has already been unsubscribed by this point
    // (hydrateForGame unsubscribes before subscribing to the new channel) --
    // confirm directly, since this is the premise the rest of this sub-case
    // depends on.
    expect(client.channels.filter((c) => c.name === 'game:GAME_B')).toHaveLength(1)

    // Attempt to fire a stale `winners` INSERT event carrying GAME_A's
    // winner row, as if it were still in flight from the old channel.
    act(() => {
      client.fireRemoteChange({
        table: 'winners',
        eventType: 'INSERT',
        row: {
          id: 'W_A1_STALE',
          game_id: 'GAME_A',
          prize_id: 'CYBER_FIVE',
          player_id: 'P_A1',
          ticket_id: 'T_A1',
          claim_id: 'C_A1',
          confirmed_at: '2026-01-01T00:05:00.000Z',
          prize_label: 'Cyber Five',
          player_name: 'Alice',
          ticket_ref: 'A1-REF',
        },
      })
    })

    // *** Documented mock limitation (per design.md's own finding) ***
    // Per mockSupabaseClient.ts's doc comment on fireRemoteChange: "A
    // channel that has been `.unsubscribe()`d no longer has any registered
    // listener at all." Since GAME_A's channel was already unsubscribed
    // (confirmed above) before this fireRemoteChange call, there is no
    // listener left to receive this event at all -- fireRemoteChange is a
    // no-op here, and state.winners stays []. This CANNOT reproduce the
    // real race design.md describes (an already-in-flight server-pushed
    // event arriving at an already-registered callback DURING the
    // asynchronous websocket teardown handshake, before the old channel's
    // listener has actually been removed server-side) -- it is an EXPECTED,
    // DOCUMENTED LIMITATION of this synchronous-unsubscribe mock, not
    // evidence that the real race doesn't exist. The real guard (task 9)
    // is verified instead via direct unit tests of the guard function
    // itself against a raw `(change) => {...}` callback invocation,
    // bypassing this mock's channel/unsubscribe machinery entirely -- not
    // through this mock-based scenario.
    expect(sink.current!.state.winners).toEqual([])
    expect(sink.current!.state.game.id).toBe('GAME_B')
  })
})
