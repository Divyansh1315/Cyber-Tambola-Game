// Spec: presenter-realtime-winner-sync — task 2 (preservation property
// tests, written BEFORE the fix, per the bugfix workflow).
//
// Property 2: Preservation - Unaffected Rendering, Resets, and Mechanisms
// Unchanged (design.md Correctness Properties).
//
// For any state transition where the bug condition does NOT hold (ordinary
// LOBBY/WORD_ACTIVE/PAUSED rendering with no pending announcement or
// completion, RESET_GAME's winners->winnerHistory fold, NO_ACTIVE_GAME's
// reset, CONFIRM_CLAIM's confirmed-only invariant, or the pointer-follow
// effect's unsubscribe-before-subscribe ordering), the fixed system must
// produce exactly the same result as the original (unfixed) system. This
// file OBSERVES that baseline on the CURRENT (unfixed) code; once the fix
// (tasks 3-9) lands, re-running this exact file (task 14) proves none of
// these scenarios were altered by it.
//
// Mock harness, Harness component, and realtimeClient pass-through
// conventions below are copied from
// `presenterRealtimeWinnerSync.exploration.test.tsx` (task 1) /
// `claimDuplicateSubmission.preservation.test.tsx` (prior spec, task 2) for
// consistency.
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.9
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import fc from 'fast-check'
import {
  createMockSupabaseClient,
  type MockSupabaseClient,
} from '../../state/testSupport/mockSupabaseClient'
import type { PrizeClaim } from '../../types/claim'
import type { Winner } from '../../types/prize'
import type { Player } from '../../types/player'
import type { Ticket } from '../../types/ticket'
import { gameSessionReducer } from '../../state/gameSessionReducer'
import { gameSessionInitialState, type GameSessionState } from '../../state/gameSessionInitialState'

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

import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from '../../state/GameSessionContext'
import { PresentationView } from './PresentationView'

// ---------------------------------------------------------------------------
// Test harness (mirrors the existing exploration/preservation tests'
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

function mountProvider() {
  const sink: { current: GameSessionContextValue | null } = { current: null }
  const utils = render(
    <GameSessionProvider>
      <Harness sink={sink} />
    </GameSessionProvider>,
  )
  return { sink, ...utils }
}

function mountProviderWithPresenter() {
  const sink: { current: GameSessionContextValue | null } = { current: null }
  const utils = render(
    <GameSessionProvider>
      <Harness sink={sink} />
      <PresentationView />
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

/** A minimal already-VALID, PENDING claim, same convention as the exploration test file. */
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

function buildWinner(overrides: Partial<Winner> = {}): Winner {
  return {
    id: 'WINNER_1',
    gameId: 'GAME_001',
    prizeId: 'CYBER_FIVE',
    playerId: 'PLAYER_1',
    ticketId: 'TICKET_1',
    claimId: 'CLAIM_1',
    confirmedAt: '2026-01-01T09:05:00.000Z',
    prizeLabel: 'Cyber Five',
    playerName: 'Alex',
    ticketRef: 'REF-1',
    ...overrides,
  }
}

describe('Preservation: ordinary LOBBY/WORD_ACTIVE/PAUSED rendering (unfixed code)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = null
  })

  it('1a. LOBBY: lobby QR/Game Code and circuit background render exactly as today', async () => {
    const sink: { current: GameSessionContextValue | null } = { current: null }
    render(
      <GameSessionProvider>
        <Harness sink={sink} />
        <PresentationView />
      </GameSessionProvider>,
    )
    await waitFor(() => expect(sink.current).not.toBeNull())
    expect(sink.current!.state.game.status).toBe('LOBBY')

    expect(screen.getByText('Cyber Awareness Month')).toBeInTheDocument()
    expect(screen.getByText('Cyber Tambola')).toBeInTheDocument()
    expect(screen.getByText('Scan to Join')).toBeInTheDocument()
    expect(screen.getByText('Game Code')).toBeInTheDocument()
    expect(screen.getByText(sink.current!.state.game.code)).toBeInTheDocument()
    // Circuit background SVG is present (aria-hidden decoration).
    expect(document.querySelector('.projector__circuits')).toBeTruthy()
    expect(document.querySelector('.projector__lobby')).toBeTruthy()
  })

  it('1b. WORD_ACTIVE: Cyber Word/definition/awareness-tip layout renders exactly as today', async () => {
    const sink: { current: GameSessionContextValue | null } = { current: null }
    render(
      <GameSessionProvider>
        <Harness sink={sink} />
        <PresentationView />
      </GameSessionProvider>,
    )
    await waitFor(() => expect(sink.current).not.toBeNull())

    act(() => {
      sink.current!.dispatch({ type: 'START_GAME' })
    })

    await waitFor(() => {
      expect(sink.current!.state.game.status).toBe('WORD_ACTIVE')
    })

    const currentTerm = sink.current!.currentTerm!
    expect(currentTerm).toBeDefined()
    expect(screen.getByText('Cyber Word')).toBeInTheDocument()
    expect(screen.getByText(currentTerm.term)).toBeInTheDocument()
    expect(screen.getByText('What It Means')).toBeInTheDocument()
    expect(screen.getByText(currentTerm.definition)).toBeInTheDocument()
    expect(screen.getByText('Safe Practice')).toBeInTheDocument()
    expect(screen.getByText(currentTerm.awarenessTip)).toBeInTheDocument()
  })

  it('1c. PAUSED: Game Paused message renders exactly as today', async () => {
    const sink: { current: GameSessionContextValue | null } = { current: null }
    render(
      <GameSessionProvider>
        <Harness sink={sink} />
        <PresentationView />
      </GameSessionProvider>,
    )
    await waitFor(() => expect(sink.current).not.toBeNull())

    act(() => {
      sink.current!.dispatch({ type: 'START_GAME' })
    })
    await waitFor(() => expect(sink.current!.state.game.status).toBe('WORD_ACTIVE'))

    act(() => {
      sink.current!.dispatch({ type: 'PAUSE_GAME' })
    })
    await waitFor(() => expect(sink.current!.state.game.status).toBe('PAUSED'))

    expect(screen.getByText('Game Paused')).toBeInTheDocument()
    expect(screen.getByText('⏸')).toBeInTheDocument()
  })
})

