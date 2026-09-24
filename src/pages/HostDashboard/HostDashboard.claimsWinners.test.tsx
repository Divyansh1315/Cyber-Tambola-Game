// Feature: module-5-prize-claim-processing-winner-management — HostDashboard
// Claim Inbox and Winner Panel component tests (Task 11.5).
//
// Validates: Requirements 7.4, 8.1, 8.5, 9.2, 9.3, 10.1, 15.3, 19.1, 19.2
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { HostDashboard } from './HostDashboard'
import { GameSessionProvider } from '../../state/GameSessionContext'
import { STORAGE_KEY, toEnvelope } from '../../state/persistence'
import { createSeedGame } from '../../state/gameSessionInitialState'
import type { Player } from '../../types/player'
import type { Ticket } from '../../types/ticket'
import type { PrizeClaim, Winner } from '../../types/prize'

// --- Test fixtures ----------------------------------------------------------

const GAME_ID = 'GAME_001'

function makePlayer(overrides: Partial<Player> & { id: string }): Player {
  const displayName = overrides.displayName ?? 'Player'
  const employeeDemoId = overrides.employeeDemoId ?? 'EMP-0000'
  return {
    gameId: GAME_ID,
    joinedAt: new Date('2026-01-01T09:00:00.000Z').toISOString(),
    name: displayName,
    employeeId: employeeDemoId,
    ticketRef: `Ticket #${overrides.id}`,
    ticketId: `t-${overrides.id}`,
    ...overrides,
    displayName,
    employeeDemoId,
  }
}

function makeTicket(id: string, playerId: string): Ticket {
  return {
    id,
    playerId,
    gameId: GAME_ID,
    createdAt: new Date('2026-01-01T09:00:00.000Z').toISOString(),
    ref: `Ticket #${id}`,
    rows: [[{ termId: 'TERM_001', term: 'Phishing', state: 'LOCKED', row: 0, col: 0 }]],
  }
}

/** Build a PrizeClaim fixture with sensible defaults, overridable per test. */
function makeClaim(overrides: Partial<PrizeClaim> & { id: string }): PrizeClaim {
  return {
    gameId: GAME_ID,
    playerId: 'p1',
    ticketId: 't-p1',
    prizeId: 'CYBER_FIVE',
    submittedAt: new Date('2026-01-01T10:00:00.000Z').toISOString(),
    validationStatus: 'VALID',
    hostDecision: 'PENDING',
    prizeLabel: 'Cyber Five',
    playerName: 'Player',
    ticketRef: 'Ticket #1',
    ...overrides,
  }
}

/** Pre-seed a valid localStorage envelope, including claims/winners, so the provider restores it. */
function seedSession(opts: {
  players?: Player[]
  tickets?: Ticket[]
  claims?: PrizeClaim[]
  winners?: Winner[]
}): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(
      toEnvelope({
        game: createSeedGame(),
        players: opts.players ?? [],
        tickets: opts.tickets ?? [],
        marks: [],
        claims: opts.claims ?? [],
        winners: opts.winners ?? [],
      }),
    ),
  )
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

/** Grabs the "Pending Claims"/"Confirmed"/"Rejected/Invalid" subsection element by heading text. */
function getSubsection(title: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: title })
  return heading.parentElement as HTMLElement
}

// ---------------------------------------------------------------------------

