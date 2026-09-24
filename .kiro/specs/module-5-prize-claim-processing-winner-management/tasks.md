# Implementation Plan: Module 5 — Prize Claim Processing & Winner Management

## Overview

This plan implements Module 5 in dependency order: the extended `PrizeClaim`/`Winner`
domain types, then the two new pure engines (`claimEngine.ts`'s `validatePrizeClaim`
and `winnerEngine.ts`'s lookup/derivation helpers), then the reducer's three new
actions (`SUBMIT_PRIZE_CLAIM`, `CONFIRM_CLAIM`, `REJECT_CLAIM`) and `SyncPayload`
extension, then the initial-state seed and removal of `mockClaims.ts`, then
persistence, then the context provider wiring, then UI rewiring across
`PlayerGame`, `HostDashboard`, and `PresentationView`, then cross-cutting
regression/integration tests, and finally a full build and verification pass.

The project already has Vitest, @testing-library/react, @testing-library/user-event,
@testing-library/jest-dom, and fast-check installed and wired from prior modules — no
test tooling setup is needed here. Test invocation uses the single-run form
(`vitest run` / `npm test`), never watch mode. Property-based tests reference the 18
correctness properties in `design.md` and tag each test with the feature name and
property number, exactly per the established convention.

## Tasks

- [x] 1. Extend the PrizeClaim and Winner domain types
  - [x] 1.1 Update `src/types/claim.ts`
    - Add `ValidationStatus` (`'PENDING' | 'VALID' | 'INVALID'`) and `HostDecision` (`'PENDING' | 'CONFIRMED' | 'REJECTED'`) type exports
    - Extend `PrizeClaim` with `gameId`, `playerId`, `ticketId`, `submittedAt`, `validationStatus`, `hostDecision`, optional `rejectionReason`, optional `decidedAt`, retaining the existing denormalized display fields (`prizeLabel`, `playerName`, `ticketRef`) and the deprecated optional `status`/`ClaimStatus` for backwards compatibility
    - _Requirements: 1.1, 1.2, 1.3, 1.6_

  - [x] 1.2 Update `src/types/prize.ts`
    - Extend `Winner` with `gameId`, `ticketId`, `claimId`, `confirmedAt`, retaining existing `id`/`prizeId`/`playerId`/`prizeLabel`/`playerName`
    - Re-export `ClaimStatus`, `PrizeClaim`, `ValidationStatus`, `HostDecision` from `./claim` so exactly one definition of each type exists
    - _Requirements: 1.4, 1.6_

  - [x] 1.3 Write unit test asserting the extended type shapes compile
    - Construct `PrizeClaim` and `Winner` literals with every Requirement 1.1/1.4 field present and assert they type-check and round-trip through a plain object equality check
    - _Requirements: 1.1, 1.4_

- [x] 2. Implement the pure Claim_Engine validation pipeline
  - [x] 2.1 Implement `src/utils/claimEngine.ts`
    - Export `ClaimValidationResult` union with reasons `GAME_NOT_FOUND`, `PLAYER_NOT_FOUND`, `PLAYER_NOT_IN_GAME`, `TICKET_NOT_FOUND`, `TICKET_NOT_OWNED_BY_PLAYER`, `PRIZE_NOT_FOUND`, `DUPLICATE_ACTIVE_CLAIM`, `RESUBMISSION_LIMIT_REACHED`, `PRIZE_CLOSED`, `NOT_ELIGIBLE`
    - Implement `validatePrizeClaim({game, player, ticket, marks, prizeId, winners, existingClaims})` running the ten gates in order, computing Prize_Eligible exclusively via `getPlayerTicketMarks`/`getAllPrizeProgress`/`isPrizeEligible` from `prizeEngine.ts` (never reimplementing prize-counting logic), and checking prize-closed via `isPrizeClosed` from `winnerEngine.ts`
    - Never mutate any input
    - _Requirements: 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 2.2 Write property test for the claim validation pipeline
    - File `src/utils/claimEngine.validatePrizeClaim.test.ts`; tag `// Feature: module-5-prize-claim-processing-winner-management, Property 1: {title}`; ≥100 iterations
    - **Property 1: The claim validation pipeline accepts iff every condition holds, and identifies the first failing reason otherwise** — Validates Requirements 2.4, 3.1, 3.2, 3.3, 3.4, 3.6, 4.1, 4.2, 4.3, 4.4
    - Use a claim-history generator producing sequences of prior claims for a single `(playerId, prizeId)` pair with controlled `hostDecision` distributions (none, one `PENDING`, one `CONFIRMED`, zero/one/two-plus `REJECTED`) to exercise the resubmission-budget gate precisely, plus reuse of ticket/marks generators for realistic `PrizeProgress` inputs
    - _Requirements: 2.4, 3.1, 3.2, 3.3, 3.4, 3.6, 4.1, 4.2, 4.3, 4.4_

- [x] 3. Implement the pure Winner_Engine lookup and derivation helpers
  - [x] 3.1 Implement `isPrizeClosed`, `getWinnerForPrize`, and `canConfirmClaim` in `src/utils/winnerEngine.ts`
    - `isPrizeClosed(winners, gameId, prizeId)` returns true exactly when a matching Winner record exists
    - `getWinnerForPrize(winners, gameId, prizeId)` returns the matching Winner or undefined
    - `canConfirmClaim(claim, winners)` returns true exactly when `validationStatus === 'VALID'`, `hostDecision === 'PENDING'`, and the prize is not closed
    - _Requirements: 5.1, 5.3, 8.1, 10.1, 11.1, 11.2, 11.3_

  - [x] 3.2 Write property tests for `isPrizeClosed` and `canConfirmClaim`
    - Files `src/utils/winnerEngine.isPrizeClosed.test.ts`, `src/utils/winnerEngine.canConfirmClaim.test.ts`; tag `// Feature: module-5-prize-claim-processing-winner-management, Property {n}: {title}`; ≥100 iterations
    - **Property 2: Prize-closed derivation and the at-most-one-winner invariant** — Validates Requirements 5.1, 5.2, 5.4, 5.5, 11.1
    - **Property 6: A confirm action is permitted exactly when the claim is valid, pending, and its prize is open** — Validates Requirements 8.1, 8.7, 8.8, 10.1, 11.3
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 8.1, 8.7, 8.8, 10.1, 11.1, 11.3_

  - [x] 3.3 Implement `getPlayerWinningPrizes`, `sortClaimsForInbox`, and `groupClaimsForHistory` in `src/utils/winnerEngine.ts`
    - `getPlayerWinningPrizes(winners, playerId)` returns the list of Prize_Ids for which that player has a confirmed Winner
    - `sortClaimsForInbox(claims)` sorts PENDING-first, then `submittedAt` ascending within each group, never mutating the input
    - `groupClaimsForHistory(claims)` partitions into `{pending, confirmed, rejectedOrInvalid}` where INVALID or REJECTED claims go to `rejectedOrInvalid`
    - _Requirements: 6.2, 7.4, 7.5, 10.2, 11.4_

  - [x] 3.4 Write property tests for sorting and grouping
    - Files `src/utils/winnerEngine.sortClaimsForInbox.test.ts`, `src/utils/winnerEngine.groupClaimsForHistory.test.ts`; tag `// Feature: module-5-prize-claim-processing-winner-management, Property {n}: {title}`; ≥100 iterations; reuse a shared claims-list generator with random `hostDecision`/`validationStatus`/`submittedAt` combinations
    - **Property 4: Claim inbox sorting is PENDING-first, then submission-time ascending** — Validates Requirements 6.2, 7.4
    - **Property 5: Claim history grouping is a lossless, non-overlapping partition** — Validates Requirements 7.5, 10.2
    - _Requirements: 6.2, 7.4, 7.5, 10.2_

  - [x] 3.5 Implement `derivePlayerClaimStatus` in `src/utils/winnerEngine.ts`
    - Export `PlayerClaimStatus` union with the six literals
    - Implement the precedence rules: winner for another player → `CLOSED_BY_OTHER_WINNER`; winner for this player → `CONFIRMED`; own latest claim `PENDING`/`REJECTED` → that status; otherwise `ELIGIBLE`/`NOT_ELIGIBLE` from `progress.current >= progress.target`
    - Total and unambiguous over every input combination
    - _Requirements: 12.1, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_

  - [x] 3.6 Write property test for `derivePlayerClaimStatus`
    - File `src/utils/winnerEngine.derivePlayerClaimStatus.test.ts`; tag `// Feature: module-5-prize-claim-processing-winner-management, Property 10: {title}`; ≥100 iterations; reuse ticket/marks generators for realistic `PrizeProgress` inputs
    - **Property 10: Player claim status is total, unambiguous, and reflects another player's win** — Validates Requirements 12.1, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8
    - _Requirements: 12.1, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_

- [x] 4. Checkpoint — pure engines pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Extend the reducer with claim/winner actions
  - [x] 5.1 Add `SUBMIT_PRIZE_CLAIM`, `CONFIRM_CLAIM`, `REJECT_CLAIM` to `src/state/gameSessionReducer.ts`
    - Add the three action types to the `GameSessionAction` union, carrying only `playerId`/`ticketId`/`prizeId` for submission (no eligibility flag) and `claimId` (plus optional `rejectionReason` for reject) for the host actions
    - `SUBMIT_PRIZE_CLAIM` case: call `validatePrizeClaim`; always append a new `PrizeClaim` (VALID/PENDING on success, INVALID/PENDING with the failure reason otherwise) and increment `rev`
    - `CONFIRM_CLAIM` case: no-op (same state reference) unless `canConfirmClaim` passes; otherwise set the claim's `hostDecision` to `CONFIRMED`/`decidedAt`, append exactly one new `Winner`, increment `rev`
    - `REJECT_CLAIM` case: no-op unless `hostDecision === 'PENDING'`; otherwise set `hostDecision` to `REJECTED`/`decidedAt`/`rejectionReason`, increment `rev`
    - Keep the reducer pure: no `localStorage`/`BroadcastChannel` access inside any of the three cases; reuse the existing `localId()`/`now()` helpers
    - _Requirements: 2.3, 2.4, 2.5, 3.3, 3.4, 6.1, 6.3, 6.4, 8.2, 8.3, 8.4, 8.6, 8.7, 8.8, 9.1, 9.2, 9.3, 9.4, 18.1, 18.2, 18.3, 18.4_

  - [x] 5.2 Write property tests for the three reducer actions and side-effect isolation
    - Files `src/state/gameSessionReducer.submitClaim.test.ts`, `gameSessionReducer.confirmClaim.test.ts`, `gameSessionReducer.rejectClaim.test.ts`; tag `// Feature: module-5-prize-claim-processing-winner-management, Property {n}: {title}`; ≥100 iterations; deep-freeze input state to enforce purity
    - **Property 3: Claims are only ever appended or selectively updated by id, never bulk-rewritten** — Validates Requirements 6.1, 6.3, 6.4
    - **Property 7: Confirming an eligible claim updates exactly that claim and creates exactly one well-formed Winner** — Validates Requirements 8.2, 8.3, 8.4
    - **Property 8: Rejecting a pending claim updates exactly that claim and never creates a Winner** — Validates Requirements 9.1, 9.2, 9.3, 9.4
    - **Property 9: Claim and winner actions never affect marks, tickets, players, currentPlayerId, or other prizes' progress** (parameterized over all three actions) — Validates Requirements 18.1, 18.2, 18.3, 18.4
    - _Requirements: 6.1, 6.3, 6.4, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 18.1, 18.2, 18.3, 18.4_

  - [x] 5.3 Extend `SyncPayload` and `SYNC_STATE` with `claims`/`winners`
    - Add `claims: PrizeClaim[]` and `winners: Winner[]` to the `SyncPayload` interface without adding them to `isValidSyncPayload`'s required shape check
    - Extract the shared `mergeById` helper from the existing inline `marks` merge and reuse it for `claims` and `winners`
    - In `SYNC_STATE`, default incoming `claims`/`winners` to `[]` when missing or not arrays, then merge by id; leave `currentPlayerId` untouched
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6_

  - [x] 5.4 Write property test for cross-tab sync of claims/winners
    - File `src/state/gameSessionReducer.syncState.claimsWinners.test.ts`; tag `// Feature: module-5-prize-claim-processing-winner-management, Property 17: {title}`; ≥100 iterations; reuse and extend the existing malformed-sync-payload generators with variants omitting `claims`/`winners` or setting them to `null`/non-array values
    - **Property 17: Cross-tab sync includes, losslessly merges, and safely defaults claims and winners without disturbing currentPlayerId** — Validates Requirements 17.2, 17.3, 17.4, 17.5, 17.6
    - _Requirements: 17.2, 17.3, 17.4, 17.5, 17.6_

- [x] 6. Seed `claims`/`winners` in initial state and remove mock data
  - [x] 6.1 Update `src/state/gameSessionInitialState.ts` and delete `src/data/mockClaims.ts`
    - Change `claims`/`winners` seeding from `mockClaims`/`mockWinners` to `[]`
    - Delete `src/data/mockClaims.ts` and remove its import from `gameSessionInitialState.ts`
    - _Requirements: 19.1, 19.3_

  - [x] 6.2 Write property test extending `RESET_GAME` coverage to claims/winners
    - File `src/state/gameSessionReducer.reset.test.ts` (extend existing); tag `// Feature: module-5-prize-claim-processing-winner-management, Property 18: {title}`; ≥100 iterations
    - **Property 18: RESET_GAME clears claims and winners, and every prize reports open afterward** — Validates Requirements 19.1, 19.2
    - _Requirements: 19.1, 19.2_

- [x] 7. Extend persistence to cover `claims`/`winners`
  - [x] 7.1 Update `src/state/persistence.ts`
    - Add `claims: PrizeClaim[]` and `winners: Winner[]` to `PersistedEnvelope` and `PersistedSlice`
    - `toEnvelope` copies both fields through unchanged; `PERSIST_VERSION` stays `3`
    - `parseEnvelope`: default restored `claims`/`winners` to `[]` when missing, `null`, or not an array, without rejecting the rest of an otherwise-valid envelope
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

  - [x] 7.2 Write property test for claims/winners persistence round-trip and fail-safe defaulting
    - File `src/state/persistence.claimsWinners.test.ts` (extends the existing `persistence.test.ts` suite); tag `// Feature: module-5-prize-claim-processing-winner-management, Property 16: {title}`; ≥100 iterations; reuse and extend existing malformed-envelope generators with variants omitting `claims`/`winners`, setting them to `null`, or to non-array values
    - **Property 16: Persistence round-trips claims and winners and defaults missing/invalid values safely** — Validates Requirements 16.2, 16.3, 16.4
    - _Requirements: 16.2, 16.3, 16.4_

- [x] 8. Wire claims and winners into the context provider
  - [x] 8.1 Update `src/state/GameSessionContext.tsx`
    - `initState()`'s restored-slice merge adds `claims: restored.claims, winners: restored.winners`
    - The persistence `useEffect`'s slice object adds `claims: state.claims, winners: state.winners`; add both to its dependency array
    - The sync broadcast payload adds `claims: state.claims, winners: state.winners`
    - No new derived context selectors are required — screens call `claimEngine`/`winnerEngine` helpers directly against `state.claims`/`state.winners`
    - _Requirements: 11.5, 16.1, 17.1_

- [x] 9. Checkpoint — state, persistence, and sync integrate
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Rewire the Player Game screen to the five-prize claim UI
  - [x] 10.1 Update `src/pages/PlayerGame/PlayerGame.tsx`
    - Remove the single `claimConfirmed` boolean and the single generic "Claim a Prize" card
    - Compute per-prize claim status blocks by iterating `currentPrizeProgress`, looking up each prize's own latest claim by the player and the game's `Winner` via `getWinnerForPrize`, and deriving `claimStatus` via `derivePlayerClaimStatus`
    - Render each block's message/button purely from `claimStatus` per the design's status table, with an INVALID-claim special case (Req 10.3) shown before falling through to `NOT_ELIGIBLE`/`ELIGIBLE`
    - Wire each prize's claim button to `dispatch({ type: 'SUBMIT_PRIZE_CLAIM', playerId, ticketId, prizeId })`, reading no eligibility flag from anywhere
    - Render the `CONFIRMED` block's celebration message inline within that prize's own card only, never as an overlay covering the ticket or other prize blocks
    - Pair every status message with distinguishable text (not color alone)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 10.3, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 13.1, 13.2, 13.3, 18.5_

  - [x] 10.2 Write component tests for PlayerGame's per-prize claim UI
    - Tapping an `ELIGIBLE` prize's claim button dispatches `SUBMIT_PRIZE_CLAIM` and that prize's block re-renders as `PENDING`
    - A `NOT_ELIGIBLE` prize's claim button is disabled and shows progress text; claiming one prize never disables or affects the other four prizes' own buttons/messages
    - After a host confirms, that prize's block shows the "Winner Confirmed" celebration without covering the ticket or the other prize blocks
    - An `INVALID`-result claim shows the exact progress-based message (e.g. "Claim could not be validated. Your current progress is 4/5.") rather than a generic error
    - A player can continue marking terms and see progress increase for other prizes after winning one
    - _Requirements: 2.1, 2.2, 2.5, 10.3, 12.3, 12.4, 12.5, 13.1, 13.2, 13.3, 18.5_

  - [x] 10.3 Write property/example test for the INVALID-claim progress message
    - File `src/pages/PlayerGame/playerGame.invalidClaimMessage.test.ts`; tag `// Feature: module-5-prize-claim-processing-winner-management, Property 14: {title}`; ≥100 iterations
    - **Property 14: An INVALID claim's player-facing message names current progress** — Validates Requirements 10.3
    - _Requirements: 10.3_

- [x] 11. Rewire the Host Dashboard to real claims and winners
  - [x] 11.1 Update `ClaimStatusTag` to accept `{validationStatus, hostDecision}`
    - Replace the old single `status: ClaimStatus` prop with the two independent statuses, rendering two small tags instead of one
    - _Requirements: 1.5_

  - [x] 11.2 Write unit test for the updated `ClaimStatusTag`
    - Assert the correct icon+text pair renders for each `validationStatus`/`hostDecision` combination
    - _Requirements: 1.5_

  - [x] 11.3 Update `src/pages/HostDashboard/HostDashboard.tsx` — Claim Inbox
    - Delete the local `useState<PrizeClaim[]>`/`useState<Winner[]>` mirrors and the local `confirmWinner`/`rejectClaim` functions
    - Render three subsections from `groupClaimsForHistory(sortClaimsForInbox(state.claims))`: Pending Claims, Confirmed, Rejected/Invalid
    - Each row shows player display name, ticket reference, prize label, submission time, validation result, host decision, Confirm control, Reject control — never the employee/demo id
    - Confirm button `disabled={!canConfirmClaim(claim, state.winners)}`, dispatching `CONFIRM_CLAIM`; Reject button `disabled={claim.hostDecision !== 'PENDING'}`, prompting for a reason (fixed options or free text) then dispatching `REJECT_CLAIM`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 9.1, 9.3, 10.1, 10.2_

  - [x] 11.4 Update `src/pages/HostDashboard/HostDashboard.tsx` — Winner Panel
    - Replace the `winners.map(...)` list with a fixed-order render over all 5 `PRIZES`, each row showing `getWinnerForPrize(state.winners, state.game.id, prize.id)?.playerName` or the literal "Not awarded"
    - _Requirements: 15.1, 15.2, 15.3_

  - [x] 11.5 Write component tests for HostDashboard's Claim Inbox and Winner Panel
    - Pending Claims subsection lists claims PENDING-first then by submission time
    - Confirm is disabled for an `INVALID` claim and enabled for a `VALID`/`PENDING` claim on an open prize
    - Confirming one claim moves it to the Confirmed subsection and immediately shows the corresponding Winner Panel row without a refresh
    - Rejecting a claim with a supplied reason shows that reason in the Rejected/Invalid subsection
    - Triggering Reset Demo Game clears both subsections and the Winner Panel back to all "Not awarded"
    - _Requirements: 7.4, 8.1, 8.5, 9.2, 9.3, 10.1, 15.3, 19.1, 19.2_

  - [x] 11.6 Write property/example tests for the inbox row and winner panel view-models
    - Files `src/pages/HostDashboard/hostClaimInboxViewModel.test.ts`, `hostWinnerPanelViewModel.test.ts`; tag `// Feature: module-5-prize-claim-processing-winner-management, Property {n}: {title}`; ≥100 iterations
    - **Property 11: Host claim inbox rows show only the fields the host needs** — Validates Requirements 7.2, 7.3
    - **Property 13: The winner panel lists all five prizes, each awarded or explicitly not** — Validates Requirements 15.2
    - _Requirements: 7.2, 7.3, 15.2_

- [x] 12. Checkpoint — player and host claim/winner UI integrate
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Add winner announcement to the Presentation View
  - [x] 13.1 Update `src/pages/PresentationView/PresentationView.tsx`
    - Add local `dismissedWinnerIds` state; find the most recent still-undismissed `Winner` from `state.winners`
    - When present, render a winner-announcement overlay showing only the prize label and player display name, instead of (not on top of) the normal `game.status`-driven stage content
    - Add a host-controlled "Dismiss Winner Announcement" action that adds the winner's id to `dismissedWinnerIds`, returning the stage to the current `game.status`/`currentTerm` view
    - _Requirements: 14.1, 14.2, 14.3, 14.4_

  - [x] 13.2 Write component tests for the Presentation View winner announcement
    - A confirmed winner triggers the announcement overlay showing only the prize label and player display name (never employee/demo id, ticket id, or claim id)
    - Tapping "Dismiss Winner Announcement" returns the stage to the current `game.status`/`currentTerm` view
    - _Requirements: 14.1, 14.2, 14.3_

  - [x] 13.3 Write property tests for the announcement view-model and dismiss-rendering equivalence
    - Files `src/pages/PresentationView/presentationWinnerViewModel.test.ts`, `presentationView.dismissRendering.test.ts`; tag `// Feature: module-5-prize-claim-processing-winner-management, Property {n}: {title}`; ≥100 iterations
    - **Property 12: Presentation winner announcements show only the prize label and player name** — Validates Requirements 14.1, 14.2
    - **Property 15: Dismissing a winner announcement restores the exact live-game rendering** — Validates Requirements 14.3, 14.4
    - _Requirements: 14.1, 14.2, 14.3, 14.4_

- [x] 14. Checkpoint — Presentation View integrates
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Integration and regression tests across screens and prior-module behavior
  - [x] 15.1 Write claim submission → host confirm → cross-screen propagation integration test
    - Dispatch `SUBMIT_PRIZE_CLAIM` for an eligible player/prize, dispatch `CONFIRM_CLAIM` for the resulting claim, and assert the Player screen, Host Winner Panel, and Presentation View all reflect the new `Winner` from the same state update, with no manual refresh
    - _Requirements: 8.5, 15.3_

  - [x] 15.2 Write claims/winners persistence-across-refresh integration test
    - Submit and confirm a claim, read `localStorage`, remount the provider, assert the same claim/winner are restored
    - _Requirements: 16.3, 20.3_

  - [x] 15.3 Write legacy-envelope-upgrade integration test
    - Seed `localStorage` with a pre-Module-5 envelope (`version: 3`, no `claims`/`winners` keys), mount the provider, assert it initializes with `claims === []` and `winners === []` without throwing
    - _Requirements: 16.4_

  - [x] 15.4 Write cross-tab claim/winner sync integration test
    - Simulate two tabs sharing a `BroadcastChannel`; submit a claim in the player tab, assert the host tab's `state.claims` updates to include it; confirm it in the host tab, assert the player tab's `state.winners`/claim status update to match
    - _Requirements: 17.2, 17.3_

  - [x] 15.5 Write continue-playing-after-winning-one-prize integration test
    - After a player's `CYBER_FIVE` claim is confirmed, dispatch further valid `MARK_TERM` actions for that player and assert progress toward the remaining four open prizes still increases exactly as before, with `marks` and the confirmed prize's own progress unaffected
    - _Requirements: 13.3, 18.5, 20.1, 20.4_

  - [x] 15.6 Write one-retry-after-rejection-then-blocked integration test
    - Submit a claim, reject it, resubmit (assert accepted), reject the resubmission, attempt a third submission for the same player/prize and assert it is rejected with `RESUBMISSION_LIMIT_REACHED`
    - _Requirements: 4.3, 4.4, 21.3_

  - [x] 15.7 Write regression tests for prior-module marks/identity/persistence/sync behavior
    - Assert Valid_Marks are preserved across new Cyber Word calls exactly as before this module
    - Assert `currentPlayerId` identity in a player's tab is preserved across host actions, including claim confirm/reject actions dispatched from a host tab
    - Assert a refresh after a Mark, a claim submission, or a claim confirmation restores the same player, ticket, marks, claims, and winners without loss
    - Assert Prize_Progress values for any Prize_Id never decrease as a result of a new Cyber Word call or any claim/winner action
    - Assert the existing direct-word-call gameplay model (`START_GAME`/`CALL_NEXT_WORD`) is unchanged by this module
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5_

  - [x] 15.8 Write example tests covering Requirement 21's specific assertions
    - Assert a valid claim submission is accepted with `validationStatus: 'VALID'`/`hostDecision: 'PENDING'`; an ineligible submission is `INVALID` and never produces a Winner; duplicate submissions never result in more than one active claim; a confirm action creates exactly one Winner and sets `hostDecision: 'CONFIRMED'`; confirm is blocked for an `INVALID` claim; no further confirm succeeds once a prize is closed; `currentPlayerId` is never altered by a claim-submission or claim-decision sync payload
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.9_

- [x] 16. Final checkpoint — full verification
  - Run the full test suite and confirm zero failures
  - Run the TypeScript project build (`tsc -b`) and confirm zero type errors
  - Run the production build (`vite build`) and confirm it succeeds
  - Ask the user if questions arise
  - _Requirements: 1.6, 20.1, 20.2, 20.3, 20.4, 20.5_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses for traceability.
- Checkpoints (tasks 4, 9, 12, 14, 16) ensure incremental validation as pure logic, state, UI, and cross-screen behavior come together.
- Property tests validate the 18 universal correctness properties from `design.md`; each test is tagged `// Feature: module-5-prize-claim-processing-winner-management, Property {n}: {title}` and runs ≥100 iterations.
- Component/integration tests validate UI text, dispatch behavior, and end-to-end flows that are not expressible as pure properties.
- `validatePrizeClaim` is the single shared validation pipeline used by the reducer's `SUBMIT_PRIZE_CLAIM` case; `canConfirmClaim` is the single shared gate used by the reducer's `CONFIRM_CLAIM` case and the Host Dashboard's Confirm button — no gate logic is duplicated between them.
- The reducer stays pure: all `PrizeClaim`/`Winner` id/timestamp generation reuses the existing `localId()`/`now()` helpers, and no `localStorage`/`BroadcastChannel` access happens inside any of the three new reducer cases.
- Task 6.1 deletes `src/data/mockClaims.ts` entirely since no other module imports it once `HostDashboard` reads `state.claims`/`state.winners` directly.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "3.1"] },
    { "id": 2, "tasks": ["2.1", "3.2", "3.3"] },
    { "id": 3, "tasks": ["2.2", "3.4", "3.5"] },
    { "id": 4, "tasks": ["3.6", "5.1", "6.1"] },
    { "id": 5, "tasks": ["5.2", "5.3", "6.2", "7.1"] },
    { "id": 6, "tasks": ["5.4", "7.2", "8.1"] },
    { "id": 7, "tasks": ["10.1", "11.1", "13.1"] },
    { "id": 8, "tasks": ["10.2", "10.3", "11.2", "11.3", "13.2"] },
    { "id": 9, "tasks": ["11.4", "13.3"] },
    { "id": 10, "tasks": ["11.5", "11.6"] },
    { "id": 11, "tasks": ["15.1", "15.2", "15.3", "15.4", "15.5", "15.6", "15.7", "15.8"] }
  ]
}
```
