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

- [x] 15. Fix the Diagonal Strike color (Requirement 10)
  - [x] 15.1 Update `src/components/player/Ticket.css`
    - Change `.ticket-cell--marked::after`'s `background` from `var(--color-accent-strong)` to `var(--color-ink)`
    - No other property on the rule changes; no new CSS variable is introduced; the selector remains scoped to `.ticket-cell--marked::after` only
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x]* 15.2 Regression-check the Diagonal Strike's existing presence/absence test
    - File `src/components/player/TicketCell.test.tsx` (existing): confirm Property 8's existing assertions (presence iff `MARKED`) still pass unchanged, since they assert the class, not the color; if any existing assertion hardcodes the old `--color-accent-strong` value, update it to `--color-ink`
    - _Requirements: 10.1_

- [x] 16. Checkpoint — Diagonal Strike color fix passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Tune the Celebration effect (Requirement 11)
  - [x] 17.1 Update `src/components/player/CelebrationOverlay.tsx` and `CelebrationOverlay.css`
    - Change `CONFETTI_COUNT` from `24` to `56`; leave `CELEBRATION_DURATION_MS` unchanged
    - In `CelebrationOverlay.css`, update `.celebration-overlay__piece`'s `width`/`height` from `8px`/`14px` to `10px`/`16px`, and its `animation` duration from `1.8s` to `1.6s`
    - Replace the 2-color `:nth-child(3n)`/`:nth-child(3n + 1)` rules with 4-color `:nth-child(4n)`/`:nth-child(4n + 1)`/`:nth-child(4n + 2)`/`:nth-child(4n + 3)` rules using `var(--color-primary)`, `var(--color-warning)`, `var(--color-accent)`, `var(--color-danger)` respectively
    - Do not change the trigger condition in `useClaimPopupQueue`, the auto-dismiss `useEffect`/cleanup, or the `reducedMotion` branch
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x]* 17.2 Update the confetti-count test
    - File `src/components/player/CelebrationOverlay.test.tsx` (extended): update/add an assertion that rendering with `reducedMotion={false}` produces exactly `56` `.celebration-overlay__piece` elements
    - Confirm the existing trigger/dismiss/cleanup/reduced-motion tests pass unchanged
    - _Requirements: 11.1_

- [x] 18. Checkpoint — Celebration tuning passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 19. Implement `getAwardedCellTermIds` in `prizeEngine.ts` (Requirement 12, part 1)
  - [x] 19.1 Export `LINE_PRIZE_ROWS` and add `getAwardedCellTermIds`
    - Add the `export` keyword to the existing private `LINE_PRIZE_ROWS` const; no change to its three existing key/value pairs
    - Add `Winner` to the existing `Prize, PrizeProgress` import from `../types/prize`
    - Add the new exported pure function `getAwardedCellTermIds(ticket: Ticket, winners: readonly Winner[], playerId: string, gameId: string): Set<string>` per design.md's Addendum section 1, including the `FIXED_PATTERN_PRIZE_IDS` const (`FIREWALL_LINE`, `SECURITY_LINE`, `DATA_DEFENDER_LINE`, `CYBER_FULL_HOUSE` — `CYBER_FIVE` excluded)
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.7, 12.8_

  - [x]* 19.2 Write property test for Property 10
    - File `src/utils/prizeEngine.test.ts` (extended); tag `// Feature: player-ux-improvements, Property 10: {title}`; ≥100 iterations
    - **Property 10: A termId is awarded if and only if it belongs to a Fixed_Pattern_Prize's fixed cell set for which this exact player+game has a Winner** — Validates Requirements 12.1, 12.2, 12.4
    - _Requirements: 12.1, 12.2, 12.4_

  - [x]* 19.3 Write property test for Property 11
    - File `src/utils/prizeEngine.test.ts` (extended); tag `// Feature: player-ux-improvements, Property 11: {title}`; ≥100 iterations
    - **Property 11: CYBER_FIVE never contributes termIds** — Validates Requirements 12.3
    - _Requirements: 12.3_

  - [x]* 19.4 Write property test for Property 12
    - File `src/utils/prizeEngine.test.ts` (extended); tag `// Feature: player-ux-improvements, Property 12: {title}`; ≥100 iterations
    - **Property 12: A Winner for a different player or a different game never contributes termIds** — Validates Requirements 12.4, 12.5
    - _Requirements: 12.4, 12.5_

  - [x]* 19.5 Write property test for Property 13
    - File `src/utils/prizeEngine.test.ts` (extended); tag `// Feature: player-ux-improvements, Property 13: {title}`; ≥100 iterations
    - **Property 13: Overlapping awarded cell sets de-duplicate via Set semantics** — Validates Requirements 12.7
    - _Requirements: 12.7_

