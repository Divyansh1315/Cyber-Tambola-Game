// Feature: module-3-player-joining-tickets — HostDashboard component tests
//
// Validates: Requirements 6.1, 6.2, 17.2, 17.4
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HostDashboard } from './HostDashboard'
import { GameSessionProvider } from '../../state/GameSessionContext'
import { STORAGE_KEY, toEnvelope } from '../../state/persistence'
import { createSeedGame } from '../../state/gameSessionInitialState'
import type { Player } from '../../types/player'
import type { Ticket } from '../../types/ticket'

// --- Test fixtures ----------------------------------------------------------

function makePlayer(overrides: Partial<Player> & { id: string }): Player {
  const displayName = overrides.displayName ?? 'Player'
  const employeeDemoId = overrides.employeeDemoId ?? 'EMP-0000'
  return {
    gameId: 'GAME_001',
    joinedAt: new Date('2026-01-01T09:00:00.000Z').toISOString(),
    name: displayName,
    employeeId: employeeDemoId,
    ticketRef: `Ticket #${overrides.id}`,
    ticketId: `t-${overrides.id}`,
    ...overrides,
    // Explicit fields not present as raw override keys are set from resolved values.
    displayName,
    employeeDemoId,
  }
}

function makeTicket(id: string, playerId: string): Ticket {
  return {
    id,
    playerId,
    gameId: 'GAME_001',
    createdAt: new Date('2026-01-01T09:00:00.000Z').toISOString(),
    ref: `Ticket #${id}`,
    rows: [
      [{ termId: 'TERM_001', term: 'Phishing', state: 'LOCKED', row: 0, col: 0 }],
    ],
  }
}

/** Pre-seed a valid v2 localStorage envelope so the provider restores it. */
function seedPlayers(players: Player[], tickets: Ticket[]): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(
      toEnvelope({
        game: createSeedGame(),
        players,
        tickets,
        marks: [],
        claims: [],
        winners: [],
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

// ---------------------------------------------------------------------------

describe('HostDashboard participant count + roster', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('shows a participant count of 0 with no players and never the fixed 47 (Req 6.1, 6.2)', () => {
    renderDashboard()

    // The Participants stat is present and derived from players.length === 0.
    const label = screen.getByText('Participants', { selector: '.host__stat-label' })
    const stat = label.parentElement as HTMLElement
    expect(stat).toHaveTextContent('0')

    // The fixed demo value 47 must never appear as the participant count.
    expect(screen.queryByText('47')).not.toBeInTheDocument()
  })

  it('participant count equals players.length after seeding (Req 6.1)', () => {
    const players = [
      makePlayer({ id: 'p1', displayName: 'Asha', employeeDemoId: 'EMP-1001' }),
      makePlayer({ id: 'p2', displayName: 'Bhavya', employeeDemoId: 'EMP-1002' }),
      makePlayer({ id: 'p3', displayName: 'Chetan', employeeDemoId: 'EMP-1003' }),
    ]
    const tickets = players.map((p) => makeTicket(p.ticketId, p.id))
    seedPlayers(players, tickets)

    renderDashboard()

    const label = screen.getByText('Participants', { selector: '.host__stat-label' })
    const stat = label.parentElement as HTMLElement
    expect(stat).toHaveTextContent(String(players.length))
    expect(screen.queryByText('47')).not.toBeInTheDocument()
  })

  it('the participant roster lists display names but never any employeeDemoId (Req 17.2, 17.4)', () => {
    const players = [
      makePlayer({ id: 'p1', displayName: 'Asha', employeeDemoId: 'EMP-1001' }),
      makePlayer({ id: 'p2', displayName: 'Bhavya', employeeDemoId: 'EMP-1002' }),
    ]
    const tickets = players.map((p) => makeTicket(p.ticketId, p.id))
    seedPlayers(players, tickets)

    const { container } = renderDashboard()

    // Display names are visible.
    expect(screen.getByText('Asha')).toBeInTheDocument()
    expect(screen.getByText('Bhavya')).toBeInTheDocument()

    // No employeeDemoId string appears anywhere in the rendered output.
    expect(container.textContent).not.toContain('EMP-1001')
    expect(container.textContent).not.toContain('EMP-1002')
  })
})
