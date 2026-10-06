# Implementation Plan

## Overview

This plan fixes the Player/Ticket identity mismatch bug: a stale `currentPlayerId` can survive a Reset (or an unconfirmed backend hydration) and still be rendered and submitted for a prize claim, even though it no longer belongs to the confirmed Active Game. The fix adds a single `getActivePlayerSession()` resolver and a real `isBackendConfirmed` signal to `GameSessionContext.tsx`, gates claim submission (not rendering) on session consistency, clears stale `currentPlayerId` once the backend is confirmed, and surfaces a distinct recovery message — all without touching `claimEngine.ts` or any `submit_claim`/RPC validation gate, which remain the unchanged server-side backstop. Work proceeds via the bug-condition methodology: exploration (task 1) and preservation (task 2) tests are written and run against the unfixed code first, the fix is implemented and tested in tasks 3-13, then re-verified end-to-end in tasks 14-17.

## Tasks

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Stale Player/Ticket Identity Survives Reset and Is Submitted Unchecked
  - **IMPORTANT**: Write this property-based test BEFORE implementing the fix
  - **GOAL**: Surface counterexamples that demonstrate the bug exists, reproducing the reported incident shape (stale `currentPlayerId` across a Reset resolves to a different Ticket server-side than the one rendered)
  - Use the existing mock Supabase test harness (`src/state/testSupport/mockSupabaseClient.ts`), following the pattern already established by `GameSessionContext.multiTabReset.integration.test.tsx` and `realtimeClient.activeGamePointer.test.ts`
  - Add a new test file `src/state/sessionConsistencyGuard.exploration.test.tsx`
  - **Scoped PBT Approach**: Scope the property to the concrete reported shape plus the two deterministic variants from design.md's Exploratory Bug Condition Checking section:
    1. Join Game A, trigger `reset_game_to_new` (Game B becomes Active), assert `currentPlayer`/`currentTicket` are STILL non-undefined and fully resolved on the unfixed code even though they reference Game A, not the confirmed Active Game B (`isBugCondition` per design.md: `NOT resolvedPlayer(X).gameId = X.activeGameId`)
    2. From that same stale state, dispatch `SUBMIT_PRIZE_CLAIM`; assert (unfixed) `rpcSubmitClaim`/the mock's `submitClaim` is invoked with the stale `playerId`, with no client-side pre-check blocking it
    3. Simulate `isHydrated === true` immediately on mount before the mock's `getActiveGame()` promise has settled (i.e. `backendConfirmed = false`); assert claim submission is not blocked despite the backend snapshot being unconfirmed (`isBugCondition`: `NOT X.backendConfirmed`)
  - Test implementation details from the Bug Condition in design.md (`isBugCondition(X)` formal spec, `ClaimSubmissionContext` shape: `localCurrentPlayerId`, `localPlayers`, `localTickets`, `backendConfirmed`, `activeGameId`)
  - The test assertions should match Property 1 from design.md's Correctness Properties ("Claim Submission Blocked for Unconfirmed/Inconsistent Session") — i.e. on FIXED code these same scenarios must flip to blocked; on UNFIXED code they must demonstrate the opposite
  - Run test on UNFIXED code (current `GameSessionContext.tsx`/`gameSessionReducer.ts`)
  - **EXPECTED OUTCOME**: Test FAILS (or its assertions demonstrating the bug PASS against unfixed code, depending on how you phrase them — either way, document that the counterexample reproduces) — this confirms the bug exists
  - Document the counterexamples found: (a) `currentPlayer`/`currentTicket` remain defined using data no longer belonging to the confirmed Active Game, (b) `rpcSubmitClaim` is invoked with a `playerId` that does not resolve to a player in the confirmed Active Game — the exact `PLAYER_NOT_IN_GAME` condition from the incident report
  - Mark task complete when test is written, run, and failure/counterexample is documented
  - _Requirements: 1.1, 1.2, 1.5_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Consistent Session Claim Submission Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Add a new test file `src/state/sessionConsistencyGuard.preservation.test.tsx`
  - Observe on UNFIXED code: a genuinely consistent session (fresh join, `activePlayer.gameId === activeGame.id`, `activeTicket.playerId === activePlayer.id && activeTicket.gameId === activeGame.id`, backend confirmed) — join → mark to Cyber Five eligibility → claim — and record the exact sequence of dispatched actions, the exact `rpcSubmitClaim(playerId, prizeId)` call arguments, and the resulting `claims` entry's `ticketRef`/`playerName`
  - Write a property-based test (e.g. using `fast-check`, matching whatever PBT library is already a devDependency in `package.json` — reuse it rather than adding a new one) that generates random `(player.gameId, ticket.playerId, ticket.gameId, activeGame.id, isBackendConfirmed)` tuples restricted to the NON-bug-condition region (`isBugCondition(X) = false`) and asserts the observed baseline behavior holds for every generated tuple: same RPC call, same resulting claim, same rendered Ticket reference
  - Also cover, as concrete (non-PBT) cases backing the same property: refresh mid-session restores the same identity and submits identically; Local Fallback (no Supabase configured) is unaffected (guard trivially passes)
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve — the unfixed code already behaves correctly for the non-bug-condition region, since the defect only manifests under `isBugCondition(X) = true`)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.3, 3.5, 3.7, 3.8_

