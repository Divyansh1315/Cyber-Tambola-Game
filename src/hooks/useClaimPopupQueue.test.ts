import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import fc from 'fast-check'

import { deriveActivePopup, useClaimPopupQueue, type PrizeStatusEntry } from './useClaimPopupQueue'
import { PRIZES } from '../utils/prizeEngine'
import type { PrizeId } from '../types/prize'
import type { PlayerClaimStatus } from '../utils/winnerEngine'

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

/**
 * Arbitrary list of (prizeId, status) pairs covering all five PrizeIds, in
 * PRIZES order, each with an independently-generated status.
 */
const prizeStatusesArb: fc.Arbitrary<PrizeStatusEntry[]> = fc
  .tuple(...PRIZE_IDS.map(() => statusArb))
  .map((statuses) =>
    PRIZE_IDS.map((prizeId, i) => ({ prizeId, status: statuses[i] })),
  )

/** Arbitrary subset of PrizeIds, used as a dismissed-set. */
const dismissedSetArb: fc.Arbitrary<ReadonlySet<PrizeId>> = fc
  .subarray([...PRIZE_IDS])
  .map((arr) => new Set(arr))

/** Arbitrary "currently shown" value: a real PrizeId or undefined. */
const currentlyShownArb: fc.Arbitrary<PrizeId | undefined> = fc.option(
  fc.constantFrom(...PRIZE_IDS),
  { nil: undefined },
)

describe('useClaimPopupQueue.deriveActivePopup', () => {
  // Feature: player-ux-improvements, Property 1: Exactly one eligible-and-not-dismissed prize's popup is shown, in PRIZES order
  it('property 1: returns undefined or a poppable prizeId, and falls back to the first eligible, not-dismissed prize in PRIZES order', () => {
    fc.assert(
      fc.property(
        prizeStatusesArb,
        dismissedSetArb,
        currentlyShownArb,
        (prizeStatuses, dismissedThisSession, currentlyShown) => {
          const result = deriveActivePopup(
            prizeStatuses,
            dismissedThisSession,
            currentlyShown,
          )

          if (result === undefined) {
            // No eligible, not-dismissed prize should exist in this case,
            // unless the "keep showing current" branch applied and
            // currentlyShown was itself undefined.
            const current = prizeStatuses.find((p) => p.prizeId === currentlyShown)
            const keptCurrent =
              current !== undefined &&
              (current.status === 'ELIGIBLE' ||
                current.status === 'PENDING' ||
                current.status === 'REJECTED')
            if (!keptCurrent) {
              const anyEligibleNotDismissed = prizeStatuses.some(
                (p) => p.status === 'ELIGIBLE' && !dismissedThisSession.has(p.prizeId),
              )
              expect(anyEligibleNotDismissed).toBe(false)
            }
            return
          }

          const resultEntry = prizeStatuses.find((p) => p.prizeId === result)
          expect(resultEntry).toBeDefined()
          expect(['ELIGIBLE', 'PENDING', 'REJECTED']).toContain(resultEntry!.status)

          // If the result is not the kept "currentlyShown", it must be the
          // first ELIGIBLE, not-dismissed prize in PRIZES order.
          const current = prizeStatuses.find((p) => p.prizeId === currentlyShown)
          const keptCurrent =
            current !== undefined &&
            (current.status === 'ELIGIBLE' ||
              current.status === 'PENDING' ||
              current.status === 'REJECTED')

          if (!(keptCurrent && result === currentlyShown)) {
            const expectedFirst = prizeStatuses.find(
              (p) => p.status === 'ELIGIBLE' && !dismissedThisSession.has(p.prizeId),
            )?.prizeId
            expect(result).toBe(expectedFirst)
          }
        },
      ),
      { numRuns: RUNS },
    )
  })

  // Feature: player-ux-improvements, Property 3: Closing the current popup advances to the next still-eligible queued prize, or to none
  it('property 3: once the currently-shown prize is closed, the next call returns the next eligible not-dismissed prize in PRIZES order, or undefined', () => {
    fc.assert(
      fc.property(prizeStatusesArb, dismissedSetArb, (prizeStatuses, dismissedThisSession) => {
        // Build a scenario where at least one prize is ELIGIBLE and shown.
        const eligibleEntries = prizeStatuses.filter(
          (p) => p.status === 'ELIGIBLE' && !dismissedThisSession.has(p.prizeId),
        )
        fc.pre(eligibleEntries.length > 0)

        const shown = eligibleEntries[0].prizeId

        // Simulate closing the popup: change that prize's status away from
        // ELIGIBLE/PENDING/REJECTED (e.g. to CONFIRMED), leaving everything
        // else untouched.
        const afterClose: PrizeStatusEntry[] = prizeStatuses.map((p) =>
          p.prizeId === shown ? { ...p, status: 'CONFIRMED' as PlayerClaimStatus } : p,
        )

        const result = deriveActivePopup(afterClose, dismissedThisSession, shown)

        const expectedNext = afterClose.find(
          (p) => p.status === 'ELIGIBLE' && !dismissedThisSession.has(p.prizeId),
        )?.prizeId

        expect(result).toBe(expectedNext)
      }),
      { numRuns: RUNS },
    )
  })

  // Feature: player-ux-improvements, Property 4: Dismissing an eligible popup suppresses it for the rest of the session but never touches other prizes or the manual claim card
  it('property 4: dismissing an eligible prize suppresses only that prize, leaving other eligible prizes selectable', () => {
    fc.assert(
      fc.property(prizeStatusesArb, (prizeStatuses) => {
        const eligibleEntries = prizeStatuses.filter((p) => p.status === 'ELIGIBLE')
        fc.pre(eligibleEntries.length > 0)

        const dismissedPrizeId = eligibleEntries[0].prizeId
        const dismissedThisSession = new Set<PrizeId>([dismissedPrizeId])

        // The dismissed prize, still ELIGIBLE and still dismissed, should
        // never be returned when it is not the "currentlyShown" one.
        const result = deriveActivePopup(prizeStatuses, dismissedThisSession, undefined)
        expect(result).not.toBe(dismissedPrizeId)

        // Any other independently-eligible prize is unaffected: if there is
        // another eligible, not-dismissed prize, it (the first such one in
        // order) is still selectable.
        const otherEligible = prizeStatuses.find(
          (p) => p.status === 'ELIGIBLE' && !dismissedThisSession.has(p.prizeId),
        )
        if (otherEligible) {
          expect(result).toBe(otherEligible.prizeId)
        } else {
          expect(result).toBeUndefined()
        }
      }),
      { numRuns: RUNS },
    )
  })
})

