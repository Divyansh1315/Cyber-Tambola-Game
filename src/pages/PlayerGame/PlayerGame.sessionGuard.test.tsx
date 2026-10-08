// Spec: claim-player-ticket-identity-mismatch — task 12 (unit test for the
// `PlayerGame.tsx` recovery message added in task 8).
//
// `PlayerGame.tsx` reads `lastSessionGuardFailure` from `useGameSession()`
// and, for the prize block whose `prizeId` matches it, renders a distinct
// recovery message ("Your session is out of date. Please refresh or rejoin
// to continue.") with a "Refresh" button, instead of the normal
// `claimStatusView` message/button for that one block. Other prize blocks
// render normally.
//
// `lastSessionGuardFailure` is purely ephemeral provider-local state (never
// persisted to localStorage), so it cannot be seeded via `seedSession` like
// the rest of `PlayerGame.test.tsx`'s suite -- it is only ever set by the
// pre-submission session consistency guard (GameSessionContext.tsx, task
// 5.2) actually firing on a real `SUBMIT_PRIZE_CLAIM` dispatch. In Local // not-a-ticket-dimension
// Fallback mode `isBackendConfirmed` is always `true`, and task 7.2's
// stale-identity invalidation effect clears any structurally-stale
// `currentPlayerId` before a guard failure could ever be observed there.
//
// The reachable way to exercise the guard (reusing the convention from
// `sessionConsistencyGuard.unit.test.tsx`'s NOT_BACKEND_CONFIRMED case) is
// the mock-Supabase harness: keep `get_active_game` pending so
// `isBackendConfirmed` stays `false` (the stale-identity effect only runs
// once it flips `true`), seed a structurally-consistent player/ticket
// directly via `JOIN_PLAYER` + `HYDRATE_FROM_REMOTE`, then dispatch
// `SUBMIT_PRIZE_CLAIM` through the real Claim button -- the guard blocks it
// with `NOT_BACKEND_CONFIRMED` and sets `lastSessionGuardFailure` for that
// prize. A tiny invisible `Harness` sibling (same convention as the
// existing guard unit test) exposes `dispatch`/context state for seeding,
// while assertions target the real rendered `PlayerGame` UI (via
// `PlayerEntry`) in the same provider.
//
// Validates: Requirements 2.3
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useRef } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
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
} from '../../state/GameSessionContext'
import { PlayerEntry } from '../PlayerEntry'
import type { TicketCell } from '../../types/ticket'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/** Invisible sibling exposing the live context value for seeding dispatches. */
function Harness({ sink }: { sink: { current: GameSessionContextValue | null } }) {
  const ctx = useGameSession()
  const ref = useRef(sink)
  useEffect(() => {
    ref.current.current = ctx
  })
  sink.current = ctx
  return null
}

