// Feature: module-4-term-marking-prize-engine — HostDashboard RESET_GAME
// end-to-end verification (Task 11.1).
//
// Validates: Requirements 17.1, 17.2, 17.3
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { HostDashboard } from './HostDashboard'
import { PlayerGame } from '../PlayerGame/PlayerGame'
import {
  GameSessionProvider,
  useGameSession,
} from '../../state/GameSessionContext'
import { buildJoinOutcome } from '../../state/joinService'
import { createSeedGame } from '../../state/gameSessionInitialState'
import { cyberTerms } from '../../data/cyberTerms'
import type { Game } from '../../types/game'
import type { GameSessionAction } from '../../state/gameSessionReducer'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface SessionHandle {
  state: {
    game: Game
    players: unknown[]
    tickets: unknown[]
    marks: unknown[]
    currentPlayerId?: string
  }
  dispatch: (action: GameSessionAction) => void
}

/**
 * A hidden harness that reaches into the real session context and exposes
 * dispatch/state on `window` so the test body can drive the real
 * reducer/context end to end (no mocks) while rendering the real screens.
 */
function SessionBridge() {
  const ctx = useGameSession()
  ;(window as unknown as { __session: SessionHandle }).__session = {
    state: ctx.state as SessionHandle['state'],
    dispatch: ctx.dispatch,
  }
  return null
}

function getSession(): SessionHandle {
  return (window as unknown as { __session: SessionHandle }).__session
}

/** Dispatch through the real context and flush the resulting state update. */
function dispatchAndFlush(action: GameSessionAction): void {
  act(() => {
    getSession().dispatch(action)
  })
}

function joinFreshPlayer(game: Game, name: string, employeeId: string) {
  const outcome = buildJoinOutcome({
    form: { gameCode: 'CYBER24', employeeName: name, employeeId },
    game,
    players: [],
    tickets: [],
    terms: cyberTerms,
  })
  if (outcome.kind !== 'new') {
    throw new Error(`expected a new join outcome, got ${outcome.kind}`)
  }
  return outcome
}

