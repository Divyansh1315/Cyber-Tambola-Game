// Feature: module-5-prize-claim-processing-winner-management
//
// Task 15.8 — Example tests covering Requirement 21's specific assertions.
// These are concrete example tests (not property-based) exercising the pure
// gameSessionReducer directly, mirroring the fixture-building patterns from
// gameSessionReducer.submitClaim.test.ts / .confirmClaim.test.ts.
//
// Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.9
import { describe, it, expect } from 'vitest'
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState, type GameSessionState } from './gameSessionInitialState'
import { PRIZES } from '../utils/prizeEngine'
import type { Player } from '../types/player'
import type { Ticket } from '../types/ticket'
import type { Mark } from '../types/mark'
import type { PrizeClaim } from '../types/claim'
import type { Winner } from '../types/prize'

// ---------------------------------------------------------------------------
// Fixture builders (adapted from gameSessionReducer.confirmClaim.test.ts /
// gameSessionReducer.submitClaim.test.ts)
// ---------------------------------------------------------------------------

function makePlayer(id: string, ticketId: string): Player {
  return {
    id,
    gameId: 'GAME_001',
    displayName: `Player ${id}`,
    employeeDemoId: `EMP-${id}`,
    ticketId,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: `Player ${id}`,
    employeeId: `EMP-${id}`,
    ticketRef: ticketId,
  }
}

/** A ticket with exactly 5 terms on row 0, so marking all 5 makes CYBER_FIVE
 * (and FIREWALL_LINE, since they share row 0) eligible. */
function makeTicket(id: string, playerId: string): Ticket {
  return {
    id,
    playerId,
    gameId: 'GAME_001',
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: `Ticket #${id}`,
    rows: [
      [
        { termId: 'TERM_001', term: 'Phishing', state: 'AVAILABLE' as const, row: 0, col: 0 },
        { termId: 'TERM_002', term: 'Malware', state: 'AVAILABLE' as const, row: 0, col: 1 },
        { termId: 'TERM_003', term: 'Ransomware', state: 'AVAILABLE' as const, row: 0, col: 2 },
        { termId: 'TERM_004', term: 'Spyware', state: 'AVAILABLE' as const, row: 0, col: 3 },
        { termId: 'TERM_005', term: 'Trojan', state: 'AVAILABLE' as const, row: 0, col: 4 },
      ],
      [
        { termId: 'TERM_006', term: 'Firewall', state: 'AVAILABLE' as const, row: 1, col: 0 },
        { termId: 'TERM_007', term: 'VPN', state: 'AVAILABLE' as const, row: 1, col: 1 },
      ],
      [
        { termId: 'TERM_008', term: 'Encryption', state: 'AVAILABLE' as const, row: 2, col: 0 },
        { termId: 'TERM_009', term: 'Backup', state: 'AVAILABLE' as const, row: 2, col: 1 },
      ],
    ],
  }
}

function makeValidMark(playerId: string, ticketId: string, termId: string, id: string): Mark {
  return {
    id,
    gameId: 'GAME_001',
    playerId,
    ticketId,
    termId,
    markedAt: '2026-01-01T00:00:00.000Z',
    valid: true,
  }
}

function makeClaim(
  id: string,
  playerId: string,
  ticketId: string,
  prizeId: 'CYBER_FIVE',
  validationStatus: 'VALID' | 'INVALID',
  hostDecision: 'PENDING' | 'CONFIRMED' | 'REJECTED',
): PrizeClaim {
  return {
    id,
    gameId: 'GAME_001',
    playerId,
    ticketId,
    prizeId,
    submittedAt: '2026-01-01T00:00:00.000Z',
    validationStatus,
    hostDecision,
    decidedAt: hostDecision === 'PENDING' ? undefined : '2026-01-01T00:05:00.000Z',
    prizeLabel: PRIZES.find((p) => p.id === prizeId)!.label,
    playerName: `Player ${playerId}`,
    ticketRef: `Ticket #${ticketId}`,
  }
}

