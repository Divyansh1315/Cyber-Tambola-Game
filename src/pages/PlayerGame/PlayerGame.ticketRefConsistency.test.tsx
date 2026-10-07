// Spec: claim-duplicate-submission — newly discovered bug (manual browser
// acceptance test, task 15, bugfix.md Req 2.8).
//
// Root cause: the Player screen's header rendered
// `shortTicketRef(currentTicket.id)` -- a CLIENT-SIDE recomputation derived
// from the ticket's own id -- while the Host Claim Inbox / Winner History
// render `claim.ticketRef`, which traces back to `tickets.ref`, computed
// SERVER-SIDE in `join_game` as `'Ticket #' || upper(substr(p_player_id, 1,
// 4))` -- derived from the PLAYER's id, not the ticket's id. These are two
// unrelated algorithms over two different source ids: for any real
// player/ticket pair (distinct ids) they produce different output. The
// server-authoritative value already arrives on the client as
// `currentTicket.ref` (mapped 1:1 from `tickets.ref` by
// `remoteRowMappers.ts`'s `mapRowToTicket`), so the fix is to render
// `currentTicket.ref` directly instead of recomputing a ref from the
// ticket's own id.
//
// This test constructs a ticket whose `id` and `ref` deliberately produce
// DIFFERENT `shortTicketRef()` outputs (mirroring the real-world case,
// since server-side `ref` is derived from `player_id`, never from
// `ticket.id`), then asserts the Player screen's rendered header shows the
// server-authoritative `ticket.ref` -- never the locally-recomputed
// `shortTicketRef(ticket.id)` value.
//
// Validates: Requirements 2.8 (bugfix.md)
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { GameSessionProvider } from '../../state/GameSessionContext'
import { PlayerEntry } from '../PlayerEntry'
import { shortTicketRef } from '../../state/joinService'
import { createSeedGame } from '../../state/gameSessionInitialState'
import {
  CURRENT_PLAYER_STORAGE_KEY,
  STORAGE_KEY,
  toEnvelope,
} from '../../state/persistence'
import type { Game } from '../../types/game'
import type { Player } from '../../types/player'
import type { Ticket, TicketCell } from '../../types/ticket'

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

function seedSession(args: { game: Game; players: Player[]; tickets: Ticket[]; currentPlayerId: string }) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(
      toEnvelope({
        game: args.game,
        players: args.players,
        tickets: args.tickets,
        marks: [],
        claims: [],
        winners: [],
      }),
    ),
  )
  window.localStorage.setItem(CURRENT_PLAYER_STORAGE_KEY, args.currentPlayerId)
}

function renderPlayerGame() {
  return render(
    <GameSessionProvider>
      <MemoryRouter initialEntries={[{ pathname: '/player' }]}>
        <Routes>
          <Route path="/player" element={<PlayerEntry />} />
        </Routes>
      </MemoryRouter>
    </GameSessionProvider>,
  )
}

describe('PlayerGame ticket reference consistency (claim-duplicate-submission bugfix, Req 2.8)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("renders the server-authoritative ticket.ref, not a client-side shortTicketRef(ticket.id) recomputation, when the two diverge", () => {
    const game = createSeedGame()

    // Server-realistic shape: ticket.id is the ticket's own id (e.g. a DB
    // uuid), but ticket.ref was computed server-side from the PLAYER's id
    // (join_game: 'Ticket #' || upper(substr(player_id, 1, 4))) -- NOT from
    // the ticket's own id. Deliberately choose a ticket id whose
    // shortTicketRef() output differs from the player-id-derived ref, the
    // exact real-world mismatch shape.
    const ticketId = 'ticket-uuid-aaaa1111'
    const playerId = 'player-uuid-bbbb2222'
    const serverRef = `Ticket #${playerId.replace(/[^0-9a-zA-Z]/g, '').toUpperCase().slice(0, 4)}`
    const wrongClientRef = shortTicketRef(ticketId)
    // Sanity check the fixture actually reproduces divergence (mirrors the
    // real bug: these two algorithms operate on different source ids).
    expect(serverRef).not.toBe(wrongClientRef)

    const player: Player = {
      id: playerId,
      gameId: game.id,
      displayName: 'Asha Kumar',
      ticketId,
      joinedAt: '2026-01-01T00:00:00.000Z',
      name: 'Asha Kumar',
      ticketRef: serverRef,
    }
    const ticket: Ticket = {
      id: ticketId,
      playerId,
      gameId: game.id,
      createdAt: '2026-01-01T00:00:00.000Z',
      ref: serverRef,
      rows: buildTicketRows(),
    }

    seedSession({ game, players: [player], tickets: [ticket], currentPlayerId: player.id })

    renderPlayerGame()

    // The rendered header must show the server-authoritative ref ...
    expect(screen.getByText(serverRef)).toBeInTheDocument()
    // ... and must NEVER show the wrong, locally-recomputed value (the bug).
    expect(screen.queryByText(wrongClientRef)).not.toBeInTheDocument()
  })
})
