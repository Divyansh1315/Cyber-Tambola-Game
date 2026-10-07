import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { deriveCellState } from './deriveCellState'

// Feature: ticket-3x4-dimension-refactor, Property: Cell state is derived solely from the
// current term and valid marks
//
// For any termId, currentTermId, and set of Marked_Term_Ids:
//   - MARKED when termId is present in markedTermIds (checked first, regardless of currentTermId)
//   - AVAILABLE when absent from markedTermIds and termId === currentTermId
//   - LOCKED when absent from markedTermIds and termId !== currentTermId
// Metamorphic: a term that was current, got marked, and is no longer current still
// reports MARKED, never LOCKED (marks are permanent, Req 16.1).
//
// **Validates: Requirements 13.5, 14.1, 14.3, 16.1**

/** A small alphabet of term ids so overlaps between the cell and currentTermId occur. */
const termIdArb = fc.constantFrom('t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8')
const currentTermIdArb = fc.option(termIdArb, { nil: undefined })

/** Build a markedTermIds set that either does or does not contain termId. */
function markedSetFor(termId: string, marked: boolean): ReadonlySet<string> {
  return marked ? new Set([termId]) : new Set<string>()
}

describe('deriveCellState (current-term rule)', () => {
  it('yields MARKED/AVAILABLE/LOCKED strictly from marked + current-term equality', () => {
    fc.assert(
      fc.property(termIdArb, currentTermIdArb, fc.boolean(), (termId, currentTermId, marked) => {
        const state = deriveCellState(termId, currentTermId, markedSetFor(termId, marked))

        if (marked) {
          // Marked -> MARKED regardless of currentTermId (Req 16.1)
          expect(state).toBe('MARKED')
        } else if (termId === currentTermId) {
          // Not marked and is the current term -> AVAILABLE (Req 14.1)
          expect(state).toBe('AVAILABLE')
        } else {
          // Not marked and not the current term -> LOCKED (Req 14.2, 14.3)
          expect(state).toBe('LOCKED')
        }
      }),
      { numRuns: 200 },
    )
  })

  it('never returns LOCKED when the term is marked, regardless of currentTermId', () => {
    fc.assert(
      fc.property(termIdArb, currentTermIdArb, (termId, currentTermId) => {
        expect(deriveCellState(termId, currentTermId, new Set([termId]))).toBe('MARKED')
      }),
      { numRuns: 200 },
    )
  })

  it('metamorphic: a term that was current, got marked, then stops being current still reports MARKED', () => {
    fc.assert(
      fc.property(termIdArb, termIdArb, (termId, nextCurrentTermId) => {
        const markedTermIds = new Set([termId])

        // While it was current (or even if it never was), once marked it's MARKED.
        expect(deriveCellState(termId, termId, markedTermIds)).toBe('MARKED')

        // After the game moves on to a different current term, still MARKED (Req 16.1).
        expect(deriveCellState(termId, nextCurrentTermId, markedTermIds)).toBe('MARKED')
      }),
      { numRuns: 200 },
    )
  })

  it('metamorphic: changing currentTermId does not affect unrelated unmarked cells unless they become current', () => {
    fc.assert(
      fc.property(
        termIdArb,
        currentTermIdArb,
        currentTermIdArb,
        fc.array(termIdArb, { maxLength: 8 }),
        (termId, before, after, otherTermIds) => {
          const markedTermIds = new Set<string>()

          for (const other of otherTermIds) {
            if (other === termId || other === before || other === after) continue
            // An unmarked term that is neither the before nor after current term stays LOCKED.
            expect(deriveCellState(other, before, markedTermIds)).toBe('LOCKED')
            expect(deriveCellState(other, after, markedTermIds)).toBe('LOCKED')
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('does not mutate its inputs', () => {
    fc.assert(
      fc.property(termIdArb, currentTermIdArb, fc.boolean(), (termId, currentTermId, marked) => {
        const markedTermIds = markedSetFor(termId, marked)
        const snapshot = new Set(markedTermIds)
        deriveCellState(termId, currentTermId, markedTermIds)
        expect(markedTermIds).toEqual(snapshot)
      }),
      { numRuns: 100 },
    )
  })
})
