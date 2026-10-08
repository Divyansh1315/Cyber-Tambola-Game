import { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import fc from 'fast-check'
import { render, cleanup, act } from '@testing-library/react'

import { CelebrationOverlay, CELEBRATION_DURATION_MS } from './CelebrationOverlay'

const RUNS = 100

afterEach(() => {
  cleanup()
})

// Feature: player-ux-improvements, Property 9: Celebration overlay shows identical confirmed-win information under both motion preferences
describe('CelebrationOverlay - Property 9 (identical confirmed-win information under both motion preferences)', () => {
  it('renders the prizeLabel confirmed-win message in both branches, and renders confetti iff reducedMotion is false', () => {
    fc.assert(
      fc.property(fc.string(), fc.boolean(), (prizeLabel, reducedMotion) => {
        const { container, unmount } = render(
          <CelebrationOverlay
            prizeLabel={prizeLabel}
            onDismiss={() => {}}
            reducedMotion={reducedMotion}
          />,
        )

        const message = container.querySelector('.celebration-overlay__message')
        expect(message).not.toBeNull()
        expect(message!.textContent).toBe(`🏆 ${prizeLabel} confirmed!`)

        const confetti = container.querySelectorAll('.celebration-overlay__piece')
        if (reducedMotion) {
          expect(confetti.length).toBe(0)
        } else {
          expect(confetti.length).toBeGreaterThan(0)
        }

        unmount()
      }),
      { numRuns: RUNS },
    )
  })
})

describe('CelebrationOverlay - auto-dismiss timing and DOM cleanup', () => {
  it('calls onDismiss exactly once after CELEBRATION_DURATION_MS', () => {
    vi.useFakeTimers()
    try {
      const onDismiss = vi.fn()
      render(<CelebrationOverlay prizeLabel="Cyber Five" onDismiss={onDismiss} reducedMotion />)

      expect(onDismiss).not.toHaveBeenCalled()
      vi.advanceTimersByTime(CELEBRATION_DURATION_MS)
      expect(onDismiss).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes the overlay container from the DOM once onDismiss-driven unmount occurs', () => {
    vi.useFakeTimers()
    try {
      function Wrapper() {
        const [show, setShow] = useState(true)
        return show ? (
          <CelebrationOverlay
            prizeLabel="Cyber Five"
            onDismiss={() => setShow(false)}
            reducedMotion
          />
        ) : null
      }

      const { container } = render(<Wrapper />)
      expect(container.querySelector('.celebration-overlay')).not.toBeNull()

      act(() => {
        vi.advanceTimersByTime(CELEBRATION_DURATION_MS)
      })

      expect(container.querySelector('.celebration-overlay')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