- [x] 3. Add `isBackendConfirmed` signal to `GameSessionContext.tsx`
  - [x] 3.1 Add `isBackendConfirmed` state and wire its transitions
    - Add `const [isBackendConfirmed, setIsBackendConfirmed] = useState<boolean>(true)` in `GameSessionProvider`, parallel to the existing `hasActiveGame` state
    - Set to `false` the moment the mount-time effect finds Supabase configured and calls `setRemoteSyncStatus('syncing')` (before `resolveInitialGame(1)` is invoked)
    - Set to `true` inside `hydrateForGame(...)`, immediately after `dispatch({ type: 'HYDRATE_FROM_REMOTE', snapshot })` and `setHasActiveGame(true)`
    - Set to `false` again whenever `NO_ACTIVE_GAME` is dispatched (both in `resolveInitialGame`'s else-branch and in `subscribeToActiveGamePointer`'s `newActiveGameId === null` branch), and when a pointer-change event triggers a new `getActiveGame()`/`hydrateForGame` round trip (set `false` before calling `hydrateForGame`, matching the "syncing" semantics), until that round trip's own `HYDRATE_FROM_REMOTE` lands
    - Do NOT use this to gate `isHydrated` or change its value/meaning — `isHydrated` stays hardcoded `true` exactly as today (Req 2.4, 3.3)
    - _Bug_Condition: isBugCondition(X) where X.backendConfirmed = false_
    - _Expected_Behavior: isBackendConfirmed is true only once HYDRATE_FROM_REMOTE for the live Active Game has completed, or Supabase is not configured_
    - _Requirements: 2.4_

  - [x] 3.2 Expose `isBackendConfirmed` on `GameSessionContextValue`
    - Add `isBackendConfirmed: boolean` to the `GameSessionContextValue` interface with a doc comment distinguishing it from `isHydrated` (mirroring the design.md Glossary entry)
    - Include it in the `value` memo's return object and its dependency array
    - _Requirements: 2.1, 2.4_

