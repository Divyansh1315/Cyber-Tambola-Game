# Implementation Plan

## Overview

This plan fixes the Presenter realtime winner sync bug: `PresentationView.tsx`'s only notion of "which Winner is currently showing" is `findLatestUndismissedWinner(state.winners, dismissedWinnerIds)`, where `dismissedWinnerIds` is Presenter-local `useState` seeded empty on every mount and cleared only by a manual "Dismiss Winner Announcement" button — never by any Host action, never shared across Presenter instances or refreshes, and with no FINAL_RESULTS branch at all for `game.status === 'COMPLETED'`. The fix adds one additive, shared field (`game.latestWinnerAnnouncementId`), set by `CONFIRM_CLAIM` and cleared by `CALL_NEXT_WORD`/`START_GAME`, replaces the dismiss mechanism with a pure `derivePresenterMode(state)` function implementing Req 2.10's exact 4-step priority order, adds a pure `buildFinalWinnerSummary(winners, activeGameId)` for the Final Winner Summary, extends `toAnnouncementViewModel` with `ticketRef`, and adds a `game_id` guard inside `GameSessionContext.tsx`'s `subscribeToGame` callback (comparing against `gameIdRef.current`, not `state.game.id`) to close the Req 2.8 stale cross-game Realtime event race. `claimEngine.ts`, `prizeEngine.ts`, and `winnerEngine.ts` are untouched. Work proceeds via the bug-condition methodology: exploration (task 1) and preservation (task 2) tests are written and run against the unfixed code first, the fix is implemented and tested in tasks 3-11, then re-verified end-to-end in tasks 13-14, with final sign-off in task 16 explicitly flagging the two manual/non-automated acceptance items (real-browser Host+Presenter full-flow test, optional cross-device test, and the completion summary) that remain outside automated tasks.

## Tasks

