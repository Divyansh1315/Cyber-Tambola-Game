// Feature: module-5-prize-claim-processing-winner-management — integration
// test (task 15.6): one retry after rejection, then blocked.
//
// A player whose claim is rejected may resubmit exactly once (Req 4.3). If
// that resubmission is also rejected, a third submission for the same
// (playerId, prizeId) pair must be rejected with RESUBMISSION_LIMIT_REACHED
// (Req 4.4), and no Winner must ever be created since nothing was ever
// confirmed (Req 21.3).
import { describe, it, expect } from 'vitest'
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import type { GameSessionState } from './gameSessionInitialState'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'
import type { PrizeClaim } from '../types/claim'

const PLAYER_ID = 'PLAYER_1'
const TICKET_ID = 'TICKET_1'
const GAME_ID = 'GAME_001'
const PRIZE_ID = 'CYBER_FIVE'

/** A 3x4 ticket whose 12 cells have distinct termIds T0..T11. */
function makeTicket(): Ticket {
  const rows: TicketCell[][] = []
  let n = 0
  for (let row = 0; row < 3; row++) {
    const cells: TicketCell[] = []
    for (let col = 0; col < 4; col++) {
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
    ticketId: TICKET_ID,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: 'Asha',
    ticketRef: 'Ticket #1',
  }
}

// Mark 5 distinct terms so CYBER_FIVE (any 5 marked terms) reaches 5/5. // not-a-ticket-dimension
const MARK_TERM_IDS = ['T0', 'T4', 'T8', 'T1', 'T5']

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
      revealedTermIds: [...MARK_TERM_IDS],
    },
    players: [player],
    tickets: [ticket],
    currentPlayerId: player.id,
  }
}

/** Dispatch MARK_TERM for termId after first making it the current term. */
function markTerm(state: GameSessionState, termId: string): GameSessionState {
  const withCurrent = { ...state, game: { ...state.game, currentTermId: termId } }
  return gameSessionReducer(withCurrent, { type: 'MARK_TERM', termId })
}

describe('one-retry-after-rejection-then-blocked integration (module-5, task 15.6)', () => {
  it('allows exactly one resubmission after a rejection, then blocks further submissions with RESUBMISSION_LIMIT_REACHED', () => {
    let state = baseState()

    for (const termId of MARK_TERM_IDS) {
      state = markTerm(state, termId)
    }
    expect(state.marks).toHaveLength(5)

    // Business rule (fix/multiplayer-reliability): a NEW valid claim is now
    // auto-decided (CONFIRMED/REJECTED) immediately at submission time, so
    // REJECT_CLAIM (host-triggered rejection of a PENDING claim) can no
    // longer be exercised via a fresh SUBMIT_PRIZE_CLAIM dispatch. The two
    // rejected-claim entries this scenario needs are instead seeded
    // directly as legacy PENDING-then-REJECTED claims (exactly the shape
    // REJECT_CLAIM still exists to act on for backward compatibility), so
    // this test continues to exercise gates 7/8's resubmission-limit logic
    // (claimEngine.ts, unchanged by this fix) rather than the now-removed
    // manual-confirmation flow.
    const claim1: PrizeClaim = {
      id: 'legacy-claim-1',
      gameId: GAME_ID,
      playerId: PLAYER_ID,
      ticketId: TICKET_ID,
      prizeId: PRIZE_ID,
      submittedAt: '2026-01-01T00:00:00.000Z',
      validationStatus: 'VALID',
      hostDecision: 'PENDING',
      prizeLabel: 'Cyber Five',
      playerName: 'Asha',
      ticketRef: 'Ticket #1',
    }
    state = { ...state, claims: [claim1] }

    // --- reject 1st ---
    state = gameSessionReducer(state, { type: 'REJECT_CLAIM', claimId: claim1.id })
    const claim1Rejected = state.claims.find((c) => c.id === claim1.id)!
    expect(claim1Rejected.hostDecision).toBe('REJECTED')
    expect(state.claims).toHaveLength(1)

    // --- 2nd submission (the one allowed resubmission) — seeded directly
    // as a legacy PENDING claim for the same reason as claim1 above.
    const claim2 = { ...claim1, id: 'legacy-claim-2' }
    state = { ...state, claims: [...state.claims, claim2] }
    expect(state.claims).toHaveLength(2)
    expect(claim2.validationStatus).toBe('VALID')
    expect(claim2.hostDecision).toBe('PENDING')

    // --- reject 2nd ---
    state = gameSessionReducer(state, { type: 'REJECT_CLAIM', claimId: claim2.id })
    const claim2Rejected = state.claims.find((c) => c.id === claim2.id)!
    expect(claim2Rejected.hostDecision).toBe('REJECTED')
    expect(state.claims).toHaveLength(2)

    // --- 3rd submission — blocked with RESUBMISSION_LIMIT_REACHED ---
    state = gameSessionReducer(state, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: PLAYER_ID,
      ticketId: TICKET_ID,
      prizeId: PRIZE_ID,
    })
    expect(state.claims).toHaveLength(3)
    const claim3 = state.claims.find(
      (c) => c.id !== claim1.id && c.id !== claim2.id,
    )!
    expect(claim3.validationStatus).toBe('INVALID')
    expect(claim3.hostDecision).toBe('PENDING')
    expect(claim3.rejectionReason).toBe('RESUBMISSION_LIMIT_REACHED')

    // --- No Winner was ever created for this player/prize. ---
    expect(state.winners).toHaveLength(0)
    expect(
      state.winners.some((w) => w.playerId === PLAYER_ID && w.prizeId === PRIZE_ID),
    ).toBe(false)

    // --- Claims grew by exactly one per submission (append-only). ---
    const claimsForPair = state.claims.filter(
      (c) => c.playerId === PLAYER_ID && c.prizeId === PRIZE_ID,
    )
    expect(claimsForPair).toHaveLength(3)
    expect(new Set(claimsForPair.map((c) => c.id)).size).toBe(3)

    // currentPlayerId untouched by any of the claim actions.
    expect(state.currentPlayerId).toBe(PLAYER_ID)
  })
})
