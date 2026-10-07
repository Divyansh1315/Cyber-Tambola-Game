import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { validateMarkAttempt, canMarkTerm } from './prizeEngine'
import type { Game, GameStatus } from '../types/game'
import type { Mark } from '../types/mark'
import type { Ticket, TicketCell } from '../types/ticket'
import { TICKET_COLUMNS } from './ticketGenerator'

/** Non-COMPLETED statuses under which marking the current term is allowed. */
const NON_COMPLETED_STATUSES: GameStatus[] = ['LOBBY', 'WORD_ACTIVE', 'PAUSED']

function makeGame(
  status: GameStatus,
  revealedTermIds: string[],
  currentTermId?: string,
): Game {
  return {
    id: 'GAME_001',
    code: 'CYBER24',
    status,
    createdAt: new Date().toISOString(),
    currentRound: 1,
    currentTermId,
    revealedTermIds,
  }
}

/** Build a valid 3x4 ticket with 12 distinct termIds `T0`..`T11`. */
function makeTicket(ticketId: string): Ticket {
  const rows: TicketCell[][] = []
  for (let row = 0; row < 3; row++) {
    rows[row] = []
    for (let col = 0; col < TICKET_COLUMNS; col++) {
      const i = row * TICKET_COLUMNS + col
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

/** The 12 termIds present on the fixture ticket. */
const TICKET_TERM_IDS = Array.from({ length: 12 }, (_, i) => `T${i}`)

const termIdOnTicketArb = fc.constantFrom(...TICKET_TERM_IDS)
const nonCompletedStatusArb = fc.constantFrom<GameStatus>(...NON_COMPLETED_STATUSES)

function baseState(currentTermId: string | undefined, callHistory: string[]) {
  const ticket = makeTicket('t-1')
  const game = makeGame('WORD_ACTIVE', callHistory, currentTermId)
  return {
    game,
    players: [{ id: 'p-1', ticketId: 't-1' }],
    tickets: [ticket],
    marks: [] as Mark[],
    currentPlayerId: 'p-1',
  }
}

// ---------------------------------------------------------------------------
// Property 10: Only the current term is newly markable
// Feature: ticket-3x4-dimension-refactor, Property 10: Only the current term is newly markable
// Validates: Requirements 14.1, 14.2, 19.1, 19.2
// ---------------------------------------------------------------------------

describe('Property 10: Only the current term is newly markable', () => {
  it('a tap on the current term with no prior mark validates; a tap on any other on-ticket term (called before or never called) is rejected as TERM_NOT_CURRENT', () => {
    fc.assert(
      fc.property(
        termIdOnTicketArb,
        termIdOnTicketArb,
        fc.subarray(TICKET_TERM_IDS),
        (currentTermId, tappedTermId, callHistory) => {
          const state = baseState(currentTermId, callHistory)
          const result = validateMarkAttempt(state, tappedTermId)

          if (tappedTermId === currentTermId) {
            expect(result.valid).toBe(true)
          } else {
            expect(result.valid).toBe(false)
            if (!result.valid) expect(result.reason).toBe('TERM_NOT_CURRENT')
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('membership in Call_History alone never grants markability without also being currentTermId', () => {
    fc.assert(
      fc.property(
        termIdOnTicketArb,
        fc.subarray(TICKET_TERM_IDS, { minLength: 1 }),
        (currentTermId, callHistory) => {
          // Pick a term that was called previously but is not the current term.
          const previouslyCalledNotCurrent = callHistory.find(
            (id) => id !== currentTermId,
          )
          fc.pre(previouslyCalledNotCurrent !== undefined)

          const state = baseState(currentTermId, callHistory)
          const result = validateMarkAttempt(state, previouslyCalledNotCurrent!)

          expect(result.valid).toBe(false)
          if (!result.valid) expect(result.reason).toBe('TERM_NOT_CURRENT')
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 11: Tapping a non-current cell is a strict, idempotent no-op
// Feature: ticket-3x4-dimension-refactor, Property 11: Tapping a non-current cell is a strict, idempotent no-op
// Validates: Requirements 15.1, 15.2, 15.3
// ---------------------------------------------------------------------------

describe('Property 11: Tapping a non-current cell is a strict, idempotent no-op', () => {
  it('repeated validateMarkAttempt calls against a non-current term never mutate state and always reject identically', () => {
    fc.assert(
      fc.property(
        termIdOnTicketArb,
        termIdOnTicketArb,
        fc.integer({ min: 1, max: 5 }),
        (currentTermId, tappedTermId, repeatCount) => {
          fc.pre(tappedTermId !== currentTermId)

          const state = baseState(currentTermId, [])
          const snapshot = JSON.parse(JSON.stringify(state))

          const results = Array.from({ length: repeatCount }, () =>
            validateMarkAttempt(state, tappedTermId),
          )

          for (const result of results) {
            expect(result.valid).toBe(false)
            if (!result.valid) expect(result.reason).toBe('TERM_NOT_CURRENT')
          }
          // All repeated results are identical (idempotent).
          expect(results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(
            true,
          )
          // No side effects accumulate across repeated taps.
          expect(JSON.parse(JSON.stringify(state))).toEqual(snapshot)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('canMarkTerm agrees with validateMarkAttempt for non-current terms', () => {
    fc.assert(
      fc.property(termIdOnTicketArb, termIdOnTicketArb, (currentTermId, tappedTermId) => {
        fc.pre(tappedTermId !== currentTermId)
        const state = baseState(currentTermId, [])
        expect(canMarkTerm(state, tappedTermId)).toBe(false)
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 12: Marks are permanent under repeated taps
// Feature: ticket-3x4-dimension-refactor, Property 12: Marks are permanent under repeated taps
// Validates: Requirements 16.1, 16.2, 17.4
// ---------------------------------------------------------------------------

describe('Property 12: Marks are permanent under repeated taps', () => {
  it('a term with an existing Valid_Mark is always rejected as DUPLICATE_MARK, even if it is still the current term', () => {
    fc.assert(
      fc.property(termIdOnTicketArb, fc.integer({ min: 1, max: 5 }), (termId, repeatCount) => {
        const existingMark = makeMark({ termId })
        const state = {
          ...baseState(termId, [termId]),
          marks: [existingMark],
        }

        const results = Array.from({ length: repeatCount }, () =>
          validateMarkAttempt(state, termId),
        )

        for (const result of results) {
          expect(result.valid).toBe(false)
          if (!result.valid) expect(result.reason).toBe('DUPLICATE_MARK')
        }
        // Exactly one mark continues to exist; no duplication, no removal.
        expect(state.marks.filter((m) => m.termId === termId)).toHaveLength(1)
      }),
      { numRuns: 100 },
    )
  })

  it('a term with an existing Valid_Mark is always rejected (never re-marked) once the current term advances elsewhere, whether via DUPLICATE_MARK or the earlier-ordered TERM_NOT_CURRENT gate', () => {
    // Once a term is no longer current, tapping it fails the earlier
    // TERM_NOT_CURRENT gate before DUPLICATE_MARK is ever reached (Req 17.1
    // gate ordering) -- but the net effect for Requirement 16.1/16.2 is the
    // same either way: the Mark is never removed or duplicated, and the tap
    // is always rejected.
    fc.assert(
      fc.property(termIdOnTicketArb, termIdOnTicketArb, (markedTermId, nextCurrentTermId) => {
        const existingMark = makeMark({ termId: markedTermId })
        const state = {
          ...baseState(nextCurrentTermId, [markedTermId, nextCurrentTermId]),
          marks: [existingMark],
        }

        const result = validateMarkAttempt(state, markedTermId)
        expect(result.valid).toBe(false)
        if (!result.valid) {
          const expectedReason =
            markedTermId === nextCurrentTermId ? 'DUPLICATE_MARK' : 'TERM_NOT_CURRENT'
          expect(result.reason).toBe(expectedReason)
        }
        // Regardless of reason, exactly one mark continues to exist.
        expect(state.marks.filter((m) => m.termId === markedTermId)).toHaveLength(1)
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 13: Validation gate ordering is total and deterministic
// Feature: ticket-3x4-dimension-refactor, Property 13: Validation gate ordering is total and deterministic
// Validates: Requirements 17.1, 17.2
// ---------------------------------------------------------------------------

type Scenario =
  | 'NO_CURRENT_PLAYER'
  | 'TICKET_NOT_FOUND'
  | 'TERM_NOT_ON_TICKET'
  | 'TERM_NOT_CURRENT'
  | 'GAME_COMPLETED'
  | 'DUPLICATE_MARK'
  | 'VALID'

const scenarioArb = fc.constantFrom<Scenario>(
  'NO_CURRENT_PLAYER',
  'TICKET_NOT_FOUND',
  'TERM_NOT_ON_TICKET',
  'TERM_NOT_CURRENT',
  'GAME_COMPLETED',
  'DUPLICATE_MARK',
  'VALID',
)

function buildFixture(scenario: Scenario, status: GameStatus, termId: string) {
  const state = baseState(termId, [termId])

  switch (scenario) {
    case 'NO_CURRENT_PLAYER':
      return {
        state: { ...state, currentPlayerId: undefined },
        termId,
        expectedReason: 'NO_CURRENT_PLAYER' as const,
      }
    case 'TICKET_NOT_FOUND':
      return {
        state: { ...state, tickets: [] },
        termId,
        expectedReason: 'TICKET_NOT_FOUND' as const,
      }
    case 'TERM_NOT_ON_TICKET':
      return {
        state,
        termId: 'NOT_ON_TICKET',
        expectedReason: 'TERM_NOT_ON_TICKET' as const,
      }
    case 'TERM_NOT_CURRENT':
      return {
        state: { ...state, game: { ...state.game, currentTermId: undefined } },
        termId,
        expectedReason: 'TERM_NOT_CURRENT' as const,
      }
    case 'GAME_COMPLETED':
      return {
        state: { ...state, game: { ...state.game, status: 'COMPLETED' as GameStatus } },
        termId,
        expectedReason: 'GAME_COMPLETED' as const,
      }
    case 'DUPLICATE_MARK': {
      const existing = makeMark({ playerId: 'p-1', ticketId: 't-1', termId })
      return {
        state: { ...state, marks: [existing] },
        termId,
        expectedReason: 'DUPLICATE_MARK' as const,
      }
    }
    case 'VALID':
      return {
        state: { ...state, game: { ...state.game, status } },
        termId,
        expectedReason: undefined,
      }
  }
}

describe('Property 13: Validation gate ordering is total and deterministic', () => {
  it('every scenario resolves to a definite valid/invalid outcome with the expected reason, deterministically', () => {
    fc.assert(
      fc.property(
        scenarioArb,
        nonCompletedStatusArb,
        termIdOnTicketArb,
        (scenario, status, termId) => {
          const fixture = buildFixture(scenario, status, termId)
          const { state, termId: attemptTermId, expectedReason } = fixture

          const first = validateMarkAttempt(state, attemptTermId)
          const second = validateMarkAttempt(state, attemptTermId)

          // Deterministic: identical inputs always yield identical outputs.
          expect(second).toEqual(first)

          if (expectedReason) {
            expect(first.valid).toBe(false)
            if (!first.valid) expect(first.reason).toBe(expectedReason)
          } else {
            expect(first.valid).toBe(true)
          }

          // Total: the function never throws and always returns one of the
          // defined MarkValidationResult shapes.
          expect(typeof first.valid).toBe('boolean')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('a state failing multiple gates simultaneously always reports the earliest-ordered failing gate', () => {
    // Combine NO_CURRENT_PLAYER (gate 1) with a termId that would also fail
    // TERM_NOT_ON_TICKET (a later gate) -- gate 1 must win.
    fc.assert(
      fc.property(termIdOnTicketArb, (termId) => {
        const state = { ...baseState(termId, [termId]), currentPlayerId: undefined }
        const result = validateMarkAttempt(state, 'NOT_ON_TICKET_EITHER')
        expect(result.valid).toBe(false)
        if (!result.valid) expect(result.reason).toBe('NO_CURRENT_PLAYER')
      }),
      { numRuns: 100 },
    )
  })

  it('a state failing TICKET_NOT_FOUND and TERM_NOT_CURRENT simultaneously reports TICKET_NOT_FOUND (gate 2 before gate 4)', () => {
    fc.assert(
      fc.property(termIdOnTicketArb, termIdOnTicketArb, (currentTermId, tappedTermId) => {
        fc.pre(tappedTermId !== currentTermId)
        const state = { ...baseState(currentTermId, []), tickets: [] }
        const result = validateMarkAttempt(state, tappedTermId)
        expect(result.valid).toBe(false)
        if (!result.valid) expect(result.reason).toBe('TICKET_NOT_FOUND')
      }),
      { numRuns: 100 },
    )
  })
})
