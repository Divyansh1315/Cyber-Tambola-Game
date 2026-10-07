// Feature: fix/multiplayer-reliability — automatic first-valid-claim-wins
//
// Business rule: for a single-winner prize, the first VALID claim
// successfully accepted wins automatically; every later claim for the same
// prize is auto-rejected. The host no longer manually confirms/rejects a
// prize-claim winner. Covers the Local Fallback reducer's SUBMIT_PRIZE_CLAIM
// case (gameSessionReducer.ts), which mirrors submit_claim's SQL end-state
// (0010_claim_auto_win.sql).
import { describe, it, expect } from 'vitest'
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState, type GameSessionState } from './gameSessionInitialState'
import type { Player } from '../types/player'
import type { Ticket } from '../types/ticket'
import type { Mark } from '../types/mark'

function makePlayer(id: string, ticketId: string): Player {
  return {
    id,
    gameId: 'GAME_001',
    displayName: `Player ${id}`,
    ticketId,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: `Player ${id}`,
    ticketRef: ticketId,
  }
}

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

/** Marks for CYBER_FIVE's eligibility: any 5 distinct marked terms. */
function cyberFiveMarks(playerId: string, ticketId: string): Mark[] {
  return ['TERM_001', 'TERM_002', 'TERM_003', 'TERM_004', 'TERM_005'].map((termId, i) => ({
    id: `mark-${playerId}-${i}`,
    gameId: 'GAME_001',
    playerId,
    ticketId,
    termId,
    markedAt: '2026-01-01T00:00:00.000Z',
    valid: true,
  }))
}

function baseState(): GameSessionState {
  const playerA = makePlayer('P1', 'T1')
  const playerB = makePlayer('P2', 'T2')
  return {
    ...gameSessionInitialState,
    game: { ...gameSessionInitialState.game, revealedTermIds: [] },
    players: [playerA, playerB],
    tickets: [makeTicket('T1', 'P1'), makeTicket('T2', 'P2')],
    currentPlayerId: 'P1',
    marks: [...cyberFiveMarks('P1', 'T1'), ...cyberFiveMarks('P2', 'T2')],
    claims: [],
    winners: [],
  }
}

describe('SUBMIT_PRIZE_CLAIM auto-win business rule', () => {
  it('(a) a single valid claim for an open prize immediately becomes the winner', () => {
    const state = baseState()
    const next = gameSessionReducer(state, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: 'P1',
      ticketId: 'T1',
      prizeId: 'CYBER_FIVE',
    })

    const claim = next.claims[0]
    expect(claim.validationStatus).toBe('VALID')
    expect(claim.hostDecision).toBe('CONFIRMED')
    expect(claim.decidedAt).toBeDefined()

    expect(next.winners).toHaveLength(1)
    const winner = next.winners[0]
    expect(winner.prizeId).toBe('CYBER_FIVE')
    expect(winner.playerId).toBe('P1')
    expect(winner.claimId).toBe(claim.id)

    expect(next.game.latestWinnerAnnouncementId).toBe(winner.id)
  })

  it('(b) a second claim submitted after the prize is already won is rejected, and the original winner is unchanged', () => {
    // In this synchronous, single-threaded Local Fallback reducer, a second
    // submission for an already-closed prize is caught by
    // validatePrizeClaim's own PRIZE_CLOSED gate (gate 9) before the
    // reducer's auto-win logic ever runs -- there is no real race to lose,
    // unlike the SQL path's genuine concurrent-transaction race (which
    // 0010_claim_auto_win.sql's PRIZE_ALREADY_WON branch exists for). The
    // reducer's own PRIZE_ALREADY_WON branch mirrors that SQL end-state for
    // parity but is defensive/unreachable here, exactly like gate 3's own
    // "structurally unreachable" comment in the SQL file. Either way, the
    // observable outcome required by the business rule holds: the second
    // claim never wins and the original winner is untouched.
    const state = baseState()
    const afterFirst = gameSessionReducer(state, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: 'P1',
      ticketId: 'T1',
      prizeId: 'CYBER_FIVE',
    })
    const originalWinner = afterFirst.winners[0]

    const afterSecond = gameSessionReducer(afterFirst, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: 'P2',
      ticketId: 'T2',
      prizeId: 'CYBER_FIVE',
    })

    const secondClaim = afterSecond.claims[afterSecond.claims.length - 1]
    expect(secondClaim.hostDecision).not.toBe('CONFIRMED')
    expect(secondClaim.validationStatus).toBe('INVALID')
    expect(secondClaim.rejectionReason).toBe('PRIZE_CLOSED')

    // The original winner is unchanged (not replaced) and still the only one.
    expect(afterSecond.winners).toHaveLength(1)
    expect(afterSecond.winners[0]).toEqual(originalWinner)
  })

  it('(c) an invalid claim never creates a Winner and the prize remains open for a subsequent valid claim', () => {
    const state = baseState()
    // P2 has no marks matching CYBER_FIVE's eligibility if we strip them.
    const stateNoMarksForP2: GameSessionState = {
      ...state,
      marks: state.marks.filter((m) => m.playerId !== 'P2'),
    }

    const afterInvalid = gameSessionReducer(stateNoMarksForP2, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: 'P2',
      ticketId: 'T2',
      prizeId: 'CYBER_FIVE',
    })

    const invalidClaim = afterInvalid.claims[0]
    expect(invalidClaim.validationStatus).toBe('INVALID')
    expect(invalidClaim.hostDecision).toBe('PENDING')
    expect(afterInvalid.winners).toHaveLength(0)

    // Prize remains open: P1's subsequent valid claim still wins it.
    const afterValid = gameSessionReducer(afterInvalid, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: 'P1',
      ticketId: 'T1',
      prizeId: 'CYBER_FIVE',
    })
    const validClaim = afterValid.claims[afterValid.claims.length - 1]
    expect(validClaim.hostDecision).toBe('CONFIRMED')
    expect(afterValid.winners).toHaveLength(1)
  })

  it('(d) winning one prize does not affect any other prize open/closed status', () => {
    const state = baseState()
    // Give P1 full eligibility for both CYBER_FIVE and FIREWALL_LINE (row 0,
    // target 5 cells: TERM_001-005 already marked above satisfies both).
    const afterFirst = gameSessionReducer(state, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: 'P1',
      ticketId: 'T1',
      prizeId: 'CYBER_FIVE',
    })
    expect(afterFirst.winners).toHaveLength(1)
    expect(afterFirst.winners[0].prizeId).toBe('CYBER_FIVE')

    // FIREWALL_LINE for P2 is a different prizeId -- must still be open.
    const afterSecond = gameSessionReducer(afterFirst, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: 'P2',
      ticketId: 'T2',
      prizeId: 'FIREWALL_LINE',
    })
    const firewallClaim = afterSecond.claims[afterSecond.claims.length - 1]
    expect(firewallClaim.hostDecision).toBe('CONFIRMED')
    expect(afterSecond.winners).toHaveLength(2)
    expect(afterSecond.winners.map((w) => w.prizeId).sort()).toEqual([
      'CYBER_FIVE',
      'FIREWALL_LINE',
    ])
    // The original CYBER_FIVE winner is untouched.
    expect(afterSecond.winners.find((w) => w.prizeId === 'CYBER_FIVE')).toEqual(
      afterFirst.winners[0],
    )
  })
})
