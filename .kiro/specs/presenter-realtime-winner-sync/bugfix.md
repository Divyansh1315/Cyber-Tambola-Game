# Bugfix Requirements Document

## Introduction

The Presentation View (projector screen, `src/pages/PresentationView/PresentationView.tsx`) is supposed to be a strictly read-only mirror of the central game session store, driven entirely by Host actions. Four related defects break that contract around Winner display and game-reset/game-end handling:

- **Problem A**: after the Host resets the game or starts a new game, the Presenter can continue showing the previous game's Winner.
- **Problem B**: the Winner announcement lifecycle is wrong. It is currently dismissed by a manual "Dismiss Winner Announcement" button rendered directly on the Presenter screen, driven by component-local React state (`dismissedWinnerIds`, a `useState<Set<string>>` inside `PresentationView`). This violates the read-only contract (Presenter must never have a self-dismiss affordance) and the dismissal is not synchronized through shared state, so a Presenter refresh loses track of which Winner was already dismissed. The correct flow is: Host confirms Winner → Presenter immediately shows the announcement → it stays visible with no timer → it clears only when the Host clicks "Next Cyber Word."
- **Problem C**: there is no Final Winner Summary. The `game.status === 'COMPLETED'` branch in `PresentationView.tsx` only renders a static "Game Completed" message with a 🏁 icon — it never reads `state.winners`/`state.winnerHistory` or lists the five prize categories and their winners.
- **Problem D**: Presenter must fully reset with a new game and must not retain any stale previous-game artifact (announcement, summary, current word, called-word history, round, game code, status).