/**
 * Arbitrary sequence of prizeStatuses "snapshots" (one per simulated
 * render), each snapshot being an arbitrary status for every PrizeId.
 */
const statusSequenceArb: fc.Arbitrary<PrizeStatusEntry[][]> = fc.array(
  fc.tuple(...PRIZE_IDS.map(() => statusArb)).map((statuses) =>
    PRIZE_IDS.map((prizeId, i) => ({ prizeId, status: statuses[i] })),
  ),
  { minLength: 1, maxLength: 8 },
)

describe('useClaimPopupQueue (hook wrapper)', () => {
  // Feature: player-ux-improvements, Property 2: Popup and Celebration overlay are mutually exclusive
  it('property 2: activePopupPrizeId and pendingCelebrationPrizeId are never both defined, across any sequence of status-list snapshots', () => {
    fc.assert(
      fc.property(statusSequenceArb, (snapshots) => {
        const { result, rerender } = renderHook(
          ({ prizeStatuses }: { prizeStatuses: PrizeStatusEntry[] }) =>
            useClaimPopupQueue({ prizeStatuses }),
          { initialProps: { prizeStatuses: snapshots[0] } },
        )

        const assertMutualExclusion = () => {
          const { activePopupPrizeId, pendingCelebrationPrizeId } = result.current
          const bothDefined =
            activePopupPrizeId !== undefined && pendingCelebrationPrizeId !== undefined
          expect(bothDefined).toBe(false)
        }

        assertMutualExclusion()

        for (let i = 1; i < snapshots.length; i++) {
          act(() => {
            rerender({ prizeStatuses: snapshots[i] })
          })
          assertMutualExclusion()
        }
      }),
      { numRuns: RUNS },
    )
  })

  // Feature: player-ux-improvements, Property 5: A CONFIRMED transition is flagged for celebration exactly once
  it('property 5: flags a prizeId as pendingCelebrationPrizeId exactly on the render where it first transitions to CONFIRMED, and does not re-flag it while it remains CONFIRMED', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PRIZE_IDS),
        fc.integer({ min: 2, max: 6 }),
        (targetPrizeId, confirmAtIndex) => {
          // Build a deterministic sequence: targetPrizeId starts at a
          // non-CONFIRMED status, transitions to CONFIRMED at
          // `confirmAtIndex`, and stays CONFIRMED for the remaining
          // snapshots. All other prizes stay NOT_ELIGIBLE throughout so
          // they never interfere with the flag under test.
          const totalSnapshots = confirmAtIndex + 3
          const snapshots: PrizeStatusEntry[][] = []
          for (let i = 0; i < totalSnapshots; i++) {
            const targetStatus: PlayerClaimStatus = i < confirmAtIndex ? 'ELIGIBLE' : 'CONFIRMED'
            snapshots.push(
              PRIZE_IDS.map((prizeId) => ({
                prizeId,
                status: prizeId === targetPrizeId ? targetStatus : 'NOT_ELIGIBLE',
              })),
            )
          }

          const { result, rerender } = renderHook(
            ({ prizeStatuses }: { prizeStatuses: PrizeStatusEntry[] }) =>
              useClaimPopupQueue({ prizeStatuses }),
            { initialProps: { prizeStatuses: snapshots[0] } },
          )

          for (let i = 1; i < snapshots.length; i++) {
            act(() => {
              rerender({ prizeStatuses: snapshots[i] })
            })

            if (i === confirmAtIndex) {
              // First render where the transition to CONFIRMED is observed.
              expect(result.current.pendingCelebrationPrizeId).toBe(targetPrizeId)
            } else if (i > confirmAtIndex) {
              // Status remains CONFIRMED on subsequent renders: must not be
              // re-flagged (it was already flagged once at confirmAtIndex
              // and nothing has acknowledged/cleared it since, so it simply
              // stays as-is rather than being set again).
              expect(result.current.pendingCelebrationPrizeId).toBe(targetPrizeId)
            }
          }

          // Acknowledging clears the flag, and staying CONFIRMED afterwards
          // never re-flags it (a prize cannot leave CONFIRMED).
          act(() => {
            result.current.acknowledgeCelebration(targetPrizeId)
          })
          expect(result.current.pendingCelebrationPrizeId).toBeUndefined()

          act(() => {
            rerender({ prizeStatuses: snapshots[snapshots.length - 1] })
          })
          expect(result.current.pendingCelebrationPrizeId).toBeUndefined()
        },
      ),
      { numRuns: RUNS },
    )
  })
})
