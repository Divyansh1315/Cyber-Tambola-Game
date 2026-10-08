import { useRef, useState } from 'react'

import type { PrizeId } from '../types/prize'
import type { PlayerClaimStatus } from '../utils/winnerEngine'

/** One entry per prize, in the exact order getAllPrizeProgress() already returns (Req 3.4). */
export interface PrizeStatusEntry {
  prizeId: PrizeId
  status: PlayerClaimStatus
}

export interface ClaimPopupQueueInput {
  /** One entry per prize, in the exact order getAllPrizeProgress() already returns (Req 3.4). */
  prizeStatuses: readonly PrizeStatusEntry[]
}

export interface ClaimPopupQueueResult {
  /** The single Prize_Id whose popup should be visible right now, or undefined (Req 3.1, 3.2). */
  activePopupPrizeId: PrizeId | undefined
  /** Call when the player explicitly dismisses the currently-active popup while it is ELIGIBLE (Req 4.4). */
  dismissActivePopup: () => void
  /** The Prize_Id that just transitioned into CONFIRMED and has not yet had its Celebration_Overlay shown (Req 2.3, 6.1). Cleared via acknowledgeCelebration. */
  pendingCelebrationPrizeId: PrizeId | undefined
  acknowledgeCelebration: (prizeId: PrizeId) => void
}

/**
 * Pure derivation of which single prize's popup (if any) should be visible
 * right now, given the live per-prize statuses, the set of prizes the
 * player has explicitly dismissed this session while ELIGIBLE, and the
 * prizeId currently being shown (if any).
 *
 * Step 1: if `currentlyShown`'s status is still "poppable" (ELIGIBLE,
 * PENDING, or REJECTED), keep showing it — this is what lets the
 * loading/rejected states render in place rather than the popup flickering
 * to a different prize mid-submission.
 *
 * Step 2: otherwise, return the first prize in `prizeStatuses`' own order
 * (already PRIZES order per Req 3.4) whose status is ELIGIBLE and which is
 * not in `dismissedThisSession`.
 *
 * Validates: Requirements 1.1, 3.1, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4
 */
export function deriveActivePopup(
  prizeStatuses: readonly PrizeStatusEntry[],
  dismissedThisSession: ReadonlySet<PrizeId>,
  currentlyShown: PrizeId | undefined,
): PrizeId | undefined {
  const current = prizeStatuses.find((p) => p.prizeId === currentlyShown)
  if (
    current &&
    (current.status === 'ELIGIBLE' ||
      current.status === 'PENDING' ||
      current.status === 'REJECTED')
  ) {
    return currentlyShown
  }

  return prizeStatuses.find(
    (p) => p.status === 'ELIGIBLE' && !dismissedThisSession.has(p.prizeId),
  )?.prizeId
}

/**
 * Stateful wrapper around `deriveActivePopup`, plus celebration-transition
 * tracking, per design.md's `ClaimPopupQueueState`.
 *
 * All state (the dismissed-set, the currently-shown prize, the previous
 * statuses snapshot, and the pending-celebration prize) is held in-memory
 * only via `useState`/`useRef` — nothing is ever written to `localStorage`
 * or `sessionStorage` (Req 4.5), so it resets on every mount.
 *
 * Validates: Requirements 2.3, 3.2, 4.4, 4.5, 6.1, 6.2
 */
export function useClaimPopupQueue(input: ClaimPopupQueueInput): ClaimPopupQueueResult {
  const { prizeStatuses } = input

  const [dismissedThisSession, setDismissedThisSession] = useState<Set<PrizeId>>(
    () => new Set(),
  )
  const [currentlyShown, setCurrentlyShown] = useState<PrizeId | undefined>(undefined)
  const [pendingCelebrationPrizeId, setPendingCelebrationPrizeId] = useState<
    PrizeId | undefined
  >(undefined)

  // The previous render's status-per-prize snapshot, used only to detect a
  // fresh transition into CONFIRMED. A ref (not state) since updating it
  // must never itself trigger a re-render.
  const previousStatusesRef = useRef<Map<PrizeId, PlayerClaimStatus>>(new Map())

  const activePopupPrizeId = deriveActivePopup(
    prizeStatuses,
    dismissedThisSession,
    currentlyShown,
  )
  if (activePopupPrizeId !== currentlyShown) {
    setCurrentlyShown(activePopupPrizeId)
  }

  // Detect fresh transitions into CONFIRMED: previous status was not
  // CONFIRMED, new status is CONFIRMED. Flags at most one new prize per
  // render pass; does not re-flag a prize that stays CONFIRMED across
  // subsequent renders.
  const previousStatuses = previousStatusesRef.current
  let freshlyConfirmed: PrizeId | undefined
  for (const entry of prizeStatuses) {
    const prev = previousStatuses.get(entry.prizeId)
    if (entry.status === 'CONFIRMED' && prev !== 'CONFIRMED') {
      freshlyConfirmed = entry.prizeId
      break
    }
  }

  const nextPreviousStatuses = new Map<PrizeId, PlayerClaimStatus>()
  for (const entry of prizeStatuses) {
    nextPreviousStatuses.set(entry.prizeId, entry.status)
  }
  previousStatusesRef.current = nextPreviousStatuses

  if (freshlyConfirmed !== undefined && freshlyConfirmed !== pendingCelebrationPrizeId) {
    setPendingCelebrationPrizeId(freshlyConfirmed)
  }

  // A Celebration_Overlay for one prize and a Prize_Claim_Popup for a
  // different, independently-ELIGIBLE prize can be derived in the very
  // same render (e.g. two prizes complete at once). Req 3.2 requires the
  // two surfaces never overlap, so the celebration takes priority: the
  // popup is suppressed (not cancelled — `currentlyShown` is left as-is)
  // until the celebration is acknowledged, at which point it reappears.
  const effectiveActivePopupPrizeId =
    pendingCelebrationPrizeId !== undefined ? undefined : activePopupPrizeId

  const dismissActivePopup = () => {
    if (currentlyShown === undefined) return
    setDismissedThisSession((prev) => {
      const next = new Set(prev)
      next.add(currentlyShown)
      return next
    })
    setCurrentlyShown(undefined)
  }

  const acknowledgeCelebration = (prizeId: PrizeId) => {
    setPendingCelebrationPrizeId((current) => (current === prizeId ? undefined : current))
  }

  return {
    activePopupPrizeId: effectiveActivePopupPrizeId,
    dismissActivePopup,
    pendingCelebrationPrizeId,
    acknowledgeCelebration,
  }
}
