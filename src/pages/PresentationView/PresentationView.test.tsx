// Feature: module-3-player-joining-tickets — PresentationView component tests
//
// Validates: Requirements 17.3
//
// Feature: module-5-prize-claim-processing-winner-management — winner
// announcement component tests (Task 13.2)
// Validates: Requirements 14.1, 14.2, 14.3
//
// Feature: winner-history-and-game-reset — task 12.2
// Regression assertion that Winner_History is never rendered by
// PresentationView.tsx, for both a Supabase-configured and a Local-Fallback
// render. Mocks `../../state/realtimeClient` module-wide (same convention as
// `HostDashboard.winnerHistory.test.tsx` / `GameSessionContext.pointerFollow
// .integration.test.tsx`) so the Supabase-configured render path is
// exercised without a network call.
// Validates: Requirements 2.5, 9.4
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  function getSupabaseConfig() {
    // A Supabase-configured render is exercised whenever a mock client is
    // set for the test; Local Fallback is exercised when it is null.
    return mockClient ? { url: 'https://mock.supabase.co', anonKey: 'mock-anon-key' } : null
  }

  return {
    ...actual,
    getSupabaseClient,
    getSupabaseConfig,
  }
})

import { PresentationView } from './PresentationView'
import { GameSessionProvider } from '../../state/GameSessionContext'
import { STORAGE_KEY, toEnvelope } from '../../state/persistence'
import type { Game } from '../../types/game'
import type { Player } from '../../types/player'
import type { Ticket } from '../../types/ticket'
import type { Winner } from '../../types/prize'

// --- Test fixtures ----------------------------------------------------------

function makePlayer(id: string, displayName: string, employeeDemoId: string): Player {
  return {
    id,
    gameId: 'GAME_001',
    displayName,
    employeeDemoId,
    ticketId: `t-${id}`,
    joinedAt: new Date('2026-01-01T09:00:00.000Z').toISOString(),
    name: displayName,
    employeeId: employeeDemoId,
    ticketRef: `Ticket #${id}`,
  }
}

function makeTicket(id: string, playerId: string): Ticket {
  return {
    id,
    playerId,
    gameId: 'GAME_001',
    createdAt: new Date('2026-01-01T09:00:00.000Z').toISOString(),
    ref: `Ticket #${id}`,
    rows: [[{ termId: 'TERM_001', term: 'Phishing', state: 'LOCKED', row: 0, col: 0 }]],
  }
}

function seedGame(
  game: Game,
  players: Player[],
  tickets: Ticket[],
  winners: Winner[] = [],
): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(
      toEnvelope({ game, players, tickets, marks: [], claims: [], winners }),
    ),
  )
}

function makeWinner(overrides: Partial<Winner> = {}): Winner {
  return {
    id: 'winner-1',
    gameId: 'GAME_001',
    prizeId: 'CYBER_FIVE',
    playerId: 'p1',
    ticketId: 't-p1',
    claimId: 'claim-fake-id-999',
    confirmedAt: new Date('2026-01-01T09:05:00.000Z').toISOString(),
    prizeLabel: 'Cyber Five',
    playerName: 'Asha',
    ticketRef: 't-p1-ref',
    ...overrides,
  }
}

function baseGame(status: Game['status']): Game {
  return {
    id: 'GAME_001',
    code: 'CYBER24',
    status,
    createdAt: new Date('2026-01-01T09:00:00.000Z').toISOString(),
    currentRound: status === 'LOBBY' ? 0 : 1,
    currentTermId: status === 'WORD_ACTIVE' ? 'TERM_001' : undefined,
    revealedTermIds: status === 'WORD_ACTIVE' ? ['TERM_001'] : [],
  }
}

function renderView() {
  return render(
    <MemoryRouter>
      <GameSessionProvider>
        <PresentationView />
      </GameSessionProvider>
    </MemoryRouter>,
  )
}

const SEEDED_IDS = ['EMP-1001', 'EMP-1002']

/** Queues get_active_game to resolve to no row, so the pointer-follow mount
 *  effect settles on NO_ACTIVE_GAME rather than hanging on an unqueued RPC. */
function queueNoActiveGame(client: MockSupabaseClient) {
  client.queueRpcResponse('get_active_game', { data: [] })
}

// Markup/text fragments that would only ever appear if PresentationView.tsx
// rendered a Winner_History section (see HostDashboard.tsx's
// `host__winner-history*` classes and "Winner History" card title).
const WINNER_HISTORY_MARKERS = ['Winner History', 'host__winner-history']

function assertNoWinnerHistoryMarkup(container: HTMLElement): void {
  for (const marker of WINNER_HISTORY_MARKERS) {
    expect(container.textContent).not.toContain(marker)
  }
  expect(container.querySelector('[class*="winner-history"]')).toBeNull()
}

// ---------------------------------------------------------------------------

