# Implementation Plan: Player UX Improvements

## Overview

This plan builds the feature in the dependency order design.md already implies:
branch setup first, then the generic `Modal` primitive (nothing else depends on
anything but this), then the pure `deriveActivePopup` queue-derivation logic and
its hook wrapper (tested in isolation before any component touches it), then
`PrizeClaimPopup` (built on `Modal`, wired to the queue hook's output), then
`CelebrationOverlay` (independent of `Modal`, driven by the same queue hook),
then the additive `TicketCell`/`Ticket.css` diagonal-strike CSS hook (fully
independent of the popup/celebration work), then `PlayerGame.tsx` wiring that
assembles all of the above, and finally the cross-cutting error-handling branch
and manual-review checklist called out in design.md's Testing Strategy.

Property-based tests (fast-check, already a devDependency) and unit/example
tests are written immediately alongside each component's implementation task,
not deferred to the end, per design.md's Testing Strategy. Each property test
is tagged `// Feature: player-ux-improvements, Property {n}: {title}` and runs
≥100 iterations. Test invocation uses the single-run form (`vitest run` / `npm
test`), never watch mode.

Scope is limited to exactly the files/components design.md names: the new
`Modal`, `useClaimPopupQueue`/`deriveActivePopup`, `PrizeClaimPopup`,
`CelebrationOverlay`, and the modified `TicketCell.tsx`/`Ticket.css` and
`PlayerGame.tsx`. No other file is touched.

## Tasks

- [x] 1. Create the feature branch
  - Create and check out a new git branch named `feature/player-ux-improvements` from the branch currently checked out
  - _Requirements: 9.1_

- [x] 2. Build the generic `Modal` primitive
  - [x] 2.1 Implement `src/components/common/Modal.tsx` and `Modal.css`
    - `ModalProps`: `open`, `onDismiss?`, `dismissable = true`, `'aria-label'`, `children`
    - Render nothing when `open` is false; otherwise render a fixed backdrop + bottom-sheet panel (`max-width: 460px`, matching `.player__inner`) with `role="dialog"` and `aria-modal="true"`
    - Wire backdrop-tap/Esc dismissal to `onDismiss` only when `dismissable` is true; render no close affordance when `dismissable` is false
    - Follow the existing per-component CSS file convention (`Button.css`, `Card.css`)
    - _Requirements: 7.1, 7.2_

  - [x]* 2.2 Write unit tests for `Modal`
    - File `src/components/common/Modal.test.tsx` (new)
    - Assert nothing renders when `open={false}`; assert `role="dialog"`/`aria-modal="true"` present when `open={true}`
    - Assert backdrop-tap and Esc call `onDismiss` only when `dismissable` is true, and do nothing when `dismissable` is false
    - _Requirements: 7.1, 7.2_

- [x] 3. Checkpoint — `Modal` passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement the pure popup-queue derivation logic
  - [x] 4.1 Implement `deriveActivePopup` in `src/hooks/useClaimPopupQueue.ts`
    - Pure function: `(prizeStatuses, dismissedThisSession, currentlyShown) => PrizeId | undefined`
    - Step 1: if `currentlyShown`'s status is `ELIGIBLE`/`PENDING`/`REJECTED`, keep returning it
    - Step 2: otherwise return the first prize in `prizeStatuses`' own order whose status is `ELIGIBLE` and not in `dismissedThisSession`
    - _Requirements: 1.1, 3.1, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4_

  - [x]* 4.2 Write property tests for `deriveActivePopup`
    - File `src/hooks/useClaimPopupQueue.test.ts` (new); tag `// Feature: player-ux-improvements, Property {n}: {title}`; ≥100 iterations
    - **Property 1: Exactly one eligible-and-not-dismissed prize's popup is shown, in PRIZES order** — Validates Requirements 1.1, 3.1, 3.4, 4.1, 4.2, 4.3
    - **Property 3: Closing the current popup advances to the next still-eligible queued prize, or to none** — Validates Requirements 3.3
    - **Property 4: Dismissing an eligible popup suppresses it for the rest of the session but never touches other prizes or the manual claim card** — Validates Requirements 4.4
    - _Requirements: 1.1, 3.1, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4_

  - [x] 4.3 Implement the celebration-transition tracking and `useClaimPopupQueue` hook wrapper
    - Internal state shape per design.md's `ClaimPopupQueueState`: `dismissedThisSession: Set<PrizeId>`, `currentlyShown`, `previousStatuses: Map<PrizeId, PlayerClaimStatus>`, `pendingCelebrationPrizeId`
    - On each input change, detect a fresh transition into `CONFIRMED` (previous status was not `CONFIRMED`, new status is `CONFIRMED`) and set `pendingCelebrationPrizeId`; do not re-flag while it remains `CONFIRMED`
    - Expose `activePopupPrizeId` (via `deriveActivePopup`), `dismissActivePopup`, `pendingCelebrationPrizeId`, `acknowledgeCelebration`
    - All state is in-memory only (`useState`/`useReducer`); never written to `localStorage`/`sessionStorage`
    - _Requirements: 2.3, 3.2, 4.4, 4.5, 6.1, 6.2_

  - [x]* 4.4 Write property tests for the `useClaimPopupQueue` hook wrapper
    - File `src/hooks/useClaimPopupQueue.test.ts` (extended); use `@testing-library/react`'s `renderHook`; tag `// Feature: player-ux-improvements, Property {n}: {title}`; ≥100 iterations
    - **Property 2: Popup and Celebration overlay are mutually exclusive** — Validates Requirements 3.2
    - **Property 5: A CONFIRMED transition is flagged for celebration exactly once** — Validates Requirements 2.3, 6.1, 6.2
    - _Requirements: 2.3, 3.2, 6.1, 6.2_

- [x] 5. Checkpoint — queue-derivation logic passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement `PrizeClaimPopup`
  - [x] 6.1 Implement `src/components/player/PrizeClaimPopup.tsx`
    - Props per design.md: `progress`, `status`, `view`, `isSubmitting`, `onClaim`, `onDismiss`
    - Render inside `Modal`; title = `progress.label`; body message = `view.message` verbatim
    - Primary button label = `isSubmitting ? 'Submitting Claim...' : view.buttonLabel`; `disabled={view.buttonDisabled || isSubmitting}`; `onClick` calls `onClaim` exactly once per click and never when disabled
    - `Modal`'s `dismissable` is `true` only while `status === 'ELIGIBLE'`; `false` while `PENDING`/submitting
    - Add the session-guard-failed branch: when a `sessionGuardFailed` prop (passed from `PlayerGame.tsx`'s existing `lastSessionGuardFailure` check) is true, render the same "session out of date, refresh" message/button in place of the claim button
    - _Requirements: 1.2, 1.3, 1.4, 2.1, 2.2, 2.4, 2.5, 2.6_

  - [x]* 6.2 Write property tests for `PrizeClaimPopup`
    - File `src/components/player/PrizeClaimPopup.test.tsx` (new); tag `// Feature: player-ux-improvements, Property {n}: {title}`; ≥100 iterations
    - **Property 6: Popup content and button state are a pure function of status, progress, and submission flag** — Validates Requirements 1.2, 2.1, 2.4, 2.6
    - **Property 7: Claiming always dispatches the exact existing action shape, exactly once per enabled click** — Validates Requirements 1.3, 2.2
    - _Requirements: 1.2, 1.3, 2.1, 2.2, 2.4, 2.6_

  - [x]* 6.3 Write unit test for the session-guard-failed branch
    - File `src/components/player/PrizeClaimPopup.test.tsx` (extended): one fixed scenario rendering `PrizeClaimPopup` with `sessionGuardFailed=true` and asserting the refresh message/button renders instead of the claim button
    - _Requirements: 2.4_

- [x] 7. Checkpoint — `PrizeClaimPopup` passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement `CelebrationOverlay`
  - [x] 8.1 Implement `src/components/player/CelebrationOverlay.tsx` and its CSS
    - Props: `prizeLabel`, `onDismiss`, `reducedMotion?` (defaults to reading `matchMedia('(prefers-reduced-motion: reduce)').matches`, guarded with `typeof window.matchMedia === 'function'` and defaulting to `false` if absent)
    - Animated branch: dependency-free CSS-only confetti (fixed count of staggered `<span>`s with `@keyframes`) layered over a "🏆 {prizeLabel} confirmed!" message
    - Reduced-motion branch: identical message, no animated spans
    - `useEffect` with `setTimeout(onDismiss, CELEBRATION_DURATION_MS)` (e.g. 3000ms constant), cleared on unmount
    - Decorative confetti spans use `pointer-events: none`; overlay does not cover the full ticket so the cells beneath remain tappable
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 6.7_

  - [x]* 8.2 Write property test for `CelebrationOverlay`
    - File `src/components/player/CelebrationOverlay.test.tsx` (new); tag `// Feature: player-ux-improvements, Property 9: {title}`; ≥100 iterations
    - **Property 9: Celebration overlay shows identical confirmed-win information under both motion preferences** — Validates Requirements 6.6
    - _Requirements: 6.6_

  - [x]* 8.3 Write unit tests for auto-dismiss timing and DOM cleanup
    - File `src/components/player/CelebrationOverlay.test.tsx` (extended): mount with `vi.useFakeTimers()`, advance exactly `CELEBRATION_DURATION_MS`, assert `onDismiss` fired
    - Mount via a conditional-render wrapper (mirroring how `PlayerGame.tsx` will mount it) and assert the overlay's container is removed from the DOM once `onDismiss`-driven unmount occurs
    - _Requirements: 6.3, 6.5_

- [x] 9. Checkpoint — `CelebrationOverlay` passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Add the Diagonal Strike CSS hook to `TicketCell`
  - [x] 10.1 Update `src/components/player/Ticket.css`
    - Add `position: relative` to `.ticket-cell--marked`
    - Add a `.ticket-cell--marked::after` pseudo-element: `content: ''`, `position: absolute`, `left: 6%`, `right: 6%`, `top: 50%`, `height: 2px`, `background: var(--color-accent-strong)`, `transform: translateY(-50%) rotate(-18deg)`, `pointer-events: none`
    - No change to `TicketCell.tsx` markup; no new props
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 7.3_

  - [x]* 10.2 Write property test for the Diagonal Strike CSS hook
    - File `src/components/player/TicketCell.test.tsx` (extended); tag `// Feature: player-ux-improvements, Property 8: {title}`; ≥100 iterations
    - **Property 8: The diagonal strike CSS hook is present if and only if the cell is MARKED, and term text is always preserved** — Validates Requirements 5.1, 5.2, 5.5
    - _Requirements: 5.1, 5.2, 5.5_

- [x] 11. Checkpoint — Diagonal Strike passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Wire everything together in `PlayerGame.tsx`
  - [x] 12.1 Add `useClaimPopupQueue` wiring to `src/pages/PlayerGame/PlayerGame.tsx`
    - Call `useClaimPopupQueue({ prizeStatuses: prizeBlocks.map((b) => ({ prizeId: b.progress.id, status: b.status })) })`
    - Derive `activeBlock` from `popupQueue.activePopupPrizeId` and `celebratingBlock` from `popupQueue.pendingCelebrationPrizeId` against the existing `prizeBlocks`
    - Render at most one `<PrizeClaimPopup>` for `activeBlock`, wired to that block's existing `progress`/`status`/`view`/`isSubmitting`, the existing `dispatch({ type: 'SUBMIT_PRIZE_CLAIM', playerId: currentPlayer.id, ticketId: currentTicket.id, prizeId: progress.id })` call, `popupQueue.dismissActivePopup`, and the existing `lastSessionGuardFailure`-derived `sessionGuardFailed` boolean
    - Render at most one `<CelebrationOverlay>` for `celebratingBlock`, wired to `popupQueue.acknowledgeCelebration(celebratingBlock.progress.id)`
    - Render both as siblings after the existing "Claim Your Prizes" card's JSX in source order; make no other change to `PlayerGame.tsx`'s existing logic, state, or `prizeBlocks` derivation
    - _Requirements: 1.1, 1.5, 2.3, 2.5, 3.1, 3.2, 4.1, 4.2, 4.3, 4.5, 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x]* 12.2 Write unit tests for ticket/prize-card usability while a popup or overlay is open
    - File `src/pages/PlayerGame/PlayerGame.test.tsx` (extended or new): render `PlayerGame` with a popup open, fire one tap on a `TicketCell`, assert the tap's mark dispatch still fires
    - Render with a popup open, assert the existing "Claim Your Prizes" card is still present and unaffected for prizes not shown in the popup
    - Render with the overlay open, assert ticket cells remain tappable
    - _Requirements: 1.5, 2.7, 6.4_

  - [x]* 12.3 Write integration test for end-to-end popup → claim → celebration flow
    - File `src/pages/PlayerGame/PlayerGame.test.tsx` (extended): drive `prizeBlocks` status from `ELIGIBLE` → `PENDING` → `CONFIRMED` across re-renders and assert the popup appears, shows the loading state, closes, and the celebration overlay appears exactly once
    - Drive a second scenario from `ELIGIBLE` → `REJECTED` and assert the rejection message renders and the button re-enables when status returns to `ELIGIBLE`
    - Drive a third scenario with two prizes becoming `ELIGIBLE` at once and assert only one popup renders at a time, in `PRIZES` order
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.6, 3.1, 3.3, 3.4_

- [x] 13. Checkpoint — full feature integration passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Final verification pass
  - Run the full test suite (`npm test` / `vitest run`) and confirm all tests pass
  - Run the production build (`npm run build`) and confirm zero TypeScript errors
  - Confirm no existing test file for `prizeEngine.ts`, `winnerEngine.ts`, the reducer, or the existing "Claim Your Prizes" card's rendering was modified
  - Ask the user if questions arise
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses for traceability.
- Checkpoints (tasks 3, 5, 7, 9, 11, 13) ensure incremental validation as `Modal`, the queue-derivation logic, `PrizeClaimPopup`, `CelebrationOverlay`, the Diagonal Strike, and the full `PlayerGame.tsx` wiring come together.
- Property tests validate the 9 universal correctness properties from `design.md`; each test is tagged `// Feature: player-ux-improvements, Property {n}: {title}` and runs ≥100 iterations using `fast-check` (already a devDependency).
- The following requirements/acceptance criteria from `design.md`'s Testing Strategy are explicitly **not** covered by automated tests and are called out as required manual/visual review before merge: Requirements 5.3, 5.4, 7.1, 7.2, 7.3, 7.4 (diagonal-strike legibility and layout fit at mobile widths), consistent with design.md's "Not covered by automated tests" section.
- Requirement 9.1 (branch creation) is handled by task 1 and is the only operational/non-code task in this plan.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "4.1", "10.1"] },
    { "id": 2, "tasks": ["2.2", "4.2", "4.3", "10.2"] },
    { "id": 3, "tasks": ["4.4"] },
    { "id": 4, "tasks": ["6.1", "8.1"] },
    { "id": 5, "tasks": ["6.2", "6.3", "8.2", "8.3"] },
    { "id": 6, "tasks": ["12.1"] },
    { "id": 7, "tasks": ["12.2", "12.3"] }
  ]
}
```