describe('Preservation: RESET_GAME winners->winnerHistory fold (unfixed code)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = null
  })

  it('2. dispatching RESET_GAME with non-empty winners/winnerHistory folds exactly as today', async () => {
    const { sink } = mountProviderWithPresenter()
    await waitFor(() => expect(sink.current).not.toBeNull())

    const existingWinners: Winner[] = [
      buildWinner({ id: 'WINNER_1', prizeId: 'CYBER_FIVE' }),
      buildWinner({ id: 'WINNER_2', prizeId: 'SECURITY_LINE' }),
    ]

    act(() => {
      sink.current!.dispatch({
        type: 'SYNC_LOCAL',
        payload: {
          game: sink.current!.state.game,
          players: sink.current!.state.players,
          tickets: sink.current!.state.tickets,
          marks: sink.current!.state.marks,
          claims: sink.current!.state.claims,
          winners: existingWinners,
        },
      })
    })
    // winnerHistory is not part of SharedStatePayload (by design); seed it
    // directly via a RECONCILE-adjacent approach is unnecessary here --
    // winnerHistory only accumulates via RESET_GAME itself, so observe the
    // fold starting from the actual initial empty winnerHistory, then do a
    // SECOND reset to confirm accumulation across cycles instead.
    expect(sink.current!.state.winners).toEqual(existingWinners)
    expect(sink.current!.state.winnerHistory).toEqual([])

    const priorGameRevealedTermIds = ['TERM_0', 'TERM_1']
    const priorGameCurrentRound = 3
    act(() => {
      sink.current!.dispatch({
        type: 'SYNC_LOCAL',
        payload: {
          game: {
            ...sink.current!.state.game,
            revealedTermIds: priorGameRevealedTermIds,
            currentRound: priorGameCurrentRound,
          },
          players: [{ id: 'P1', gameId: sink.current!.state.game.id, displayName: 'Alex', ticketId: 'T1', joinedAt: '2026-01-01T00:00:00.000Z', name: 'Alex', ticketRef: 'REF-1' }],
          tickets: [{ id: 'T1', playerId: 'P1', gameId: sink.current!.state.game.id, createdAt: '2026-01-01T00:00:00.000Z', ref: 'REF-1', rows: [] }],
          marks: sink.current!.state.marks,
          claims: [buildPendingClaim({ hostDecision: 'CONFIRMED' })],
          winners: existingWinners,
        },
      })
    })
    expect(sink.current!.state.game.revealedTermIds).toEqual(priorGameRevealedTermIds)
    expect(sink.current!.state.game.currentRound).toBe(priorGameCurrentRound)
    expect(sink.current!.state.players).toHaveLength(1)
    expect(sink.current!.state.tickets).toHaveLength(1)
    expect(sink.current!.state.claims).toHaveLength(1)

    // First reset: winners -> winnerHistory, exactly [...old (empty), ...winners].
    act(() => {
      sink.current!.dispatch({ type: 'RESET_GAME' })
    })

    expect(sink.current!.state.winnerHistory).toEqual([...[], ...existingWinners])
    expect(sink.current!.state.winners).toEqual([])
    expect(sink.current!.state.claims).toEqual([])
    expect(sink.current!.state.players).toEqual([])
    expect(sink.current!.state.tickets).toEqual([])
    expect(sink.current!.state.game.revealedTermIds).toEqual([])
    expect(sink.current!.state.game.currentRound).toBe(0)
    expect(sink.current!.state.game.status).toBe('LOBBY')
    // A fresh local code is generated -- it need not equal the prior code,
    // but it must be a non-empty string following the existing format.
    expect(typeof sink.current!.state.game.code).toBe('string')
    expect(sink.current!.state.game.code.length).toBeGreaterThan(0)

    // Second reset cycle: confirm winnerHistory ACCUMULATES rather than being
    // replaced -- [...oldWinnerHistory, ...oldWinners].
    const secondCycleWinners: Winner[] = [buildWinner({ id: 'WINNER_3', prizeId: 'DATA_DEFENDER_LINE' })]
    const winnerHistoryAfterFirstReset = sink.current!.state.winnerHistory
    act(() => {
      sink.current!.dispatch({
        type: 'SYNC_LOCAL',
        payload: {
          game: sink.current!.state.game,
          players: sink.current!.state.players,
          tickets: sink.current!.state.tickets,
          marks: sink.current!.state.marks,
          claims: sink.current!.state.claims,
          winners: secondCycleWinners,
        },
      })
    })
    act(() => {
      sink.current!.dispatch({ type: 'RESET_GAME' })
    })
    expect(sink.current!.state.winnerHistory).toEqual([
      ...winnerHistoryAfterFirstReset,
      ...secondCycleWinners,
    ])
    expect(sink.current!.state.winners).toEqual([])
  })
})

