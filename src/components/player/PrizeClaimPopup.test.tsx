import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import fc from 'fast-check'

import { PrizeClaimPopup } from './PrizeClaimPopup'
import { PRIZES } from '../../utils/prizeEngine'
import type { PrizeId, PrizeProgress } from '../../types/prize'
import type { PlayerClaimStatus } from '../../utils/winnerEngine'

const RUNS = 100

const PRIZE_IDS: readonly PrizeId[] = PRIZES.map((p) => p.id)

const STATUSES: readonly PlayerClaimStatus[] = [
  'NOT_ELIGIBLE',
  'ELIGIBLE',
  'PENDING',
  'CONFIRMED',
  'REJECTED',
  'CLOSED_BY_OTHER_WINNER',
]

const statusArb: fc.Arbitrary<PlayerClaimStatus> = fc.constantFrom(...STATUSES)

const progressArb: fc.Arbitrary<PrizeProgress> = fc
  .record({
    prizeIndex: fc.integer({ min: 0, max: PRIZE_IDS.length - 1 }),
    current: fc.integer({ min: 0, max: 10 }),
    target: fc.integer({ min: 1, max: 10 }),
  })
  .map(({ prizeIndex, current, target }) => {
    const prize = PRIZES[prizeIndex]
    return { id: prize.id, label: prize.label, current, target }
  })

const viewArb = fc.record({
  message: fc.string({ minLength: 0, maxLength: 40 }),
  buttonLabel: fc.string({ minLength: 1, maxLength: 20 }),
  buttonDisabled: fc.boolean(),
})

describe('PrizeClaimPopup', () => {
  // Feature: player-ux-improvements, Property 6: Popup content and button state are a pure function of status, progress, and submission flag
  it('property 6: title equals progress.label, message equals view.message verbatim, button disabled iff view.buttonDisabled || isSubmitting', () => {
    fc.assert(
      fc.property(
        progressArb,
        statusArb,
        viewArb,
        fc.boolean(),
        (progress, status, view, isSubmitting) => {
          const { unmount, getByRole } = render(
            <PrizeClaimPopup
              progress={progress}
              status={status}
              view={view}
              isSubmitting={isSubmitting}
              onClaim={() => {}}
              onDismiss={() => {}}
              sessionGuardFailed={false}
            />,
          )

          try {
            expect(getByRole('heading', { level: 2 })).toHaveTextContent(progress.label)

            const messageEl = getByRole('status')
            expect(messageEl.textContent).toBe(view.message)

            const button = getByRole('button')
            const expectedDisabled = view.buttonDisabled || isSubmitting
            expect(button.hasAttribute('disabled')).toBe(expectedDisabled)
          } finally {
            unmount()
          }
        },
      ),
      { numRuns: RUNS },
    )
  })

  // Feature: player-ux-improvements, Property 7: Claiming always dispatches the exact existing action shape, exactly once per enabled click
  it('property 7: activating the button while enabled calls onClaim exactly once per click; while disabled, never calls onClaim', () => {
    fc.assert(
      fc.property(
        progressArb,
        statusArb,
        viewArb,
        fc.boolean(),
        (progress, status, view, isSubmitting) => {
          const onClaim = vi.fn()
          const { unmount, getByRole } = render(
            <PrizeClaimPopup
              progress={progress}
              status={status}
              view={view}
              isSubmitting={isSubmitting}
              onClaim={onClaim}
              onDismiss={() => {}}
              sessionGuardFailed={false}
            />,
          )

          try {
            const button = getByRole('button')
            const disabled = view.buttonDisabled || isSubmitting

            fireEvent.click(button)

            if (disabled) {
              expect(onClaim).not.toHaveBeenCalled()
            } else {
              expect(onClaim).toHaveBeenCalledTimes(1)
            }
          } finally {
            unmount()
          }
        },
      ),
      { numRuns: RUNS },
    )
  })

  // Unit test for the session-guard-failed branch (task 6.3)
  it('renders the refresh message/button instead of the claim button when sessionGuardFailed is true', () => {
    const progress: PrizeProgress = { id: 'CYBER_FIVE', label: 'Cyber Five', current: 5, target: 5 }
    const onClaim = vi.fn()

    render(
      <PrizeClaimPopup
        progress={progress}
        status="ELIGIBLE"
        view={{ message: '🎉 Cyber Five Ready!', buttonLabel: 'Claim Cyber Five', buttonDisabled: false }}
        isSubmitting={false}
        onClaim={onClaim}
        onDismiss={() => {}}
        sessionGuardFailed
      />,
    )

    expect(
      screen.getByText('Your session is out of date. Please refresh or rejoin to continue.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /claim cyber five/i })).not.toBeInTheDocument()
  })
})