Investigation of the current implementation (`src/pages/PresentationView/PresentationView.tsx`, `src/state/gameSessionReducer.ts`'s `RESET_GAME`/`NO_ACTIVE_GAME`/`CONFIRM_CLAIM` cases, `src/state/GameSessionContext.tsx`'s pointer-follow effect and `isBackendConfirmed`/`hasActiveGame` signals, `src/types/prize.ts`'s `Winner` type) confirms the following, read directly from the code rather than assumed:

- `PresentationView`'s only notion of "which Winner is currently showing" is `findLatestUndismissedWinner(state.winners, dismissedWinnerIds)`, where `dismissedWinnerIds` is local component state seeded empty on every mount. This is the entire mechanism behind Problems A and B: it is not keyed off any Host action (there is no "Next Cyber Word was clicked" signal at all — nothing in `PresentationView.tsx` reacts to `currentTerm`/round changes to clear a shown Winner), it is not shared/authoritative (a Presenter refresh resets `dismissedWinnerIds` to empty, which can resurrect an already-dismissed Winner from `state.winners` since Winners are never removed from that array by anything other than `RESET_GAME`), and it exposes a manual dismiss button the Presenter should never have.
- `RESET_GAME` (`gameSessionReducer.ts`) already does the right thing for the underlying data: it returns `{ ...gameSessionInitialState, game: createSeedGame(generateLocalGameCode()), winnerHistory: [...state.winnerHistory, ...state.winners] }`. This folds the just-finished session's `winners` into the permanent `winnerHistory` array and resets `winners`, `claims`, `players`, `tickets`, `game.revealedTermIds`, `game.currentRound`, and `game.code` to the fresh seed game's values in one atomic replace. **This is confirmed correct and is treated below as a Preservation (Unchanged Behavior) requirement, not something this spec fixes.** The defect is entirely that `PresentationView`'s own local `dismissedWinnerIds` state is not reset by this transition (a fresh mount gets an empty `Set` either way, but a Presenter tab that stays mounted across the reset keeps whatever `Set` it already had, and more importantly keeps rendering whatever stale `latestWinner` logic produces against the new, now-empty `state.winners` — which does correctly clear once `RESET_GAME` lands, but there is no FINAL_RESULTS/summary state being cleared because none currently exists).
- `NO_ACTIVE_GAME` (`gameSessionReducer.ts`) resets to `{ ...gameSessionInitialState, currentPlayerId: state.currentPlayerId }`, which also clears `winners`/`claims`/`game` to initial values. Confirmed correct and preserved as-is.
- `GameSessionContext.tsx`'s pointer-follow effect (the `subscribeToActiveGamePointer` callback) already unsubscribes the old per-game Realtime channel (`gameChannel?.unsubscribe()`) before subscribing to the new game id's channel, and no-ops when the announced id equals the already-tracked `gameIdRef.current`. `hydrateForGame` replaces state wholesale via `HYDRATE_FROM_REMOTE` for the new game. This pointer-switch mechanism is confirmed structurally sound for avoiding a stale *subscription* surviving a Reset.
- However, `SYNC_REMOTE`'s per-table cases (`games`, `called_terms`, `tickets`, `players`, `marks`) apply an incoming row change with no explicit check that the change's own `game_id` equals `state.game.id`. Correctness today relies entirely on there only ever being one live per-game channel subscribed at a time (per the point above). Whether a race exists where a late-arriving event from the just-torn-down old channel could still be in flight and get applied after the new channel's subscription (and possibly after a `HYDRATE_FROM_REMOTE` for the new game) has not been empirically confirmed and is called out below as an item requiring an exploration test, not asserted as broken.
- `toAnnouncementViewModel` (`PresentationView.tsx`) currently returns only `{ prizeLabel, playerName }`, built from `winner.prizeLabel`/`winner.playerName` — i.e. it already excludes Employee ID, internal Player ID, Supabase ids, and claim validation codes, matching the report's requirement. Adding `ticketRef` (`Winner.ticketRef` already exists on the type in `src/types/prize.ts`) to this view-model's output is in scope for this fix and must preserve that same exclusion list.
- `CONFIRM_CLAIM` (`gameSessionReducer.ts`) only ever creates a `Winner` from a claim whose `hostDecision` passes `canConfirmClaim(claim, state.winners)` — there is no path in the reducer that creates a `Winner` from a non-confirmed claim. `state.winners` therefore already only ever contains confirmed winners; this is preserved as-is. The Final Winner Summary this spec adds must read from `state.winners`/`state.winnerHistory` (both exclusively confirmed) and must not read `state.claims` for display.
- There is currently no shared/authoritative field distinguishing "the Winner that should currently be announced" from "a Winner that exists in history but has already been superseded by a later Next-Cyber-Word action." This is the structural gap behind Problem B and must be closed with an explicit shared signal (not Presenter-local-only state), so a Presenter refresh mid-announcement still shows the Winner, and a Presenter refresh after Next Cyber Word was clicked does not resurrect it.

This document defines the required fix behavior and the behavior that must remain unchanged, expressed as a bug condition so the fix can be checked systematically rather than patched around the four symptom reports individually.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the Host resets the game or starts a new game THEN the Presentation screen may continue displaying a Winner announcement, a Final Winner Summary, or other state that belonged to the previous game, because no mechanism exists to clear a currently-displayed Winner announcement in sync with the reset

1.2 WHEN the Host confirms a Winner THEN the Presenter's decision to keep showing that Winner announcement, and to later stop showing it, is governed entirely by a Presenter-local `useState<Set<string>>` (`dismissedWinnerIds`) and a manual "Dismiss Winner Announcement" button rendered on the Presenter screen itself, rather than by any Host action (there is no code path that reacts to the Host clicking "Next Cyber Word" to clear the announcement)

1.3 WHEN the Presentation screen is refreshed while a Winner announcement is (or was) being shown THEN the system re-initializes `dismissedWinnerIds` to an empty `Set`, so the displayed Winner either incorrectly disappears (if some other state changed) or incorrectly reappears/persists based purely on reconstructed local state rather than shared, authoritative "is this announcement still active" state

1.4 WHEN the Host sets the game's status to `COMPLETED` THEN the Presentation screen renders only a static "Game Completed" message and never displays a Final Winner Summary listing the five prize categories (Cyber Five, Firewall Line, Security Line, Data Defender Line, Cyber Full House) and each category's confirmed winner or "No Winner"

1.5 WHEN the Presentation screen's `game.status === 'COMPLETED'` branch is reached THEN the system does not read `state.winners`/`state.winnerHistory` at all, so there is no way for a summary to be derived even manually

1.6 WHEN a Reset creates a brand-new game id THEN it has not been empirically confirmed (only structurally reasoned about) that a late-arriving Realtime event from the old, just-unsubscribed game channel can never be applied to the new game's state via `SYNC_REMOTE`, since `SYNC_REMOTE`'s per-table cases apply incoming row changes with no explicit `row.game_id === state.game.id` guard

### Expected Behavior (Correct)

2.1 WHEN the Host confirms a Winner THEN the Presentation screen SHALL immediately display that Winner's announcement (prize category, winner name, ticket reference, congratulatory message — never Employee ID, internal Player ID, Supabase ids, or claim validation codes) and SHALL keep it visible with no timer and no Presenter-side dismiss affordance

2.2 WHEN the Host clicks "Next Cyber Word" while a Winner announcement is being shown on the Presenter THEN the Presentation screen SHALL stop showing that Winner announcement and SHALL display the newly-called Cyber Word instead

2.3 WHEN "which Winner announcement is currently active" is determined THEN the system SHALL derive or store this using shared/authoritative state (not Presenter-local-only React state), so that: (a) if the Host has not yet called Next Word since confirming a Winner, refreshing the Presenter SHALL still show that Winner; and (b) if the Host has already called Next Word since confirming a Winner, refreshing the Presenter SHALL show the current Cyber Word (or Lobby, as applicable) and SHALL NOT resurrect the superseded Winner announcement

2.4 WHEN the Host sets the game's status to `COMPLETED` THEN the Presentation screen SHALL stop showing the current Cyber Word screen and SHALL display a Final Winner Summary listing all five prize categories (Cyber Five, Firewall Line, Security Line, Data Defender Line, Cyber Full House), each showing its confirmed winner's name (and ticket reference) or "No Winner" if that category has no confirmed winner for the active game

2.5 WHEN the Final Winner Summary is rendered THEN the system SHALL derive it live from `state.winners` filtered to the active game and to confirmed winners only (consistent with `CONFIRM_CLAIM`'s existing confirmed-only invariant), never from a hardcoded or cached list, and SHALL NEVER display a pending, rejected, or otherwise non-confirmed claim as if it were a winner

2.6 WHEN the Host resets the game or starts a new game THEN the Presentation screen SHALL immediately reset to the new game's state and SHALL NOT retain any of: the previous game's Winner announcement, the previous game's Final Winner Summary, the previous game's current Cyber Word, the previous game's called-word history, the previous round, the previous Game Code, or the previous game status

2.7 WHEN a Reset creates a new game id THEN the Presenter SHALL unsubscribe from the old game's Realtime channel and subscribe to the new one (already true structurally via the pointer-follow effect) AND, whether the reset creates a new game id or reuses the same one, the Presenter SHALL correctly consume the reset shared state (cleared Winner-announcement signal, cleared current term, reset round, new/reset code) either way

2.8 WHEN a Realtime event is evaluated for application to local state THEN, if investigation finds a reachable case where a delayed/stale event from an old game id could be applied to a newer game's state, the system SHALL add a guard requiring the incoming event's `game_id` to equal the currently active game's id before applying it

2.9 WHEN the Winner announcement view-model is extended to include a ticket reference THEN the system SHALL continue to exclude Employee ID, internal Player ID, Supabase ids, and claim validation codes from anything rendered on the Presenter

2.10 WHEN the Presenter's display mode is determined for any given state THEN the system SHALL follow this explicit priority: (1) if the game status is `COMPLETED`, show FINAL_RESULTS (never the current word); else (2) if there is an active, not-yet-superseded Winner announcement, show WINNER (not the word); else (3) if the game is active and has a current term, show WORD; else (4) show LOBBY (game code + QR)

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `RESET_GAME` is dispatched THEN the system SHALL CONTINUE TO fold the just-finished session's `state.winners` into `state.winnerHistory` (never dropping prior entries) and reset `winners`, `claims`, `players`, `tickets`, `game.revealedTermIds`, `game.currentRound`, and `game.code` to the fresh seed game's values, exactly as `gameSessionReducer.ts`'s current `RESET_GAME` case already does

3.2 WHEN `NO_ACTIVE_GAME` is dispatched THEN the system SHALL CONTINUE TO reset `game`/`players`/`tickets`/`marks`/`claims`/`winners` to initial values while preserving `currentPlayerId`, exactly as today

3.3 WHEN `CONFIRM_CLAIM` is dispatched THEN the system SHALL CONTINUE TO only ever create a `Winner` record from a claim that passes `canConfirmClaim`, and SHALL CONTINUE TO NEVER create a `Winner` from a pending, rejected, or otherwise non-confirmed claim

3.4 WHEN the Host dispatches any action unrelated to Winner announcement, game completion, or game reset (e.g. marking terms, calling the next word under normal mid-game play, rejecting a claim) THEN the Presentation screen SHALL CONTINUE TO behave exactly as today for the LOBBY, WORD_ACTIVE, and PAUSED display states, including the existing lobby QR/Game Code rendering, the circuit background decoration, and the Cyber Word/definition/awareness-tip layout

3.5 WHEN the Presenter's pointer-follow effect (`GameSessionContext.tsx`'s `subscribeToActiveGamePointer` handling) observes a new Active Game id THEN the system SHALL CONTINUE TO unsubscribe the old per-game Realtime channel before subscribing to the new one, and SHALL CONTINUE TO no-op when the announced id equals the already-tracked active game id, exactly as today

3.6 WHEN Supabase is not configured (Local Fallback / dev mode) THEN the system SHALL CONTINUE TO support the full Host-confirms-winner → Presenter-shows-announcement → Host-calls-next-word → Presenter-shows-word flow using the existing local reducer logic, with no dependency on this fix requiring a live Supabase connection to function

3.7 WHEN work is performed under this spec THEN it SHALL CONTINUE TO occur only on the `deployment` branch; the `main` branch SHALL NOT be touched, committed to, or merged into as part of this fix

3.8 WHEN this fix is implemented THEN it SHALL CONTINUE TO NOT redesign the Host Dashboard, Player screens, or any Presenter screen beyond what is strictly required to remove the manual-dismiss button and add the Winner-announcement/Final-Summary display logic, and SHALL CONTINUE TO NOT change prize rules, prize categories, or `prizeEngine.ts`/`claimEngine.ts` validation logic

3.9 WHEN the QR/Game Code is rendered on the Lobby display mode THEN the system SHALL CONTINUE TO show the currently active game's own code and QR (never a stale code/QR from a previous game), and this SHALL be true immediately after a reset exactly as it is true today in the non-reset case

## Bug Condition (for reference during design/testing)

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type PresenterStateTransition
         { priorGameId, currentGameId,
           winnerJustConfirmed: boolean,       // a Winner was confirmed and no Next Word has been called since
           nextWordCalledSinceWinner: boolean, // Host clicked Next Cyber Word since that Winner was confirmed
           gameStatus: 'LOBBY' | 'WORD_ACTIVE' | 'PAUSED' | 'COMPLETED',
           presenterRefreshed: boolean,
           resetOccurred: boolean }
  OUTPUT: boolean

  // True whenever the Presenter's rendered display mode would disagree with
  // the priority rule in Req 2.10, given the current shared/authoritative
  // state -- i.e. whenever Presenter-local-only state (dismissedWinnerIds)
  // or a missing FINAL_RESULTS/reset-clearing mechanism would cause it to
  // show the wrong thing.
  RETURN (X.resetOccurred AND NOT fullyResetToNewGame(X))
      OR (X.gameStatus = 'COMPLETED' AND NOT showingFinalResultsSummary(X))
      OR (X.winnerJustConfirmed AND NOT X.nextWordCalledSinceWinner AND NOT showingWinnerAnnouncement(X))
      OR (X.nextWordCalledSinceWinner AND showingWinnerAnnouncement(X))
      OR (X.presenterRefreshed AND renderedDisplayMode(X) <> expectedDisplayMode(X))
END FUNCTION
```

```pascal
// Property 1: Fix Checking - Correct Display Mode At All Times
FOR ALL X WHERE isBugCondition(X) DO
  result ← presenterDisplayMode'(X)
  ASSERT result = expectedDisplayMode(X)
     AND (X.gameStatus = 'COMPLETED' IMPLIES result = 'FINAL_RESULTS')
     AND (result = 'FINAL_RESULTS' IMPLIES allFiveCategoriesShown(result) AND onlyConfirmedWinnersShown(result))
     AND (result = 'WINNER' IMPLIES noEmployeeOrInternalIdsShown(result))
END FOR
```

```pascal
// Property 2: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT presenterDisplayMode(X) = presenterDisplayMode'(X)
  // i.e. ordinary LOBBY / WORD_ACTIVE / PAUSED rendering, pointer-follow
  // channel subscribe/unsubscribe behavior, RESET_GAME's winners->
  // winnerHistory fold, NO_ACTIVE_GAME's reset, and CONFIRM_CLAIM's
  // confirmed-only invariant are all byte-for-byte unchanged by the fix.
END FOR
```

## Required Regression Test Coverage

The following specific test scenarios are non-negotiable acceptance criteria for this fix and MUST be covered (as exploration, fix-checking, or preservation tests, per the design/tasks phases) before this spec is considered complete:

- **winner-announcement-then-next-word-clears-it**: confirming a Winner shows the announcement on the Presenter; clicking "Next Cyber Word" clears it and shows the newly-called word, with no timer involved.
- **reset-clears-winner-and-returns-to-lobby**: resetting the game while a Winner announcement (and/or Final Summary) is showing immediately clears it and returns the Presenter to Lobby (or Word, per the new game's actual state) with no stale previous-game artifact visible.
- **end-game-shows-full-summary-all-five-categories**: setting game status to `COMPLETED` shows a Final Winner Summary listing all five prize categories.
- **missing-winners-show-no-winner-per-category**: any prize category with no confirmed winner for the active game renders "No Winner" in the Final Summary, never a pending/rejected claim.
- **new-game-pointer-switch-unsubscribes-old-subscribes-new-no-stale-winner-leaks**: when the Active Game pointer switches to a new game id, the Presenter unsubscribes the old Realtime channel, subscribes to the new one, and no Winner/word/summary from the old game leaks into the new game's display.

## Required Final Acceptance Criteria

This fix is not considered complete, and the implementation workflow is not considered finished, until BOTH of the following are satisfied and recorded, consistent with the completion-summary convention already established by `.kiro/specs/claim-player-ticket-identity-mismatch/` and `.kiro/specs/claim-duplicate-submission/`:

**A. Mandatory manual real-browser Host+Presenter full-flow test.** A manual, real-browser (not automated/headless) acceptance test MUST be executed during the implementation workflow, opening a real Host tab and a real Presenter tab: reset → confirm Lobby shows the new game's code/QR → start the game → call a word → confirm a Winner → confirm the Winner stays visible on the Presenter for at least 5 seconds with no auto-hide → click Next Cyber Word → confirm the Winner is cleared and the new word is shown → confirm another Winner for a different prize → click Next Cyber Word → confirm it clears again → end the game → confirm the Final Winner Summary shows all five categories correctly → reset → confirm everything (announcement, summary, word, round, code) is cleared. This MUST be recorded as completed (or explicitly noted as not yet executed, with reason) before the fix is considered done. A cross-device variant of this test (Host and Presenter on separate physical devices) is optional but SHOULD be attempted and its result recorded either way.

**B. Completion summary.** Upon completing implementation, a summary MUST be produced and recorded covering at minimum: root cause confirmation for each of Problems A-D; the specific shared/authoritative mechanism added to track the active Winner announcement; whether a `game_id` guard was added to `SYNC_REMOTE` (Req 2.8) and why/why not; files modified; the five required regression test results (listed above); the manual real-browser full-flow test result (Req A above); the optional cross-device test result or explicit note that it was not attempted; `npm run build` result; commit hash; and confirmation that the `main` branch was not touched.

This summary requirement is carried forward as a final acceptance criterion for the design and tasks phases of this spec, and MUST be satisfied at the end of implementation, not merely planned.
