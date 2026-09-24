// Feature: module-4-term-marking-prize-engine — bugfix regression
//
// Reproduces the Module 4 acceptance defect end-to-end at the reducer level:
// existing Marks must never be lost when a subsequent word is called (or any
// other in-tab lifecycle action fires). CALL_NEXT_WORD only ever touches
// `game`; it must never disturb `marks`, and Cyber Five progress must never
// regress purely from calling the next word.
//
// Validates: bugfix — marks lost on answer reveal (cross-tab sync root cause;
// this test locks down the reducer-level invariant the fix depends on).
import { describe, it, expect } from 'vitest'
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import { getCyberFiveProgress } from '../utils/prizeEngine'
import type { GameSessionState } from './gameSessionInitialState'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    gameId: 'GAME_001',
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: 'Ticket #1',
    rows,
  }
}

function makePlayer(): Player {
  return {
    id: PLAYER_ID,
    gameId: 'GAME_001',
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
      status: 'WORD_ACTIVE',
      currentRound: 1,
    },
    players: [player],
    tickets: [ticket],
    currentPlayerId: player.id,
  }
}

/**
 * Simulate "term `termId` has just been officially called" by directly
 * setting `currentTermId`/`revealedTermIds`/`status: 'WORD_ACTIVE'` on the
 * game slice. CALL_NEXT_WORD/START_GAME now select AND reveal a term in one
 * step (Module 5), and which exact term gets selected is randomized — so
 * this helper bypasses the reducer's own term-selection to deterministically
 * drive `revealedTermIds` to known values, exactly the same convention the
 * rest of the test suite (SYNC_STATE-based fixtures) already relies on. It
 * does not call the reducer at all, so it cannot regress `marks` itself —
 * the regression under test is exercised by dispatching MARK_TERM/
 * CALL_NEXT_WORD afterward, not by this setup helper.
 */
function revealTerm(state: GameSessionState, termId: string): GameSessionState {
  return {
    ...state,
    game: {
      ...state.game,
      status: 'WORD_ACTIVE' as const,
      currentTermId: termId,
      revealedTermIds: state.game.revealedTermIds.includes(termId)
        ? state.game.revealedTermIds
        : [...state.game.revealedTermIds, termId],
    },
  }
}

// ---------------------------------------------------------------------------
// Regression test A — marks survive every subsequent reveal
// ---------------------------------------------------------------------------

describe('marks survive across multiple subsequent reveals (bugfix regression, Test A)', () => {
  it('keeps every previously-created mark intact as more terms are revealed and marked', () => {
    const terms = ['T0', 'T1', 'T2', 'T3', 'T4']
    let state = baseState()

    // Reveal A -> marks == []
    state = revealTerm(state, terms[0])
    expect(state.marks).toEqual([])

    // Mark A -> marks == [A]
    state = gameSessionReducer(state, { type: 'MARK_TERM', termId: terms[0] })
    expect(state.marks.map((m) => m.termId)).toEqual(['T0'])

    let previousCyberFive = getCyberFiveProgress(state.tickets[0], state.marks).current

    for (let i = 1; i < terms.length; i++) {
      const marksBeforeReveal = state.marks

      // Reveal the next term — must NOT disturb any existing mark.
      state = revealTerm(state, terms[i])
      expect(state.marks).toEqual(marksBeforeReveal)
      expect(state.marks).toHaveLength(i)

      // Cyber Five progress must never regress from a reveal-only action.
      const cyberFiveAfterReveal = getCyberFiveProgress(state.tickets[0], state.marks).current
      expect(cyberFiveAfterReveal).toBeGreaterThanOrEqual(previousCyberFive)

      // Mark the newly revealed term.
      state = gameSessionReducer(state, { type: 'MARK_TERM', termId: terms[i] })
      expect(state.marks.map((m) => m.termId)).toEqual(terms.slice(0, i + 1))

      const cyberFiveAfterMark = getCyberFiveProgress(state.tickets[0], state.marks).current
      expect(cyberFiveAfterMark).toBeGreaterThanOrEqual(cyberFiveAfterReveal)
      previousCyberFive = cyberFiveAfterMark
    }

    // Final state: all 5 marks present, Cyber Five capped at 5.
    expect(state.marks).toHaveLength(5)
    expect(state.marks.map((m) => m.termId).sort()).toEqual([...terms].sort())
    expect(getCyberFiveProgress(state.tickets[0], state.marks).current).toBe(5)
  })

  it('never regresses marks or Cyber Five progress across an interleaved CALL_NEXT_WORD sequence', () => {
    let state = baseState()
    state = revealTerm(state, 'T0')
    state = gameSessionReducer(state, { type: 'MARK_TERM', termId: 'T0' })
    expect(state.marks).toHaveLength(1)

    // CALL_NEXT_WORD only ever touches `game` — assert marks untouched.
    const marksBefore = state.marks
    state = gameSessionReducer(state, { type: 'CALL_NEXT_WORD' })
    expect(state.marks).toBe(marksBefore)

    state = revealTerm(state, 'T1')
    expect(state.marks).toBe(marksBefore)
    state = gameSessionReducer(state, { type: 'MARK_TERM', termId: 'T1' })
    expect(state.marks).toHaveLength(2)
  })
})