- [x] 4. Implement `getActivePlayerSession()` resolver and wire derived selectors to use it
  - [x] 4.1 Implement `getActivePlayerSession()` inside the `value` memo in `GameSessionContext.tsx`
    - Add the function per design.md's Fix Implementation point 2, returning `{ activeGame, activePlayer, activeTicket, isConsistent, inconsistencyReason? }` with `inconsistencyReason` one of `'NOT_BACKEND_CONFIRMED' | 'PLAYER_NOT_FOUND' | 'PLAYER_NOT_IN_GAME' | 'TICKET_NOT_FOUND' | 'TICKET_NOT_OWNED_BY_PLAYER'`
    - Resolution order: `activeGame := state.game`; `activePlayer := state.players.find(p => p.id === state.currentPlayerId)`; `activeTicket := state.tickets.find(t => t.playerId === activePlayer?.id && t.gameId === activeGame.id)` (deterministic single-ticket resolution per Req 2.6 — never "first ticket in array")
    - `isConsistent := isBackendConfirmed && !!activePlayer && !!activeTicket && activePlayer.gameId === activeGame.id && activeTicket.playerId === activePlayer.id && activeTicket.gameId === activeGame.id`
    - Set `inconsistencyReason` to the first failing check, in the order: not backend confirmed, player not found, player not in game, ticket not found, ticket not owned by player — so each failure is independently attributable (matching the dev-diagnostic reason codes)
    - Keep the function pure given `state`/`isBackendConfirmed` (no side effects), so it is safe to call from both the render-time memo and the submission guard
    - _Bug_Condition: isBugCondition(X) from bugfix.md / design.md_
    - _Expected_Behavior: getActivePlayerSession().isConsistent matches the exact boolean formula in the Bug Condition's formal specification_
    - _Requirements: 2.1, 2.2, 2.6, 2.7_

  - [x] 4.2 Rewire `currentPlayer`/`currentTicket`/`currentPlayerMarks`/`currentPrizeProgress` to derive from the resolver
    - Replace the existing standalone `state.players.find(...)`/`state.tickets.find(...)` derivation in the `value` memo with a call to `getActivePlayerSession()`, then derive `currentPlayer`/`currentTicket` from its `activePlayer`/`activeTicket` output
    - Continue to use the resolver's `activePlayer`/`activeTicket` output **unconditionally** (i.e. even when `isConsistent` is `false`) for `currentPlayer`/`currentTicket`/`currentPlayerMarks`/`currentPrizeProgress` — this preserves today's no-flicker optimistic rendering (Req 2.4); only claim *submission* (task 5) is gated on `isConsistent`
    - _Expected_Behavior: UI rendering is unaffected by isConsistent; only submission is gated (Req 2.4)_
    - _Preservation: Preservation Requirements from design.md — refresh mid-session, Local Fallback, duplicate-name-different-devices all continue rendering exactly as today_
    - _Requirements: 2.1, 2.4, 2.6, 2.7_

- [x] 5. Add the pre-submission session consistency guard in `wrappedDispatch`
  - [x] 5.1 Add an ephemeral `lastSessionGuardFailure` provider-local state
    - Add `const [lastSessionGuardFailure, setLastSessionGuardFailure] = useState<SessionGuardFailure | undefined>(undefined)` inside `GameSessionProvider`, where `SessionGuardFailure` carries at least `{ prizeId: PrizeId; reason: InconsistencyReason }`
    - This is purely ephemeral UI feedback — never written to `localStorage`, never broadcast via `syncChannel`, never added to the shared envelope or `SharedStatePayload`
    - Clear it on the next successful consistent submission or on navigation away from `PlayerGame`
    - Expose it on `GameSessionContextValue` (e.g. as `lastSessionGuardFailure`)
    - _Preservation: SESSION_GUARD_BLOCKED is not shared/persisted state, per design.md Fix Implementation point 4_
    - _Requirements: 2.3_

  - [x] 5.2 Implement the guard inside `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` case
    - Immediately before the existing `rpcSubmitClaim(action.playerId, action.prizeId).catch(rollback)` call, call `getActivePlayerSession()` against `before` (the state captured at the top of `wrappedDispatch`), consistent with how `resolveRollbackTarget` already uses `before`/`after`
    - If `isConsistent` is `false`:
      - Do NOT call `rpcSubmitClaim`
      - Do NOT fabricate/synthesize a replacement ticket or player
      - Call `rollback()` (the same helper already wired via `resolveRollbackTarget`) so the optimistic claim entry added earlier in `wrappedDispatch` is removed rather than left dangling as a phantom PENDING claim the backend never saw
      - Call `setLastSessionGuardFailure({ prizeId: action.prizeId, reason: inconsistencyReason })`
      - Log dev-only diagnostics (task 6)
    - If `isConsistent` is `true`: proceed exactly as today — unchanged call to `rpcSubmitClaim`, same rollback-on-rejection behavior, byte-for-byte unchanged (Property 2)
    - _Bug_Condition: isBugCondition(input) — backend not confirmed, or activePlayer/activeTicket/activeGame disagree_
    - _Expected_Behavior: expectedBehavior(result) — result.submitted = false AND result.message = userFriendlyRecoveryMessage AND result.devDiagnosticsLogged = true AND result.secretsLogged = false (design.md Property: Fix Checking)_
    - _Preservation: Preservation Requirements from design.md Property 2 — consistent-session submissions produce an identical RPC call and claim entry to pre-fix behavior_
    - _Requirements: 2.2, 2.3, 2.7_