- [x] 20. Checkpoint — `getAwardedCellTermIds` passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 21. Thread the Awarded Cell CSS hook through `TicketCell`/`Ticket` (Requirement 12, part 2)
  - [x] 21.1 Add the two new state-color tokens to `src/styles/global.css`
    - Append `--state-awarded-bg: #cbd5e1;` and `--state-awarded-ink: #334155;` to the existing "State colors for ticket / status" block, following its existing `--state-{name}-bg`/`--state-{name}-ink` naming convention
    - _Requirements: 12.9_

  - [x] 21.2 Add the `.ticket-cell--awarded` rule to `src/components/player/Ticket.css`
    - Add `.ticket-cell--awarded { background: var(--state-awarded-bg); border-color: var(--state-awarded-ink); color: var(--state-awarded-ink); }`, positioned after `.ticket-cell--marked` in source order so it wins the cascade on specificity-equal overlap
    - _Requirements: 12.6, 12.8, 12.9_

  - [x] 21.3 Add the `isAwarded` prop to `src/components/player/TicketCell.tsx`
    - Add optional `isAwarded?: boolean` (default `false`) to `TicketCellProps`
    - Add `isAwarded ? 'ticket-cell--awarded' : ''` additively to the existing className array; no other change to markup, `onToggle`, `aria-label`, or `aria-pressed`
    - _Requirements: 12.6, 12.8_

  - [x] 21.4 Add the `awardedTermIds` prop to `src/components/player/Ticket.tsx`
    - Add `awardedTermIds: ReadonlySet<string>` to `TicketProps`
    - Pass `isAwarded={awardedTermIds.has(cell.termId)}` to each rendered `<TicketCell>`
    - _Requirements: 12.1, 12.6_

  - [x]* 21.5 Write property test for Property 14
    - File `src/components/player/TicketCell.test.tsx` (extended); tag `// Feature: player-ux-improvements, Property 14: {title}`; ≥100 iterations
    - **Property 14: The awarded CSS hook is present if and only if `isAwarded` is true, additively alongside the existing marked hook** — Validates Requirements 12.8
    - _Requirements: 12.8_

  - [x]* 21.6 Write the CSS-cascade regression unit test
    - File `src/components/player/TicketCell.test.tsx` (extended): render `TicketCell` with `cell.state === 'MARKED'` and `isAwarded={true}`, assert via `getComputedStyle` that the resolved `background` matches `--state-awarded-bg`, not `--state-marked-bg`
    - _Requirements: 12.6, 12.9_

