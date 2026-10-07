# Implementation Plan

## Overview

This plan fixes the claim duplicate submission bug: a single "Claim [Prize]" click can end up rendered as two differently-id'd entries in `state.claims` because `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` case never reconciles its optimistic entry's locally-minted id against the server-confirmed `ClaimRow`'s id before a realtime echo (or the RPC's own resolution) folds that row in. The fix introduces an additive `RECONCILE_CLAIM_ID` reducer action, wired from a new `.then` on `rpcSubmitClaim`, so the optimistic entry is swapped for the authoritative row in place before `SYNC_REMOTE`/`upsertById` ever needs to match it. Three independent defense-in-depth layers are added alongside the primary mechanism: a Host Claim Inbox dedup-by-id rendering safeguard, a client-side per-prize `isSubmittingClaim` submission lock, and an additive partial unique index closing `submit_claim`'s Gate 7 race window at the database level. `claimEngine.ts` and every existing `submit_claim`/`validatePrizeClaim` gate remain untouched. Work proceeds via the bug-condition methodology: exploration (task 1) and preservation (task 2) tests are written and run against the unfixed code first, the fix is implemented and tested in tasks 3-9, then re-verified end-to-end in tasks 12-13, with final sign-off in task 15 explicitly flagging the two manual acceptance items (real-browser test, 25-item summary) that remain outside automated tasks.