- [x] 6. Add dev-only diagnostic logging on guard failure
  - In the guard-failure branch from task 5.2, add a single structured log call gated behind `import.meta.env.DEV`, e.g. `if (import.meta.env.DEV) console.warn('[session-guard]', { activeGameId, currentPlayerId, activeTicketId, inconsistencyReason })`
  - Log exactly: `ACTIVE_GAME_ID` (`state.game.id`), `CURRENT_PLAYER_ID` (`state.currentPlayerId`), `ACTIVE_TICKET_ID` (`activeTicket?.id`), and `inconsistencyReason` — no display names, no device join tokens, no host secrets, no full `players`/`tickets` arrays
  - Implement as a single `console.warn('[session-guard]', { ... })` call (or a tiny local helper if it ends up reused in more than one place) so it is trivially greppable and removable as one line/block
  - Note for later: this logging is temporary per design.md's "Temporary Diagnostic Logging" section — task 11 handles its removal/down-leveling after verification
  - _Expected_Behavior: devDiagnosticsLogged = true AND secretsLogged = false (design.md Property: Fix Checking)_
  - _Requirements: 2.3_

- [x] 7. Add `CLEAR_STALE_PLAYER` reducer action and stale-identity invalidation effect
  - [x] 7.1 Add the `CLEAR_STALE_PLAYER` action and reducer case
    - In `gameSessionReducer.ts`, add `| { type: 'CLEAR_STALE_PLAYER' }` to the `GameSessionAction` union, documented alongside the other additive Module-6-era actions
    - Add the reducer case: `case 'CLEAR_STALE_PLAYER': return { ...state, currentPlayerId: undefined }`, mirroring `RESTORE_PLAYER`'s existing "ignore if absent" convention but for the inverse case — no existing case is modified
    - _Bug_Condition: currentPlayerId does not resolve to a Player with gameId equal to the confirmed Active Game's id (design.md Property 3)_
    - _Expected_Behavior: currentPlayerId is cleared, never silently continuing to render the stale resolution (Req 2.5)_
    - _Requirements: 2.5_

  - [x] 7.2 Add the stale-identity invalidation effect in `GameSessionProvider`
    - Add a new `useEffect` that runs whenever `isBackendConfirmed` flips to `true` (depend on `isBackendConfirmed` and `state.currentPlayerId`/`state.game.id`/`state.players`)
    - Compute `activePlayer := state.players.find(p => p.id === state.currentPlayerId)`
    - If `state.currentPlayerId` is set AND (`activePlayer` is undefined OR `activePlayer.gameId !== state.game.id`): dispatch `{ type: 'CLEAR_STALE_PLAYER' }`
    - This effect must NOT run while `isBackendConfirmed` is `false` (mid-retry/no Active Game) — a transient disconnection must never be mistaken for "this player's game is gone" (Req 2.4's cached-render guarantee would otherwise be defeated)
    - No new persistence code is needed: the existing `writeCurrentPlayerId` effect already runs off `state.currentPlayerId` changes and will persist the cleared value
    - No new redirect logic is needed in `PlayerGame.tsx`: its existing `!currentPlayer || !currentTicket` guard fires on the next render exactly as it already does for a device with no `currentPlayerId` at all
    - _Bug_Condition: isBugCondition — stale currentPlayerId after Reset (design.md Property 3)_
    - _Expected_Behavior: currentPlayerId is cleared and the device is routed back through the normal join/restore flow, exactly like a device with no currentPlayerId at all_
    - _Preservation: this effect must not fire during a transient disconnect (Req 2.4, 3.3)_
    - _Requirements: 1.5, 2.5_

- [x] 8. Add the distinct recovery message in `PlayerGame.tsx`
  - Read `lastSessionGuardFailure` from `useGameSession()`
  - When set and its `prizeId` matches the prize block currently being rendered, render a distinct recovery message instead of the existing per-prize `claimStatusView` message — worded distinctly from the generic `"Claim could not be validated. Your current progress is X/Y."` string (Req 2.3), e.g. `"Your session is out of date. Please refresh or rejoin to continue."`
  - Include a visible "Refresh" action, reusing the existing `Button`/`Card` components already used for the `remoteSyncStatus === 'error'` notice, for visual consistency
  - Do NOT change the `Navigate to="/player"` redirect guard itself — it continues to fire purely off `currentPlayer`/`currentTicket` being absent (unchanged by this task; task 7.2 is what makes that guard correctly fire for a stale identity)
  - _Expected_Behavior: a distinct, user-friendly recovery message is shown, separate from the generic "could not be validated" message (Req 2.3)_
  - _Requirements: 2.3_

- [x] 9. Unit tests for `getActivePlayerSession()`
  - Add `src/state/getActivePlayerSession.test.ts` (or colocate in a `GameSessionContext.*.test.tsx` file matching existing naming conventions in `src/state/`)
  - Cover: existence checks (missing player → `PLAYER_NOT_FOUND`; missing ticket → `TICKET_NOT_FOUND`), each of the four cross-id agreement checks individually so a failure in any one is independently attributable (`activePlayer.gameId !== activeGame.id` → `PLAYER_NOT_IN_GAME`; `activeTicket.playerId !== activePlayer.id` → `TICKET_NOT_OWNED_BY_PLAYER`; `activeTicket.gameId !== activeGame.id` → `PLAYER_NOT_IN_GAME` or `TICKET_NOT_OWNED_BY_PLAYER` per the resolution order chosen in task 4.1), and the `isBackendConfirmed` gate (`NOT_BACKEND_CONFIRMED`)
  - Include a property-based test generating random `(player.gameId, ticket.playerId, ticket.gameId, activeGame.id, isBackendConfirmed)` tuples and asserting `isConsistent` matches the exact boolean formula from the Bug Condition's formal specification for every generated tuple
  - _Requirements: 2.1, 2.2, 2.6, 2.7_

- [x] 10. Unit tests for the pre-submission guard in `wrappedDispatch`
  - Add `src/state/sessionConsistencyGuard.unit.test.tsx` (or extend `gameSessionReducer.submitClaim.test.ts`'s sibling context-level tests if a `GameSessionContext`-level unit test file already exists for `wrappedDispatch`)
  - Cover every failure branch: not backend confirmed; player not found; player not in game; ticket not found; ticket not owned by player — for each, assert `rpcSubmitClaim` is never called, the optimistic claim entry is rolled back (removed from `state.claims`), `lastSessionGuardFailure` is set with the correct `inconsistencyReason`, and (in DEV) the diagnostic log fires with only the four allowed non-sensitive fields
  - Cover the passing branch: assert it is behaviorally identical to today's implementation — same `rpcSubmitClaim(action.playerId, action.prizeId)` call, same optimistic claim entry retained, same payload as today's (pre-fix) behavior, using the baseline captured in task 2's preservation test
  - _Requirements: 2.2, 2.3, 2.7, 3.1, 3.5_

- [x] 11. Unit tests for `CLEAR_STALE_PLAYER` and the stale-identity invalidation effect
  - Add `src/state/gameSessionReducer.clearStalePlayer.test.ts` covering the reducer case directly: clears `currentPlayerId` when it is absent/mismatched against `state.game.id`, and is a no-op when `currentPlayerId` is already `undefined` (consistent with `RESTORE_PLAYER`'s existing style)
  - Add or extend an integration test (e.g. alongside `GameSessionContext.multiTabReset.integration.test.tsx`) covering the effect from task 7.2: dispatches `CLEAR_STALE_PLAYER` only after `isBackendConfirmed` flips to `true` with a mismatched player, and never while `isBackendConfirmed` is `false`
  - _Requirements: 1.5, 2.5_

- [x] 12. Unit test for the `PlayerGame.tsx` recovery message
  - Extend `src/pages/PlayerGame/PlayerGame.test.tsx` (or add `src/pages/PlayerGame/PlayerGame.sessionGuard.test.tsx`) to assert the distinct recovery message from task 8 renders when `lastSessionGuardFailure` is present for the attempted prize, and that the existing per-prize message rendering (including the generic "Claim could not be validated..." string) is otherwise unchanged
  - _Requirements: 2.3_

- [x] 13. Regression tests for each required preserved/fixed scenario
  - Add `src/state/sessionConsistencyGuard.regression.integration.test.tsx` covering, as named test cases:
    1. **Exact ticket match (consistent session)**: join → mark to eligibility → claim; assert the Player screen's `shortTicketRef(currentTicket.id)`, the submitted claim's `ticketRef`, and the eventual Winner History `ticketRef` are identical (Property 4)
    2. **Reset/rejoin uses new ticket only**: Host resets; a Player tab with a now-stale `currentPlayerId` has it cleared once the backend is confirmed for the new Active Game; the Player screen redirects to join; rejoining issues a new ticket, never reusing the retired one (Property 3; Req 3.2)
    3. **Refresh preserves same identity**: a genuinely consistent Player refreshes; `currentPlayerId` restores from `localStorage`; once confirmed, the guard's checks pass trivially; no redirect, no guard failure, claim submission behaves exactly as pre-refresh (Req 3.3)
    4. **Duplicate name, different devices, never merges sessions**: two devices join with the same `displayName`; each gets a distinct `playerId`/`ticketId` via distinct device join tokens; each device's `getActivePlayerSession()` resolves independently and consistently to its own player/ticket, never the other's (Req 3.4)
    5. **Genuinely stale player from a different game still rejected server-side**: construct a `playerId` whose `gameId` really does belong to a different (non-Active) game; assert the client-side guard blocks it with the recovery message BEFORE any RPC call is made; separately, confirm against `submit_claim`'s existing (unchanged) SQL behavior that if such an id were ever submitted anyway, the server still independently rejects it with `PLAYER_NOT_IN_GAME` — proving the server-side gate remains intact as a backstop and was not weakened by this fix (Req 3.5)
    6. **Ticket reference consistency across surfaces**: for a single successfully-submitted, then host-confirmed claim, assert the Ticket reference is identical across the Player screen header, the Host Claim Inbox row for that claim, and the Winner History entry for that confirmed claim (Req 2.8, 3.1, 3.6)
  - _Requirements: 1.5, 2.2, 2.5, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 14. Checkpoint - run the full build and automated test suite
  - Run `npm run build` and fix any type errors introduced by the new `GameSessionContextValue` fields (`isBackendConfirmed`, `lastSessionGuardFailure`) or the new `CLEAR_STALE_PLAYER` action
  - Run the full automated test suite (e.g. `npm test -- --run` or the project's configured non-watch test command) and fix any regressions, paying particular attention to any existing test that asserts on `GameSessionContextValue`'s exact shape or on `currentPlayer`/`currentTicket` derivation timing
  - Do NOT modify, remove, or weaken `src/utils/claimEngine.ts` or any `submit_claim`/`validatePrizeClaim` RPC validation gate (`PLAYER_NOT_FOUND`, `PLAYER_NOT_IN_GAME`, `TICKET_NOT_FOUND`, `TICKET_NOT_OWNED_BY_PLAYER`, `PRIZE_NOT_FOUND`, `DUPLICATE_ACTIVE_CLAIM`, `RESUBMISSION_LIMIT_REACHED`, `PRIZE_CLOSED`, `NOT_ELIGIBLE`) while fixing regressions — those must remain exactly as-is; if a test failure seems to require touching one of these, stop and treat that as a signal the fix has gone out of scope, not something to patch around
  - Confirm every task-1 exploration test now PASSES (bug fixed) and every task-2 preservation test still PASSES (no regressions)
  - Ask the user if questions arise
  - _Requirements: all_

- [x] 15. Verify exploration and preservation tests against the fix
  - [x] 15.1 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Stale Player/Ticket Identity Submission Now Blocked
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior; when it passes, it confirms the expected behavior is satisfied
    - Run the bug condition exploration test from task 1 against the fixed code
    - **EXPECTED OUTCOME**: Test PASSES (confirms the bug is fixed — submission is blocked, optimistic entry rolled back, recovery message/diagnostics surfaced)
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.7_

  - [x] 15.2 Verify preservation tests still pass
    - **Property 2: Preservation** - Consistent Session Claim Submission Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run the preservation property tests from task 2 against the fixed code
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions for every genuinely consistent session)
    - Confirm all tests still pass after the fix (no regressions)
    - _Requirements: 3.1, 3.3, 3.5, 3.7, 3.8_

- [x] 16. Remove or down-level the temporary diagnostic logging
  - Per design.md's "Temporary Diagnostic Logging" section: this happens as a task-execution step once the fix is verified against the full regression test plan (tasks 13-15), not as a separate undocumented follow-up
  - Review the single `console.warn('[session-guard]', { ... })` call added in task 6: if it has proven useful as a permanent, lightweight, dev-only diagnostic (design.md does not mandate removal — it mandates the choice be made deliberately at this point, either removing it or down-leveling it to a quieter signal), keep it exactly as a `import.meta.env.DEV`-gated, non-sensitive, structured log and document that decision in a brief code comment at the call site
  - If instead removed, delete only that single greppable call (and its now-unused helper, if one was extracted) — leave `lastSessionGuardFailure`, the guard logic itself, and the recovery-message UI (tasks 5-8) fully intact; this task only concerns the diagnostic `console.warn`, never the guard's actual blocking behavior
  - Re-run the full test suite once more after this change to confirm nothing depended on the log call's presence
  - _Requirements: 2.3_

- [x] 17. Final checkpoint - ensure all tests pass
  - Run `npm run build` and the full automated test suite one final time
  - Confirm: every exploration test passes, every preservation test passes, every regression test from task 13 passes, and `src/utils/claimEngine.ts` plus every `submit_claim`/`validatePrizeClaim` RPC gate is untouched (byte-identical to the pre-fix version — confirm via `git diff` showing no changes to `src/utils/claimEngine.ts` or any `supabase/migrations/*.sql` file)
  - Ask the user if questions arise
  - _Requirements: all_

## Task Dependency Graph

```
1. Bug condition exploration test (unfixed code)        2. Preservation property tests (unfixed code)
   (independent baseline)                                   (independent baseline)
        \                                                        /
         \                                                      /
          \____________________  both are prerequisites to  ___/
                                 implementation (3-8), but
                                 not to each other
                                        |
                                        v
3. isBackendConfirmed signal (GameSessionContext.tsx)
   3.1 Add state + wire transitions
   3.2 Expose on GameSessionContextValue
                                        |
                                        v
4. getActivePlayerSession() resolver + rewire selectors
   4.1 Implement resolver (depends on 3's isBackendConfirmed)
   4.2 Rewire currentPlayer/currentTicket/marks/prizeProgress (depends on 4.1)
                                        |
                                        v
5. Pre-submission session consistency guard in wrappedDispatch
   5.1 Add lastSessionGuardFailure state
   5.2 Implement guard logic (depends on 4.1's resolver and 5.1's state)
                                        |
                                        v
6. Dev-only diagnostic logging on guard failure
   (depends on 5.2's guard-failure branch existing)
                                        |
                                        v
7. CLEAR_STALE_PLAYER action + stale-identity invalidation effect
   7.1 Add action/reducer case
   7.2 Add invalidation effect (depends on 7.1 and on 3's isBackendConfirmed)
                                        |
                                        v
8. Distinct recovery message in PlayerGame.tsx
   (depends on 5.1's lastSessionGuardFailure being exposed)
                                        |
                                        v
   ______________________________________________________________
  |                 |                  |                  |       |
  v                 v                  v                  v       v
9. Unit tests    10. Unit tests    11. Unit tests     12. Unit    13. Regression
   for resolver      for the          for CLEAR_          test       tests
   (depends on 4)    guard (depends   STALE_PLAYER         for        (depends on
                      on 5)           + effect             recovery   3-8 end-to-end,
                                      (depends on 7)        message    i.e. all of them)
                                                            (depends
                                                            on 8)
   \_________________\________________\__________________/_________/
                                        |
                                        v
14. Checkpoint - full build + test suite
    (depends on all of 3-13 being implemented and their tests written)
                                        |
                                        v
15. Verify exploration/preservation tests against the fix
    15.1 Re-run task 1's exploration test (depends on 14)
    15.2 Re-run task 2's preservation test (depends on 14)
                                        |
                                        v
16. Remove or down-level temporary diagnostic logging
    (depends on 15 confirming the fix is verified)
                                        |
                                        v
17. Final checkpoint - ensure all tests pass
    (depends on 16)
```

**Summary:**
- Tasks 1 and 2 are independent of each other and must both run (on unfixed code) before any implementation task.
- Tasks 3 → 4 → 5 → 6 → 7 → 8 are mostly sequential: each builds on state, types, or functions introduced by the prior one (`isBackendConfirmed` → resolver → guard → logging → stale-id clearing → UI message).
- Tasks 9-13 are test tasks that depend on the specific implementation task(s) they exercise (9→4, 10→5, 11→7, 12→8, 13→3-8 collectively) and can be done in parallel with each other once their respective implementation task lands.
- Task 14 depends on all of 3-13 being complete.
- Task 15 depends on 14 and re-runs the exact tests from tasks 1 and 2 (no new tests written).
- Task 16 depends on 15 passing.
- Task 17 depends on 16.

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "2"], "description": "Independent exploration/preservation baselines on unfixed code" },
    { "wave": 2, "tasks": ["3"], "description": "Add isBackendConfirmed signal to GameSessionContext.tsx" },
    { "wave": 3, "tasks": ["4"], "description": "Implement getActivePlayerSession() resolver and rewire derived selectors (depends on 3)" },
    { "wave": 4, "tasks": ["5"], "description": "Add the pre-submission session consistency guard in wrappedDispatch (depends on 4)" },
    { "wave": 5, "tasks": ["6"], "description": "Add dev-only diagnostic logging on guard failure (depends on 5)" },
    { "wave": 6, "tasks": ["7"], "description": "Add CLEAR_STALE_PLAYER action and stale-identity invalidation effect (depends on 3 and 7.1)" },
    { "wave": 7, "tasks": ["8"], "description": "Add the distinct recovery message in PlayerGame.tsx (depends on 5's lastSessionGuardFailure)" },
    { "wave": 8, "tasks": ["9", "10", "11", "12", "13"], "description": "Test tasks, parallelizable once their respective implementation task lands (9→4, 10→5, 11→7, 12→8, 13→3-8)" },
    { "wave": 9, "tasks": ["14"], "description": "Build + full test suite checkpoint" },
    { "wave": 10, "tasks": ["15"], "description": "Re-run exploration/preservation tests against the fix" },
    { "wave": 11, "tasks": ["16"], "description": "Diagnostic logging keep/remove decision" },
    { "wave": 12, "tasks": ["17"], "description": "Final checkpoint" }
  ]
}
```

## Notes

- **Diagnostic logging decision deferred to task 16**: task 6 adds a single `console.warn('[session-guard]', { ... })` call gated behind `import.meta.env.DEV`. Whether to keep it permanently (as a lightweight dev-only diagnostic) or remove it is a decision deliberately deferred to task 16, made only after the fix is verified against the full regression/exploration/preservation test plan (tasks 13-15) — not as an undocumented follow-up. If kept, document the decision in a brief code comment at the call site.
- **`claimEngine.ts` and RPC gates must never be modified**: no task in this plan touches `src/utils/claimEngine.ts` or any `submit_claim`/`validatePrizeClaim` RPC validation gate (`PLAYER_NOT_FOUND`, `PLAYER_NOT_IN_GAME`, `TICKET_NOT_FOUND`, `TICKET_NOT_OWNED_BY_PLAYER`, `PRIZE_NOT_FOUND`, `DUPLICATE_ACTIVE_CLAIM`, `RESUBMISSION_LIMIT_REACHED`, `PRIZE_CLOSED`, `NOT_ELIGIBLE`). If any regression fix during task 14 seems to require touching one of these, that is a signal the fix has gone out of scope — stop and reconsider rather than patching around it. Task 17 confirms this via `git diff` showing no changes to that file or any `supabase/migrations/*.sql` file.
- **`SESSION_GUARD_BLOCKED` is not shared/persisted state**: the guard-failure signal (`lastSessionGuardFailure`) is implemented as ephemeral provider-local `useState`, never written to `localStorage` and never broadcast via `syncChannel` or the shared envelope — this is deliberate per the design doc, to avoid leaking purely-local UI feedback into multi-device sync state.
- **`isHydrated` is never repurposed**: `isBackendConfirmed` is an additive, narrower-purpose signal gating only claim submission; `isHydrated` keeps its existing hardcoded-`true` value and meaning throughout this plan, preserving the no-flicker/no-forced-rejoin rendering behavior.
