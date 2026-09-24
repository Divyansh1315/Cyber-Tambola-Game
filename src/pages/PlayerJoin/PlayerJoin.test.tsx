// Feature: module-3-player-joining-tickets — component tests for PlayerJoin
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { GameSessionProvider } from '../../state/GameSessionContext'
import { PlayerJoin } from './PlayerJoin'

/**
 * Renders PlayerJoin at "/" inside the real session provider and a router.
 * The "/player" route renders a visible marker so navigation can be asserted
 * from the rendered DOM (no router mocking required).
 */
function renderJoin(initialPath: string = '/') {
  return render(
    <GameSessionProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/" element={<PlayerJoin />} />
          <Route path="/player" element={<div>PLAYER GAME SCREEN</div>} />
        </Routes>
      </MemoryRouter>
    </GameSessionProvider>,
  )
}

describe('PlayerJoin', () => {
  // Clear persisted state so one test's join does not leak into the next.
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders three labelled inputs each with maxLength 64', () => {
    renderJoin()

    const gameCode = screen.getByLabelText('Game Code')
    const name = screen.getByLabelText('Employee Name')
    const id = screen.getByLabelText('Employee ID / Demo ID')

    expect(gameCode).toBeInTheDocument()
    expect(name).toBeInTheDocument()
    expect(id).toBeInTheDocument()

    expect(gameCode).toHaveAttribute('maxlength', '64')
    expect(name).toHaveAttribute('maxlength', '64')
    expect(id).toHaveAttribute('maxlength', '64')
  })

  it('does not prefill the name or id fields', () => {
    renderJoin()

    expect(screen.getByLabelText('Employee Name')).toHaveValue('')
    expect(screen.getByLabelText('Employee ID / Demo ID')).toHaveValue('')
    // Game code may stay prefilled for demo convenience.
    expect(screen.getByLabelText('Game Code')).toHaveValue('CYBER24')
  })

  it('shows a validation message and does not navigate when the name is empty', async () => {
    const user = userEvent.setup()
    renderJoin()

    // Leave name empty; fill only the id.
    await user.type(screen.getByLabelText('Employee ID / Demo ID'), 'EMP-1')
    await user.click(screen.getByRole('button', { name: /join game/i }))

    expect(screen.getByRole('alert')).toHaveTextContent(/please fill in/i)
    expect(screen.queryByText('PLAYER GAME SCREEN')).not.toBeInTheDocument()
  })

  it('shows a validation message and does not navigate when the id is empty', async () => {
    const user = userEvent.setup()
    renderJoin()

    await user.type(screen.getByLabelText('Employee Name'), 'Asha')
    await user.click(screen.getByRole('button', { name: /join game/i }))

    expect(screen.getByRole('alert')).toHaveTextContent(/please fill in/i)
    expect(screen.queryByText('PLAYER GAME SCREEN')).not.toBeInTheDocument()
  })

  it('navigates to /player on a valid new join', async () => {
    const user = userEvent.setup()
    renderJoin()

    // Game code is prefilled with CYBER24; add a fresh name + id.
    await user.type(screen.getByLabelText('Employee Name'), 'Asha')
    await user.type(screen.getByLabelText('Employee ID / Demo ID'), 'EMP-100')
    await user.click(screen.getByRole('button', { name: /join game/i }))

    expect(await screen.findByText('PLAYER GAME SCREEN')).toBeInTheDocument()
  })

  it("prefills the game code from the URL's code query param, e.g. after scanning a QR (winner-history-and-game-reset)", () => {
    renderJoin('/?code=ahma29')

    // Codes rotate on every Reset; a stale hardcoded prefill would silently
    // point a returning player at the wrong game. The field also normalizes
    // to uppercase, matching how the field's own onChange handler already
    // treats manually-typed input.
    expect(screen.getByLabelText('Game Code')).toHaveValue('AHMA29')
  })

  it('falls back to the seed game code when no code query param is present', () => {
    renderJoin('/')

    expect(screen.getByLabelText('Game Code')).toHaveValue('CYBER24')
  })

  it('rejects an unknown game code without navigating', async () => {
    const user = userEvent.setup()
    renderJoin()

    const gameCode = screen.getByLabelText('Game Code')
    await user.clear(gameCode)
    await user.type(gameCode, 'WRONG99')
    await user.type(screen.getByLabelText('Employee Name'), 'Asha')
    await user.type(screen.getByLabelText('Employee ID / Demo ID'), 'EMP-200')
    await user.click(screen.getByRole('button', { name: /join game/i }))

    expect(screen.getByRole('alert')).toHaveTextContent(/not found/i)
    expect(screen.queryByText('PLAYER GAME SCREEN')).not.toBeInTheDocument()
  })
})
