// Feature: module-5-prize-claim-processing-winner-management — Task 15.1
// Integration test: claim submission -> host confirm -> cross-screen
// propagation. Asserts that a single SUBMIT_PRIZE_CLAIM + CONFIRM_CLAIM pair
// dispatched against one shared GameSessionProvider instance is reflected,
// from that same state update, in the Player screen, the Host Dashboard's
// Winner Panel, and the Presentation View — with no manual refresh/remount.
// Validates Requirements 8.5, 15.3.
import { describe, it, expect, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import {
  GameSessionProvider,
  useGameSession as useGameSessionForTest,
} from './GameSessionContext'
import { PlayerGame } from '../pages/PlayerGame/PlayerGame'
import { HostDashboard } from '../pages/HostDashboard/HostDashboard'
import { PresentationView } from '../pages/PresentationView/PresentationView'
import { buildJoinOutcome } from './joinService'
import { createSeedGame } from './gameSessionInitialState'
import { CURRENT_PLAYER_STORAGE_KEY, STORAGE_KEY, toEnvelope } from './persistence'
import { cyberTerms } from '../data/cyberTerms'
import type { Game } from '../types/game'
import type { Mark } from '../types/mark'
import type { Player } from '../types/player'
import type { Ticket } from '../types/ticket'

/** Build a real player + ticket from the join service (no mocks/fakes). */
function buildJoined(game: Game): { player: Player; ticket: Ticket } {
  const outcome = buildJoinOutcome({
    form: { gameCode: 'CYBER24', employeeName: 'Riya Sharma', employeeId: 'EMP-2002' },
    game,
    players: [],
    tickets: [],
    terms: cyberTerms,
  })
  if (outcome.kind !== 'new') {
    throw new Error(`expected a new join outcome, got ${outcome.kind}`)
  }
  return { player: outcome.player, ticket: outcome.ticket }
}

/** Build a well-formed Mark for a given player/ticket/term (no mocks). */
function buildMark(player: Player, ticket: Ticket, termId: string): Mark {
  return {
    id: `mark-${termId}`,
    gameId: player.gameId,
    playerId: player.id,
    ticketId: ticket.id,
    termId,
    markedAt: new Date().toISOString(),
    valid: true,
  }
}

/** Seed localStorage with a shared-state envelope + current-player key. */
function seedSession(args: {
  game: Game
  players: Player[]
  tickets: Ticket[]
  currentPlayerId?: string
  marks?: Mark[]
}) {
  const { currentPlayerId, ...shared } = args
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(
      toEnvelope({ marks: [], claims: [], winners: [], ...shared }),
    ),
  )
  if (currentPlayerId !== undefined) {
    window.localStorage.setItem(CURRENT_PLAYER_STORAGE_KEY, currentPlayerId)
  }
}

/** Bridge component exposing dispatch/state from inside the provider tree. */
function HostBridge({
  sink,
}: {
  sink: { current: ReturnType<typeof useGameSessionForTest> | null }
}) {
  const ctx = useGameSessionForTest()
  sink.current = ctx
  return null
}

describe('Claim submit -> confirm cross-screen propagation (module-5-prize-claim-processing-winner-management)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('propagates a newly confirmed Winner to PlayerGame, HostDashboard Winner Panel, and PresentationView from one shared state update, without manual refresh (Req 8.5, 15.3)', async () => {
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    const allTermIds = ticket.rows.flat().map((c) => c.termId)
    // Mark exactly 5 terms so Cyber Five is ELIGIBLE (5/5).
    const marks5 = allTermIds.slice(0, 5).map((id) => buildMark(player, ticket, id))
    const revealedGame: Game = {
      ...game,
      status: 'WORD_ACTIVE',
      currentRound: 1,
      revealedTermIds: allTermIds,
    }
    seedSession({
      game: revealedGame,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
      marks: marks5,
    })

    const sink: { current: ReturnType<typeof useGameSessionForTest> | null } = {
      current: null,
    }

    // All three screens mounted under ONE shared GameSessionProvider,
    // together with a HostBridge that exposes dispatch/state directly —
    // mimicking multiple live screens over the same session state.
    render(
      <GameSessionProvider>
        <HostBridge sink={sink} />
        <MemoryRouter initialEntries={['/player']}>
          <Routes>
            <Route path="/player" element={<PlayerGame />} />
          </Routes>
        </MemoryRouter>
        <HostDashboard />
        <PresentationView />
      </GameSessionProvider>,
    )

    // Allow the BroadcastChannel subscription + initial sync to settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })

    // Sanity: before claim/confirm, Winner Panel shows 5x "Not awarded" and
    // Presentation View shows no announcement.
    expect(screen.getAllByText(/Not awarded/)).toHaveLength(5)
    expect(screen.queryByText(/Winner$/)).not.toBeInTheDocument()

    // Dispatch SUBMIT_PRIZE_CLAIM directly via the bridge.
    act(() => {
      sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: player.id,
        ticketId: ticket.id,
        prizeId: 'CYBER_FIVE',
      })
    })

    const submittedClaim = sink.current!.state.claims.find(
      (c) => c.playerId === player.id && c.prizeId === 'CYBER_FIVE',
    )
    expect(submittedClaim).toBeDefined()
    expect(submittedClaim!.validationStatus).toBe('VALID')
    expect(submittedClaim!.hostDecision).toBe('PENDING')

    // Dispatch CONFIRM_CLAIM for the resulting claim.
    act(() => {
      sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: submittedClaim!.id })
    })

    // --- Player screen reflects the confirmed Winner ---
    const cyberFiveBlock = screen
      .getByText('Cyber Five', { selector: '.player__claim-block-label' })
      .closest('li') as HTMLElement
    expect(cyberFiveBlock).toHaveTextContent('WINNER')
    expect(cyberFiveBlock).toHaveTextContent('confirmed')
    expect(
      screen.getByRole('button', { name: /winner confirmed/i }),
    ).toBeDisabled()

    // --- Host Winner Panel reflects the confirmed Winner ---
    // Only 4 prizes remain "Not awarded" (Cyber Five is now awarded).
    expect(screen.getAllByText(/Not awarded/)).toHaveLength(4)

    // --- Presentation View shows the winner announcement overlay ---
    expect(screen.getByText('Cyber Five Winner')).toBeInTheDocument()
    // The winner's display name now appears in both the Winner Panel row
    // and the Presentation View announcement.
    expect(screen.getAllByText('Riya Sharma').length).toBeGreaterThanOrEqual(2)
    expect(
      screen.getByRole('button', { name: /dismiss winner announcement/i }),
    ).toBeInTheDocument()
  })
})