- [ ] 1. Write bug condition exploration test(s)
  - **Property 1: Bug Condition** - Dismiss-Button/Local-State Mechanism Fails To Survive Refresh/Second Instance, No FINAL_RESULTS Branch
  - **IMPORTANT**: Write this property-based test BEFORE implementing the fix
  - **GOAL**: Reproduce, on the real unfixed code, (a) the `dismissedWinnerIds`/manual-dismiss mechanism's failure to clear a Winner announcement in sync with `CALL_NEXT_WORD`, and its failure to survive a Presenter refresh or a second concurrently-mounted Presenter instance consistently, and (b) the complete absence of any FINAL_RESULTS branch when `game.status === 'COMPLETED'`. Also attempt (and document the outcome of) an exploration test for the Req 2.8 stale-cross-game-event race
  - Use the existing mock Supabase test harness (`src/state/testSupport/mockSupabaseClient.ts`), following the pattern already established by `GameSessionContext.multiTabReset.integration.test.tsx` and the prior `claim-player-ticket-identity-mismatch`/`claim-duplicate-submission` specs' exploration tests
  - Add a new test file `src/pages/PresentationView/presenterRealtimeWinnerSync.exploration.test.tsx`
  - **Scoped PBT Approach**: scope the property to the concrete deterministic shapes from design.md's Exploratory Bug Condition Checking section (these are deterministic sequencing bugs, not input-dependent, so the property is scoped to concrete scenario replays rather than randomized generation):
    1. **winner-announcement-then-next-word-clears-it (unfixed)**: dispatch `CONFIRM_CLAIM`, mount `PresentationView`, assert the announcement renders via `findLatestUndismissedWinner`; dispatch `CALL_NEXT_WORD`; assert (unfixed) the announcement is NOT cleared by anything except the manual Dismiss button — no code path reacts to `CALL_NEXT_WORD` at all
    2. **second-presenter-instance-and-refresh-inconsistency (unfixed)**: mount two `PresentationView` instances (or remount one, simulating a refresh) sharing the same `state.winners`; have one instance's operator "click Dismiss" (toggle its local `dismissedWinnerIds`); assert the other instance (or the remounted instance, whose `dismissedWinnerIds` resets to empty) disagrees about whether the Winner is still showing — demonstrating the mechanism is Presenter-local, not shared
    3. **end-game-shows-full-summary-all-five-categories (unfixed)**: dispatch however many `CONFIRM_CLAIM`s, then set `game.status` to `'COMPLETED'`; assert (unfixed) the rendered output is the static "Game Completed" message with no prize category, no winner name, and no read of `state.winners`/`state.winnerHistory` at all
    4. **missing-winners-show-no-winner-per-category (unfixed)**: same as above but with zero or partial `CONFIRM_CLAIM`s; assert (unfixed) there is no per-category rendering to even inspect, since no Final Summary exists yet
    5. **req-2.8-stale-cross-game-event (unfixed, attempt and document outcome)**: using the mock Supabase client, hydrate game A, confirm a Winner for game A, trigger a reset (hydrate game B via a new pointer event), then attempt to fire a `winners` INSERT event carrying game A's winner row against game A's old channel reference. Per design.md's own finding, the mock's `unsubscribe()` is modeled as synchronous and immediate (removes registered listeners synchronously), so this specific scenario is NOT expected to reproduce the real async-teardown race through `fireRemoteChange` alone. Document this limitation explicitly in the test file as the EXPECTED OUTCOME for this sub-case (confirming the mock cannot reproduce it, not that the race doesn't exist) — if a direct-callback-reference invocation is attempted instead (bypassing `fireRemoteChange`) to probe the ungated code path, document that result too, whichever way it comes out
  - Test implementation details from the Bug Condition in design.md (`isBugCondition(X)` formal spec, `PresenterStateTransition` shape: `priorGameId`, `currentGameId`, `winnerJustConfirmed`, `nextWordCalledSinceWinner`, `gameStatus`, `presenterRefreshed`, `resetOccurred`, `staleEventGameId`)
  - The test assertions should match Property 1 and Property 4 from design.md's Correctness Properties — on FIXED code these same scenarios must flip to the correct `derivePresenterMode`/`buildFinalWinnerSummary`/guard outcome; on UNFIXED code they must demonstrate the gap (or, for sub-case 5, demonstrate the mock's known limitation)
  - Run test(s) on UNFIXED code (current `PresentationView.tsx`/`gameSessionReducer.ts`/`GameSessionContext.tsx`)
  - **EXPECTED OUTCOME**: Tests FAIL / their assertions demonstrating the bug PASS against unfixed code for sub-cases 1-4 (document whichever framing you use) — this confirms Problems A/B/C exist as described. Sub-case 5 is expected to confirm the mock's documented limitation rather than produce a failing-then-passing demonstration
  - Document the counterexamples found: (a) no reaction to `CALL_NEXT_WORD` while an announcement is showing, (b) a second instance/refresh disagreeing about whether a Winner is still showing, (c) no Final Summary content at all when `COMPLETED`, (d) the mock-vs-real async-teardown limitation for the Req 2.8 scenario
  - Mark task complete when test(s) are written, run, and failure/counterexample (or documented limitation) is recorded
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Unaffected Rendering, Resets, and Mechanisms Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Add a new test file `src/pages/PresentationView/presenterRealtimeWinnerSync.preservation.test.tsx`
  - Observe on UNFIXED code, and record each as the baseline to assert against the fixed code later:
    1. **Ordinary LOBBY/WORD_ACTIVE/PAUSED rendering**: for states with no pending announcement and no completion, confirm the existing lobby QR/Game Code rendering, circuit background, and Cyber Word/definition/awareness-tip layout render exactly as today
    2. **RESET_GAME's winners→winnerHistory fold**: dispatch `RESET_GAME` with a non-empty `state.winners`/`state.winnerHistory`; confirm the resulting `winnerHistory` is `[...oldWinnerHistory, ...oldWinners]` and `winners`/`claims`/`players`/`tickets`/`game.revealedTermIds`/`game.currentRound`/`game.code` reset to the fresh seed game's values, exactly as the current reducer case already does
    3. **NO_ACTIVE_GAME's reset**: dispatch `NO_ACTIVE_GAME`; confirm `game`/`players`/`tickets`/`marks`/`claims`/`winners` reset to initial values while `currentPlayerId` is preserved, exactly as today
    4. **CONFIRM_CLAIM's confirmed-only invariant**: dispatch `CONFIRM_CLAIM` for a claim that fails `canConfirmClaim`; confirm no `Winner` is created; dispatch it for a claim that passes; confirm a `Winner` is created exactly as today (pre-fix shape, before the new `latestWinnerAnnouncementId` field is added)
    5. **Pointer-follow unsubscribe-before-subscribe ordering**: observe the existing `subscribeToActiveGamePointer` effect unsubscribing the old per-game channel before subscribing to the new game id's channel, and no-oping when the announced id equals the already-tracked `gameIdRef.current`
  - Write property-based tests (reuse whatever PBT library is already a devDependency in `package.json`, matching the convention used by the two prior specs' preservation tests) asserting the observed baseline behavior holds for the non-bug-condition region (`isBugCondition(X) = false`): same rendered output for randomly generated `(status: 'WORD_ACTIVE'|'PAUSED', currentTermId, latestWinnerAnnouncementId: undefined)` combinations, same `RESET_GAME`/`NO_ACTIVE_GAME` field-level reset behavior across randomly generated `winners`/`winnerHistory` arrays, same `CONFIRM_CLAIM` confirmed-only gating
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve — the unfixed code already behaves correctly for the non-bug-condition region, since the defect only manifests when the bug condition holds)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.9_