describe('PresentationView never exposes an Employee/Demo ID (Req 17.3)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  const statuses: Game['status'][] = ['LOBBY', 'WORD_ACTIVE']

  statuses.forEach((status) => {
    it(`renders no employeeDemoId while status is ${status}`, () => {
      const players = [
        makePlayer('p1', 'Asha', SEEDED_IDS[0]),
        makePlayer('p2', 'Bhavya', SEEDED_IDS[1]),
      ]
      const tickets = players.map((p) => makeTicket(p.ticketId, p.id))
      seedGame(baseGame(status), players, tickets)

      const { container } = renderView()

      for (const id of SEEDED_IDS) {
        expect(container.textContent).not.toContain(id)
      }
    })
  })
})

describe('PresentationView never renders Winner_History (Req 2.5, 9.4)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mockClient = null
  })

  const statuses: Game['status'][] = ['LOBBY', 'WORD_ACTIVE']

  statuses.forEach((status) => {
    it(`renders no Winner_History markup, group header, or row text while status is ${status} (Local Fallback)`, () => {
      mockClient = null
      const players = [
        makePlayer('p1', 'Asha', SEEDED_IDS[0]),
        makePlayer('p2', 'Bhavya', SEEDED_IDS[1]),
      ]
      const tickets = players.map((p) => makeTicket(p.ticketId, p.id))
      const winner = makeWinner({ playerId: 'p1' })
      seedGame(baseGame(status), players, tickets, [winner])

      const { container } = renderView()

      assertNoWinnerHistoryMarkup(container)
    })

    it(`renders no Winner_History markup, group header, or row text while status is ${status} (Supabase-configured)`, async () => {
      mockClient = createMockSupabaseClient()
      queueNoActiveGame(mockClient)

      const players = [
        makePlayer('p1', 'Asha', SEEDED_IDS[0]),
        makePlayer('p2', 'Bhavya', SEEDED_IDS[1]),
      ]
      const tickets = players.map((p) => makeTicket(p.ticketId, p.id))
      const winner = makeWinner({ playerId: 'p1' })
      // Seed the same local snapshot so state.game/players/winners is
      // populated even though the pointer-follow effect resolves via the
      // mocked NO_ACTIVE_GAME path in this Supabase-configured render.
      seedGame(baseGame(status), players, tickets, [winner])

      const { container } = renderView()

      assertNoWinnerHistoryMarkup(container)
    })
  })

  // Re-run the existing Req 17.3 "never exposes an Employee/Demo ID"
  // assertions unmodified to confirm they still pass after the mount-effect
  // changes from task 12.1.
  statuses.forEach((status) => {
    it(`still renders no employeeDemoId while status is ${status} (regression check)`, () => {
      mockClient = null
      const players = [
        makePlayer('p1', 'Asha', SEEDED_IDS[0]),
        makePlayer('p2', 'Bhavya', SEEDED_IDS[1]),
      ]
      const tickets = players.map((p) => makeTicket(p.ticketId, p.id))
      seedGame(baseGame(status), players, tickets)

      const { container } = renderView()

      for (const id of SEEDED_IDS) {
        expect(container.textContent).not.toContain(id)
      }
    })
  })
})

describe('PresentationView winner announcement (Req 14.1, 14.2, 14.3)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('shows only the prize label and player display name for a confirmed winner, never employee/demo id, ticket id, or claim id', () => {
    const players = [
      makePlayer('p1', 'Asha', 'EMP-SECRET-1001'),
      makePlayer('p2', 'Bhavya', 'EMP-SECRET-1002'),
    ]
    const tickets = players.map((p) => makeTicket(p.ticketId, p.id))
    const winner = makeWinner({
      playerId: 'p1',
      ticketId: 'ticket-fake-id-777',
      claimId: 'claim-fake-id-999',
      prizeLabel: 'Cyber Five',
      playerName: 'Asha',
    })
    seedGame(baseGame('WORD_ACTIVE'), players, tickets, [winner])

    const { container } = renderView()

    expect(screen.getByText('Cyber Five Winner')).toBeInTheDocument()
    expect(screen.getByText('Asha')).toBeInTheDocument()

    expect(container.textContent).not.toContain('EMP-SECRET-1001')
    expect(container.textContent).not.toContain('EMP-SECRET-1002')
    expect(container.textContent).not.toContain('ticket-fake-id-777')
    expect(container.textContent).not.toContain('claim-fake-id-999')
  })

  it('returns the stage to the current game.status view after dismissing the announcement', async () => {
    const user = userEvent.setup()
    const players = [makePlayer('p1', 'Asha', 'EMP-1001')]
    const tickets = players.map((p) => makeTicket(p.ticketId, p.id))
    const winner = makeWinner({ playerId: 'p1' })
    seedGame(baseGame('WORD_ACTIVE'), players, tickets, [winner])

    renderView()

    expect(screen.getByText('Cyber Five Winner')).toBeInTheDocument()
    expect(screen.queryByText('Cyber Word')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Dismiss Winner Announcement' }))

    expect(screen.queryByText('Cyber Five Winner')).not.toBeInTheDocument()
    expect(screen.getByText('Cyber Word')).toBeInTheDocument()
    expect(screen.getByText('Phishing')).toBeInTheDocument()
  })
})
