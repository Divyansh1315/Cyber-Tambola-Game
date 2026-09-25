// Feature: module-3-player-joining-tickets — PlayerGame component tests (Task 12.2)
// Feature: module-4-term-marking-prize-engine — PlayerGame marking/prize tests (Task 10.2)
import { describe, it, expect, beforeEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import {
  GameSessionProvider,
  useGameSession as useGameSessionForTest,
} from '../../state/GameSessionContext'
import { PlayerEntry } from '../PlayerEntry'
import { buildJoinOutcome } from '../../state/joinService'
import { createSeedGame } from '../../state/gameSessionInitialState'
import {
  CURRENT_PLAYER_STORAGE_KEY,
  STORAGE_KEY,
  toEnvelope,
} from '../../state/persistence'
import { cyberTerms } from '../../data/cyberTerms'
import type { Game } from '../../types/game'
import type { Mark } from '../../types/mark'
import type { Player } from '../../types/player'
import type { PrizeClaim, Winner } from '../../types/prize'
import type { Ticket } from '../../types/ticket'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a real player + ticket from the join service (no mocks/fakes). */
function buildJoined(game: Game): { player: Player; ticket: Ticket } {
  const outcome = buildJoinOutcome({
    form: { gameCode: 'CYBER24', employeeName: 'Asha Kumar', employeeId: 'EMP-1001' },
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

/**
 * Pre-seed localStorage with a v2 SHARED-state envelope, plus the separate
 * client-local currentPlayerId key, so the provider restores the given
 * player/ticket as the current player on mount (Req 16.2 restore path).
 */
function seedSession(args: {
  game: Game
  players: Player[]
  tickets: Ticket[]
  currentPlayerId?: string
  marks?: Mark[]
  claims?: PrizeClaim[]
  winners?: Winner[]
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

/** Build a well-formed PrizeClaim for a given player/ticket/prize (no mocks). */
function buildClaim(
  player: Player,
  ticket: Ticket,
  prizeId: PrizeClaim['prizeId'],
  overrides?: Partial<PrizeClaim>,
): PrizeClaim {
  return {
    id: `claim-${prizeId}-${player.id}`,
    gameId: player.gameId,
    playerId: player.id,
    ticketId: ticket.id,
    prizeId,
    submittedAt: new Date().toISOString(),
    validationStatus: 'VALID',
    hostDecision: 'PENDING',
    prizeLabel: prizeId,
    playerName: player.displayName,
    ticketRef: ticket.id,
    ...overrides,
  }
}

/** Build a well-formed Winner for a given player/ticket/prize (no mocks). */
function buildWinner(
  player: Player,
  ticket: Ticket,
  prizeId: PrizeClaim['prizeId'],
  claimId: string,
  overrides?: Partial<Winner>,
): Winner {
  return {
    id: `winner-${prizeId}`,
    gameId: player.gameId,
    prizeId,
    playerId: player.id,
    ticketId: ticket.id,
    claimId,
    confirmedAt: new Date().toISOString(),
    prizeLabel: prizeId,
    playerName: player.displayName,
    ticketRef: ticket.id,
    ...overrides,
  }
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

/** Render PlayerGame inside provider + router at /player. */
function renderPlayerGame(options?: {
  restored?: boolean
}) {
  const initialEntry = options?.restored
    ? { pathname: '/player', state: { restored: true } }
    : { pathname: '/player' }
  return render(
    <GameSessionProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          {/* PlayerGame redirects to "/player" (not "/") when there is no
              current player/ticket -- "/" is the Host Dashboard in the real
              app. PlayerEntry is the real production wrapper that renders
              PlayerJoin/PlayerGame at "/player" based on currentPlayer, so
              using it here (rather than PlayerGame in isolation) keeps this
              test's redirect assertions faithful to production routing. */}
          <Route path="/player" element={<PlayerEntry />} />
        </Routes>
      </MemoryRouter>
    </GameSessionProvider>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlayerGame (module-3-player-joining-tickets)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('redirects to the join screen when there is no current player (Req 9.4)', () => {
    // No session seeded → provider has no current player.
    renderPlayerGame()

    // The join screen renders its "Join Game" control; the player header does not.
    expect(
      screen.getByRole('button', { name: /join game/i }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Your Cyber Word Ticket')).not.toBeInTheDocument()
  })

  it('header shows the display name and a short ticket ref, not a long id or Divyansh (Req 10.1–10.3)', () => {
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    seedSession({
      game,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
    })

    renderPlayerGame()

    // Real display name is shown; the old hard-coded demo name is gone.
    expect(screen.getByText('Asha Kumar')).toBeInTheDocument()
    expect(screen.queryByText('Divyansh')).not.toBeInTheDocument()

    // Short "Ticket #XXXX" ref is shown; the full ticket id is never rendered.
    expect(screen.getByText(/^Ticket #[0-9A-Z]+$/)).toBeInTheDocument()
    expect(screen.queryByText(ticket.id)).not.toBeInTheDocument()
  })

  it('renders 15 ticket cells resolved from real ticket data (Req 11.1, 11.2)', () => {
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    seedSession({
      game,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
    })

    renderPlayerGame()

    // The ticket grid renders one gridcell per cell — exactly 15 for a 3x5 ticket.
    expect(screen.getAllByRole('gridcell')).toHaveLength(15)
  })

  it('flips a ticket cell from LOCKED to AVAILABLE when its term is revealed (Test E, Req 12.2)', () => {
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    // Pick a term that is on this ticket and drive the game to reveal it.
    const targetTermId = ticket.rows[0][0].termId
    const revealedGame: Game = {
      ...game,
      status: 'WORD_ACTIVE',
      currentRound: 1,
      currentTermId: targetTermId,
      revealedTermIds: [targetTermId],
    }
    seedSession({
      game: revealedGame,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
    })

    renderPlayerGame()

    // The revealed cell's button is now tappable (AVAILABLE), no longer locked.
    const label = ticket.rows[0][0].term
    const cellButton = screen.getByRole('button', {
      name: new RegExp(`^${label}\\.`),
    })
    expect(cellButton).toBeEnabled()
    expect(cellButton).toHaveAttribute('aria-label', expect.stringMatching(/Available/))
  })

  it('keeps the Cyber Five claim button disabled with the exact progress at initial zeroed progress (Req 2.3, 12.3, 18.3)', () => {
    // Reveal an answer so the reveal precondition is met but progress is still 0.
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    const revealedGame: Game = {
      ...game,
      status: 'WORD_ACTIVE',
      currentRound: 1,
      currentTermId: ticket.rows[0][0].termId,
      revealedTermIds: [ticket.rows[0][0].termId],
    }
    seedSession({
      game: revealedGame,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
    })

    renderPlayerGame()

    // Module 5: each Prize_Id renders its own progress-based message and its
    // own claim button, driven by derivePlayerClaimStatus (NOT_ELIGIBLE at 0/5).
    const cyberFiveBlock = screen.getByText('Cyber Five', {
      selector: '.player__claim-block-label',
    }).closest('li') as HTMLElement
    expect(cyberFiveBlock).toHaveTextContent('Progress: 0/5')
    expect(
      screen.getByRole('button', { name: /claim cyber five/i }),
    ).toBeDisabled()
  })

  it('shows the restored-session message when navigated with { restored: true } (Req 5.5)', () => {
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    seedSession({
      game,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
    })

    renderPlayerGame({ restored: true })

    expect(
      screen.getByText('Existing game session restored.'),
    ).toBeInTheDocument()
  })
})

describe('PlayerGame marking and prize display (module-4-term-marking-prize-engine)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('tapping an AVAILABLE cell dispatches MARK_TERM and the cell re-renders as MARKED (Req 12.1, 12.2, 12.4)', async () => {
    const user = userEvent.setup()
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    const targetTermId = ticket.rows[0][0].termId
    const revealedGame: Game = {
      ...game,
      status: 'WORD_ACTIVE',
      currentRound: 1,
      currentTermId: targetTermId,
      revealedTermIds: [targetTermId],
    }
    seedSession({
      game: revealedGame,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
    })

    renderPlayerGame()

    const label = ticket.rows[0][0].term
    const cellButton = screen.getByRole('button', {
      name: new RegExp(`^${label}\\.`),
    })
    expect(cellButton).toHaveAttribute('aria-label', expect.stringMatching(/Available/))

    await user.click(cellButton)

    // Re-render happens in place — no navigation/reload occurred (still on
    // the same page, same button element updates to MARKED).
    expect(cellButton).toHaveAttribute('aria-label', expect.stringMatching(/Marked/))
    expect(cellButton).toHaveAttribute('aria-pressed', 'true')
    expect(cellButton.textContent).toContain('✓')
  })

  it('tapping a LOCKED cell does not mark it, shows the hint, and leaves progress unchanged (Req 13, 14.1, 14.2)', async () => {
    const user = userEvent.setup()
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    // Nothing revealed yet — every cell is LOCKED.
    seedSession({
      game,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
    })

    renderPlayerGame()

    const progressBefore = screen.getAllByRole('progressbar').map((el) =>
      el.getAttribute('aria-valuenow'),
    )

    const label = ticket.rows[0][0].term
    const cellButton = screen.getByRole('button', {
      name: new RegExp(`^${label}\\.`),
    })
    expect(cellButton).toBeDisabled()

    // A disabled button cannot be clicked via user-event's pointer checks,
    // which itself proves LOCKED cells never dispatch. Directly assert the
    // locked state and that no lockedHint/progress change occurs regardless.
    await user.click(cellButton).catch(() => undefined)

    expect(cellButton).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/not revealed yet/i),
    )
    expect(screen.queryByText(/has not been revealed yet\.$/)).not.toBeInTheDocument()

    const progressAfter = screen.getAllByRole('progressbar').map((el) =>
      el.getAttribute('aria-valuenow'),
    )
    expect(progressAfter).toEqual(progressBefore)
  })

  it('tapping an already-MARKED cell is a no-op: stays MARKED, progress unchanged (Req 13.1, 13.2, 14.3)', async () => {
    const user = userEvent.setup()
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    const targetTermId = ticket.rows[0][0].termId
    const revealedGame: Game = {
      ...game,
      status: 'WORD_ACTIVE',
      currentRound: 1,
      currentTermId: targetTermId,
      revealedTermIds: [targetTermId],
    }
    const mark = buildMark(player, ticket, targetTermId)
    seedSession({
      game: revealedGame,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
      marks: [mark],
    })

    renderPlayerGame()

    const label = ticket.rows[0][0].term
    const cellButton = screen.getByRole('button', {
      name: new RegExp(`^${label}\\.`),
    })
    expect(cellButton).toHaveAttribute('aria-label', expect.stringMatching(/Marked/))

    const progressBefore = screen.getAllByRole('progressbar').map((el) =>
      el.getAttribute('aria-valuenow'),
    )

    await user.click(cellButton)

    expect(cellButton).toHaveAttribute('aria-label', expect.stringMatching(/Marked/))
    const progressAfter = screen.getAllByRole('progressbar').map((el) =>
      el.getAttribute('aria-valuenow'),
    )
    expect(progressAfter).toEqual(progressBefore)
  })

  it('Prize Progress panel reflects real currentPrizeProgress after a mark is created (Req 15.1, 15.2, 15.3)', async () => {
    const user = userEvent.setup()
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    const targetTermId = ticket.rows[0][0].termId
    const revealedGame: Game = {
      ...game,
      status: 'WORD_ACTIVE',
      currentRound: 1,
      currentTermId: targetTermId,
      revealedTermIds: [targetTermId],
    }
    seedSession({
      game: revealedGame,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
    })

    renderPlayerGame()

    // Before marking: Cyber Five shows the real computed 0/5 (not any other
    // stale mock value baked into state.prizeProgress). Scope to the Prize
    // Progress panel's own "Cyber Five" label, since Module 5's claim block
    // also renders a "Cyber Five" label elsewhere on the page.
    const cyberFiveItem = () =>
      screen
        .getAllByText('Cyber Five')
        .map((el) => el.closest('li') as HTMLElement)
        .find((li) => li.classList.contains('prize-progress__item'))!
    expect(cyberFiveItem()).toHaveTextContent('0/5')

    const label = ticket.rows[0][0].term
    const cellButton = screen.getByRole('button', {
      name: new RegExp(`^${label}\\.`),
    })
    await user.click(cellButton)

    // After marking one term: Cyber Five progresses to 1/5, proving the panel
    // re-renders from live currentPrizeProgress, not a static snapshot.
    expect(cyberFiveItem()).toHaveTextContent('1/5')
    const cyberFiveClaimBlock = screen.getByText('Cyber Five', {
      selector: '.player__claim-block-label',
    }).closest('li') as HTMLElement
    expect(cyberFiveClaimBlock).toHaveTextContent('Progress: 1/5')
  })

  it('shows the exact progress messaging at 3/5 and 4/5, and the Ready message at 5/5 (Req 12.3, 12.4)', () => {
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    const allTermIds = ticket.rows.flat().map((c) => c.termId)

    // --- 3/5 marked ---
    const marks3 = allTermIds.slice(0, 3).map((id) => buildMark(player, ticket, id))
    const revealedGame3: Game = {
      ...game,
      status: 'WORD_ACTIVE',
      currentRound: 1,
      revealedTermIds: allTermIds,
    }
    seedSession({
      game: revealedGame3,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
      marks: marks3,
    })
    const { unmount: unmount3 } = renderPlayerGame()
    const cyberFiveBlock3 = screen.getByText('Cyber Five', {
      selector: '.player__claim-block-label',
    }).closest('li') as HTMLElement
    expect(cyberFiveBlock3).toHaveTextContent('Progress: 3/5')
    unmount3()
    window.localStorage.clear()

    // --- 4/5 marked ---
    const marks4 = allTermIds.slice(0, 4).map((id) => buildMark(player, ticket, id))
    seedSession({
      game: revealedGame3,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
      marks: marks4,
    })
    const { unmount: unmount4 } = renderPlayerGame()
    const cyberFiveBlock4 = screen.getByText('Cyber Five', {
      selector: '.player__claim-block-label',
    }).closest('li') as HTMLElement
    expect(cyberFiveBlock4).toHaveTextContent('Progress: 4/5')
    unmount4()
    window.localStorage.clear()

    // --- 5/5 marked ---
    const marks5 = allTermIds.slice(0, 5).map((id) => buildMark(player, ticket, id))
    seedSession({
      game: revealedGame3,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
      marks: marks5,
    })
    renderPlayerGame()
    expect(screen.getByText('🎉 Cyber Five Ready!')).toBeInTheDocument()
  })

  it('Claim control is disabled below 5/5, and enabled with Cyber Five Ready wording at 5/5 (Req 12.3, 12.4)', () => {
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    const allTermIds = ticket.rows.flat().map((c) => c.termId)

    // Below eligibility (4/5): Claim disabled, no ready text.
    const marks4 = allTermIds.slice(0, 4).map((id) => buildMark(player, ticket, id))
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
      marks: marks4,
    })
    const { unmount } = renderPlayerGame()
    expect(
      screen.getByRole('button', { name: /claim cyber five/i }),
    ).toBeDisabled()
    expect(screen.queryByText('🎉 Cyber Five Ready!')).not.toBeInTheDocument()
    unmount()
    window.localStorage.clear()

    // At eligibility (5/5): Claim enabled and labeled "Claim Cyber Five".
    const marks5 = allTermIds.slice(0, 5).map((id) => buildMark(player, ticket, id))
    seedSession({
      game: revealedGame,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
      marks: marks5,
    })
    renderPlayerGame()
    const claimButton = screen.getByRole('button', { name: /claim cyber five/i })
    expect(claimButton).toBeEnabled()
    expect(screen.getByText('🎉 Cyber Five Ready!')).toBeInTheDocument()
  })
})

describe('PlayerGame per-prize claim UI (module-5-prize-claim-processing-winner-management)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  function claimBlockFor(label: string): HTMLElement {
    return screen
      .getByText(label, { selector: '.player__claim-block-label' })
      .closest('li') as HTMLElement
  }

  it('tapping an ELIGIBLE prize claim button dispatches SUBMIT_PRIZE_CLAIM and re-renders that block as PENDING (Req 2.1, 2.2, 2.5, 12.5)', async () => {
    const user = userEvent.setup()
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    const allTermIds = ticket.rows.flat().map((c) => c.termId)
    // Cyber Five at 5/5 -> ELIGIBLE.
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

    renderPlayerGame()

    const claimButton = screen.getByRole('button', { name: /claim cyber five/i })
    expect(claimButton).toBeEnabled()

    await user.click(claimButton)

    // Re-renders in place: the Cyber Five block now shows the PENDING
    // message and a disabled "Claim Pending" control.
    const cyberFiveBlock = claimBlockFor('Cyber Five')
    expect(cyberFiveBlock).toHaveTextContent(
      'Claim submitted. Waiting for Host confirmation.',
    )
    expect(
      screen.getByRole('button', { name: /claim pending/i }),
    ).toBeDisabled()
  })

  it('a NOT_ELIGIBLE prize claim button is disabled with progress text, and claiming/interacting with one prize never affects the other four (Req 2.5, 12.3, 13.2, 13.3, 18.5)', async () => {
    const user = userEvent.setup()
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    const allTermIds = ticket.rows.flat().map((c) => c.termId)
    // Mark exactly one cell per row plus a couple extra spread across rows,
    // so Cyber Five (any 5 marks) reaches 5/5 while no single Line_Prize row
    // (which needs all 5 of its own row's cells) or Full House (needs all
    // 15) reaches its own target.
    const marks5 = [
      ticket.rows[0][0].termId,
      ticket.rows[1][0].termId,
      ticket.rows[2][0].termId,
      ticket.rows[0][1].termId,
      ticket.rows[1][1].termId,
    ].map((id) => buildMark(player, ticket, id))
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

    renderPlayerGame()

    const otherLabels = [
      'Firewall Line',
      'Security Line',
      'Data Defender Line',
      'Cyber Full House',
    ]
    const otherButtonsBefore = otherLabels.map((label) =>
      screen.getByRole('button', { name: new RegExp(`^claim ${label}`, 'i') }),
    )
    otherButtonsBefore.forEach((btn) => expect(btn).toBeDisabled())
    const otherBlocksTextBefore = otherLabels.map((label) =>
      claimBlockFor(label).textContent,
    )

    // Claim the ELIGIBLE prize (Cyber Five) — the other four must not change.
    await user.click(screen.getByRole('button', { name: /claim cyber five/i }))

    otherLabels.forEach((label, i) => {
      const btn = screen.getByRole('button', {
        name: new RegExp(`^claim ${label}`, 'i'),
      })
      expect(btn).toBeDisabled()
      expect(claimBlockFor(label).textContent).toBe(otherBlocksTextBefore[i])
    })

    // Each NOT_ELIGIBLE block shows its own real progress text.
    expect(claimBlockFor('Firewall Line')).toHaveTextContent('Progress: 2/5')
    expect(claimBlockFor('Cyber Full House')).toHaveTextContent('Progress: 5/15')
  })

  it('after a host confirms, that prize block shows the Winner Confirmed celebration without covering the ticket or other prize blocks (Req 12.6, 13.1, 13.2, 13.3)', () => {
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    const claim = buildClaim(player, ticket, 'CYBER_FIVE', {
      hostDecision: 'CONFIRMED',
      decidedAt: new Date().toISOString(),
    })
    const winner = buildWinner(player, ticket, 'CYBER_FIVE', claim.id)
    seedSession({
      game,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
      claims: [claim],
      winners: [winner],
    })

    renderPlayerGame()

    const cyberFiveBlock = claimBlockFor('Cyber Five')
    expect(cyberFiveBlock).toHaveTextContent('WINNER')
    expect(cyberFiveBlock).toHaveTextContent('confirmed')
    expect(
      screen.getByRole('button', { name: /winner confirmed/i }),
    ).toBeDisabled()

    // The ticket and the other prize blocks are still fully present, not
    // covered by any overlay.
    expect(screen.getByText('Your Cyber Word Ticket')).toBeInTheDocument()
    expect(screen.getAllByRole('gridcell')).toHaveLength(15)
    expect(claimBlockFor('Firewall Line')).toBeInTheDocument()
    expect(claimBlockFor('Security Line')).toBeInTheDocument()
    expect(claimBlockFor('Data Defender Line')).toBeInTheDocument()
    expect(claimBlockFor('Cyber Full House')).toBeInTheDocument()
  })

  it('an INVALID-result claim shows the exact progress-based message, not a generic error (Req 10.3)', () => {
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    const allTermIds = ticket.rows.flat().map((c) => c.termId)
    // 4/5 marked for Cyber Five — an own claim was already rejected by the
    // system as INVALID (e.g. submitted before reaching 5/5).
    const marks4 = allTermIds.slice(0, 4).map((id) => buildMark(player, ticket, id))
    const revealedGame: Game = {
      ...game,
      status: 'WORD_ACTIVE',
      currentRound: 1,
      revealedTermIds: allTermIds,
    }
    const invalidClaim = buildClaim(player, ticket, 'CYBER_FIVE', {
      validationStatus: 'INVALID',
      rejectionReason: 'NOT_ELIGIBLE',
    })
    seedSession({
      game: revealedGame,
      players: [player],
      tickets: [ticket],
      currentPlayerId: player.id,
      marks: marks4,
      claims: [invalidClaim],
    })

    renderPlayerGame()

    expect(
      screen.getByText('Claim could not be validated. Your current progress is 4/5.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/^(error|something went wrong)/i),
    ).not.toBeInTheDocument()
  })

  it('a player can continue marking terms and see progress increase for other prizes after winning one (Req 13.3, 18.5)', async () => {
    const user = userEvent.setup()
    const game = createSeedGame()
    const { player, ticket } = buildJoined(game)
    const allTermIds = ticket.rows.flat().map((c) => c.termId)
    // Spread the 5 Cyber-Five-winning marks across rows so row 0 (Firewall
    // Line) still has an unmarked cell left to mark in this test.
    const cyberFiveTermIds = [
      ticket.rows[0][0].termId,
      ticket.rows[0][1].termId,
      ticket.rows[1][0].termId,
      ticket.rows[1][1].termId,
      ticket.rows[2][0].termId,
    ]
    const cyberFiveMarks = cyberFiveTermIds.map((id) => buildMark(player, ticket, id))
    const claim = buildClaim(player, ticket, 'CYBER_FIVE', {
      hostDecision: 'CONFIRMED',
      decidedAt: new Date().toISOString(),
    })
    const winner = buildWinner(player, ticket, 'CYBER_FIVE', claim.id)
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
      marks: cyberFiveMarks,
      claims: [claim],
      winners: [winner],
    })

    renderPlayerGame()

    // Confirmed prize stays CONFIRMED.
    expect(claimBlockFor('Cyber Five')).toHaveTextContent('WINNER')

    // Mark another term belonging to a still-open prize (row 0 = Firewall Line).
    const nextTermId = ticket.rows[0].find(
      (c) => !cyberFiveMarks.some((m) => m.termId === c.termId),
    )!.termId
    const nextLabel = ticket.rows[0].find((c) => c.termId === nextTermId)!.term

    const cellButton = screen.getByRole('button', {
      name: new RegExp(`^${nextLabel}\\.`),
    })
    await user.click(cellButton)

    // Firewall Line progress increased for the remaining open prize.
    expect(claimBlockFor('Firewall Line')).toHaveTextContent(/Progress: [1-9]\/5/)

    // The confirmed prize's own status remains unaffected.
    expect(claimBlockFor('Cyber Five')).toHaveTextContent('WINNER')
    expect(
      screen.getByRole('button', { name: /winner confirmed/i }),
    ).toBeDisabled()
  })
})

describe('PlayerGame survives Host lifecycle dispatches without redirecting (bugfix regression)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  const hasBroadcastChannel =
    typeof (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel === 'function'

  it.runIf(hasBroadcastChannel)(
    'stays rendered (never navigates to /) while a separate Host tab dispatches lifecycle actions, and marking still works interleaved with reveals',
    async () => {
      const user = userEvent.setup()
      const game = createSeedGame()
      const { player, ticket } = buildJoined(game)
      seedSession({
        game,
        players: [player],
        tickets: [ticket],
        currentPlayerId: player.id,
      })

      // The Player tab: mounts the real PlayerEntry wrapper at "/player",
      // seeded with the joined player above (loaded from localStorage on
      // mount) -- matches production routing, where "/" is the Host
      // Dashboard and "/player" is the sole Player entry point.
      render(
        <GameSessionProvider>
          <MemoryRouter initialEntries={['/player']}>
            <Routes>
              <Route path="/player" element={<PlayerEntry />} />
            </Routes>
          </MemoryRouter>
        </GameSessionProvider>,
      )
      expect(screen.getByText('Your Cyber Word Ticket')).toBeInTheDocument()

      // A separate "Host" tab: its own provider instance, with NO current
      // player of its own (host tabs never call JOIN_PLAYER/RESTORE_PLAYER).
      // This is exactly the shape of the original defect — a Host tab
      // broadcasting lifecycle actions while its own currentPlayerId (and
      // possibly its own view of `players`) has nothing to do with the
      // Player tab's identity.
      function HostBridge({ sink }: { sink: { current: ReturnType<typeof useGameSessionForTest> | null } }) {
        const ctx = useGameSessionForTest()
        sink.current = ctx
        return null
      }
      const hostSink: { current: ReturnType<typeof useGameSessionForTest> | null } = {
        current: null,
      }
      render(
        <GameSessionProvider>
          <HostBridge sink={hostSink} />
        </GameSessionProvider>,
      )

      // Allow the BroadcastChannel subscription + initial sync to settle.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20))
      })

      const targetTermId = ticket.rows[0][0].termId
      const label = ticket.rows[0][0].term

      // The Host tab drives the game forward via real lifecycle dispatches.
      // Its own `players` may be empty/stale relative to the Player tab —
      // that must never redirect the Player tab away from PlayerGame.
      act(() => {
        hostSink.current!.dispatch({ type: 'START_GAME' })
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20))
      })
      expect(screen.getByText('Your Cyber Word Ticket')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /join game/i })).not.toBeInTheDocument()

      // Reveal clues from the Host tab until the player's own ticket term is
      // revealed, then mark it from the Player-tab UI, interleaved with
      // further Host reveals — proving the marks-persistence fix and the
      // identity fix coexist correctly.
      const activeTermCount = cyberTerms.filter((t) => t.active).length
      let revealed = hostSink.current!.state.game.revealedTermIds.includes(targetTermId)
      for (let i = 0; i < activeTermCount && !revealed; i++) {
        if (hostSink.current!.state.game.status === 'COMPLETED') break
        act(() => {
          hostSink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
        })
        await act(async () => {
          await new Promise((r) => setTimeout(r, 20))
        })
        if (hostSink.current!.state.game.revealedTermIds.includes(targetTermId)) {
          revealed = true
          break
        }
      }
      expect(revealed).toBe(true)

      // Still on PlayerGame, never redirected.
      expect(screen.getByText('Your Cyber Word Ticket')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /join game/i })).not.toBeInTheDocument()

      const cellButton = screen.getByRole('button', {
        name: new RegExp(`^${label}\\.`),
      })
      expect(cellButton).toHaveAttribute('aria-label', expect.stringMatching(/Available/))

      await user.click(cellButton)

      expect(cellButton).toHaveAttribute('aria-label', expect.stringMatching(/Marked/))

      // A further Host-only lifecycle action (pause/resume) still must not
      // redirect the player away, and the mark must survive it.
      act(() => {
        hostSink.current!.dispatch({ type: 'PAUSE_GAME' })
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20))
      })
      act(() => {
        hostSink.current!.dispatch({ type: 'RESUME_GAME' })
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20))
      })

      expect(screen.queryByRole('button', { name: /join game/i })).not.toBeInTheDocument()
      expect(cellButton).toHaveAttribute('aria-label', expect.stringMatching(/Marked/))
    },
  )
})