## Tasks

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Single Click Produces Two Differently-Id'd Claim Entries
  - **IMPORTANT**: Write this property-based test BEFORE implementing the fix
  - **GOAL**: Reproduce, on the real unfixed code, one click producing two different-id'd claims entries in `state.claims`, and determine empirically whether the ticket-mismatch symptom shares the same mechanism or is a separate bug
  - Use the existing mock Supabase test harness (`src/state/testSupport/mockSupabaseClient.ts`), following the pattern already established by `GameSessionContext.multiTabReset.integration.test.tsx` and the prior `claim-player-ticket-identity-mismatch` spec's exploration tests
  - Add a new test file `src/state/claimDuplicateSubmission.exploration.test.tsx`
  - **Scoped PBT Approach**: Scope the property to the concrete reported shape plus the deterministic variants from design.md's Exploratory Bug Condition Checking section (ordering is deterministic per test case, not randomized, since the underlying defect is present for every submission on unfixed code — not input-dependent):
    1. **single-click-produces-two-entries**: mount `GameSessionProvider` with a consistent, already-hydrated session (joined player with a matching ticket, backend confirmed, satisfying the prior spec's `isConsistent` guard). Dispatch one `SUBMIT_PRIZE_CLAIM`, let the queued `submit_claim` RPC resolve with a `ClaimRow` whose `id` differs from the observed optimistic id, then fire a realtime `claims` INSERT event via `fireRemoteChange` carrying that same row. Assert (on unfixed code) `state.claims` ends up with 2 entries sharing `playerId`/`prizeId` but differing `id`
    2. **realtime-echo-arrives-before-rpc-resolves**: fire the realtime echo for the server row BEFORE awaiting the queued RPC promise's own resolution; assert the same 2-entry duplication occurs regardless of ordering
    3. **wrong-ticket-mechanism-check**: in the same 2-entry duplicate from case 1, compare `ticketRef` on both entries; assert whether they are identical (confirms Hypothesized Root Cause point 5 — same mechanism) or diverge (would refute it and require revisiting design.md before continuing)
    4. **rapid-double-click-race**: dispatch two `SUBMIT_PRIZE_CLAIM` actions for the same `(player, prize)` back-to-back in the same synchronous tick; queue two separate `submit_claim` RPC responses that both resolve successfully; assert (on unfixed code) `rpcSubmitClaim` is called twice with no client-side mechanism preventing the second call
  - Test implementation details from the Bug Condition in design.md (`isBugCondition(X)` formal spec, `ClaimSubmissionSequence` shape: `optimisticClaimId`, `serverClaimRowId`, `rpcResolutionReconciled`, `realtimeEchoReceived`)
  - The test assertions should match Property 1 from design.md's Correctness Properties ("Single Submission Produces Exactly One Reconciled Claim Entry") — on FIXED code these same scenarios must flip to exactly one entry; on UNFIXED code they must demonstrate the duplicate
  - Run test on UNFIXED code (current `GameSessionContext.tsx`/`gameSessionReducer.ts`/`remoteRowMappers.ts`)
  - **EXPECTED OUTCOME**: Test FAILS / its assertions demonstrating the bug PASS against unfixed code (document whichever framing you use) — this confirms the bug exists
  - Document the counterexamples found: (a) exactly 2 entries in `state.claims` for one real-world submission, confirming the `.then`-less reconciliation gap, (b) two `rpcSubmitClaim` calls for one rapid double-click, confirming the absent `isSubmittingClaim` guard, (c) whether `ticketRef` is identical or divergent across the duplicate pair
  - Mark task complete when test is written, run, and failure/counterexample is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Unaffected Submissions and Guards Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Add a new test file `src/state/claimDuplicateSubmission.preservation.test.tsx`
  - Observe on UNFIXED code, and record each as the baseline to assert against the fixed code later:
    1. **Local Fallback claim flow**: no Supabase configured — `wrappedDispatch`'s local-only branch never calls `rpcSubmitClaim` and never receives a realtime echo; the full join → mark → claim → confirm flow produces exactly one claim entry even on unfixed code, since there is nothing to duplicate against
    2. **Genuinely consistent single-claim flow with no echo configured**: a consistent session submits one claim and no realtime echo fires in the test at all; confirm it already produces exactly 1 entry unfixed
    3. **Cross-player isolation**: two different players submit claims (same or different prizes); confirm each claim's `playerId`/`ticketId`/`ticketRef` stays exclusively tied to its own submitter with no cross-contamination, observed on unfixed code
    4. **Session-guard-blocked submission**: a submission blocked by the prior spec's `claim-player-ticket-identity-mismatch` consistency guard; confirm `rpcSubmitClaim` is never called, matching that spec's own Fix Checking assertions
  - Write property-based tests (reuse whatever PBT library is already a devDependency in `package.json`, matching the convention used by the prior spec's preservation tests) asserting the observed baseline behavior holds for the non-bug-condition region (`isBugCondition(X) = false`): same dispatched actions, same `rpcSubmitClaim` call shape/args, same guard behavior, same rendered Host Claim Inbox / Winner History output
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve — the unfixed code already behaves correctly for the non-bug-condition region, since the defect only manifests when the bug condition holds)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 3. Add `RECONCILE_CLAIM_ID` reducer action
  - In `src/state/gameSessionReducer.ts`, add `| { type: 'RECONCILE_CLAIM_ID'; optimisticId: string; confirmedClaim: PrizeClaim }` to the `GameSessionAction` union, placed alongside the other additive reconciliation-style actions (`ROLLBACK_OPTIMISTIC`, `CLEAR_STALE_PLAYER`)
  - Add the reducer case: find the entry in `state.claims` matching `action.optimisticId`; if absent, return `state` unchanged (safe no-op, mirroring `RESTORE_PLAYER`/`CLEAR_STALE_PLAYER`'s existing "ignore if absent" convention); otherwise replace that entry in place (same array index) with `action.confirmedClaim`
  - This is additive only — no existing reducer case's logic, order, or behavior changes
  - _Bug_Condition: isBugCondition(X) where X.optimisticClaimId <> X.serverClaimRowId AND NOT X.rpcResolutionReconciled_
  - _Expected_Behavior: RECONCILE_CLAIM_ID replaces the optimistic entry in place with the server's authoritative ClaimRow (design.md Fix Implementation point 1-2)_
  - _Requirements: 2.2, 2.3_

- [x] 4. Wire `RECONCILE_CLAIM_ID` dispatch from `rpcSubmitClaim`'s resolution in `GameSessionContext.tsx`
  - Add a `.then((row) => dispatch({ type: 'RECONCILE_CLAIM_ID', optimisticId: augmentedAction.optimisticId!, confirmedClaim: mapRowToClaim(row as unknown as Record<string, unknown>) }))` to the existing `rpcSubmitClaim(action.playerId, action.prizeId)` call in `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` case, immediately after the existing consistent-session branch, keeping the existing `.catch(rollback)` unchanged and chained after the new `.then`
  - `augmentedAction.optimisticId` is guaranteed defined here per design.md point 3 (the existing `optimisticId` injection already runs unconditionally for `SUBMIT_PRIZE_CLAIM` before this switch runs); `mapRowToClaim` is already imported in this file
  - Do NOT modify `SYNC_REMOTE`'s `upsertById` call or `remoteRowMappers.ts` — once reconciliation lands at RPC-resolution time, the existing id-match logic finds the (now-reconciled) entry on first lookup with zero changes required there
  - _Bug_Condition: isBugCondition(X) — the `.then`-less rpcSubmitClaim call (bugfix.md 1.3)_
  - _Expected_Behavior: expectedBehavior(result) — rpcSubmitClaim's resolved ClaimRow is consumed and used to reconcile the optimistic entry (design.md Property 1)_
  - _Preservation: SYNC_REMOTE/upsertById unmodified; rejected submissions still roll back via the unchanged .catch(rollback) (design.md Property 2)_
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 5. Add per-prize `isSubmittingClaim` submission lock in `GameSessionContext.tsx`
  - Add `const [submittingClaimPrizeIds, setSubmittingClaimPrizeIds] = useState<Set<PrizeId>>(new Set())` in `GameSessionProvider`
  - Set this prize's id at the very top of the `SUBMIT_PRIZE_CLAIM` case (covering both the guard-blocked and guard-passed paths); clear it in BOTH the `RECONCILE_CLAIM_ID`-dispatching `.then` added in task 4 and the existing `.catch(rollback)` branch, so the flag never gets stuck set after either outcome
  - Expose a derived boolean `isSubmittingClaim(prizeId): boolean` on `GameSessionContextValue` (not the raw `Set`), so callers don't need to know the storage representation
  - _Bug_Condition: isBugCondition — rapid double-click, no client-side guard against a second dispatch for the same prize (bugfix.md 1.5)_
  - _Expected_Behavior: at most one in-flight SUBMIT_PRIZE_CLAIM dispatch per prize at a time, client-side (design.md Property 3)_
  - _Requirements: 2.6, 2.7_

- [x] 6. Wire the submission lock into the Claim button in `PlayerGame.tsx`
  - Read `isSubmittingClaim(prizeId)` from `useGameSession()`
  - In each prize block's Claim button, add `|| isSubmittingClaim(progress.id)` to the existing `disabled={view.buttonDisabled || readOnly}` condition
  - Swap the button label to `"Submitting Claim..."` while true, mirroring the existing `claimStatusView`-driven label-swap convention already used for `PENDING`/`CONFIRMED` states — label/disabled change only, no new component, no restructuring
  - _Bug_Condition: isBugCondition — rapid double-click (bugfix.md 1.5)_
  - _Expected_Behavior: the Claim button is disabled and shows "Submitting Claim..." while a submission for that prize is in flight (bugfix.md 2.7)_
  - _Preservation: no redesign/restyle of the Claim Inbox or Player claim UI beyond this disabled-state protection (bugfix.md 3.9)_
  - _Requirements: 2.6, 2.7_

- [x] 7. Add Host Claim Inbox dedup-by-id rendering safeguard
  - In `src/pages/HostDashboard/HostDashboard.tsx`, add a small, pure, additive exported helper co-located next to `toClaimInboxRowViewModel`:
    ```ts
    /** Removes any later duplicate-id entries, keeping each id's first occurrence (Req 2.5). */
    export function dedupeClaimsById(claims: readonly PrizeClaim[]): PrizeClaim[] {
      const seen = new Set<string>()
      return claims.filter((c) => {
        if (seen.has(c.id)) return false
        seen.add(c.id)
        return true
      })
    }
    ```
  - Apply it as a pure pre-filter ahead of the existing pipeline: `groupClaimsForHistory(sortClaimsForInbox(dedupeClaimsById(state.claims)))` — the existing pipeline itself is otherwise completely unmodified
  - This is independent, defense-in-depth protection with no dependency on tasks 3-4; it masks a duplicate-id symptom even if some other, future bug reintroduces one
  - _Bug_Condition: isBugCondition — duplicate id-pair reaching rendered state for any reason (bugfix.md 1.1, 1.2)_
  - _Expected_Behavior: the Host Claim Inbox never renders more than one card for a given claim id, even if state.claims momentarily contains a duplicate (bugfix.md 2.5; design.md Property 4)_
  - _Preservation: a claims list with no duplicate ids renders identically, same order, same count, dedupeClaimsById only ever removes true duplicates (design.md Property 4)_
  - _Requirements: 2.5_

- [x] 8. Write and document the additive partial unique index migration (0006)
  - Add `supabase/migrations/0006_claims_active_unique_index.sql`:
    ```sql
    -- Module: claim-duplicate-submission bugfix
    -- Additive-only: strictly ADDS a backstop; does not alter submit_claim's
    -- existing 10-gate order or any gate's outcome (bugfix.md Req 2.9, 3.5).
    -- Mirrors the "hard backstop even if application-level logic were ever
    -- bypassed" convention already documented on called_terms/marks/tickets/
    -- players/winners in 0001_schema.sql -- claims was the one table in that
    -- migration without an equivalent constraint.
    create unique index claims_one_active_per_player_prize
      on claims (player_id, prize_id)
      where host_decision in ('PENDING', 'CONFIRMED');
    ```
  - Do NOT edit `submit_claim`'s function body, `claimEngine.ts`, or any existing migration file (`0001_schema.sql` through `0005_rpc_lifecycle_and_claims.sql`) — confirmed unmodified by design.md point 9
  - **Explicitly document, in a code comment at the top of the migration file and restated in the task completion notes, that this migration is NOT auto-applied**: it must be manually run against the live Supabase project (e.g. via the Supabase SQL editor or CLI migration-apply step actually used for this project) as an explicit implementation step, consistent with bugfix.md's Required Final Acceptance Criteria item 16 ("whether a manual migration is required: yes")
  - Record, as part of this task's completion notes, what `RpcError.code` a unique-violation on this index actually surfaces as when triggered via `rpcSubmitClaim` (diagnostic completeness only — `wrappedDispatch`'s existing generic `.catch(rollback)` already handles any RPC rejection safely, so no new client-side handling is required)
  - _Bug_Condition: DUPLICATE_ACTIVE_CLAIM race window — Gate 7's SELECT-then-INSERT gap with no row lock or unique-index backstop (design.md Hypothesized Root Cause point 3)_
  - _Expected_Behavior: a second concurrent INSERT for the same (player_id, prize_id) with an active host_decision fails at the database level regardless of what either transaction's Gate 7 SELECT observed (design.md Property 3)_
  - _Preservation: submit_claim's 10-gate order and every gate's outcome unchanged; this is additive-only (bugfix.md 2.9, 3.5)_
  - _Requirements: 2.6, 2.9_

- [x] 9. Unit tests for the reconciliation mechanism, Host dedup rendering, and the submission lock
  - `RECONCILE_CLAIM_ID` reducer case: replaces the matching optimistic entry in place at the same array index; no-ops safely (returns unchanged state) if `optimisticId` is absent from `state.claims`
  - `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` `.then`/`.catch` wiring: asserts `RECONCILE_CLAIM_ID` is dispatched with the correct `optimisticId`/`confirmedClaim` on RPC success, and that the existing rollback still fires unchanged on RPC rejection
  - `dedupeClaimsById`: removes true duplicates, preserves order and content of everything else, is a no-op on an already-duplicate-free list (design.md Property 4) — include a property-based test (reusing the project's existing PBT library) generating random `PrizeClaim[]` (with or without duplicate ids) asserting output length never exceeds input length, every output id is unique, and relative order of first-occurrences is preserved
  - `isSubmittingClaim` state transitions: set on submission start, cleared on both the `.then` and `.catch` continuations, independent per `prizeId`
  - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 2.7_

- [x] 10. Regression tests for the six required scenarios from bugfix.md
  - Add `src/state/claimDuplicateSubmission.regression.integration.test.tsx` covering, as named test cases (mirroring bugfix.md's Required Regression Test Coverage verbatim):
    1. **single-click-produces-exactly-one-claim**: one click on "Claim [Prize]" results in exactly one rendered Host Claim Inbox entry and exactly one underlying database row (via the mock harness's recorded insert)
    2. **rapid-double-click-produces-at-most-one-active-claim**: two near-simultaneous submissions for the same `(player, prize)` result in at most one PENDING/CONFIRMED claim client-rendered, with the second dispatch prevented client-side by `isSubmittingClaim` (mounted `PlayerGame`, `fireEvent.click` twice in the same tick, asserting the second click is a no-op because the button is already disabled)
    3. **realtime-echo-does-not-duplicate**: a realtime `SYNC_REMOTE` event for a claim row already represented locally (via the optimistic entry, now reconciled) reconciles to one entry in both orderings (RPC-resolves-first and echo-arrives-first)
    4. **wrong-ticket**: two different players' claims submitted concurrently or in sequence never cross-contaminate; each rendered claim's Ticket reference always matches the Ticket active for the submitting player at submission time
    5. **refresh-then-claim**: a player who refreshes their browser tab and then submits a claim produces exactly one claim entry, with no duplicate surviving from before the refresh
    6. **reset/rejoin-then-claim**: a player who resets/rejoins and then submits a claim produces exactly one claim entry for the new session, with no stale pre-reset claim entry duplicated or resurfacing
  - Also include the full `join (mock RPC) → mark → claim (mock RPC + realtime echo in both orderings) → confirm` integration flow asserting exactly one Claim Inbox entry and one Winner History entry throughout
  - _Requirements: 1.1, 1.2, 1.4, 1.5, 2.1, 2.2, 2.4, 2.6, 2.8, 3.1, 3.4, 3.6_

- [x] 11. Checkpoint - run the full build and automated test suite
  - Run `npm run build` and fix any type errors introduced by the new `GameSessionAction` member (`RECONCILE_CLAIM_ID`), the new `GameSessionContextValue` field (`isSubmittingClaim`), or the new `dedupeClaimsById` export
  - Run the full automated test suite (e.g. `npm test -- --run` or the project's configured non-watch test command) and fix any regressions
  - Do NOT modify, remove, or weaken `src/utils/claimEngine.ts`, any `submit_claim`/`validatePrizeClaim` RPC validation gate, or the `claim-player-ticket-identity-mismatch` guard (`getActivePlayerSession`, `isBackendConfirmed`, `CLEAR_STALE_PLAYER`) while fixing regressions — if a test failure seems to require touching one of these, stop and treat that as a signal the fix has gone out of scope, not something to patch around
  - Confirm every task-1 exploration test now PASSES (bug fixed) and every task-2 preservation test still PASSES (no regressions)
  - Ask the user if questions arise
  - _Requirements: all_

- [x] 12. Verify exploration and preservation tests against the fix
  - [x] 12.1 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Single Submission Produces Exactly One Reconciled Claim Entry
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test. If the test's assertions need to flip from "assert the duplicate occurs" to "assert exactly one entry survives" for the FIXED code (per design.md's framing — the same scenarios flip outcome, not the same assertions), update those assertions in place in the existing test file rather than creating a new file
    - Run the bug condition exploration test from task 1 against the fixed code
    - **EXPECTED OUTCOME**: Test PASSES (confirms the bug is fixed — exactly one entry survives in both echo orderings, the surviving entry's `id` equals the server row's `id`, and `ticketRef` matches the Ticket active for that player at submission time)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.8_

  - [x] 12.2 Verify preservation tests still pass
    - **Property 2: Preservation** - Unaffected Submissions and Guards Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run the preservation property tests from task 2 against the fixed code
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions for Local Fallback, consistent single-claim flow, cross-player isolation, and the session-guard-blocked case)
    - Confirm all tests still pass after the fix (no regressions)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 13. Decide keep/remove for any temporary diagnostics added during investigation
  - Per bugfix.md's Introduction carryover ("Temporary Diagnostics"): if any temporary diagnostic logging was added while investigating the duplicate-id mechanism or the Gate 7 race (e.g. a one-off `console.warn`/`console.debug` call to inspect `state.claims` ids, RPC resolution timing, or the migration's surfaced `RpcError.code` from task 8), review each such call now that the fix is verified against the full regression/exploration/preservation test plan (tasks 10-12)
  - Deliberately decide, per call site: keep it permanently as a lightweight, non-sensitive, `import.meta.env.DEV`-gated diagnostic (documenting the decision in a brief code comment at the call site), or remove it entirely
  - If none were added during this spec's investigation, record that explicitly rather than silently skipping this task
  - Re-run the full test suite once more after any removal to confirm nothing depended on a log call's presence
  - _Requirements: 2.3_

- [x] 14. Final checkpoint - ensure all tests pass and no out-of-scope files changed
  - Run `npm run build` and the full automated test suite one final time
  - Confirm: every exploration test passes, every preservation test passes, every regression test from task 10 passes
  - Confirm via `git diff` against the merge-base commit before this spec's changes that `src/utils/claimEngine.ts` is byte-identical, every existing `submit_claim`/`validatePrizeClaim` gate in `supabase/migrations/0001_schema.sql` through `0005_rpc_lifecycle_and_claims.sql` is byte-identical, and the only new SQL file is the additive `0006_claims_active_unique_index.sql` from task 8
  - Confirm the `claim-player-ticket-identity-mismatch` guard files (`getActivePlayerSession`, `isBackendConfirmed`, `CLEAR_STALE_PLAYER`) show no diff beyond what task 4's `.then` addition required (i.e. no changes to the guard's own logic)
  - Ask the user if questions arise
  - _Requirements: all_

- [~] 15. Manual acceptance criteria required to consider this spec done (NOT automated tasks)
  - **This task is intentionally not satisfiable by any automated test** — it exists so the spec does not silently omit bugfix.md's Required Final Acceptance Criteria
  - **A. Real browser acceptance test**: open a real Player tab and a real Host tab against a live (or realistically simulated) backend, click "Claim [Prize]" exactly once, and visually confirm the Host Claim Inbox shows exactly one card with a Ticket reference matching the Player's own screen. Record this as completed, or explicitly note it as not yet executed with reason — this fix is NOT considered complete until this is recorded
  - **B. 25-item completion summary**: produce and record the full 25-item summary specified in bugfix.md's Required Final Acceptance Criteria section B (root cause confirmation, DB-row-count finding, double-invocation/realtime-echo/retry/duplicate-subscription findings, ticket-mismatch root cause, name-matching/stale-player/stale-ticket findings, files modified, idempotency/lock/dedup/DB-constraint descriptions, manual-migration yes/no, all six regression test results, real browser test result, `npm run build` result, commit hash, and confirmation `main` was not touched)
  - This spec is NOT considered complete until both A and B above are satisfied and recorded, in addition to tasks 1-14 passing
  - _Requirements: all (bugfix.md Required Final Acceptance Criteria)_

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
3. Add RECONCILE_CLAIM_ID reducer action (gameSessionReducer.ts)
                                        |
                                        v
4. Wire RECONCILE_CLAIM_ID dispatch from rpcSubmitClaim's .then (depends on 3)
                                        |
                                        v
5. Add per-prize isSubmittingClaim lock state (GameSessionContext.tsx)
   (independent of 3-4; can proceed in parallel with 3-4, but is placed
   after here for linear readability -- no data dependency on RECONCILE_CLAIM_ID)
                                        |
                                        v
6. Wire isSubmittingClaim into the Claim button (PlayerGame.tsx)
   (depends on 5)
                                        |
                                        v
7. Host Claim Inbox dedup-by-id rendering safeguard (HostDashboard.tsx)
   (independent of 3-6; defense-in-depth, no shared dependency)
                                        |
                                        v
8. Additive partial unique index migration 0006 (supabase/migrations/)
   (independent of 3-7; defense-in-depth at the DB level)
                                        |
                                        v
   ______________________________________________
  |                                                |
  v                                                v
9. Unit tests for reconciliation/dedup/lock      10. Regression tests for the six
   (depends on 3, 4, 5, 7)                           required scenarios
                                                      (depends on 3-8 end-to-end)
   \________________________________________________/
                                        |
                                        v
11. Checkpoint - full build + test suite
    (depends on 3-10 being implemented and their tests written)
                                        |
                                        v
12. Verify exploration/preservation tests against the fix
    12.1 Re-run task 1's exploration test (depends on 11)
    12.2 Re-run task 2's preservation test (depends on 11)
                                        |
                                        v
13. Keep/remove decision for temporary diagnostics
    (depends on 12 confirming the fix is verified)
                                        |
                                        v
14. Final checkpoint - all tests pass, no out-of-scope diffs
    (depends on 13)
                                        |
                                        v
15. Manual acceptance criteria (real browser test + 25-item summary)
    (depends on 14; NOT an automated task -- the spec is not done without it)
```

**Summary:**
- Tasks 1 and 2 are independent of each other and must both run (on unfixed code) before any implementation task.
- Task 3 → 4 is sequential (the dispatch wiring in 4 needs the action defined in 3).
- Task 5 → 6 is sequential and independent of 3-4 (the submission lock is a separate mechanism from the id-reconciliation mechanism; both are implementation prerequisites for the test tasks).
- Tasks 7 and 8 are each independent defense-in-depth additions with no dependency on 3-6 or on each other.
- Tasks 9 and 10 are test tasks that depend on the implementation tasks they exercise (9 → 3, 4, 5, 7; 10 → 3-8 collectively) and can be done in parallel with each other once their respective implementation tasks land.
- Task 11 depends on all of 3-10 being complete.
- Task 12 depends on 11 and re-runs the exact tests from tasks 1 and 2 (no new tests written, only in-place assertion updates where the fix flips the expected outcome).
- Task 13 depends on 12 passing.
- Task 14 depends on 13.
- Task 15 depends on 14, and is a manual/documentation gate, not an automated task — it must still be completed before the spec is considered done.

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "2"], "description": "Independent exploration/preservation baselines on unfixed code" },
    { "wave": 2, "tasks": ["3"], "description": "Add RECONCILE_CLAIM_ID reducer action" },
    { "wave": 3, "tasks": ["4"], "description": "Wire RECONCILE_CLAIM_ID dispatch from rpcSubmitClaim's .then (depends on 3)" },
    { "wave": 4, "tasks": ["5"], "description": "Add per-prize isSubmittingClaim lock state" },
    { "wave": 5, "tasks": ["6"], "description": "Wire isSubmittingClaim into the Claim button (depends on 5)" },
    { "wave": 6, "tasks": ["7", "8"], "description": "Independent defense-in-depth additions: Host dedup-by-id rendering, and the additive unique index migration" },
    { "wave": 7, "tasks": ["9", "10"], "description": "Test tasks, parallelizable once their respective implementation tasks land (9 depends on 3,4,5,7; 10 depends on 3-8)" },
    { "wave": 8, "tasks": ["11"], "description": "Build + full test suite checkpoint" },
    { "wave": 9, "tasks": ["12"], "description": "Re-run exploration/preservation tests against the fix" },
    { "wave": 10, "tasks": ["13"], "description": "Temporary diagnostics keep/remove decision" },
    { "wave": 11, "tasks": ["14"], "description": "Final checkpoint" },
    { "wave": 12, "tasks": ["15"], "description": "Manual acceptance criteria: real browser test + 25-item completion summary (not automated)" }
  ]
}
```

## Notes

- **`claimEngine.ts` and RPC gates must never be modified**: no task in this plan touches `src/utils/claimEngine.ts` or any `submit_claim`/`validatePrizeClaim` RPC validation gate (`GAME_NOT_FOUND`, `PLAYER_NOT_FOUND`, `PLAYER_NOT_IN_GAME`, `TICKET_NOT_FOUND`, `TICKET_NOT_OWNED_BY_PLAYER`, `PRIZE_NOT_FOUND`, `DUPLICATE_ACTIVE_CLAIM`, `RESUBMISSION_LIMIT_REACHED`, `PRIZE_CLOSED`, `NOT_ELIGIBLE`). The only SQL change in this plan is the strictly additive index in task 8. If any regression fix during task 11 seems to require touching one of these, that is a signal the fix has gone out of scope — stop and reconsider rather than patching around it. Task 14 confirms this via `git diff`.
- **The `claim-player-ticket-identity-mismatch` guard is read, not modified**: `getActivePlayerSession()`, `isBackendConfirmed`, the pre-submission consistency check, and `CLEAR_STALE_PLAYER` are not touched by any task in this plan beyond task 4's `.then` addition running strictly after that guard's `isConsistent` check has already passed.
- **Migration 0006 requires a manual apply step**: migrations in this project are not auto-applied to the live Supabase project. Task 8 explicitly documents the manual-apply requirement; it is also one of the 25 items required in task 15's completion summary (item 16).
- **Task 15 is a deliberate, non-automated gate**: it is included in this plan specifically so the real-browser acceptance test and the 25-item completion summary from bugfix.md's Required Final Acceptance Criteria are not silently dropped from the implementation workflow. Completing tasks 1-14 alone does NOT make this spec done.