function makeWinner(id: string, playerId: string, ticketId: string, prizeId: 'CYBER_FIVE', claimId: string): Winner {
  return {
    id,
    gameId: 'GAME_001',
    prizeId,
    playerId,
    ticketId,
    claimId,
    confirmedAt: '2026-01-01T00:05:00.000Z',
    prizeLabel: PRIZES.find((p) => p.id === prizeId)!.label,
    playerName: `Player ${playerId}`,
  }
}

/** Base state: one eligible player (5/5 marks on row 0 => CYBER_FIVE
 * eligible), no claims, no winners, prize open. */
function baseEligibleState(): GameSessionState {
  const playerId = 'P1'
  const ticketId = 'TICKET_P1'
  const marks: Mark[] = [
    makeValidMark(playerId, ticketId, 'TERM_001', 'm1'),
    makeValidMark(playerId, ticketId, 'TERM_002', 'm2'),
    makeValidMark(playerId, ticketId, 'TERM_003', 'm3'),
    makeValidMark(playerId, ticketId, 'TERM_004', 'm4'),
    makeValidMark(playerId, ticketId, 'TERM_005', 'm5'),
  ]
  return {
    ...gameSessionInitialState,
    game: { ...gameSessionInitialState.game, revealedTermIds: [] },
    players: [makePlayer(playerId, ticketId)],
    tickets: [makeTicket(ticketId, playerId)],
    currentPlayerId: playerId,
    marks,
    claims: [],
    winners: [],
  }
}

/** Base state: one ineligible player (only 2/5 marks, CYBER_FIVE not met). */
function baseIneligibleState(): GameSessionState {
  const playerId = 'P1'
  const ticketId = 'TICKET_P1'
  const marks: Mark[] = [
    makeValidMark(playerId, ticketId, 'TERM_001', 'm1'),
    makeValidMark(playerId, ticketId, 'TERM_002', 'm2'),
  ]
  return {
    ...gameSessionInitialState,
    game: { ...gameSessionInitialState.game, revealedTermIds: [] },
    players: [makePlayer(playerId, ticketId)],
    tickets: [makeTicket(ticketId, playerId)],
    currentPlayerId: playerId,
    marks,
    claims: [],
    winners: [],
  }
}

// ---------------------------------------------------------------------------
// 21.1 — A valid claim submission is accepted as VALID/PENDING
// ---------------------------------------------------------------------------

describe('Requirement 21.1 — valid claim submission accepted as VALID/PENDING', () => {
  it('an eligible player submitting a claim gets validationStatus VALID and hostDecision PENDING', () => {
    const state = baseEligibleState()

    const next = gameSessionReducer(state, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: 'P1',
      ticketId: 'TICKET_P1',
      prizeId: 'CYBER_FIVE',
    })

    expect(next.claims.length).toBe(1)
    expect(next.claims[0].validationStatus).toBe('VALID')
    expect(next.claims[0].hostDecision).toBe('PENDING')
  })
})

// ---------------------------------------------------------------------------
// 21.2 — An ineligible submission is INVALID and never produces a Winner
// ---------------------------------------------------------------------------