- [ ] 3. Add `latestWinnerAnnouncementId` field to the `Game` type
  - In `src/types/game.ts`, add `latestWinnerAnnouncementId?: string` to the `Game` interface alongside `previousStatus`, with the doc comment from design.md's Fix Implementation point 1 explaining it is additive, shared/authoritative (never Presenter-local-only), and `undefined` means "no active announcement"
  - This is purely additive — no existing field on `Game` changes
  - _Expected_Behavior: a shared, authoritative field exists for every Presenter instance to read identically (design.md Fix Implementation point 1)_
  - _Requirements: 2.3_

- [ ] 4. Wire `CONFIRM_CLAIM`, `CALL_NEXT_WORD`, and `START_GAME` to set/clear `latestWinnerAnnouncementId`
  - [ ] 4.1 Set it in `CONFIRM_CLAIM`'s existing reducer case
    - In `src/state/gameSessionReducer.ts`, additively set `game: { ...state.game, latestWinnerAnnouncementId: newWinner.id }` in the `CONFIRM_CLAIM` case's return value, immediately after the new `Winner` is created — no existing line in this case changes
    - _Bug_Condition: isBugCondition(X) where X.winnerJustConfirmed = true AND NOT showingWinnerAnnouncement(X)_
    - _Expected_Behavior: game.latestWinnerAnnouncementId is set to the newly-confirmed Winner's id (design.md Fix Implementation point 2)_
    - _Requirements: 2.1, 2.3_

  - [ ] 4.2 Clear it in `CALL_NEXT_WORD`'s existing reducer case (both branches)
    - In both the bank-exhausted → `COMPLETED` branch and the normal next-term branch of the `CALL_NEXT_WORD` case, additively set `latestWinnerAnnouncementId: undefined` on the returned `game` object, unconditionally (whether or not an announcement was active)
    - _Bug_Condition: isBugCondition(X) where X.nextWordCalledSinceWinner = true AND showingWinnerAnnouncement(X)_
    - _Expected_Behavior: game.latestWinnerAnnouncementId is cleared whenever Next Cyber Word is called, regardless of prior value (design.md Fix Implementation point 3)_
    - _Requirements: 2.2, 2.3_

  - [ ] 4.3 Clear it in `START_GAME`'s existing reducer case
    - Additively set `latestWinnerAnnouncementId: undefined` on the `started: Game` object returned by `START_GAME`, for the same uniformity reasoning as 4.2 (every action that advances `currentTermId` clears the announcement)
    - _Expected_Behavior: starting a fresh game never carries over a stale announcement signal (design.md Fix Implementation point 4)_
    - _Requirements: 2.3, 2.6_

  - [ ] 4.4 Confirm `RESET_GAME`/`NO_ACTIVE_GAME` require no additional code
    - Verify (do not modify) that both cases already return a wholesale-replaced state built from `gameSessionInitialState`/`createSeedGame(...)`, neither of which sets `latestWinnerAnnouncementId` — it is `undefined` by construction
    - _Preservation: RESET_GAME/NO_ACTIVE_GAME's existing wholesale-replace semantics unchanged (Req 3.1, 3.2)_
    - _Requirements: 2.6, 3.1, 3.2_

- [ ] 5. Implement `derivePresenterMode` in `PresentationView.tsx`
  - Add the pure, exported function per design.md's Fix Implementation point 9, implementing Req 2.10's exact 4-step priority order: `game.status === 'COMPLETED'` → `'FINAL_RESULTS'`; else `game.latestWinnerAnnouncementId !== undefined` → `'WINNER'`; else `game.status === 'WORD_ACTIVE' && currentTermId` → `'WORD'`; else `'LOBBY'`
  - Include the doc comment explaining PAUSED's handling as a sibling check inside the same switch's fallthrough, per design.md's exact reasoning (a paused game cannot simultaneously be WORD_ACTIVE, and an active announcement during a pause still correctly takes priority)
  - _Bug_Condition: isBugCondition(X) per design.md's formal specification_
  - _Expected_Behavior: expectedBehavior(result) — derivePresenterMode returns the mode dictated by Req 2.10's priority order for every state (design.md Property 1)_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.10_