describe('HostDashboard Claim Inbox + Winner Panel (Task 11.5)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('Pending Claims subsection lists claims PENDING-first then by submission time (Req 7.4)', () => {
    const players = [
      makePlayer({ id: 'p1', displayName: 'Asha', employeeDemoId: 'EMP-1001' }),
      makePlayer({ id: 'p2', displayName: 'Bhavya', employeeDemoId: 'EMP-1002' }),
      makePlayer({ id: 'p3', displayName: 'Chetan', employeeDemoId: 'EMP-1003' }),
    ]
    const tickets = players.map((p) => makeTicket(p.ticketId, p.id))

    // A REJECTED and a CONFIRMED claim submitted earlier should NOT appear
    // ahead of PENDING claims, even though they were submitted first.
    const claims: PrizeClaim[] = [
      makeClaim({
        id: 'c-rejected',
        playerId: 'p1',
        playerName: 'Asha',
        prizeId: 'FIREWALL_LINE',
        prizeLabel: 'Firewall Line',
        submittedAt: '2026-01-01T09:00:00.000Z',
        hostDecision: 'REJECTED',
        decidedAt: '2026-01-01T09:05:00.000Z',
      }),
      makeClaim({
        id: 'c-pending-late',
        playerId: 'p3',
        playerName: 'Chetan',
        prizeId: 'SECURITY_LINE',
        prizeLabel: 'Security Line',
        submittedAt: '2026-01-01T11:00:00.000Z',
        hostDecision: 'PENDING',
      }),
      makeClaim({
        id: 'c-pending-early',
        playerId: 'p2',
        playerName: 'Bhavya',
        prizeId: 'CYBER_FIVE',
        prizeLabel: 'Cyber Five',
        submittedAt: '2026-01-01T10:30:00.000Z',
        hostDecision: 'PENDING',
      }),
    ]

    seedSession({ players, tickets, claims })
    renderDashboard()

    const pendingSection = getSubsection('Pending Claims')
    const playerNames = within(pendingSection)
      .getAllByText(/^(Asha|Bhavya|Chetan)$/)
      .map((el) => el.textContent)

    // Only PENDING claims are in this subsection, ordered by submittedAt ascending.
    expect(playerNames).toEqual(['Bhavya', 'Chetan'])
    expect(within(pendingSection).queryByText('Asha')).not.toBeInTheDocument()
  })

  it('Confirm is disabled for an INVALID claim and enabled for a VALID/PENDING claim on an open prize (Req 8.1, 10.1)', () => {
    const players = [makePlayer({ id: 'p1', displayName: 'Asha', employeeDemoId: 'EMP-1001' })]
    const tickets = players.map((p) => makeTicket(p.ticketId, p.id))

    const claims: PrizeClaim[] = [
      makeClaim({
        id: 'c-invalid',
        playerId: 'p1',
        playerName: 'Asha',
        prizeId: 'FIREWALL_LINE',
        prizeLabel: 'Firewall Line',
        validationStatus: 'INVALID',
        rejectionReason: 'NOT_ELIGIBLE',
      }),
      makeClaim({
        id: 'c-valid',
        playerId: 'p1',
        playerName: 'Asha',
        prizeId: 'CYBER_FIVE',
        prizeLabel: 'Cyber Five',
        validationStatus: 'VALID',
        hostDecision: 'PENDING',
      }),
    ]

    seedSession({ players, tickets, claims })
    renderDashboard()

    const confirmButtons = screen.getAllByRole('button', { name: /confirm winner/i })
    expect(confirmButtons).toHaveLength(2)

    // The INVALID claim's row lives in the Rejected/Invalid subsection (Req 10.2).
    const rejectedSection = getSubsection('Rejected/Invalid')
    const invalidConfirmButton = within(rejectedSection).getByRole('button', {
      name: /confirm winner/i,
    })
    expect(invalidConfirmButton).toBeDisabled()

    const pendingSection = getSubsection('Pending Claims')
    const validConfirmButton = within(pendingSection).getByRole('button', {
      name: /confirm winner/i,
    })
    expect(validConfirmButton).toBeEnabled()
  })

  it('confirming one claim moves it to Confirmed and immediately shows the Winner Panel row without a refresh (Req 8.5, 15.3)', async () => {
    const user = userEvent.setup()
    const players = [makePlayer({ id: 'p1', displayName: 'Asha', employeeDemoId: 'EMP-1001' })]
    const tickets = players.map((p) => makeTicket(p.ticketId, p.id))
    const claims: PrizeClaim[] = [
      makeClaim({
        id: 'c-valid',
        playerId: 'p1',
        playerName: 'Asha',
        prizeId: 'CYBER_FIVE',
        prizeLabel: 'Cyber Five',
        validationStatus: 'VALID',
        hostDecision: 'PENDING',
      }),
    ]

    seedSession({ players, tickets, claims })
    renderDashboard()

    // Before confirming: Winner Panel shows "Not awarded" for Cyber Five.
    const winnersCard = screen.getByText('Winners').closest('.card') as HTMLElement
    const cyberFiveRow = within(winnersCard)
      .getByText('Cyber Five')
      .closest('li') as HTMLElement
    expect(cyberFiveRow).toHaveTextContent('Not awarded')

    const pendingSection = getSubsection('Pending Claims')
    const confirmButton = within(pendingSection).getByRole('button', { name: /confirm winner/i })
    await user.click(confirmButton)

    // After confirming: claim moved to Confirmed subsection.
    const confirmedSection = getSubsection('Confirmed')
    expect(within(confirmedSection).getByText('Asha')).toBeInTheDocument()
    expect(getSubsection('Pending Claims')).toHaveTextContent('No claims in this category.')

    // Winner Panel row for Cyber Five now shows the winner's name, same render.
    const cyberFiveRowAfter = within(winnersCard)
      .getByText('Cyber Five')
      .closest('li') as HTMLElement
    expect(cyberFiveRowAfter).toHaveTextContent('Asha')
    expect(cyberFiveRowAfter).not.toHaveTextContent('Not awarded')
  })

  it('rejecting a claim with a supplied reason shows that reason in the Rejected/Invalid subsection (Req 9.2, 9.3)', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'prompt').mockReturnValue('Duplicate / already won')

    const players = [makePlayer({ id: 'p1', displayName: 'Asha', employeeDemoId: 'EMP-1001' })]
    const tickets = players.map((p) => makeTicket(p.ticketId, p.id))
    const claims: PrizeClaim[] = [
      makeClaim({
        id: 'c-valid',
        playerId: 'p1',
        playerName: 'Asha',
        prizeId: 'CYBER_FIVE',
        prizeLabel: 'Cyber Five',
        validationStatus: 'VALID',
        hostDecision: 'PENDING',
      }),
    ]

    seedSession({ players, tickets, claims })
    renderDashboard()

    const pendingSection = getSubsection('Pending Claims')
    const rejectButton = within(pendingSection).getByRole('button', { name: /reject/i })
    await user.click(rejectButton)

    expect(window.prompt).toHaveBeenCalled()

    const rejectedSection = getSubsection('Rejected/Invalid')
    expect(within(rejectedSection).getByText('Asha')).toBeInTheDocument()
    expect(rejectedSection).toHaveTextContent('Duplicate / already won')
    expect(getSubsection('Pending Claims')).toHaveTextContent('No claims in this category.')
  })

  it('triggering Reset Demo Game clears both subsections and the Winner Panel back to all "Not awarded" (Req 19.1, 19.2)', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    const players = [
      makePlayer({ id: 'p1', displayName: 'Asha', employeeDemoId: 'EMP-1001' }),
      makePlayer({ id: 'p2', displayName: 'Bhavya', employeeDemoId: 'EMP-1002' }),
    ]
    const tickets = players.map((p) => makeTicket(p.ticketId, p.id))
    const claims: PrizeClaim[] = [
      makeClaim({
        id: 'c-confirmed',
        playerId: 'p1',
        playerName: 'Asha',
        prizeId: 'CYBER_FIVE',
        prizeLabel: 'Cyber Five',
        validationStatus: 'VALID',
        hostDecision: 'CONFIRMED',
        decidedAt: '2026-01-01T10:05:00.000Z',
      }),
      makeClaim({
        id: 'c-rejected',
        playerId: 'p2',
        playerName: 'Bhavya',
        prizeId: 'FIREWALL_LINE',
        prizeLabel: 'Firewall Line',
        validationStatus: 'VALID',
        hostDecision: 'REJECTED',
        rejectionReason: 'Other',
        decidedAt: '2026-01-01T10:06:00.000Z',
      }),
    ]
    const winners: Winner[] = [
      {
        id: 'w-1',
        gameId: GAME_ID,
        prizeId: 'CYBER_FIVE',
        playerId: 'p1',
        ticketId: 't-p1',
        claimId: 'c-confirmed',
        confirmedAt: '2026-01-01T10:05:00.000Z',
        prizeLabel: 'Cyber Five',
        playerName: 'Asha',
      },
    ]

    seedSession({ players, tickets, claims, winners })
    renderDashboard()

    // Sanity: pre-reset state has entries in Confirmed/Rejected and an awarded prize.
    expect(getSubsection('Confirmed')).toHaveTextContent('Asha')
    expect(getSubsection('Rejected/Invalid')).toHaveTextContent('Bhavya')
    const winnersCard = screen.getByText('Winners').closest('.card') as HTMLElement
    expect(winnersCard).toHaveTextContent('Asha')

    await user.click(screen.getByRole('button', { name: /reset demo game/i }))

    expect(getSubsection('Pending Claims')).toHaveTextContent('No claims in this category.')
    expect(getSubsection('Confirmed')).toHaveTextContent('No claims in this category.')
    expect(getSubsection('Rejected/Invalid')).toHaveTextContent('No claims in this category.')

    // All five prizes report "Not awarded" and no winner name remains.
    const notAwardedRows = within(winnersCard).getAllByText(/Not awarded/)
    expect(notAwardedRows).toHaveLength(5)
    expect(winnersCard).not.toHaveTextContent('Asha')
  })
})