describe('Requirement 21.2 — ineligible claim submission is INVALID, no Winner', () => {
  it('an ineligible player submitting a claim gets validationStatus INVALID and no Winner is created', () => {
    const state = baseIneligibleState()

    const next = gameSessionReducer(state, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: 'P1',
      ticketId: 'TICKET_P1',
      prizeId: 'CYBER_FIVE',
    })

    expect(next.claims.length).toBe(1)
    expect(next.claims[0].validationStatus).toBe('INVALID')
    expect(next.claims[0].rejectionReason).toBe('NOT_ELIGIBLE')
    expect(next.winners).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 21.3 — Duplicate submissions never result in more than one active claim
// ---------------------------------------------------------------------------

describe('Requirement 21.3 — duplicate submissions never exceed one active claim', () => {
  it('a second submission while a PENDING claim exists is rejected as DUPLICATE_ACTIVE_CLAIM', () => {
    const state = baseEligibleState()

    const afterFirst = gameSessionReducer(state, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: 'P1',
      ticketId: 'TICKET_P1',
      prizeId: 'CYBER_FIVE',
    })
    expect(afterFirst.claims.length).toBe(1)
    expect(afterFirst.claims[0].hostDecision).toBe('PENDING')

    const afterSecond = gameSessionReducer(afterFirst, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: 'P1',
      ticketId: 'TICKET_P1',
      prizeId: 'CYBER_FIVE',
    })

    expect(afterSecond.claims.length).toBe(2)
    // "Active" means a claim that actually stands as a live claim: VALID
    // with hostDecision PENDING or CONFIRMED. An INVALID claim's
    // hostDecision starts and stays PENDING but is not an active claim.
    const active = afterSecond.claims.filter(
      (c) =>
        c.validationStatus === 'VALID' &&
        (c.hostDecision === 'PENDING' || c.hostDecision === 'CONFIRMED'),
    )
    expect(active.length).toBe(1)
    const secondClaim = afterSecond.claims[1]
    expect(secondClaim.validationStatus).toBe('INVALID')
    expect(secondClaim.rejectionReason).toBe('DUPLICATE_ACTIVE_CLAIM')
  })

  it('a second submission while a CONFIRMED claim exists is also rejected as DUPLICATE_ACTIVE_CLAIM', () => {
    const state = baseEligibleState()
    const confirmedClaim = makeClaim('c1', 'P1', 'TICKET_P1', 'CYBER_FIVE', 'VALID', 'CONFIRMED')
    const winner = makeWinner('w1', 'P1', 'TICKET_P1', 'CYBER_FIVE', 'c1')
    const stateWithWinner: GameSessionState = {
      ...state,
      claims: [confirmedClaim],
      winners: [winner],
    }

    const next = gameSessionReducer(stateWithWinner, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: 'P1',
      ticketId: 'TICKET_P1',
      prizeId: 'CYBER_FIVE',
    })

    expect(next.claims.length).toBe(2)
    const active = next.claims.filter(
      (c) =>
        c.validationStatus === 'VALID' &&
        (c.hostDecision === 'PENDING' || c.hostDecision === 'CONFIRMED'),
    )
    expect(active.length).toBe(1)
    expect(next.claims[1].validationStatus).toBe('INVALID')
    // Either DUPLICATE_ACTIVE_CLAIM or PRIZE_CLOSED is an acceptable reason
    // here since the prize is also closed by the winner; either way no
    // second active claim is created.
    expect(['DUPLICATE_ACTIVE_CLAIM', 'PRIZE_CLOSED']).toContain(next.claims[1].rejectionReason)
  })
})

// ---------------------------------------------------------------------------
// 21.4 — Confirm creates exactly one Winner and sets hostDecision CONFIRMED
// ---------------------------------------------------------------------------