describe('Preservation: NO_ACTIVE_GAME reset (unfixed code)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = null
  })

  it('3. dispatching NO_ACTIVE_GAME resets game/players/tickets/marks/claims/winners while preserving currentPlayerId', () => {
    // Exercised directly at the reducer level (not through the full
    // provider): GameSessionContext.tsx's separate stale-identity
    // invalidation effect (a DIFFERENT, independent mechanism -- see its
    // own doc comment) reacts to a players array that no longer contains
    // the current player by dispatching CLEAR_STALE_PLAYER right after
    // NO_ACTIVE_GAME lands when mounted through the real provider -- that
    // effect's behavior is out of scope for this task (it is not part of
    // the NO_ACTIVE_GAME reducer case being preserved here). Testing the
    // reducer in isolation observes exactly what the current NO_ACTIVE_GAME
    // case itself does to currentPlayerId, with no other effect's
    // subsequent dispatch interfering.
    const player: Player = {
      id: 'LOCAL_P_1',
      gameId: gameSessionInitialState.game.id,
      displayName: 'Alex',
      ticketId: 'LOCAL_T_1',
      joinedAt: '2026-01-01T00:00:00.000Z',
      name: 'Alex',
      ticketRef: 'Ticket #LOC01',
    }
    const ticket: Ticket = {
      id: 'LOCAL_T_1',
      playerId: 'LOCAL_P_1',
      gameId: gameSessionInitialState.game.id,
      createdAt: '2026-01-01T00:00:00.000Z',
      ref: 'Ticket #LOC01',
      rows: [],
    }

    const state: GameSessionState = {
      ...gameSessionInitialState,
      players: [player],
      tickets: [ticket],
      currentPlayerId: 'LOCAL_P_1',
      marks: [
        {
          id: 'M1',
          gameId: gameSessionInitialState.game.id,
          playerId: 'LOCAL_P_1',
          ticketId: 'LOCAL_T_1',
          termId: 'TERM_0',
          markedAt: '2026-01-01T00:00:00.000Z',
          valid: true,
        },
      ],
      claims: [buildPendingClaim()],
      winners: [buildWinner()],
    }

    const nextState = gameSessionReducer(state, { type: 'NO_ACTIVE_GAME' })

    // Reset to initial values exactly as today.
    expect(nextState.players).toEqual([])
    expect(nextState.tickets).toEqual([])
    expect(nextState.marks).toEqual([])
    expect(nextState.claims).toEqual([])
    expect(nextState.winners).toEqual([])
    expect(nextState.game.status).toBe('LOBBY')
    expect(nextState.game.revealedTermIds).toEqual([])
    // currentPlayerId is preserved, not cleared.
    expect(nextState.currentPlayerId).toBe('LOCAL_P_1')
  })
})

