import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { deriveCellState } from './deriveCellState'

// Feature: ticket-3x4-dimension-refactor, Property: Cell state is derived solely from the
// call history and valid marks
//
// For any termId, revealedTermIds (call history), and set of Marked_Term_Ids:
//   - MARKED when termId is present in markedTermIds (checked first, regardless of revealedTermIds)
//   - AVAILABLE when absent from markedTermIds and termId is in revealedTermIds
//   - LOCKED when absent from markedTermIds and termId is not in revealedTermIds
// Metamorphic: a term that was called, got marked, and is superseded by later calls still
// reports MARKED, never LOCKED (marks are permanent, Req 16.1).
//
// **Validates: Requirements 13.5, 14.1, 14.3, 16.1**

/** A small alphabet of term ids so overlaps between the cell and revealedTermIds occur. */
const termIdArb = fc.constantFrom('t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8')
const revealedTermIdsArb = fc.array(termIdArb, { maxLength: 8 })

/** Build a markedTermIds set that either does or does not contain termId. */
function markedSetFor(termId: string, marked: boolean): ReadonlySet<string> {
  return marked ? new Set([termId]) : new Set<string>()
}

describe('deriveCellState (call-history rule)', () => {
  it('yields MARKED/AVAILABLE/LOCKED strictly from marked + call-history membership', () => {
    fc.assert(
      fc.property(
        termIdArb,
        revealedTermIdsArb,
        fc.boolean(),
        (termId, revealedTermIds, marked) => {
          const state = deriveCellState(termId, revealedTermIds, markedSetFor(termId, marked))

          if (marked) {
            // Marked -> MARKED regardless of revealedTermIds (Req 16.1)
            expect(state).toBe('MARKED')
          } else if (revealedTermIds.includes(termId)) {
            // Not marked and has been called -> AVAILABLE (Req 14.1)
            expect(state).toBe('AVAILABLE')
          } else {
            // Not marked and never called -> LOCKED (Req 14.2, 14.3)
            expect(state).toBe('LOCKED')
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('never returns LOCKED when the term is marked, regardless of revealedTermIds', () => {
    fc.assert(
      fc.property(termIdArb, revealedTermIdsArb, (termId, revealedTermIds) => {
        expect(deriveCellState(termId, revealedTermIds, new Set([termId]))).toBe('MARKED')
      }),
      { numRuns: 200 },
    )
  })

  it('metamorphic: a term that was called, got marked, then is superseded by later calls still reports MARKED', () => {
    fc.assert(
      fc.property(termIdArb, termIdArb, (termId, laterTermId) => {
        const markedTermIds = new Set([termId])

        // While it was the only call (or even if it never was), once marked it's MARKED.
        expect(deriveCellState(termId, [termId], markedTermIds)).toBe('MARKED')

        // After the game calls another term, the earlier marked term is still MARKED (Req 16.1).
        expect(deriveCellState(termId, [termId, laterTermId], markedTermIds)).toBe('MARKED')
      }),
      { numRuns: 200 },
    )
  })

  it('metamorphic: a term stays AVAILABLE (not LOCKED) once called, even after other terms are called afterward', () => {
    fc.assert(
      fc.property(
        termIdArb,
        fc.array(termIdArb, { maxLength: 8 }),
        (termId, laterCalls) => {
          const markedTermIds = new Set<string>()
          const revealedTermIds = [termId, ...laterCalls]

          // termId was called first; regardless of what's called after, it remains AVAILABLE.
          expect(deriveCellState(termId, revealedTermIds, markedTermIds)).toBe('AVAILABLE')
        },
      ),
      { numRuns: 200 },
    )
  })

  it('a term never present in revealedTermIds is always LOCKED while unmarked', () => {
    fc.assert(
      fc.property(termIdArb, revealedTermIdsArb, (termId, revealedTermIds) => {
        fc.pre(!revealedTermIds.includes(termId))
        expect(deriveCellState(termId, revealedTermIds, new Set<string>())).toBe('LOCKED')
      }),
      { numRuns: 200 },
    )
  })

  it('does not mutate its inputs', () => {
    fc.assert(
      fc.property(
        termIdArb,
        revealedTermIdsArb,
        fc.boolean(),
        (termId, revealedTermIds, marked) => {
          const markedTermIds = markedSetFor(termId, marked)
          const snapshot = new Set(markedTermIds)
          const revealedSnapshot = [...revealedTermIds]
          deriveCellState(termId, revealedTermIds, markedTermIds)
          expect(markedTermIds).toEqual(snapshot)
          expect(revealedTermIds).toEqual(revealedSnapshot)
        },
      ),
      { numRuns: 100 },
    )
  })
})