- [x] 22. Checkpoint — Awarded Cell CSS hook passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 23. Wire `awardedTermIds` into `PlayerGame.tsx` (Requirement 12, part 3)
  - [x] 23.1 Compute and pass `awardedTermIds` in `src/pages/PlayerGame/PlayerGame.tsx`
    - Add `const awardedTermIds = useMemo(() => currentTicket ? getAwardedCellTermIds(currentTicket, state.winners, currentPlayer?.id ?? '', state.game.id) : new Set<string>(), [currentTicket, state.winners, currentPlayer, state.game.id])`, placed after the existing redirect guard alongside the existing `prizeBlocks` derivation
    - Pass `awardedTermIds={awardedTermIds}` to the existing `<Ticket>` element; make no other change to `PlayerGame.tsx`'s existing logic, state, or JSX ordering
    - _Requirements: 12.1, 12.4, 12.10_

  - [x]* 23.2 Write unit test: MARKED cell in a CONFIRMED prize's cell set renders `ticket-cell--awarded`
    - File `src/pages/PlayerGame/PlayerGame.test.tsx` (extended): render `PlayerGame` with a `Winner` record for the current player/game for one line prize, assert that line's `MARKED` ticket cells render `ticket-cell--awarded`
    - _Requirements: 12.1, 12.6_

  - [x]* 23.3 Write unit test: multi-prize overlap renders awarded on every cell
    - File `src/pages/PlayerGame/PlayerGame.test.tsx` (extended): render `PlayerGame` with `Winner` records for both a line prize and `CYBER_FULL_HOUSE` for the current player/game, assert every ticket cell renders `ticket-cell--awarded`, not just the full-house-exclusive ones
    - _Requirements: 12.7_

  - [x]* 23.4 Write unit test: `CLOSED_BY_OTHER_WINNER` prize does not award the current player
    - File `src/pages/PlayerGame/PlayerGame.test.tsx` (extended): render `PlayerGame` with a `Winner` record whose status is `CLOSED_BY_OTHER_WINNER`/whose `playerId` differs from the current player for one prize, assert that prize's cells do NOT render `ticket-cell--awarded` for the current player
    - _Requirements: 12.4, 12.5_

- [x] 24. Checkpoint — `PlayerGame.tsx` wiring passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 25. Final checkpoint — Requirements 10-12 full regression pass
  - Run the full test suite (`npm test` / `vitest run`) and confirm all tests pass
  - Run the production build (`npm run build`) and confirm zero TypeScript errors
  - Confirm no existing test file for the reducer, `winnerEngine.ts`, or the existing "Claim Your Prizes" card's rendering was modified, and that tasks 1-14's existing tests still pass unchanged
  - Ask the user if questions arise
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 11.4, 11.5, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses for traceability.
- Checkpoints (tasks 3, 5, 7, 9, 11, 13, 16, 18, 20, 22, 24, 25) ensure incremental validation as `Modal`, the queue-derivation logic, `PrizeClaimPopup`, `CelebrationOverlay`, the Diagonal Strike, the full `PlayerGame.tsx` wiring, and (for Requirements 10-12) the color fix, celebration tuning, `getAwardedCellTermIds`, the Awarded Cell CSS hook, and its `PlayerGame.tsx` wiring come together.
- Property tests validate the 9 universal correctness properties from `design.md`'s original Correctness Properties section plus Properties 10-14 from its Addendum; each test is tagged `// Feature: player-ux-improvements, Property {n}: {title}` and runs ≥100 iterations using `fast-check` (already a devDependency).
- The following requirements/acceptance criteria from `design.md`'s Testing Strategy are explicitly **not** covered by automated tests and are called out as required manual/visual review before merge: Requirements 5.3, 5.4, 7.1, 7.2, 7.3, 7.4 (diagonal-strike legibility and layout fit at mobile widths), 11.1 (the visual "firecracker" feel of the tuned celebration effect), and 12.9 (final visual confirmation of the awarded-cell grey background's legibility at real device widths), consistent with design.md's "Not covered by automated tests" sections.
- Requirement 9.1 (branch creation) is handled by task 1 and is the only operational/non-code task in this plan.
- Requirements 10-12 (tasks 15-25) are post-implementation refinements building on the already-shipped Requirements 1-9 (tasks 1-14); they touch no ticket generation, reveal, marking, prize-eligibility, claim-validation, sync, reconnect, or host-control logic.

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
    { "id": 7, "tasks": ["12.2", "12.3"] },
    { "id": 8, "tasks": ["15.1", "17.1", "19.1"] },
    { "id": 9, "tasks": ["15.2", "17.2", "19.2", "19.3", "19.4", "19.5", "21.1"] },
    { "id": 10, "tasks": ["21.2", "21.3", "21.4"] },
    { "id": 11, "tasks": ["21.5", "21.6"] },
    { "id": 12, "tasks": ["23.1"] },
    { "id": 13, "tasks": ["23.2", "23.3", "23.4"] }
  ]
}
```
