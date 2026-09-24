// Feature: module-6-realtime-multi-device-sync — regression (Req 24.2, 15.2, 15.3)
//
// Guards against a regression where a Host/Presentation-facing SYNC_REMOTE or
// HYDRATE_FROM_REMOTE dispatch would knock a genuinely-joined Player back to
// the join screen. PlayerGame.tsx's ONLY redirect trigger is
// `!currentPlayer || !currentTicket || !renderedTicket` (see PlayerGame.tsx),
// where `currentPlayer` is resolved by looking up `state.currentPlayerId` in
// `state.players`. This test dispatches a realistic sequence of host actions
// — expressed exactly as they arrive in production, as SYNC_REMOTE/
// HYDRATE_FROM_REMOTE actions — and asserts, after EVERY single dispatch,
// that `currentPlayerId` is unchanged and still resolves to a real player,
// so the redirect condition can never fire as a side effect of these events.
import { describe, expect, it } from 'vitest'
import { gameSessionReducer, type GameSessionAction } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import type { GameSessionState } from './gameSessionInitialState'
import type { Player } from '../types/player'
import type { Ticket } from '../types/ticket'

function buildPlayer(): Player {
  return {
    id: 'PLAYER_1',
    gameId: 'GAME_001',
    displayName: 'Divyansh',
    employeeDemoId: 'emp-001',
    ticketId: 'TICKET_1',
    joinedAt: new Date().toISOString(),
    name: 'Divyansh',
    employeeId: 'emp-001',
    ticketRef: 'Ticket #001',
  }
}

function buildTicket(): Ticket {
  return {
    id: 'TICKET_1',
    playerId: 'PLAYER_1',
    gameId: 'GAME_001',
    createdAt: new Date().toISOString(),
    ref: 'Ticket #001',
    rows: [],
  }
}

/** Mirrors PlayerGame.tsx's redirect guard's `currentPlayer` resolution. */
function resolvesToRealPlayer(state: GameSessionState): boolean {
  return state.players.some((p) => p.id === state.currentPlayerId)
}

describe('regression: currentPlayerId survives a sequence of host-originated remote actions (Req 24.2)', () => {
  it('never changes currentPlayerId and always resolves to a real player, after every single dispatch', () => {
    const player = buildPlayer()
    const ticket = buildTicket()

    // A Player has genuinely joined via the existing local action (Req 3.6).
    let state = gameSessionReducer(gameSessionInitialState, {
      type: 'JOIN_PLAYER',
      player,
      ticket,
    })

    const originalPlayerId = state.currentPlayerId
    expect(originalPlayerId).toBe('PLAYER_1')
    expect(resolvesToRealPlayer(state)).toBe(true)

    // A plausible sequence of host actions, expressed exactly as they arrive
    // in production: a mix of SYNC_REMOTE row changes and one full
    // HYDRATE_FROM_REMOTE snapshot replace (e.g. a reconnect happening on
    // this same device while the game is in progress).
    const dispatches: GameSessionAction[] = [
      // Host starts the round: a `games` UPDATE moving status to WORD_ACTIVE.
      {
        type: 'SYNC_REMOTE',
        change: {
          table: 'games',
          eventType: 'UPDATE',
          row: {
            id: 'GAME_001',
            code: 'CYBER24',
            status: 'WORD_ACTIVE',
            current_round: 1,
            current_term_id: 'phishing',
            created_at: state.game.createdAt,
            started_at: new Date().toISOString(),
            ended_at: null,
          },
        },
      },
      // Host calls a word: a `called_terms` INSERT.
      {
        type: 'SYNC_REMOTE',
        change: {
          table: 'called_terms',
          eventType: 'INSERT',
          row: { game_id: 'GAME_001', term_id: 'phishing', called_at: new Date().toISOString(), round: 1 },
        },
      },
      // Host pauses the game: a `games` UPDATE moving status to PAUSED.
      {
        type: 'SYNC_REMOTE',
        change: {
          table: 'games',
          eventType: 'UPDATE',
          row: {
            id: 'GAME_001',
            code: 'CYBER24',
            status: 'PAUSED',
            current_round: 1,
            current_term_id: 'phishing',
            created_at: state.game.createdAt,
            started_at: new Date().toISOString(),
            ended_at: null,
          },
        },
      },
      // Host confirms a claim: a `claims` UPDATE representing the decision.
      {
        type: 'SYNC_REMOTE',
        change: {
          table: 'claims',
          eventType: 'UPDATE',
          row: {
            id: 'CLAIM_1',
            game_id: 'GAME_001',
            player_id: 'PLAYER_1',
            ticket_id: 'TICKET_1',
            prize_id: 'CYBER_FIVE',
            submitted_at: new Date().toISOString(),
            validation_status: 'VALID',
            host_decision: 'CONFIRMED',
            rejection_reason: null,
            decided_at: new Date().toISOString(),
            prize_label: 'Cyber Five',
            player_name: 'Divyansh',
            ticket_ref: 'Ticket #001',
          },
        },
      },
      // Host confirmation creates a Winner: a `winners` INSERT.
      {
        type: 'SYNC_REMOTE',
        change: {
          table: 'winners',
          eventType: 'INSERT',
          row: {
            id: 'WINNER_1',
            game_id: 'GAME_001',
            prize_id: 'CYBER_FIVE',
            player_id: 'PLAYER_1',
            ticket_id: 'TICKET_1',
            claim_id: 'CLAIM_1',
            confirmed_at: new Date().toISOString(),
            prize_label: 'Cyber Five',
            player_name: 'Divyansh',
          },
        },
      },
      // A full reconnect-driven snapshot replace, interleaved among the
      // SYNC_REMOTE stream above (Req 15.3).
      {
        type: 'HYDRATE_FROM_REMOTE',
        snapshot: {
          game: {
            ...state.game,
            status: 'WORD_ACTIVE',
            currentRound: 1,
            currentTermId: 'phishing',
            revealedTermIds: ['phishing'],
          },
          players: [player],
          tickets: [ticket],
          marks: [],
          claims: [],
          winners: [],
        },
      },
      // Host resumes the game: a `games` UPDATE moving status back to
      // WORD_ACTIVE.
      {
        type: 'SYNC_REMOTE',
        change: {
          table: 'games',
          eventType: 'UPDATE',
          row: {
            id: 'GAME_001',
            code: 'CYBER24',
            status: 'WORD_ACTIVE',
            current_round: 1,
            current_term_id: 'phishing',
            created_at: state.game.createdAt,
            started_at: new Date().toISOString(),
            ended_at: null,
          },
        },
      },
      // Host ends the game: a `games` UPDATE moving status to COMPLETED.
      {
        type: 'SYNC_REMOTE',
        change: {
          table: 'games',
          eventType: 'UPDATE',
          row: {
            id: 'GAME_001',
            code: 'CYBER24',
            status: 'COMPLETED',
            current_round: 1,
            current_term_id: 'phishing',
            created_at: state.game.createdAt,
            started_at: new Date().toISOString(),
            ended_at: new Date().toISOString(),
          },
        },
      },
    ]

    for (const action of dispatches) {
      state = gameSessionReducer(state, action)

      // currentPlayerId must be exactly the same value after every single
      // dispatch in the sequence, not just at the end (Req 15.2, 15.3).
      expect(state.currentPlayerId).toBe(originalPlayerId)

      // Mirrors PlayerGame.tsx's `!currentPlayer` redirect condition — this
      // must remain false (i.e. a real player is found) throughout, proving
      // the redirect can never fire as a side effect of these dispatches
      // (Req 24.2).
      expect(resolvesToRealPlayer(state)).toBe(true)
    }
  })
})