function renderPlayerGame() {
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

function claimBlockFor(label: string): HTMLElement {
  return screen
    .getByText(label, { selector: '.player__claim-block-label' })
    .closest('li') as HTMLElement
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

/** 15 cells with stable, distinct termIds across 3 rows of 5. */
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

/**
 * Mounts PlayerGame with the live Active Game's `get_active_game` left
 * pending (`isBackendConfirmed` stays `false`), then joins a
 * structurally-consistent player/ticket directly and reveals/marks 5 terms
 * so Cyber Five is ELIGIBLE. Since the player/ticket/game checks all pass,
 * only the backend-confirmation check can fail once a claim is attempted
 * (NOT_BACKEND_CONFIRMED) -- the stale-identity invalidation effect never
 * fires because `isBackendConfirmed` never flips to `true` during the test.
 */
async function mountUnconfirmedEligibleSession(client: MockSupabaseClient) {
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
  client.queueRpcResponse('get_active_game', { data: [buildGameRow()] })

  const tab = renderPlayerGame()

  await waitFor(() => {
    expect(tab.sink.current!.isBackendConfirmed).toBe(false)
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
      within(claimBlockFor('Cyber Five'))
        .getByRole('button', { name: /claim cyber five/i })
        .hasAttribute('disabled'),
    ).toBe(false)
  })

  return { ...tab, resolveGetActiveGame: resolveGetActiveGame! }
}

describe('PlayerGame session guard recovery message (claim-player-ticket-identity-mismatch, Req 2.3)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    window.localStorage.clear()
    mockClient = createMockSupabaseClient()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('shows the distinct recovery message and Refresh button for the attempted prize when the session guard blocks the claim', async () => {
    const user = userEvent.setup()
    const tab = await mountUnconfirmedEligibleSession(mockClient!)

    expect(tab.getByText('Your Cyber Word Ticket')).toBeInTheDocument()
    // ELIGIBLE also auto-surfaces the Prize_Claim_Popup, so there are two
    // "Claim Cyber Five" buttons -- scope to the card's block to click it. // not-a-ticket-dimension
    const claimButton = within(claimBlockFor('Cyber Five')).getByRole('button', {
      name: /claim cyber five/i,
    })
    expect(claimButton).toBeEnabled()

    await user.click(claimButton)

    await waitFor(() => {
      expect(tab.sink.current!.lastSessionGuardFailure).toEqual({
        prizeId: 'CYBER_FIVE',
        reason: 'NOT_BACKEND_CONFIRMED',
      })
    })

    const cyberFiveBlock = claimBlockFor('Cyber Five')
    expect(cyberFiveBlock).toHaveTextContent(
      'Your session is out of date. Please refresh or rejoin to continue.',
    )
    expect(screen.queryByText(/claim could not be validated/i)).not.toBeInTheDocument()
    expect(tab.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
    // The normal claim button for this prize is replaced, not just hidden.
    expect(
      screen.queryByRole('button', { name: /claim cyber five/i }),
    ).not.toBeInTheDocument()

    tab.resolveGetActiveGame()
  })

  it('leaves every other prize block rendering normally when the guard blocks only the attempted prize', async () => {
    const user = userEvent.setup()
    const tab = await mountUnconfirmedEligibleSession(mockClient!)

    const otherLabels = [
      'Firewall Line',
      'Security Line',
      'Data Defender Line',
      'Cyber Full House',
    ]
    const otherBlocksTextBefore = otherLabels.map((label) => claimBlockFor(label).textContent)

    await user.click(
      within(claimBlockFor('Cyber Five')).getByRole('button', { name: /claim cyber five/i }),
    )

    await waitFor(() => {
      expect(claimBlockFor('Cyber Five')).toHaveTextContent(
        'Your session is out of date. Please refresh or rejoin to continue.',
      )
    })

    otherLabels.forEach((label, i) => {
      expect(claimBlockFor(label).textContent).toBe(otherBlocksTextBefore[i])
    })

    tab.resolveGetActiveGame()
  })

  it('clicking Refresh calls window.location.reload', async () => {
    const user = userEvent.setup()
    const tab = await mountUnconfirmedEligibleSession(mockClient!)

    await user.click(
      within(claimBlockFor('Cyber Five')).getByRole('button', { name: /claim cyber five/i }),
    )

    await waitFor(() => {
      expect(tab.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
    })

    const reloadSpy = vi.fn()
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    })

    try {
      await user.click(tab.getByRole('button', { name: /refresh/i }))
      expect(reloadSpy).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      })
      tab.resolveGetActiveGame()
    }
  })

  describe('regression: unaffected when lastSessionGuardFailure is undefined (normal case)', () => {
    it('still shows the exact generic "Claim could not be validated..." message for an own INVALID claim, distinguishable from the recovery message', async () => {
      const tab = await mountUnconfirmedEligibleSession(mockClient!)

      act(() => {
        const current = tab.sink.current!.state
        tab.sink.current!.dispatch({
          type: 'HYDRATE_FROM_REMOTE',
          snapshot: {
            game: current.game,
            players: current.players,
            tickets: current.tickets,
            // Drop to 4 marks (NOT_ELIGIBLE) and attach an own INVALID claim,
            // same shape as PlayerGame.test.tsx's existing INVALID-claim test.
            marks: current.marks.slice(0, 4),
            claims: [
              {
                id: 'claim-cyber-five-invalid',
                gameId: current.game.id,
                playerId: 'P_1',
                ticketId: 'T_1',
                prizeId: 'CYBER_FIVE',
                submittedAt: '2026-01-01T00:00:00.000Z',
                validationStatus: 'INVALID',
                hostDecision: 'PENDING',
                prizeLabel: 'Cyber Five',
                playerName: 'Asha Kumar',
                ticketRef: 'T_1',
                rejectionReason: 'NOT_ELIGIBLE',
              },
            ],
            winners: current.winners,
          },
        })
      })

      await waitFor(() => {
        // PENDING keeps the Prize_Claim_Popup showing (the hook's "poppable"
        // statuses include PENDING), so this message now also appears a
        // second time in the popup -- scope to the card's block.
        expect(
          within(claimBlockFor('Cyber Five')).getByText(
            'Claim could not be validated. Your current progress is 4/5.', // not-a-ticket-dimension
          ),
        ).toBeInTheDocument()
      })
      expect(screen.queryByText(/session is out of date/i)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument()

      tab.resolveGetActiveGame()
    })

    it('every prize block renders exactly as before task 8 when no claim has ever been blocked by the guard', async () => {
      const tab = await mountUnconfirmedEligibleSession(mockClient!)

      ;['Cyber Five', 'Firewall Line', 'Security Line', 'Data Defender Line', 'Cyber Full House'].forEach(
        (label) => {
          const block = claimBlockFor(label)
          expect(block.textContent).not.toMatch(/session is out of date/i)
        },
      )
      expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument()

      tab.resolveGetActiveGame()
    })
  })
})