- [ ] 6. Implement `buildFinalWinnerSummary` in `PresentationView.tsx`
  - Add the pure, exported function per design.md's Fix Implementation point 10: filters `winners` to `activeGameId`, maps `PRIZES` (imported from `../../utils/prizeEngine`) to one `FinalWinnerSummaryEntry` per category, with `winnerName`/`ticketRef` populated from a matching confirmed winner or left `undefined` (rendered as "No Winner")
  - Never reads `state.claims`; category order/labels come exclusively from `PRIZES`, never re-declared
  - _Bug_Condition: isBugCondition(X) where X.gameStatus = 'COMPLETED' AND NOT showingFinalResultsSummary(X)_
  - _Expected_Behavior: buildFinalWinnerSummary returns exactly 5 entries in PRIZES' order, each either a confirmed same-game winner or "No Winner" (design.md Property 1)_
  - _Requirements: 2.4, 2.5_

- [ ] 7. Extend `toAnnouncementViewModel` with `ticketRef`
  - Add `ticketRef: winner.ticketRef` to the function's return value per design.md's Fix Implementation point 11; `Winner.ticketRef` already exists on the type (`src/types/prize.ts`)
  - Confirm the function continues to exclude Employee ID, internal Player ID, Supabase ids, and claim validation codes — none of which were ever read from `winner` here
  - _Bug_Condition: isBugCondition per design.md Property 3_
  - _Expected_Behavior: toAnnouncementViewModel includes ticketRef and excludes every previously-excluded field (design.md Property 3)_
  - _Requirements: 2.1, 2.9_