describe('HostDashboard Reset Demo Game clears marks + prize progress end to end', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  it('RESET_GAME wipes marks/players/tickets/currentPlayerId after a dirty session with revealed + marked terms (Req 17.1, 17.2)', () => {
    render(
      <MemoryRouter>
        <GameSessionProvider>
          <SessionBridge />
          <HostDashboard />
        </GameSessionProvider>
      </MemoryRouter>,
    )

    // --- 1. Seed a dirty state: join a player, reveal terms, mark some. -----
    const game = createSeedGame()
    const { player, ticket } = joinFreshPlayer(game, 'Asha Kumar', 'EMP-1001')

    dispatchAndFlush({ type: 'JOIN_PLAYER', player, ticket })

    // Reveal three of the ticket's terms and mark two of them. There is no
    // public action to set revealedTermIds directly except through the game
    // lifecycle (START_GAME picks a random term) or SYNC_LOCAL (which the
    // reducer already treats as a first-class, validated action for applying
    // a shared-state payload) — SYNC_LOCAL is used here purely as a
    // deterministic way to drive revealedTermIds to known values, not to
    // exercise cross-tab sync itself.
    const termIdsOnTicket = ticket.rows.flat().map((c) => c.termId)
    const toReveal = termIdsOnTicket.slice(0, 3)
    const current = getSession().state
    const revealedGame: Game = {
      ...current.game,
      status: 'WORD_ACTIVE',
      currentTermId: toReveal[toReveal.length - 1],
      revealedTermIds: toReveal,
    }
    dispatchAndFlush({
      type: 'SYNC_LOCAL',
      payload: {
        game: revealedGame,
        players: current.players as never,
        tickets: current.tickets as never,
        marks: current.marks as never,
        claims: [],
        winners: [],
      },
    })

    dispatchAndFlush({ type: 'MARK_TERM', termId: toReveal[0] })
    dispatchAndFlush({ type: 'MARK_TERM', termId: toReveal[1] })

    // Confirm the dirty state actually has non-zero marks before resetting.
    const dirtyState = getSession().state
    expect(dirtyState.marks.length).toBe(2)
    expect(dirtyState.players.length).toBe(1)
    expect(dirtyState.tickets.length).toBe(1)
    expect(dirtyState.currentPlayerId).toBe(player.id)

    // --- 2. Trigger Reset Demo Game via the real HostDashboard button. -----
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /reset demo game/i }))
    })

    // --- 3. Assert the reducer's RESET_GAME cleared everything. -------------
    const resetState = getSession().state
    expect(resetState.marks).toEqual([])
    expect(resetState.players).toEqual([])
    expect(resetState.tickets).toEqual([])
    expect(resetState.currentPlayerId).toBeUndefined()
    expect(resetState.game.revealedTermIds).toEqual([])
    expect(resetState.game.status).toBe('LOBBY')
  })

  it('a fresh player joining post-reset sees every prize zeroed and no MARKED cells on the Player Game screen (Req 17.3)', () => {
    // Drive the dirty-session → reset → fresh-join sequence against a
    // throwaway harness-only render first (so PlayerGame is never mounted
    // mid-sequence and never redirects away via <Navigate> while there is no
    // current player). This isolates "does RESET_GAME really clear
    // everything, including for a subsequent join" from PlayerGame's own
    // routing behavior, which Module 3's tests already cover.
    const { unmount } = render(
      <GameSessionProvider>
        <SessionBridge />
      </GameSessionProvider>,
    )

    // Simulate "post-reset": dirty the session first, reset it, then join a
    // brand-new player — exactly the Test H flow from design.md/requirements.
    const game = createSeedGame()
    const { player: dirtyPlayer, ticket: dirtyTicket } = joinFreshPlayer(
      game,
      'Asha Kumar',
      'EMP-1001',
    )
    dispatchAndFlush({
      type: 'JOIN_PLAYER',
      player: dirtyPlayer,
      ticket: dirtyTicket,
    })
    const dirtyTermIds = dirtyTicket.rows.flat().map((c) => c.termId).slice(0, 2)
    dispatchAndFlush({
      type: 'SYNC_LOCAL',
      payload: {
        game: {
          ...getSession().state.game,
          status: 'WORD_ACTIVE',
          revealedTermIds: dirtyTermIds,
        },
        players: getSession().state.players as never,
        tickets: getSession().state.tickets as never,
        marks: getSession().state.marks as never,
        claims: [],
        winners: [],
      },
    })
    dispatchAndFlush({ type: 'MARK_TERM', termId: dirtyTermIds[0] })
    expect(getSession().state.marks.length).toBe(1)

    dispatchAndFlush({ type: 'RESET_GAME' })
    expect(getSession().state.marks).toEqual([])
    expect(getSession().state.players).toEqual([])

    // Persist the post-reset envelope (the provider's persistence effect
    // already writes it on every state change), then join a fresh player and
    // persist that too — mirroring a real "reset, then a new player joins"
    // flow across what would be two different page loads/tabs in production.
    const freshGame = getSession().state.game
    const { player, ticket } = joinFreshPlayer(freshGame, 'New Player', 'EMP-9999')
    dispatchAndFlush({ type: 'JOIN_PLAYER', player, ticket })

    unmount()

    // Now mount PlayerGame fresh — it reads the persisted, post-join session
    // from localStorage on initial load, exactly like a real page load.
    render(
      <MemoryRouter initialEntries={['/player']}>
        <GameSessionProvider>
          <Routes>
            <Route path="/player" element={<PlayerGame />} />
          </Routes>
        </GameSessionProvider>
      </MemoryRouter>,
    )

    // No cells should render as MARKED — the new player has zero marks.
    expect(screen.queryAllByRole('button', { name: /Marked/ })).toHaveLength(0)

    // Every prize renders at its zeroed value.
    expect(
      screen.getAllByText('Cyber Five').length,
    ).toBeGreaterThanOrEqual(1)

    const counts = document.querySelectorAll('.prize-progress__count')
    const rendered = Array.from(counts).map((el) =>
      (el.textContent ?? '').replace(/\s+/g, '').replace(/✓$/, ''),
    )
    expect(rendered.filter((t) => t === '0/5')).toHaveLength(4)
    expect(rendered.filter((t) => t === '0/15')).toHaveLength(1)

    // Claim messaging matches the zero-progress hint, and Claim is disabled
    // (Module 5: per-prize claim block, driven by derivePlayerClaimStatus).
    const cyberFiveClaimBlock = screen.getByText('Cyber Five', {
      selector: '.player__claim-block-label',
    }).closest('li') as HTMLElement
    expect(cyberFiveClaimBlock).toHaveTextContent('Progress: 0/5')
    expect(
      screen.getByRole('button', { name: /claim cyber five/i }),
    ).toBeDisabled()
  })
})
