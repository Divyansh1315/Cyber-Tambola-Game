import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { deriveCellState } from './deriveCellState'

// Feature: module-4-term-marking-prize-engine, Property 4: Cell state is derived solely from reveal history and valid marks
//
// Property 4: Cell state is derived solely from reveal history and valid marks
// For any termId, revealedTermIds list, and set of Marked_Term_Ids:
//   - LOCKED when termId is absent from revealedTermIds (regardless of markedTermIds)
//   - AVAILABLE when present and absent from markedTermIds
//   - MARKED when present and present in markedTermIds
// Metamorphic: adding termId to revealedTermIds flips that cell from LOCKED to
// (AVAILABLE or MARKED) and does not change unrelated termIds' results.
//
// **Validates: Requirements 4.1, 4.2, 4.3**

/** A small alphabet of term ids so overlaps between the cell and the list occur. */
const termIdArb = fc.constantFrom('t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8')
const revealedArb = fc.array(termIdArb, { maxLength: 8 })

/** Build a markedTermIds set that either does or does not contain termId. */
function markedSetFor(termId: string, marked: boolean): ReadonlySet<string> {
  return marked ? new Set([termId]) : new Set<string>()
}

describe('deriveCellState (property 4)', () => {
  it('yields AVAILABLE/LOCKED/MARKED strictly from presence + marked', () => {
    fc.assert(
      fc.property(termIdArb, revealedArb, fc.boolean(), (termId, revealed, marked) => {
        const state = deriveCellState(termId, revealed, markedSetFor(termId, marked))
        const present = revealed.includes(termId)

        if (!present) {
          // Absent -> LOCKED regardless of marked (Req 4.1)
          expect(state).toBe('LOCKED')
        } else if (marked) {
          // Present and marked -> MARKED only (Req 4.3)
          expect(state).toBe('MARKED')
        } else {
          // Present and not marked -> AVAILABLE (Req 4.2)
          expect(state).toBe('AVAILABLE')
        }
      }),
      { numRuns: 200 },
    )
  })

  it('never returns MARKED when the term is absent, regardless of marked', () => {
    fc.assert(
      fc.property(termIdArb, revealedArb, fc.boolean(), (termId, revealed, marked) => {
        const withoutTerm = revealed.filter((id) => id !== termId)
        expect(deriveCellState(termId, withoutTerm, markedSetFor(termId, marked))).toBe('LOCKED')
      }),
      { numRuns: 200 },
    )
  })

  it('metamorphic: revealing a term flips that cell from LOCKED and leaves unrelated cells unchanged', () => {
    fc.assert(
      fc.property(
        termIdArb,
        revealedArb,
        fc.boolean(),
        fc.array(termIdArb, { maxLength: 8 }),
        (termId, revealed, marked, otherTermIds) => {
          // Start from a history that definitely lacks termId.
          const before = revealed.filter((id) => id !== termId)
          const after = [...before, termId]
          const markedTermIds = markedSetFor(termId, marked)

          // The affected cell starts LOCKED and, once revealed, is no longer LOCKED.
          expect(deriveCellState(termId, before, markedTermIds)).toBe('LOCKED')
          const afterState = deriveCellState(termId, after, markedTermIds)
          expect(afterState).not.toBe('LOCKED')
          expect(afterState).toBe(marked ? 'MARKED' : 'AVAILABLE')

          // Unrelated cells (any id other than the one we revealed) are unchanged.
          for (const other of otherTermIds) {
            if (other === termId) continue
            expect(deriveCellState(other, after, markedTermIds)).toBe(
              deriveCellState(other, before, markedTermIds),
            )
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('does not mutate its inputs', () => {
    fc.assert(
      fc.property(termIdArb, revealedArb, fc.boolean(), (termId, revealed, marked) => {
        const snapshot = [...revealed]
        Object.freeze(revealed)
        // Must not throw (would throw on write to a frozen array) and must not mutate.
        deriveCellState(termId, revealed, markedSetFor(termId, marked))
        expect([...revealed]).toEqual(snapshot)
      }),
      { numRuns: 100 },
    )
  })
})
