import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { validateMarkAttempt, canMarkTerm } from './prizeEngine'
import type { Game, GameStatus } from '../types/game'
import type { Mark } from '../types/mark'
import type { Ticket, TicketCell } from '../types/ticket'

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** Non-COMPLETED statuses under which marking a revealed term is allowed. */
const NON_COMPLETED_STATUSES: GameStatus[] = [
  'LOBBY',
  'WORD_ACTIVE',
  'PAUSED',
]

function makeGame(status: GameStatus, revealedTermIds: string[]): Game {
  return {
    id: 'GAME_001',
    code: 'CYBER24',
    status,
    createdAt: new Date().toISOString(),
    currentRound: 1,
    revealedTermIds,
  }
}

/** Build a valid 3x5 ticket with 15 distinct termIds `T0`..`T14`. */
function makeTicket(ticketId: string): Ticket {
  const rows: TicketCell[][] = []
  for (let row = 0; row < 3; row++) {
    rows[row] = []
    for (let col = 0; col < 5; col++) {
      const i = row * 5 + col
      rows[row][col] = {
        termId: `T${i}`,
        term: `Term ${i}`,
        state: 'LOCKED',
        row,
        col,
      }
    }
  }
  return {
    id: ticketId,
    playerId: 'p-1',
    gameId: 'GAME_001',
    createdAt: new Date().toISOString(),
    ref: 'Ticket #001',
    rows,
  }
}

function makeMark(overrides: Partial<Mark> = {}): Mark {
  return {
    id: 'm-1',
    gameId: 'GAME_001',
    playerId: 'p-1',
    ticketId: 't-1',
    termId: 'T0',
    markedAt: new Date().toISOString(),
    valid: true,
    ...overrides,
  }
}

/**
 * A fully-valid baseline fixture: current player p-1 owns ticket t-1 (15
 * termIds T0..T14), the target term is revealed, the game is not COMPLETED,
 * and no prior mark exists for it. `validateMarkAttempt` must accept this.
 */
function validBaseline(termId = 'T0') {
  const ticket = makeTicket('t-1')
  const game = makeGame('WORD_ACTIVE', [termId])
  return {
    state: {
      game,
      players: [{ id: 'p-1', ticketId: 't-1' }],
      tickets: [ticket],
      marks: [] as Mark[],
      currentPlayerId: 'p-1',
    },
    termId,
  }
}

// ---------------------------------------------------------------------------
// Arbitraries for each of the 6 rejection scenarios + the valid baseline
// ---------------------------------------------------------------------------

type Scenario =
  | 'NO_CURRENT_PLAYER'
  | 'TICKET_NOT_FOUND'
  | 'TERM_NOT_ON_TICKET'
  | 'TERM_NOT_REVEALED'
  | 'GAME_COMPLETED'
  | 'DUPLICATE_MARK'
  | 'VALID'

const scenarioArb = fc.constantFrom<Scenario>(
  'NO_CURRENT_PLAYER',
  'TICKET_NOT_FOUND',
  'TERM_NOT_ON_TICKET',
  'TERM_NOT_REVEALED',
  'GAME_COMPLETED',
  'DUPLICATE_MARK',
  'VALID',
)

/** Arbitrary non-COMPLETED status, used to vary the valid/duplicate/etc fixtures. */
const nonCompletedStatusArb = fc.constantFrom<GameStatus>(...NON_COMPLETED_STATUSES)

/**
 * Build a `{ state, termId, scenario }` fixture that independently produces
 * each of the 6 invalid gates plus the valid baseline, per the task's
 * requirement for a state-fixture generator that toggles each gate
 * independently.
 */
function buildFixture(scenario: Scenario, status: GameStatus, termId: string) {
  const { state, termId: baseTermId } = validBaseline(termId)

  switch (scenario) {
    case 'NO_CURRENT_PLAYER': {
      return {
        state: { ...state, currentPlayerId: undefined },
        termId: baseTermId,
        expectedReason: 'NO_CURRENT_PLAYER' as const,
      }
    }
    case 'TICKET_NOT_FOUND': {
      return {
        state: { ...state, tickets: [] },
        termId: baseTermId,
        expectedReason: 'TICKET_NOT_FOUND' as const,
      }
    }
    case 'TERM_NOT_ON_TICKET': {
      return {
        state,
        termId: 'NOT_ON_TICKET',
        expectedReason: 'TERM_NOT_ON_TICKET' as const,
      }
    }
    case 'TERM_NOT_REVEALED': {
      return {
        state: { ...state, game: { ...state.game, revealedTermIds: [] } },
        termId: baseTermId,
        expectedReason: 'TERM_NOT_REVEALED' as const,
      }
    }
    case 'GAME_COMPLETED': {
      return {
        state: { ...state, game: { ...state.game, status: 'COMPLETED' as GameStatus } },
        termId: baseTermId,
        expectedReason: 'GAME_COMPLETED' as const,
      }
    }
    case 'DUPLICATE_MARK': {
      const existing = makeMark({
        playerId: 'p-1',
        ticketId: 't-1',
        termId: baseTermId,
      })
      return {
        state: { ...state, marks: [existing] },
        termId: baseTermId,
        expectedReason: 'DUPLICATE_MARK' as const,
      }
    }
    case 'VALID': {
      return {
        state: { ...state, game: { ...state.game, status } },
        termId: baseTermId,
        expectedReason: undefined,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Property 1: Invalid mark attempts are always rejected without side effects
// Feature: module-4-term-marking-prize-engine, Property 1: Invalid mark attempts are always rejected without side effects
// Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.4, 13.1, 13.2, 14.1, 14.2, 14.3
// ---------------------------------------------------------------------------

describe('Property 1: Invalid mark attempts are always rejected without side effects', () => {
  it('each of the six gates rejects with its specific reason and leaves inputs untouched; the valid baseline is accepted', () => {
    fc.assert(
      fc.property(scenarioArb, nonCompletedStatusArb, (scenario, status) => {
        const fixture = buildFixture(scenario, status, 'T0')
        const { state, termId, expectedReason } = fixture

        // Deep-copy snapshots to assert nothing was mutated by the call.
        const stateSnapshot = JSON.parse(JSON.stringify(state))

        const result = validateMarkAttempt(state, termId)
        const canMark = canMarkTerm(state, termId)

        if (expectedReason) {
          expect(result.valid).toBe(false)
          if (!result.valid) expect(result.reason).toBe(expectedReason)
          expect(canMark).toBe(false)
        } else {
          expect(result.valid).toBe(true)
          expect(canMark).toBe(true)
        }

        // No side effects: validateMarkAttempt/canMarkTerm never mutate state.
        expect(JSON.parse(JSON.stringify(state))).toEqual(stateSnapshot)
      }),
      { numRuns: 100 },
    )
  })

  it('is deterministic: calling validateMarkAttempt twice with the same inputs yields the same result', () => {
    fc.assert(
      fc.property(scenarioArb, nonCompletedStatusArb, (scenario, status) => {
        const { state, termId } = buildFixture(scenario, status, 'T0')
        const first = validateMarkAttempt(state, termId)
        const second = validateMarkAttempt(state, termId)
        expect(second).toEqual(first)
      }),
      { numRuns: 100 },
    )
  })
})
