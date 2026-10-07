// Feature: ticket-3x4-dimension-refactor — property and example tests for TicketCell
import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'
import { render, cleanup } from '@testing-library/react'
import type { TicketCell as TicketCellData, TicketCellState } from '../../types/game'
import { TicketCell } from './TicketCell'

const STATE_ARB: fc.Arbitrary<TicketCellState> = fc.constantFrom('LOCKED', 'AVAILABLE', 'MARKED')
const TERM_ID_ARB = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim().length > 0)
const TERM_ARB = fc.constantFrom(
  'Phishing',
  'Malware',
  'Social Engineering',
  'Data Classification',
  'Firewall',
  'Ransomware',
)

function buildCell(termId: string, term: string, state: TicketCellState): TicketCellData {
  return { termId, term, state, row: 0, col: 0 }
}

describe('TicketCell', () => {
  // Feature: ticket-3x4-dimension-refactor, Property 7: Unmarked cells never render a lock
  // icon or state text, regardless of internal state
  //
  // For any termId/term and any UNMARKED internal state (LOCKED or AVAILABLE), rendering
  // TicketCell produces no icon element and no visible "Locked"/"Available"/"Marked" text
  // anywhere in the rendered output.
  //
  // **Validates: Requirements 10.1, 10.2, 11.1**
  it('Property 7: unmarked cells never render a lock icon or visible state text', () => {
    fc.assert(
      fc.property(
        TERM_ID_ARB,
        TERM_ARB,
        fc.constantFrom<TicketCellState>('LOCKED', 'AVAILABLE'),
        (termId, term, state) => {
          const cell = buildCell(termId, term, state)
          const onToggle = vi.fn()
          const { container, unmount } = render(<TicketCell cell={cell} onToggle={onToggle} />)

          try {
            // No icon element rendered at all for unmarked cells.
            expect(container.querySelector('.ticket-cell__icon')).toBeNull()

            // No visible "Locked"/"Available"/"Marked" text node anywhere in the DOM.
            const visibleText = container.textContent ?? ''
            expect(visibleText).not.toMatch(/Locked/)
            expect(visibleText).not.toMatch(/Available/)
            expect(visibleText).not.toMatch(/Marked/)
          } finally {
            unmount()
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  // Feature: ticket-3x4-dimension-refactor, Property 8: LOCKED and AVAILABLE are visually and
  // semantically identical
  //
  // For any termId/term, rendering TicketCell with state LOCKED vs AVAILABLE (holding
  // termId/term fixed) produces: the same className, the same aria-label, the same
  // aria-pressed value, and the cell is never disabled.
  //
  // **Validates: Requirements 13.1, 13.4, 13.5**
  it('Property 8: LOCKED and AVAILABLE render identical className, aria-label, aria-pressed, and are never disabled', () => {
    fc.assert(
      fc.property(TERM_ID_ARB, TERM_ARB, (termId, term) => {
        const onToggle = vi.fn()

        const lockedRender = render(
          <TicketCell cell={buildCell(termId, term, 'LOCKED')} onToggle={onToggle} />,
        )
        const lockedButton = lockedRender.container.querySelector('button') as HTMLButtonElement
        const lockedClassName = lockedButton.className
        const lockedAriaLabel = lockedButton.getAttribute('aria-label')
        const lockedAriaPressed = lockedButton.getAttribute('aria-pressed')
        const lockedDisabled = lockedButton.disabled
        lockedRender.unmount()

        const availableRender = render(
          <TicketCell cell={buildCell(termId, term, 'AVAILABLE')} onToggle={onToggle} />,
        )
        const availableButton = availableRender.container.querySelector(
          'button',
        ) as HTMLButtonElement
        const availableClassName = availableButton.className
        const availableAriaLabel = availableButton.getAttribute('aria-label')
        const availableAriaPressed = availableButton.getAttribute('aria-pressed')
        const availableDisabled = availableButton.disabled
        availableRender.unmount()

        expect(lockedClassName).toBe(availableClassName)
        expect(lockedAriaLabel).toBe(availableAriaLabel)
        expect(lockedAriaPressed).toBe(availableAriaPressed)
        expect(lockedAriaPressed).toBe('false')
        expect(lockedDisabled).toBe(false)
        expect(availableDisabled).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  // Feature: ticket-3x4-dimension-refactor, Property 9: Accessible state attributes always
  // reflect the current state
  //
  // For any termId/term/state, aria-pressed is 'true' iff state === 'MARKED', and the
  // aria-label always contains the term text. Re-rendering with a new state (e.g. a
  // simulated transition) updates both attributes immediately without remounting.
  //
  // **Validates: Requirements 11.5, 11.6**
  it('Property 9: aria-pressed and aria-label always reflect the current state, including after a transition', () => {
    fc.assert(
      fc.property(TERM_ID_ARB, TERM_ARB, STATE_ARB, STATE_ARB, (termId, term, fromState, toState) => {
        const onToggle = vi.fn()
        const cell = buildCell(termId, term, fromState)
        const { container, rerender, unmount } = render(
          <TicketCell cell={cell} onToggle={onToggle} />,
        )

        try {
          const button = container.querySelector('button') as HTMLButtonElement
          expect(button.getAttribute('aria-pressed')).toBe(String(fromState === 'MARKED'))
          expect(button.getAttribute('aria-label')).toContain(term)

          rerender(<TicketCell cell={buildCell(termId, term, toState)} onToggle={onToggle} />)

          expect(button.getAttribute('aria-pressed')).toBe(String(toState === 'MARKED'))
          expect(button.getAttribute('aria-label')).toContain(term)
        } finally {
          unmount()
        }
      }),
      { numRuns: 100 },
    )
  })

  describe('example tests', () => {
    it('renders a checkmark icon only when MARKED', () => {
      const onToggle = vi.fn()
      const { container } = render(
        <TicketCell cell={buildCell('t1', 'Phishing', 'MARKED')} onToggle={onToggle} />,
      )
      const icon = container.querySelector('.ticket-cell__icon')
      expect(icon).not.toBeNull()
      expect(icon?.textContent).toBe('✓')
      cleanup()
    })

    it('applies ticket-cell--unmarked className for both LOCKED and AVAILABLE', () => {
      const onToggle = vi.fn()
      const lockedRender = render(
        <TicketCell cell={buildCell('t1', 'Phishing', 'LOCKED')} onToggle={onToggle} />,
      )
      expect(lockedRender.container.querySelector('button')).toHaveClass('ticket-cell--unmarked')
      lockedRender.unmount()

      const availableRender = render(
        <TicketCell cell={buildCell('t1', 'Phishing', 'AVAILABLE')} onToggle={onToggle} />,
      )
      expect(availableRender.container.querySelector('button')).toHaveClass(
        'ticket-cell--unmarked',
      )
      availableRender.unmount()
    })

    it('applies ticket-cell--marked className when MARKED', () => {
      const onToggle = vi.fn()
      const { container } = render(
        <TicketCell cell={buildCell('t1', 'Phishing', 'MARKED')} onToggle={onToggle} />,
      )
      expect(container.querySelector('button')).toHaveClass('ticket-cell--marked')
      expect(container.querySelector('button')).not.toHaveClass('ticket-cell--unmarked')
    })

    it('remains enabled (not disabled) while LOCKED', () => {
      const onToggle = vi.fn()
      const { container } = render(
        <TicketCell cell={buildCell('t1', 'Phishing', 'LOCKED')} onToggle={onToggle} />,
      )
      expect(container.querySelector('button')).not.toBeDisabled()
    })

    it('invokes onToggle with the cell termId when clicked', () => {
      const onToggle = vi.fn()
      const { container } = render(
        <TicketCell cell={buildCell('term-42', 'Phishing', 'AVAILABLE')} onToggle={onToggle} />,
      )
      const button = container.querySelector('button') as HTMLButtonElement
      button.click()
      expect(onToggle).toHaveBeenCalledWith('term-42')
    })
  })
})