describe('Preservation: CONFIRM_CLAIM confirmed-only invariant (unfixed code)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = null
  })

  it('4. a claim failing canConfirmClaim creates no Winner; a claim passing it creates exactly one Winner, pre-fix shape', async () => {
    const { sink } = mountProvider()
    await waitFor(() => expect(sink.current).not.toBeNull())

    // Seed one PENDING/VALID claim and one already-REJECTED claim (fails
    // canConfirmClaim's hostDecision === 'PENDING' gate).
    act(() => {
      sink.current!.dispatch({
        type: 'SYNC_LOCAL',
        payload: {
          game: sink.current!.state.game,
          players: sink.current!.state.players,
          tickets: sink.current!.state.tickets,
          marks: sink.current!.state.marks,
          claims: [
            buildPendingClaim({ id: 'CLAIM_REJECTED', hostDecision: 'REJECTED' }),
            buildPendingClaim({ id: 'CLAIM_VALID_PENDING' }),
          ],
          winners: [],
        },
      })
    })

    const winnersBefore = sink.current!.state.winners.length

    // Dispatch CONFIRM_CLAIM for the claim that fails canConfirmClaim.
    act(() => {
      sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: 'CLAIM_REJECTED' })
    })
    expect(sink.current!.state.winners).toHaveLength(winnersBefore)
    expect(
      sink.current!.state.claims.find((c) => c.id === 'CLAIM_REJECTED')?.hostDecision,
    ).toBe('REJECTED')

    // Dispatch CONFIRM_CLAIM for the claim that passes.
    act(() => {
      sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: 'CLAIM_VALID_PENDING' })
    })
    expect(sink.current!.state.winners).toHaveLength(winnersBefore + 1)
    const newWinner = sink.current!.state.winners.at(-1)!
    expect(newWinner.claimId).toBe('CLAIM_VALID_PENDING')
    expect(
      sink.current!.state.claims.find((c) => c.id === 'CLAIM_VALID_PENDING')?.hostDecision,
    ).toBe('CONFIRMED')
    // Fixed shape: CONFIRM_CLAIM now sets game.latestWinnerAnnouncementId to
    // the newly-created Winner's id (task 4) -- this is an ADDITIVE change to
    // CONFIRM_CLAIM's return value; the preserved invariant this test cares
    // about (confirmed-only gating: a failing claim creates no Winner, a
    // passing claim creates exactly one) is unaffected by this field's
    // existence.
    expect(sink.current!.state.game.latestWinnerAnnouncementId).toBe(newWinner.id)

    // Dispatching CONFIRM_CLAIM again for the SAME now-closed prize (a
    // second claim for an already-closed prize) must also create no
    // Winner -- canConfirmClaim's isPrizeClosed gate.
    act(() => {
      sink.current!.dispatch({
        type: 'SYNC_LOCAL',
        payload: {
          game: sink.current!.state.game,
          players: sink.current!.state.players,
          tickets: sink.current!.state.tickets,
          marks: sink.current!.state.marks,
          claims: [
            ...sink.current!.state.claims,
            buildPendingClaim({ id: 'CLAIM_SAME_PRIZE_AGAIN', prizeId: 'CYBER_FIVE' }),
          ],
          winners: sink.current!.state.winners,
        },
      })
    })
    act(() => {
      sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: 'CLAIM_SAME_PRIZE_AGAIN' })
    })
    expect(sink.current!.state.winners).toHaveLength(winnersBefore + 1)
    // The rejected second CONFIRM_CLAIM is a no-op case in the reducer (it
    // returns `state` unchanged), so game.latestWinnerAnnouncementId must
    // still point at the FIRST winner, unaffected by the rejected attempt.
    expect(sink.current!.state.game.latestWinnerAnnouncementId).toBe(newWinner.id)
  })
})

