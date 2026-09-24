// Feature: module-6-realtime-multi-device-sync — regression test (task 17.2)
//
// Guarantee under test: no Host- or Presentation-facing action/route ever
// redirects a Player who has a valid `currentPlayerId` away to the join/
// landing screen. PlayerGame.tsx's ONLY redirect trigger is
// `!currentPlayer || !currentTicket || !renderedTicket` (see PlayerGame.tsx),
// where `currentPlayer`/`currentTicket` are derived exactly as
// GameSessionContext.tsx derives them:
//   currentPlayer = players.find(p => p.id === currentPlayerId)
//   currentTicket = currentPlayer ? tickets.find(t => t.id === currentPlayer.ticketId) : undefined
//
// Host-facing actions (Next Cyber Word, Pause, Resume, End Game, Reset,
// Confirm Claim, Reject Claim) and Presentation-facing rendering all flow
// through the restructured realtime sync path as SYNC_REMOTE/
// HYDRATE_FROM_REMOTE dispatches (per gameSessionReducer.ts). Both reducer
// cases are documented and implemented to never touch `currentPlayerId`
// (Req 15.2, 15.3), and neither ever removes an existing player/ticket row
// from state — SYNC_REMOTE only upserts-by-id, and a HYDRATE_FROM_REMOTE
// snapshot from the real backend always includes every still-joined
// player's row. This test dispatches a representative sequence of such
// host-driven remote changes and asserts the Player route guard's
// condition (a resolvable currentPlayer + currentTicket) holds throughout,
// so `currentPlayerId` and the guard's outcome are never disturbed by any
// Host/Presentation-facing action.
//
// Validates: Requirements 24.2
import { describe, it, expect } from 'vitest'
import { gameSessionReducer, type RemoteSnapshot } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import type { GameSessionState } from './gameSessionInitialState'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'

const GAME_ID = 'GAME_001'
const PLAYER_ID = 'PLAYER_1'
const TICKET_ID = 'TICKET_1'

/** A 3x5 ticket whose 15 cells have distinct termIds T0..T14. */
function makeTicket(): Ticket {
  const rows: TicketCell[][] = []
  let n = 0
  for (let row = 0; row < 3; row++) {
    const cells: TicketCell[] = []
    for (let col = 0; col < 5; col++) {
      cells.push({ termId: `T${n}`, term: `Term ${n}`, state: 'LOCKED', row, col })
      n++
    }
    rows.push(cells)
  }
  return {
    id: TICKET_ID,
    playerId: PLAYER_ID,
    gameId: GAME_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: 'Ticket #1',
    rows,
  }
}

function makePlayer(): Player {
  return {
    id: PLAYER_ID,
    gameId: GAME_ID,
    displayName: 'Asha',
    employeeDemoId: 'EMP-1001',
    ticketId: TICKET_ID,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: 'Asha',
    employeeId: 'EMP-1001',
    ticketRef: 'Ticket #1',
  }
}

function baseState(): GameSessionState {
  const ticket = makeTicket()
  const player = makePlayer()
  return {
    ...gameSessionInitialState,
    game: {
      ...gameSessionInitialState.game,
      id: GAME_ID,
      status: 'WORD_ACTIVE',
      currentRound: 1,
      revealedTermIds: ['T0'],
    },
    players: [player],
    tickets: [ticket],
    currentPlayerId: player.id,
  }
}

/**
 * Replicates the exact PlayerGame.tsx redirect guard: `true` means the
 * Player screen would render normally; `false` means it would `<Navigate
 * to="/" replace />` the player away.
 */
function guardWouldKeepPlayerOnScreen(state: GameSessionState): boolean {
  const currentPlayer = state.players.find((p) => p.id === state.currentPlayerId)
  const currentTicket = currentPlayer
    ? state.tickets.find((t) => t.id === currentPlayer.ticketId)
    : undefined
  return Boolean(currentPlayer && currentTicket)
}