describe('Requirement 21.4 — confirm creates exactly one Winner and sets CONFIRMED', () => {
  it('confirming a valid, pending claim creates one Winner and marks the claim CONFIRMED', () => {
    const playerId = 'P1'
    const ticketId = 'TICKET_P1'
    const claim = makeClaim('c1', playerId, ticketId, 'CYBER_FIVE', 'VALID', 'PENDING')
    const state: GameSessionState = {
      ...baseEligibleState(),
      claims: [claim],
      winners: [],
    }

    const next = gameSessionReducer(state, { type: 'CONFIRM_CLAIM', claimId: 'c1' })

    expect(next.winners.length).toBe(1)
    expect(next.winners[0].claimId).toBe('c1')
    expect(next.winners[0].prizeId).toBe('CYBER_FIVE')
    expect(next.winners[0].playerId).toBe(playerId)

    const updatedClaim = next.claims.find((c) => c.id === 'c1')!
    expect(updatedClaim.hostDecision).toBe('CONFIRMED')
    expect(updatedClaim.decidedAt).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 21.5 — Confirm is blocked for an INVALID claim
// ---------------------------------------------------------------------------

describe('Requirement 21.5 — confirm blocked for an INVALID claim', () => {
  it('confirming an INVALID claim is a no-op: no Winner created, claim unchanged', () => {
    const claim = makeClaim('c1', 'P1', 'TICKET_P1', 'CYBER_FIVE', 'INVALID', 'PENDING')
    const state: GameSessionState = {
      ...baseEligibleState(),
      claims: [claim],
      winners: [],
    }

    const next = gameSessionReducer(state, { type: 'CONFIRM_CLAIM', claimId: 'c1' })

    expect(next).toBe(state)
    expect(next.winners).toEqual([])
    expect(next.claims[0].hostDecision).toBe('PENDING')
  })
})

// ---------------------------------------------------------------------------
// 21.6 — Once a prize is closed, no further confirm succeeds
// ---------------------------------------------------------------------------

describe('Requirement 21.6 — no further confirm succeeds once a prize is closed', () => {
  it('confirming a second VALID/PENDING claim on an already-closed prize is a no-op', () => {
    const confirmedClaim = makeClaim('c1', 'P1', 'TICKET_P1', 'CYBER_FIVE', 'VALID', 'CONFIRMED')
    const winner = makeWinner('w1', 'P1', 'TICKET_P1', 'CYBER_FIVE', 'c1')
    const secondClaim = makeClaim('c2', 'P2', 'TICKET_P2', 'CYBER_FIVE', 'VALID', 'PENDING')

    const state: GameSessionState = {
      ...baseEligibleState(),
      claims: [confirmedClaim, secondClaim],
      winners: [winner],
    }

    const next = gameSessionReducer(state, { type: 'CONFIRM_CLAIM', claimId: 'c2' })

    expect(next).toBe(state)
    expect(next.winners.length).toBe(1)
    expect(next.claims.find((c) => c.id === 'c2')!.hostDecision).toBe('PENDING')
  })
})

// ---------------------------------------------------------------------------
// 21.9 — currentPlayerId is never altered by a claim-bearing sync payload
// ---------------------------------------------------------------------------

describe('Requirement 21.9 — currentPlayerId unaffected by a claim-bearing SYNC_LOCAL payload', () => {
  it('a claim-submission sync payload leaves currentPlayerId unchanged', () => {
    const state = baseEligibleState()
    expect(state.currentPlayerId).toBe('P1')

    const incomingClaim = makeClaim('remote-c1', 'P2', 'TICKET_P2', 'CYBER_FIVE', 'VALID', 'PENDING')

    const next = gameSessionReducer(state, {
      type: 'SYNC_LOCAL',
      payload: {
        game: state.game,
        players: state.players,
        tickets: state.tickets,
        marks: state.marks,
        claims: [incomingClaim],
        winners: [],
      },
    })

    expect(next.currentPlayerId).toBe('P1')
    expect(next.claims.some((c) => c.id === 'remote-c1')).toBe(true)
  })

  it('a claim-decision (confirm/reject) sync payload leaves currentPlayerId unchanged', () => {
    const state = baseEligibleState()
    expect(state.currentPlayerId).toBe('P1')

    const decidedClaim = makeClaim('remote-c2', 'P2', 'TICKET_P2', 'CYBER_FIVE', 'VALID', 'CONFIRMED')
    const decidedWinner = makeWinner('remote-w2', 'P2', 'TICKET_P2', 'CYBER_FIVE', 'remote-c2')

    const next = gameSessionReducer(state, {
      type: 'SYNC_LOCAL',
      payload: {
        game: state.game,
        players: state.players,
        tickets: state.tickets,
        marks: state.marks,
        claims: [decidedClaim],
        winners: [decidedWinner],
      },
    })

    expect(next.currentPlayerId).toBe('P1')
    expect(next.claims.find((c) => c.id === 'remote-c2')!.hostDecision).toBe('CONFIRMED')
    expect(next.winners.some((w) => w.id === 'remote-w2')).toBe(true)
  })
})
