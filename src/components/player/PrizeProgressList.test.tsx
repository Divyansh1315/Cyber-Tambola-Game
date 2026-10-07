// Feature: ticket-3x4-dimension-refactor, Property 18: Prize progress percentage rendering matches round(current/target*100), and is skipped for a zero/undefined target
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { render } from '@testing-library/react'

import { PrizeProgressList } from './PrizeProgressList'
import type { PrizeId, PrizeProgress } from '../../types/prize'

const RUNS = 100

// Realistic in-production prize targets (Req 25.1-25.3): Cyber Five = 5,
// each Line Prize = 4 (TICKET_COLUMNS), Cyber Full House = 12 (TICKET_SIZE).
const PRIZE_FIXTURES: { id: PrizeId; label: string; target: number }[] = [
  { id: 'CYBER_FIVE', label: 'Cyber Five', target: 5 },
  { id: 'FIREWALL_LINE', label: 'Firewall Line', target: 4 },
  { id: 'SECURITY_LINE', label: 'Security Line', target: 4 },
  { id: 'DATA_DEFENDER_LINE', label: 'Data Defender Line', target: 4 },
  { id: 'CYBER_FULL_HOUSE', label: 'Cyber Full House', target: 12 },
]

/** Builds a PrizeProgress arbitrary for a fixed prize fixture, with `current` ranging from 0 to a bit beyond its target. */
function prizeProgressArb(fixture: { id: PrizeId; label: string; target: number }): fc.Arbitrary<PrizeProgress> {
  return fc.record({
    id: fc.constant(fixture.id),
    label: fc.constant(fixture.label),
    target: fc.constant(fixture.target),
    current: fc.integer({ min: 0, max: fixture.target + 2 }),
  })
}

/** Reads the rendered fill-bar width percentage (as a number) for the nth prize item. */
function readFillWidthPercent(container: HTMLElement, index: number): number {
  const items = container.querySelectorAll('.prize-progress__item')
  const fill = items[index]?.querySelector('.prize-progress__fill') as HTMLElement
  const width = fill.style.width // e.g. "40%"
  return Number(width.replace('%', ''))
}

describe('PrizeProgressList - Property 18 (percentage rendering)', () => {
  it('renders width/percentage equal to round(current/target*100) for Cyber Five (target 5), each Line Prize (target 4), and Cyber Full House (target 12)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PRIZE_FIXTURES).chain((fixture) => prizeProgressArb(fixture)),
        (prize) => {
          const { container } = render(<PrizeProgressList items={[prize]} />)

          const expectedPct = Math.round((prize.current / prize.target) * 100)
          const renderedPct = readFillWidthPercent(container, 0)

          expect(renderedPct).toBe(expectedPct)
        },
      ),
      { numRuns: RUNS },
    )
  })

  it('independently computes each prize\'s percentage against its own target when multiple prizes are rendered together', () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(fc.constantFrom(...PRIZE_FIXTURES), {
            selector: (fixture) => fixture.id,
            minLength: 1,
            maxLength: PRIZE_FIXTURES.length,
          })
          .chain((fixtures) => fc.tuple(...fixtures.map((fixture) => prizeProgressArb(fixture)))),
        (prizes) => {
          const { container } = render(<PrizeProgressList items={prizes} />)

          prizes.forEach((prize, index) => {
            const expectedPct = Math.round((prize.current / prize.target) * 100)
            const renderedPct = readFillWidthPercent(container, index)
            expect(renderedPct).toBe(expectedPct)
          })
        },
      ),
      { numRuns: RUNS },
    )
  })
})

/*
 * KNOWN GAP (not covered above, flagged per task instructions rather than
 * silently patched): PrizeProgressList.tsx currently computes
 * `Math.round((prize.current / prize.target) * 100)` unconditionally, with
 * no guard for `target === 0` or `target === undefined`. Requirement 25.5
 * states the UI "SHALL NOT attempt to compute or display a percentage" in
 * that case, but today a zero target produces `NaN%`/`Infinity%` rendered
 * directly into the fill bar's inline `width` style. This realistic-only
 * test suite intentionally does not exercise that branch (all production
 * prize targets are always 4, 5, or 12 — never 0 or undefined) per this
 * task's instructions; a fix for Requirement 25.5 should be addressed as
 * its own change if desired.
 */
