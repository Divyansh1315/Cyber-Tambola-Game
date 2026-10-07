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
// Property 10: Only previously-called terms are markable
// Feature: ticket-3x4-dimension-refactor, Property 10: Only previously-called terms are markable
// Validates: Requirements 14.1, 14.2, 19.1, 19.2
// ---------------------------------------------------------------------------

describe('Property 10: Only previously-called terms are markable', () => {
  it('a tap on any term present in revealedTermIds (current or not) with no prior mark validates; a tap on a never-called term is rejected as TERM_NOT_REVEALED', () => {
    fc.assert(
      fc.property(
        termIdOnTicketArb,
        termIdOnTicketArb,
        fc.subarray(TICKET_TERM_IDS),
        (currentTermId, tappedTermId, callHistory) => {
          const state = baseState(currentTermId, callHistory)
          const result = validateMarkAttempt(state, tappedTermId)

          if (callHistory.includes(tappedTermId)) {
            expect(result.valid).toBe(true)
          } else {
            expect(result.valid).toBe(false)
            if (!result.valid) expect(result.reason).toBe('TERM_NOT_REVEALED')
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('a term called earlier, then superseded by a newer current term, is still validly markable', () => {
    fc.assert(
      fc.property(
        termIdOnTicketArb,
        termIdOnTicketArb,
        (earlierTermId, currentTermId) => {
          const callHistory = [earlierTermId, currentTermId]
          const state = baseState(currentTermId, callHistory)
          const result = validateMarkAttempt(state, earlierTermId)
          expect(result.valid).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('a term absent from Call_History is never markable, regardless of currentTermId', () => {
    fc.assert(
      fc.property(
        termIdOnTicketArb,
        fc.subarray(TICKET_TERM_IDS),
        (currentTermId, callHistory) => {
          // Pick a term never called.
          const neverCalled = TICKET_TERM_IDS.find((id) => !callHistory.includes(id))
          fc.pre(neverCalled !== undefined)

          const state = baseState(currentTermId, callHistory)
          const result = validateMarkAttempt(state, neverCalled!)

          expect(result.valid).toBe(false)
          if (!result.valid) expect(result.reason).toBe('TERM_NOT_REVEALED')
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 11: Tapping a never-called cell is a strict, idempotent no-op
// Feature: ticket-3x4-dimension-refactor, Property 11: Tapping a never-called cell is a strict, idempotent no-op
// Validates: Requirements 15.1, 15.2, 15.3
// ---------------------------------------------------------------------------

describe('Property 11: Tapping a never-called cell is a strict, idempotent no-op', () => {
  it('repeated validateMarkAttempt calls against a never-called term never mutate state and always reject identically', () => {
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
            if (!result.valid) expect(result.reason).toBe('TERM_NOT_REVEALED')
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

  it('canMarkTerm agrees with validateMarkAttempt for never-called terms', () => {
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
// Call-history markability revert: once called, a term stays markable
// Feature: GAMEPLAY FIX (scoped revert of current-term-only marking)
// ---------------------------------------------------------------------------

describe('Call-history markability (revert of current-term-only rule)', () => {
  it('marking several previously-called words out of order all succeed, even after a later word has become current', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(TICKET_TERM_IDS, { minLength: 2 }),
        (calledInOrder) => {
          // Simulate: all of `calledInOrder` have been called, in that order,
          // with the last one being the current word.
          const currentTermId = calledInOrder[calledInOrder.length - 1]
          const state = baseState(currentTermId, calledInOrder)

          // Mark them out of order: last-called first, then the rest.
          const markOrder = [...calledInOrder].reverse()
          for (const termId of markOrder) {
            const result = validateMarkAttempt(state, termId)
            expect(result.valid).toBe(true)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('a word that was called, then marked, stays markable-rejected-as-duplicate (never unmarks) as later words become current', () => {
    fc.assert(
      fc.property(
        termIdOnTicketArb,
        fc.array(termIdOnTicketArb, { maxLength: 5 }),
        (firstCalled, laterCalls) => {
          const callHistory = [firstCalled, ...laterCalls]
          const existingMark = makeMark({ termId: firstCalled })
          const currentTermId = callHistory[callHistory.length - 1]
          const state = {
            ...baseState(currentTermId, callHistory),
            marks: [existingMark],
          }

          const result = validateMarkAttempt(state, firstCalled)
          expect(result.valid).toBe(false)
          if (!result.valid) expect(result.reason).toBe('DUPLICATE_MARK')
        },
      ),
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

  it('a term with an existing Valid_Mark is always rejected as DUPLICATE_MARK, even once the current term advances elsewhere (the term remains in Call_History so it still passes TERM_NOT_REVEALED)', () => {
    // The marked term stays in revealedTermIds forever (call history is
    // append-only), so DUPLICATE_MARK is the only gate it can ever fail on
    // once marked, regardless of what the game's currentTermId has become.
    fc.assert(
      fc.property(termIdOnTicketArb, termIdOnTicketArb, (markedTermId, nextCurrentTermId) => {
        const existingMark = makeMark({ termId: markedTermId })
        const state = {
          ...baseState(nextCurrentTermId, [markedTermId, nextCurrentTermId]),
          marks: [existingMark],
        }

        const result = validateMarkAttempt(state, markedTermId)
        expect(result.valid).toBe(false)
        if (!result.valid) expect(result.reason).toBe('DUPLICATE_MARK')
        // Exactly one mark continues to exist.
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
    case 'TERM_NOT_REVEALED':
      return {
        state: { ...state, game: { ...state.game, revealedTermIds: [] } },
        termId,
        expectedReason: 'TERM_NOT_REVEALED' as const,
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

  it('a state failing TICKET_NOT_FOUND and TERM_NOT_REVEALED simultaneously reports TICKET_NOT_FOUND (gate 2 before gate 4)', () => {
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