describe('no Host/Presentation-facing action redirects a Player with a valid currentPlayerId (regression, Req 24.2)', () => {
  it('keeps currentPlayerId and the route guard satisfied across a full sequence of host-driven SYNC_REMOTE changes', () => {
    let state = baseState()
    expect(state.currentPlayerId).toBe(PLAYER_ID)
    expect(guardWouldKeepPlayerOnScreen(state)).toBe(true)

    // Host: "Next Cyber Word" -> games UPDATE (current_term_id/status/round)
    // plus a called_terms INSERT, exactly as call_next_word's effect is
    // observed by subscribeToGame.
    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'games',
        eventType: 'UPDATE',
        row: {
          id: GAME_ID,
          code: 'DEMO',
          status: 'WORD_ACTIVE',
          created_at: '2026-01-01T00:00:00.000Z',
          started_at: '2026-01-01T00:00:00.000Z',
          ended_at: null,
          current_round: 2,
          current_term_id: 'T1',
          previous_status: null,
        },
      },
    })
    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'called_terms',
        eventType: 'INSERT',
        row: { game_id: GAME_ID, term_id: 'T1', called_at: '2026-01-01T00:01:00.000Z', round: 2 },
      },
    })
    expect(state.currentPlayerId).toBe(PLAYER_ID)
    expect(guardWouldKeepPlayerOnScreen(state)).toBe(true)

    // Host: "Pause"
    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'games',
        eventType: 'UPDATE',
        row: {
          id: GAME_ID,
          code: 'DEMO',
          status: 'PAUSED',
          created_at: '2026-01-01T00:00:00.000Z',
          started_at: '2026-01-01T00:00:00.000Z',
          ended_at: null,
          current_round: 2,
          current_term_id: 'T1',
          previous_status: 'WORD_ACTIVE',
        },
      },
    })
    expect(state.currentPlayerId).toBe(PLAYER_ID)
    expect(guardWouldKeepPlayerOnScreen(state)).toBe(true)

    // Host: "Resume"
    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'games',
        eventType: 'UPDATE',
        row: {
          id: GAME_ID,
          code: 'DEMO',
          status: 'WORD_ACTIVE',
          created_at: '2026-01-01T00:00:00.000Z',
          started_at: '2026-01-01T00:00:00.000Z',
          ended_at: null,
          current_round: 2,
          current_term_id: 'T1',
          previous_status: null,
        },
      },
    })
    expect(state.currentPlayerId).toBe(PLAYER_ID)
    expect(guardWouldKeepPlayerOnScreen(state)).toBe(true)

    // Host: confirms another player's claim -> claims UPDATE + winners
    // INSERT, neither of which touches this player's row or ticket.
    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'claims',
        eventType: 'UPDATE',
        row: {
          id: 'CLAIM_OTHER',
          game_id: GAME_ID,
          player_id: 'PLAYER_OTHER',
          ticket_id: 'TICKET_OTHER',
          prize_id: 'earlyFive',
          submitted_at: '2026-01-01T00:02:00.000Z',
          validation_status: 'VALID',
          host_decision: 'CONFIRMED',
          rejection_reason: null,
          decided_at: '2026-01-01T00:03:00.000Z',
          prize_label: 'Early Five',
          player_name: 'Other Player',
          ticket_ref: 'Ticket #Other',
        },
      },
    })
    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'winners',
        eventType: 'INSERT',
        row: {
          id: 'WINNER_OTHER',
          game_id: GAME_ID,
          prize_id: 'earlyFive',
          player_id: 'PLAYER_OTHER',
          ticket_id: 'TICKET_OTHER',
          claim_id: 'CLAIM_OTHER',
          confirmed_at: '2026-01-01T00:03:00.000Z',
          prize_label: 'Early Five',
          player_name: 'Other Player',
        },
      },
    })
    expect(state.currentPlayerId).toBe(PLAYER_ID)
    expect(guardWouldKeepPlayerOnScreen(state)).toBe(true)

    // Host: rejects a claim (this player's own claim, even) -> claims UPDATE.
    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'claims',
        eventType: 'UPDATE',
        row: {
          id: 'CLAIM_SELF',
          game_id: GAME_ID,
          player_id: PLAYER_ID,
          ticket_id: TICKET_ID,
          prize_id: 'topLine',
          submitted_at: '2026-01-01T00:02:00.000Z',
          validation_status: 'VALID',
          host_decision: 'REJECTED',
          rejection_reason: 'Not enough marks yet',
          decided_at: '2026-01-01T00:03:00.000Z',
          prize_label: 'Top Line',
          player_name: 'Asha',
          ticket_ref: 'Ticket #1',
        },
      },
    })
    expect(state.currentPlayerId).toBe(PLAYER_ID)
    expect(guardWouldKeepPlayerOnScreen(state)).toBe(true)

    // Host: "End Game"
    state = gameSessionReducer(state, {
      type: 'SYNC_REMOTE',
      change: {
        table: 'games',
        eventType: 'UPDATE',
        row: {
          id: GAME_ID,
          code: 'DEMO',
          status: 'COMPLETED',
          created_at: '2026-01-01T00:00:00.000Z',
          started_at: '2026-01-01T00:00:00.000Z',
          ended_at: '2026-01-01T00:04:00.000Z',
          current_round: 2,
          current_term_id: 'T1',
          previous_status: null,
        },
      },
    })
    expect(state.currentPlayerId).toBe(PLAYER_ID)
    expect(guardWouldKeepPlayerOnScreen(state)).toBe(true)

    // Presentation-facing: a full HYDRATE_FROM_REMOTE reconnect snapshot
    // (e.g. triggered on the Presentation/Host screen's own mount) that
    // still includes this player's row and ticket must not disturb the
    // guard either.
    const snapshot: RemoteSnapshot = {
      game: state.game,
      players: state.players,
      tickets: state.tickets,
      marks: state.marks,
      claims: state.claims,
      winners: state.winners,
    }
    state = gameSessionReducer(state, { type: 'HYDRATE_FROM_REMOTE', snapshot })
    expect(state.currentPlayerId).toBe(PLAYER_ID)
    expect(guardWouldKeepPlayerOnScreen(state)).toBe(true)
  })

  it('a ROLLBACK_OPTIMISTIC removing a different, unrelated optimistic entry never disturbs currentPlayerId or the guard', () => {
    let state = baseState()

    // An optimistic claim for another player gets rolled back (e.g. its
    // submit_claim RPC was rejected) — must not affect this player at all.
    state = {
      ...state,
      claims: [
        ...state.claims,
        {
          id: 'CLAIM_OPTIMISTIC_OTHER',
          gameId: GAME_ID,
          playerId: 'PLAYER_OTHER',
          ticketId: 'TICKET_OTHER',
          prizeId: 'earlyFive',
          submittedAt: '2026-01-01T00:02:00.000Z',
          validationStatus: 'VALID',
          hostDecision: 'PENDING',
          prizeLabel: 'Early Five',
          playerName: 'Other Player',
          ticketRef: 'Ticket #Other',
        },
      ],
    }

    state = gameSessionReducer(state, {
      type: 'ROLLBACK_OPTIMISTIC',
      collection: 'claims',
      id: 'CLAIM_OPTIMISTIC_OTHER',
    })

    expect(state.currentPlayerId).toBe(PLAYER_ID)
    expect(guardWouldKeepPlayerOnScreen(state)).toBe(true)
  })
})