- [ ] 8. Remove the dismiss mechanism and rewire `PresentationView`'s render body around `derivePresenterMode`
  - Remove outright (not deprecate): the `dismissedWinnerIds` `useState<Set<string>>`, the `findLatestUndismissedWinner` function, and the "Dismiss Winner Announcement" `Button` and its `onClick` handler — confirmed unused elsewhere in the codebase
  - Replace the current `latestWinner ? ... : <>{game.status === ...}</>` branching with a `switch (derivePresenterMode(state))`, keeping the existing LOBBY, WORD_ACTIVE, and PAUSED JSX bodies **verbatim** (Req 3.4) and adding a new `'WINNER'` case (reading the Winner via `state.winners.find(w => w.id === state.game.latestWinnerAnnouncementId)`, rendering through the extended `toAnnouncementViewModel`) and a new `'FINAL_RESULTS'` case (rendering `buildFinalWinnerSummary(state.winners, state.game.id)`'s five entries)
  - PAUSED continues to be read exactly as today, as a sibling check inside the same switch's handling for `game.status === 'PAUSED'`, per design.md's exact structure — no restructuring of that branch beyond threading it through the new switch
  - _Bug_Condition: isBugCondition per design.md's formal specification (dismiss-mechanism and missing-FINAL_RESULTS cases)_
  - _Expected_Behavior: PresentationView's render body is driven entirely by derivePresenterMode/buildFinalWinnerSummary, with no Presenter-side dismiss affordance (Req 2.1, 2.3, 2.4)_
  - _Preservation: LOBBY/WORD_ACTIVE/PAUSED JSX bodies preserved verbatim (Req 3.4)_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.4_

- [ ] 9. Add the `game_id` guard inside `GameSessionContext.tsx`'s `subscribeToGame` callback registration
  - Inside `hydrateForGame`, at the point `subscribeToGame(gameRow.id, (change) => { ... })` is called, add the guard per design.md's Fix Implementation point 12: extract `incomingGameId` from `(change.row as Record<string, unknown>).game_id`; if it is defined and does not equal `gameIdRef.current`, return without dispatching `SYNC_REMOTE`
  - Use `gameIdRef.current` as the comparison point, exactly as design.md specifies — **not** `state.game.id` — because `gameIdRef.current` is set synchronously at the top of `hydrateForGame`, strictly before the new channel is even subscribed, making it the race-free comparison point; `state.game.id` is precisely the field a stale event could otherwise be about to corrupt
  - Confirm (do not change) that this guard is a no-op for `games`-table events (whose row has no `.game_id` column — the guard's `incomingGameId !== undefined` check naturally skips this case) and applies uniformly to every other table (`called_terms`, `tickets`, `players`, `marks`, `claims`, `winners`), each of which carries a `game_id` column per `fetchFullGameState`'s existing `.eq('game_id', gameId)` filters
  - No change to the pointer-follow effect's own unsubscribe-before-subscribe ordering, `resolveRollbackTarget`, `getActivePlayerSession`, or any other existing dispatch branch in this file
  - _Bug_Condition: isBugCondition(X) where X.staleEventGameId IS DEFINED AND X.staleEventGameId <> X.currentGameId AND eventWouldBeApplied(X) (design.md Property 4)_
  - _Expected_Behavior: a stale cross-game event is dropped before SYNC_REMOTE is dispatched; a matching-game_id event is dispatched exactly as before (design.md Property 4)_
  - _Preservation: every Realtime event whose game_id already matches gameIdRef.current continues to be dispatched exactly as today (Req 3.5)_
  - _Requirements: 2.7, 2.8_

- [ ] 10. Unit tests for `derivePresenterMode`, `buildFinalWinnerSummary`, and the extended `toAnnouncementViewModel`
  - `derivePresenterMode`: cover every combination of `(status, latestWinnerAnnouncementId defined/undefined, currentTermId defined/undefined)`, explicitly asserting the priority ordering edge cases — `COMPLETED` wins even when `latestWinnerAnnouncementId` is also defined; an active announcement wins over `WORD_ACTIVE` with a current term; `PAUSED` with an active announcement still shows `WINNER`. Include a property-based test generating random state combinations and asserting the output always satisfies Req 2.10's priority order (design.md Property 1)
  - `buildFinalWinnerSummary`: cover all-5-present, some-missing (rendered as "No Winner", never falling back to claim data), and confirmed-only (winners belonging to a different `gameId`, or hypothetically non-confirmed data, must be excluded/impossible by the input type). Include a property-based test generating random `Winner[]` arrays (including other-game winners) asserting the output always has exactly 5 entries in `PRIZES`' fixed order
  - Extended `toAnnouncementViewModel`: assert `ticketRef` is included, and the existing exclusion list (Employee ID, internal Player ID, Supabase ids, claim validation codes) still holds
  - _Requirements: 2.1, 2.4, 2.5, 2.9, 2.10_

- [ ] 11. Regression tests for the five required scenarios from bugfix.md
  - Add `src/pages/PresentationView/presenterRealtimeWinnerSync.regression.integration.test.tsx` covering, as named test cases (mirroring bugfix.md's Required Regression Test Coverage verbatim):
    1. **winner-announcement-then-next-word-clears-it**: confirming a Winner shows the announcement on the Presenter via `derivePresenterMode` returning `'WINNER'`; clicking "Next Cyber Word" clears it (`latestWinnerAnnouncementId` becomes `undefined`) and shows the newly-called word, with no timer involved anywhere
    2. **reset-clears-winner-and-returns-to-lobby**: resetting the game while a Winner announcement (and/or Final Summary) is showing immediately clears it and returns the Presenter to `'LOBBY'` (or `'WORD'`, per the new game's actual state) with no stale previous-game artifact visible, using the new game's own code/QR
    3. **end-game-shows-full-summary-all-five-categories**: setting `game.status` to `'COMPLETED'` shows a Final Winner Summary listing all five prize categories via `derivePresenterMode` returning `'FINAL_RESULTS'` and `buildFinalWinnerSummary` returning all 5 entries
    4. **missing-winners-show-no-winner-per-category**: any prize category with no confirmed winner for the active game renders "No Winner" in the Final Summary, never a pending/rejected claim
    5. **new-game-pointer-switch-unsubscribes-old-subscribes-new-no-stale-winner-leaks**: when the Active Game pointer switches to a new game id, the Presenter unsubscribes the old Realtime channel, subscribes to the new one, and (via the task 9 guard) no Winner/word/summary from the old game leaks into the new game's display
  - Also include the full integration flow from design.md's Integration Tests section: confirm Winner → WINNER mode, no timer → Next Cyber Word → WORD mode → confirm another Winner for a different prize → Next Cyber Word → clears again → End Game → FINAL_RESULTS with all five categories → Reset → LOBBY with the new game's own code/QR and no stale artifact; plus the Local Fallback variant (Req 3.6) and the two-Presenter-instance variant confirming both render identically from `game.latestWinnerAnnouncementId` with no dependency on mount time
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.4, 3.5, 3.6, 3.9_

- [ ] 12. Checkpoint - run the full build and automated test suite
  - Run `npm run build` and fix any type errors introduced by the new `Game.latestWinnerAnnouncementId` field, the new exported `derivePresenterMode`/`buildFinalWinnerSummary` functions, or the extended `toAnnouncementViewModel` return shape
  - Run the full automated test suite (e.g. `npm test -- --run` or the project's configured non-watch test command) and fix any regressions
  - Do NOT modify, remove, or weaken `src/utils/claimEngine.ts`, `src/utils/prizeEngine.ts`, `src/utils/winnerEngine.ts`, or the `claim-player-ticket-identity-mismatch`/`claim-duplicate-submission` guards (`getActivePlayerSession`, `isBackendConfirmed`, `CLEAR_STALE_PLAYER`, `RECONCILE_CLAIM_ID`, `isSubmittingClaim`) while fixing regressions — if a test failure seems to require touching one of these, stop and treat that as a signal the fix has gone out of scope, not something to patch around
  - Confirm every task-1 exploration test now PASSES (bug fixed, except sub-case 5's documented mock limitation, which remains as documented) and every task-2 preservation test still PASSES (no regressions)
  - Ask the user if questions arise
  - _Requirements: all_

- [ ] 13. Verify exploration test(s) now pass against fixed code
  - **Property 1: Expected Behavior** - Presenter Display Mode Follows Req 2.10 Priority At All Times
  - **IMPORTANT**: Re-run the SAME test(s) from task 1 — do NOT write a new file. If an assertion needs to flip from "assert the gap occurs" to "assert the correct mode/summary now renders" for the FIXED code, update that assertion in place in the existing test file rather than creating a new file
  - Run the bug condition exploration test(s) from task 1 against the fixed code
  - **EXPECTED OUTCOME**: Sub-cases 1-4 PASS (confirms the bug is fixed — `CALL_NEXT_WORD` clears the announcement, both Presenter instances/refreshes agree because they read the same shared field, and the Final Summary renders all five categories). Sub-case 5 remains documented per its known mock limitation (the real-client guard is verified instead by task 9/10's direct unit tests)
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 2.8, 2.10_

- [ ] 14. Verify preservation tests still pass
  - **Property 2: Preservation** - Unaffected Transitions and Mechanisms Unchanged
  - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
  - Run the preservation property tests from task 2 against the fixed code
  - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions for ordinary LOBBY/WORD_ACTIVE/PAUSED rendering, `RESET_GAME`'s fold, `NO_ACTIVE_GAME`'s reset, `CONFIRM_CLAIM`'s confirmed-only invariant, and the pointer-follow effect's unsubscribe-before-subscribe ordering)
  - Confirm all tests still pass after the fix (no regressions)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.9_

- [ ] 15. Decide keep/remove for any temporary diagnostics added during the Req 2.8 investigation
  - Review each temporary diagnostic logging call (if any) added while investigating the Req 2.8 stale-cross-game-event race or while probing the mock's `unsubscribe()` behavior (e.g. a one-off `console.warn`/`console.debug` inspecting `gameIdRef.current`, incoming `change.row.game_id`, or channel lifecycle timing)
  - Deliberately decide, per call site: keep it permanently as a lightweight, non-sensitive, `import.meta.env.DEV`-gated diagnostic (documenting the decision in a brief code comment at the call site), or remove it entirely
  - If none were added during this spec's investigation, record that explicitly rather than silently skipping this task
  - Re-run the full test suite once more after any removal to confirm nothing depended on a log call's presence
  - _Requirements: 2.8_

- [ ] 16. Final checkpoint - ensure all tests pass and no out-of-scope files changed
  - Run `npm run build` and the full automated test suite one final time
  - Confirm: every exploration test passes (per task 13's scope), every preservation test passes, every regression test from task 11 passes
  - Confirm via `git diff` against the merge-base commit before this spec's changes that `src/utils/claimEngine.ts`, `src/utils/prizeEngine.ts`, and `src/utils/winnerEngine.ts` are byte-identical
  - Confirm the only changed files are `src/pages/PresentationView/PresentationView.tsx`, `src/state/gameSessionReducer.ts`, `src/types/game.ts`, and `src/state/GameSessionContext.tsx` (the Req 2.8 guard only — no change to the pointer-follow effect's own ordering, `resolveRollbackTarget`, or `getActivePlayerSession`)
  - Ask the user if questions arise
  - _Requirements: all_

- [~] 17. Manual acceptance criteria required to consider this spec done (NOT automated tasks)
  - **This task is intentionally not satisfiable by any automated test** — it exists so the spec does not silently omit bugfix.md's Required Final Acceptance Criteria
  - **A. Mandatory manual real-browser Host+Presenter full-flow test**: open a real Host tab and a real Presenter tab: reset → confirm Lobby shows the new game's code/QR → start the game → call a word → confirm a Winner → confirm the Winner stays visible on the Presenter for at least 5 seconds with no auto-hide → click Next Cyber Word → confirm the Winner is cleared and the new word is shown → confirm another Winner for a different prize → click Next Cyber Word → confirm it clears again → end the game → confirm the Final Winner Summary shows all five categories correctly → reset → confirm everything (announcement, summary, word, round, code) is cleared. Record this as completed, or explicitly note it as not yet executed with reason — this fix is NOT considered complete until this is recorded
  - **B. Optional cross-device test**: Host and Presenter on separate physical devices, same flow as A. Should be attempted and its result recorded either way, but is not mandatory
  - **C. Completion summary**: produce and record a summary covering at minimum: root cause confirmation for each of Problems A-D; the specific shared/authoritative mechanism added (`latestWinnerAnnouncementId`); whether a `game_id` guard was added to the `subscribeToGame` callback (Req 2.8) and why/why not; files modified; the five required regression test results (listed in task 11); the manual real-browser full-flow test result (A above); the optional cross-device test result or explicit note that it was not attempted (B above); `npm run build` result; commit hash; and confirmation that the `main` branch was not touched
  - This spec is NOT considered complete until A and C above are satisfied and recorded (B is optional but should be attempted), in addition to tasks 1-16 passing
  - _Requirements: all (bugfix.md Required Final Acceptance Criteria)_

## Task Dependency Graph

```
1. Bug condition exploration test(s) (unfixed code)     2. Preservation property tests (unfixed code)
   (independent baseline)                                   (independent baseline)
        \                                                        /
         \                                                      /
          \____________________  both are prerequisites to  ___/
                                 implementation (3-9), but
                                 not to each other
                                        |
                                        v
3. Add latestWinnerAnnouncementId field (types/game.ts)
                                        |
                                        v
4. Wire CONFIRM_CLAIM/CALL_NEXT_WORD/START_GAME to set/clear it (gameSessionReducer.ts)
   4.1 Set in CONFIRM_CLAIM (depends on 3)
   4.2 Clear in CALL_NEXT_WORD (depends on 3)
   4.3 Clear in START_GAME (depends on 3)
   4.4 Confirm RESET_GAME/NO_ACTIVE_GAME need no change (depends on 3)
                                        |
                                        v
   ______________________________________________
  |                 |                              |
  v                 v                              v
5. derivePresenterMode   6. buildFinalWinnerSummary   7. Extend toAnnouncementViewModel
   (PresentationView.tsx)   (PresentationView.tsx)      (PresentationView.tsx)
   (depends on 4)           (independent of 5; reads     (independent of 5-6; reads
                             state.winners directly,      Winner.ticketRef, already
                             depends on 4 only loosely     exists on the type)
                             via latestWinnerAnnouncementId
                             not being its own input)
   \_________________________|_____________________/
                                        |
                                        v
8. Remove dismiss mechanism, rewire render body around derivePresenterMode's switch
   (depends on 5, 6, 7 all being implemented)
                                        |
                                        v
9. Add game_id guard inside subscribeToGame callback (GameSessionContext.tsx)
   (independent of 3-8; separate file, separate mechanism -- Req 2.8)
                                        |
                                        v
   ______________________________________________
  |                                                |
  v                                                v
10. Unit tests for derivePresenterMode,          11. Regression tests for the five
    buildFinalWinnerSummary, extended                required scenarios
    toAnnouncementViewModel                           (depends on 3-9 end-to-end)
    (depends on 5, 6, 7)
   \________________________________________________/
                                        |
                                        v
12. Checkpoint - full build + test suite
    (depends on 3-11 being implemented and their tests written)
                                        |
                                        v
13. Verify exploration test(s) against the fix (depends on 12)
                                        |
                                        v
14. Verify preservation tests against the fix (depends on 12)
                                        |
                                        v
15. Keep/remove decision for Req 2.8 temporary diagnostics
    (depends on 13 and 14 confirming the fix is verified)
                                        |
                                        v
16. Final checkpoint - all tests pass, no out-of-scope diffs
    (depends on 15)
                                        |
                                        v
17. Manual acceptance criteria (real browser test + cross-device + completion summary)
    (depends on 16; NOT an automated task -- the spec is not done without it)
```

**Summary:**
- Tasks 1 and 2 are independent of each other and must both run (on unfixed code) before any implementation task.
- Task 3 → 4 is sequential (the set/clear wiring in 4 needs the field defined in 3).
- Tasks 5, 6, and 7 are each independent pure-function additions in `PresentationView.tsx`; 5 depends on 4's field existing, 6 and 7 are structurally independent of 5 (6 reads `state.winners`/`activeGameId` directly, 7 reads an already-existing `Winner.ticketRef`), but all three are prerequisites for task 8's render-body rewire.
- Task 8 depends on 5, 6, and 7 all being implemented, since the switch statement it introduces calls all three.
- Task 9 (the Req 2.8 guard in `GameSessionContext.tsx`) is independent of 3-8 — a separate file and separate mechanism — and can proceed in parallel with 3-8, but is placed after here for linear readability.
- Tasks 10 and 11 are test tasks that depend on the implementation tasks they exercise (10 → 5, 6, 7; 11 → 3-9 collectively) and can be done in parallel with each other once their respective implementation tasks land.
- Task 12 depends on all of 3-11 being complete.
- Task 13 and 14 depend on 12 and re-run the exact tests from tasks 1 and 2 (no new tests written, only in-place assertion updates where the fix flips the expected outcome).
- Task 15 depends on 13 and 14 passing.
- Task 16 depends on 15.
- Task 17 depends on 16, and is a manual/documentation gate, not an automated task — it must still be completed before the spec is considered done.

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "2"], "description": "Independent exploration/preservation baselines on unfixed code" },
    { "wave": 2, "tasks": ["3"], "description": "Add latestWinnerAnnouncementId field to Game type" },
    { "wave": 3, "tasks": ["4"], "description": "Wire CONFIRM_CLAIM/CALL_NEXT_WORD/START_GAME to set/clear it (depends on 3)" },
    { "wave": 4, "tasks": ["5", "6", "7"], "description": "Independent pure-function additions in PresentationView.tsx: derivePresenterMode, buildFinalWinnerSummary, extended toAnnouncementViewModel (5 depends on 4; 6 and 7 are structurally independent of 5)" },
    { "wave": 5, "tasks": ["8"], "description": "Remove dismiss mechanism, rewire render body around derivePresenterMode's switch (depends on 5, 6, 7)" },
    { "wave": 6, "tasks": ["9"], "description": "Add game_id guard inside subscribeToGame callback (GameSessionContext.tsx) -- independent of 3-8, Req 2.8" },
    { "wave": 7, "tasks": ["10", "11"], "description": "Test tasks, parallelizable once their respective implementation tasks land (10 depends on 5,6,7; 11 depends on 3-9)" },
    { "wave": 8, "tasks": ["12"], "description": "Build + full test suite checkpoint" },
    { "wave": 9, "tasks": ["13", "14"], "description": "Re-run exploration and preservation tests against the fix" },
    { "wave": 10, "tasks": ["15"], "description": "Req 2.8 temporary diagnostics keep/remove decision" },
    { "wave": 11, "tasks": ["16"], "description": "Final checkpoint" },
    { "wave": 12, "tasks": ["17"], "description": "Manual acceptance criteria: real browser test, optional cross-device test, and completion summary (not automated)" }
  ]
}
```

## Notes

- **`claimEngine.ts`/`prizeEngine.ts`/`winnerEngine.ts` must never be modified**: no task in this plan touches any of these three files. `PRIZES` (from `prizeEngine.ts`) is read (imported) by `buildFinalWinnerSummary`, never modified. If any regression fix during task 12 seems to require touching one of these, that is a signal the fix has gone out of scope — stop and reconsider rather than patching around it. Task 16 confirms this via `git diff`.
- **The `claim-player-ticket-identity-mismatch` and `claim-duplicate-submission` guards/mechanisms are not touched**: `getActivePlayerSession()`, `isBackendConfirmed`, `CLEAR_STALE_PLAYER`, `RECONCILE_CLAIM_ID`, and `isSubmittingClaim` are not referenced or modified by any task in this plan.
- **The Req 2.8 mock limitation is expected, not a test-writing failure**: design.md explicitly documents that the mock Supabase harness's synchronous `unsubscribe()` cannot reproduce the real client's asynchronous teardown race. Task 1's sub-case 5 and task 13 both carry this limitation forward as a documented outcome rather than treating it as an unresolved exploration test — the guard itself (task 9) is still implemented and verified via direct unit testing of the guard function/closure (task 10), independent of the mock's ability to reproduce the race end-to-end.
- **Task 17 is a deliberate, non-automated gate**: it is included in this plan specifically so the real-browser acceptance test, the optional cross-device test, and the completion summary from bugfix.md's Required Final Acceptance Criteria are not silently dropped from the implementation workflow. Completing tasks 1-16 alone does NOT make this spec done.
