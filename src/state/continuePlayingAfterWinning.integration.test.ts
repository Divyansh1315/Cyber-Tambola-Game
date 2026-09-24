// Feature: module-5-prize-claim-processing-winner-management — integration
// test (task 15.5): continuing to play after winning one prize.
//
// After a player's CYBER_FIVE claim is confirmed, further valid MARK_TERM
// actions for that player must still increase progress toward the remaining
// four open prizes exactly as before, with `marks` growing correctly (no
// marks lost/duplicated) and the confirmed prize's own progress/status
// unaffected — the win must not block or alter marking mechanics for the
// ticket (Req 13.3, 18.5, 20.1, 20.4).
import { describe, it, expect } from 'vitest'
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import { getAllPrizeProgress } from '../utils/prizeEngine'
import type { GameSessionState } from './gameSessionInitialState'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'

const PLAYER_ID = 'PLAYER_1'
const TICKET_ID = 'TICKET_1'
const GAME_ID = 'GAME_001'

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

// Row 0 = T0..T4 (FIREWALL_LINE), Row 1 = T5..T9 (SECURITY_LINE),
// Row 2 = T10..T14 (DATA_DEFENDER_LINE). Marking T0..T4 makes CYBER_FIVE
// eligible (any 5 marked terms) *and* also completes FIREWALL_LINE, which
// would confound the "other prizes are still open" setup for this test. So
// instead we mark 5 terms spread across rows (one from each row plus two
// extra) so CYBER_FIVE reaches 5/5 while no Line prize is complete and
// Full House is far from 15.
const INITIAL_MARK_TERM_IDS = ['T0', 'T5', 'T10', 'T1', 'T6']

// Additional terms to mark afterward, avoiding re-marking, and chosen to
// continue advancing the still-open Line prizes and Full House.
const FOLLOW_UP_TERM_IDS = ['T2', 'T7', 'T11', 'T3']

const ALL_REVEALED_TERM_IDS = [...INITIAL_MARK_TERM_IDS, ...FOLLOW_UP_TERM_IDS]

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
      // Seed revealedTermIds directly (simplest for a focused integration
      // test) so MARK_TERM's validateMarkAttempt gate on revealed terms
      // passes for every term this test needs to mark.
      revealedTermIds: [...ALL_REVEALED_TERM_IDS],
    },
    players: [player],
    tickets: [ticket],
    currentPlayerId: player.id,
  }
}

describe('continue playing after winning one prize integration (module-5, task 15.5)', () => {
  it('keeps marking mechanics and remaining prize progress fully working after a CYBER_FIVE win is confirmed', () => {
    let state = baseState()

    // --- Mark 5 terms to bring CYBER_FIVE to exactly 5/5, eligible. ---
    for (const termId of INITIAL_MARK_TERM_IDS) {
      state = gameSessionReducer(state, { type: 'MARK_TERM', termId })
    }
    expect(state.marks).toHaveLength(5)

    const progressBeforeClaim = getAllPrizeProgress(state.tickets[0], state.marks)
    const cyberFiveBeforeClaim = progressBeforeClaim.find((p) => p.id === 'CYBER_FIVE')!
    expect(cyberFiveBeforeClaim.current).toBe(5)
    expect(cyberFiveBeforeClaim.target).toBe(5)

    // Sanity: the other four prizes are still open (below target) before
    // the claim is submitted/confirmed.
    for (const p of progressBeforeClaim) {
      if (p.id === 'CYBER_FIVE') continue
      expect(p.current).toBeLessThan(p.target)
    }

    // --- Submit and confirm the CYBER_FIVE claim. ---
    state = gameSessionReducer(state, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: PLAYER_ID,
      ticketId: TICKET_ID,
      prizeId: 'CYBER_FIVE',
    })
    const claim = state.claims.find(
      (c) => c.playerId === PLAYER_ID && c.prizeId === 'CYBER_FIVE',
    )
    expect(claim).toBeDefined()
    expect(claim!.validationStatus).toBe('VALID')

    state = gameSessionReducer(state, { type: 'CONFIRM_CLAIM', claimId: claim!.id })
    const confirmedClaim = state.claims.find((c) => c.id === claim!.id)!
    expect(confirmedClaim.hostDecision).toBe('CONFIRMED')
    const winner = state.winners.find((w) => w.claimId === claim!.id)
    expect(winner).toBeDefined()
    expect(winner!.prizeId).toBe('CYBER_FIVE')
    expect(winner!.playerId).toBe(PLAYER_ID)

    // --- Baseline: the other four open prizes' progress right after the win. ---
    const baselineProgress = getAllPrizeProgress(state.tickets[0], state.marks)
    const openPrizeIds = baselineProgress
      .map((p) => p.id)
      .filter((id) => id !== 'CYBER_FIVE')
    expect(openPrizeIds.sort()).toEqual(
      ['CYBER_FULL_HOUSE', 'DATA_DEFENDER_LINE', 'FIREWALL_LINE', 'SECURITY_LINE'].sort(),
    )

    let previousProgress = new Map(baselineProgress.map((p) => [p.id, p.current]))
    let previousMarkCount = state.marks.length

    // --- Dispatch further valid MARK_TERM actions for the SAME player. ---
    for (const termId of FOLLOW_UP_TERM_IDS) {
      const marksBefore = state.marks

      state = gameSessionReducer(state, { type: 'MARK_TERM', termId })

      // marks grows by exactly one, no marks lost or duplicated.
      expect(state.marks.length).toBe(previousMarkCount + 1)
      expect(state.marks.slice(0, marksBefore.length)).toEqual(marksBefore)
      const termIds = state.marks.map((m) => m.termId)
      expect(new Set(termIds).size).toBe(termIds.length) // no duplicates
      previousMarkCount = state.marks.length

      const progressNow = getAllPrizeProgress(state.tickets[0], state.marks)

      // The remaining four open prizes' progress increases as expected
      // (never decreases; increases for prizes whose criteria this term
      // satisfies).
      for (const p of progressNow) {
        if (p.id === 'CYBER_FIVE') continue
        const prior = previousProgress.get(p.id)!
        expect(p.current).toBeGreaterThanOrEqual(prior)
      }

      // CYBER_FIVE's own progress and CONFIRMED status stay unaffected.
      const cyberFiveNow = progressNow.find((p) => p.id === 'CYBER_FIVE')!
      expect(cyberFiveNow.current).toBe(5)
      expect(cyberFiveNow.target).toBe(5)

      const claimNow = state.claims.find((c) => c.id === claim!.id)!
      expect(claimNow.hostDecision).toBe('CONFIRMED')
      const winnerNow = state.winners.find((w) => w.claimId === claim!.id)
      expect(winnerNow).toBeDefined()
      expect(winnerNow!.prizeId).toBe('CYBER_FIVE')
      expect(state.winners).toHaveLength(1) // still exactly one Winner

      previousProgress = new Map(progressNow.map((p) => [p.id, p.current]))
    }

    // Final sanity: at least one of the remaining prizes made real progress
    // (the follow-up marks weren't a no-op), proving marking mechanics were
    // never blocked by the earlier win.
    const finalProgress = getAllPrizeProgress(state.tickets[0], state.marks)
    const madeProgress = finalProgress.some(
      (p) => p.id !== 'CYBER_FIVE' && p.current > (baselineProgress.find((b) => b.id === p.id)?.current ?? 0),
    )
    expect(madeProgress).toBe(true)

    // currentPlayerId untouched by any of the claim/winner/mark actions.
    expect(state.currentPlayerId).toBe(PLAYER_ID)
  })
})