describe('Preservation: pointer-follow unsubscribe-before-subscribe ordering (unfixed code)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockClient = null
  })

  it('5. unsubscribes the old per-game channel before subscribing to the new game id\'s channel, and no-ops when the id matches gameIdRef.current', async () => {
    mockClient = createMockSupabaseClient()
    const client = mockClient

    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A' })] })
    client.queueFromResponse('players', { data: [] })
    client.queueFromResponse('tickets', { data: [] })
    client.queueFromResponse('winners', { data: [] })

    const { sink } = mountProvider()

    await waitFor(() => {
      expect(sink.current!.state.game.id).toBe('GAME_A')
    })

    expect(client.channels.filter((c) => c.name === 'game:GAME_A')).toHaveLength(1)
    const channelCountBefore = client.channels.length

    // Announce the SAME game id again via the pointer -- must be a no-op
    // (no new channel created, no unsubscribe/resubscribe churn) because it
    // equals the already-tracked gameIdRef.current.
    act(() => {
      client.fireRemoteChange({
        table: 'active_game_pointer',
        eventType: 'UPDATE',
        row: { id: true, active_game_id: 'GAME_A', updated_at: new Date().toISOString() },
      })
    })

    // Give any (incorrect) async handling a chance to run before asserting
    // it never does.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    // No-op: no new channel was created at all for the re-announced id.
    expect(client.channels.length).toBe(channelCountBefore)
    expect(client.channels.filter((c) => c.name === 'game:GAME_A')).toHaveLength(1)

    // The old GAME_A channel's listener is STILL registered (not
    // unsubscribed) -- confirmed indirectly by firing a `winners` event for
    // GAME_A and observing it is still applied, since the no-op path never
    // touched the subscription at all.
    client.fireRemoteChange({
      table: 'winners',
      eventType: 'INSERT',
      row: {
        id: 'W_NOOP_CHECK',
        game_id: 'GAME_A',
        prize_id: 'FIREWALL_LINE',
        player_id: 'P_X',
        ticket_id: 'T_X',
        claim_id: 'C_X',
        confirmed_at: '2026-01-01T00:06:00.000Z',
        prize_label: 'Firewall Line',
        player_name: 'NoopCheck',
        ticket_ref: 'REF-X',
      },
    })
    await waitFor(() => {
      expect(sink.current!.state.winners.some((w) => w.id === 'W_NOOP_CHECK')).toBe(true)
    })

    // Now announce a genuinely NEW game id -- the old GAME_A channel must be
    // unsubscribed BEFORE the new GAME_B channel is subscribed: there is a
    // brief window with zero subscriptions for GAME_A, never a window with
    // two concurrently-registered GAME_A listeners.
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
    })

    // Exactly one GAME_B channel is now subscribed.
    expect(client.channels.filter((c) => c.name === 'game:GAME_B')).toHaveLength(1)

    // The OLD GAME_A channel has been unsubscribed: firing another `winners`
    // event tagged for GAME_A no longer has any effect on state, confirming
    // the old channel's listener was torn down (unsubscribe-before-subscribe
    // ordering).
    const winnersCountAfterSwitch = sink.current!.state.winners.length
    client.fireRemoteChange({
      table: 'winners',
      eventType: 'INSERT',
      row: {
        id: 'W_STALE_AFTER_SWITCH',
        game_id: 'GAME_A',
        prize_id: 'DATA_DEFENDER_LINE',
        player_id: 'P_Y',
        ticket_id: 'T_Y',
        claim_id: 'C_Y',
        confirmed_at: '2026-01-01T00:07:00.000Z',
        prize_label: 'Data Defender Line',
        player_name: 'StaleCheck',
        ticket_ref: 'REF-Y',
      },
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(sink.current!.state.winners).toHaveLength(winnersCountAfterSwitch)
    expect(sink.current!.state.winners.some((w) => w.id === 'W_STALE_AFTER_SWITCH')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Property-based test: for randomly generated winners/winnerHistory arrays,
// RESET_GAME always folds exactly as [...oldWinnerHistory, ...oldWinners]
// and resets the other fields to the fresh seed game's values -- the
// baseline Property 2 says must never change once the fix lands. Mirrors
// claimDuplicateSubmission.preservation.test.tsx's own PBT convention
// (exercised directly at the reducer level).
// ---------------------------------------------------------------------------

import type { PrizeId } from '../../types/prize'

const prizePoolArb = fc.constantFrom<PrizeId>(
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
)

const winnerArb = fc.record({
  id: fc.stringMatching(/^[A-Z0-9]{1,8}$/),
  prizeId: prizePoolArb,
  playerName: fc.constantFrom('Alex', 'Priya', 'Sam', 'Rohan', 'Kavya'),
})

/** Builds a concrete Winner from the generated minimal shape above. */
function winnerFromArb(w: { id: string; prizeId: PrizeId; playerName: string }, gameId: string): Winner {
  return buildWinner({
    id: w.id,
    prizeId: w.prizeId,
    playerName: w.playerName,
    gameId,
    claimId: `CLAIM_${w.id}`,
    playerId: `PLAYER_${w.id}`,
    ticketId: `TICKET_${w.id}`,
    ticketRef: `REF-${w.id}`,
  })
}

describe('Property 2 (PBT): RESET_GAME always folds winners into winnerHistory as [...old, ...winners] and resets the other fields', () => {
  it('matches the observed baseline across many generated winners/winnerHistory arrays', () => {
    fc.assert(
      fc.property(
        fc.array(winnerArb, { minLength: 0, maxLength: 5 }),
        fc.array(winnerArb, { minLength: 0, maxLength: 5 }),
        (priorWinnerHistoryShapes, currentWinnersShapes) => {
          const gameId = 'GAME_PBT'
          const priorWinnerHistory = priorWinnerHistoryShapes.map((w) => winnerFromArb(w, gameId))
          const currentWinners = currentWinnersShapes.map((w) => winnerFromArb(w, gameId))

          const state: GameSessionState = {
            ...gameSessionInitialState,
            game: {
              ...gameSessionInitialState.game,
              id: gameId,
              status: 'WORD_ACTIVE',
              currentRound: 3,
              revealedTermIds: ['TERM_0', 'TERM_1'],
              code: 'PRIORCODE',
            },
            players: [
              {
                id: 'P_PBT',
                gameId,
                displayName: 'Alex',
                ticketId: 'T_PBT',
                joinedAt: '2026-01-01T00:00:00.000Z',
                name: 'Alex',
                ticketRef: 'REF-PBT',
              },
            ],
            tickets: [
              {
                id: 'T_PBT',
                playerId: 'P_PBT',
                gameId,
                createdAt: '2026-01-01T00:00:00.000Z',
                ref: 'REF-PBT',
                rows: [],
              },
            ],
            marks: [],
            claims: [buildPendingClaim({ id: 'CLAIM_PBT', gameId, hostDecision: 'CONFIRMED' })],
            winners: currentWinners,
            winnerHistory: priorWinnerHistory,
          }

          const nextState = gameSessionReducer(state, { type: 'RESET_GAME' })

          // The exact invariant Property 2 preserves.
          expect(nextState.winnerHistory).toEqual([...priorWinnerHistory, ...currentWinners])
          expect(nextState.winners).toEqual([])
          expect(nextState.claims).toEqual([])
          expect(nextState.players).toEqual([])
          expect(nextState.tickets).toEqual([])
          expect(nextState.game.revealedTermIds).toEqual([])
          expect(nextState.game.currentRound).toBe(0)
          expect(nextState.game.status).toBe('LOBBY')
          // A fresh local code is generated, which must differ in general
          // from a fixed sentinel prior code (format-level check only --
          // this reducer doesn't guarantee non-collision with the prior
          // code, only that it generates one in the expected format).
          expect(nextState.game.code).toMatch(/^[A-Z]{4}[0-9]{2}$/)
        },
      ),
      { numRuns: 100 },
    )
  })
})
