# Bugfix Requirements Document

## Introduction

A Player clicks "Claim Cyber Five" **once**. The Host's Claim Inbox then shows **two** pending claim cards for the same player and prize, created at the same instant. The Ticket reference shown on the Claim Inbox card(s) does not match the Ticket the Player's own screen is currently showing as active.

Investigation of the current implementation (`src/state/GameSessionContext.tsx`, `src/state/gameSessionReducer.ts`, `src/state/remoteRowMappers.ts`, `src/pages/HostDashboard/HostDashboard.tsx`, and `supabase/migrations/0001_schema.sql` / `0005_rpc_lifecycle_and_claims.sql`) surfaces a structural mechanism that is consistent with the report, but **has not yet been confirmed as the actual root cause by exploration tests against the real unfixed code** — that confirmation is this spec's own Property 1 obligation, not an assumption to carry into the design:

- `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` case mints a client-local id (`localId()`, via `optimisticId`) and dispatches an optimistic `PrizeClaim` into `state.claims` **immediately**, using that client-minted id as the claim's permanent local `id`.
- It then calls `rpcSubmitClaim(action.playerId, action.prizeId).catch(rollback)` — there is **no `.then`** on this call. The RPC's resolved row (which carries the server's own `gen_random_uuid()`-generated `claims.id`, structurally different from the client-minted id) is never read and never reconciled back into local state on success.
- Separately, the Realtime subscription later receives a Postgres change event for that same inserted `claims` row and dispatches `SYNC_REMOTE`, which calls `upsertById(state.claims, mapRowToClaim(row))` (`remoteRowMappers.ts`). `upsertById` matches purely by `.id` (`existing.id === item.id`). Because the optimistic entry's id and the realtime echo's id are different values describing the same real-world claim, `upsertById` cannot recognize them as the same claim — it appends the realtime row as a **second, additional** entry rather than replacing the optimistic one.
- `claims` (`0001_schema.sql`) has **no unique constraint** on `(player_id, prize_id, host_decision)` or similar — unlike `called_terms`, `marks`, `winners`, `tickets`, and `players`, which each have an explicit unique index/constraint called out in their migration comments as "the hard backstop even if [application-level logic] were ever bypassed." `submit_claim`'s Gate 7 `DUPLICATE_ACTIVE_CLAIM` check (`0005_rpc_lifecycle_and_claims.sql`) is a plain `SELECT ... exists(...)` evaluated before the `INSERT`, with no row lock and no unique-index backstop — whether this is independently exploitable (e.g. two near-simultaneous RPC calls both passing Gate 7 before either inserts) or is irrelevant because only one RPC call is ever actually made per click, is **unconfirmed** and must be determined by the exploration tests, not assumed.
- The Host Claim Inbox (`HostDashboard.tsx`) already renders `claims.map((claim) => <li key={claim.id}>...)` — i.e. it already uses a stable `claim.id` React key. This prevents a remount/identity-loss bug but does **not** prevent two distinct array entries (two different `id` values) from both rendering as two `<li>` cards, which is exactly what the duplicate-id mechanism above would produce.
- The prior spec `claim-player-ticket-identity-mismatch` (shipped in commit `0f80bc1` on `deployment`) already added `getActivePlayerSession()`, the `isBackendConfirmed` signal, the pre-submission session consistency guard, and `CLEAR_STALE_PLAYER`/stale-id invalidation. These are assumed working and **in scope only as Preservation (Unchanged Behavior) requirements** below — this spec must confirm they still hold, not re-litigate or re-implement them.
- Whether the reported "Ticket reference does not match" symptom is (a) a visual side-effect of the exact same duplicate-rendering mechanism (e.g. the stale optimistic entry's `ticketRef` was captured before some other field settled, while the realtime-echoed row's `ticketRef` is server-authoritative and differs), or (b) a distinct, separate bug, is **unconfirmed** and must be determined empirically; this document's requirements are written to cover both possibilities without presuming which is true.

This document defines the required fix behavior and the behavior that must remain unchanged, expressed as a bug condition so the fix can be checked systematically rather than patched around the single reported symptom.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a Player clicks a "Claim [Prize]" button exactly once for a prize they have not already claimed THEN the system may render two (or more) separate claim cards in the Host Claim Inbox for that same `(player, prize)` pair, originating from the same single click

1.2 WHEN the optimistic local claim entry created by a single claim submission and the realtime-echoed server row for that same submission are both present in `state.claims` THEN the system fails to recognize them as the same real-world claim (because they carry two different `id` values) and retains both as independent entries rather than reconciling the optimistic entry into the confirmed one

1.3 WHEN the `rpcSubmitClaim` call underlying a claim submission resolves successfully THEN the system discards the server's authoritative `ClaimRow` (including its server-generated `id`) instead of using it to reconcile the local optimistic entry

1.4 WHEN two claim-card entries exist in the Host Claim Inbox for what was really a single click THEN the Ticket reference and/or other displayed fields on one or both cards may not match the Ticket currently shown as active on the submitting Player's own screen

1.5 WHEN a Player double-clicks (or otherwise triggers two near-simultaneous submissions of) the same "Claim [Prize]" action before the first submission's UI feedback (e.g. a disabled/"Submitting Claim..." state) has had a chance to prevent the second THEN the system does not have a confirmed, verified-by-test guarantee that at most one claim ever ends up PENDING/CONFIRMED for that `(player, prize)` pair, beyond the existing `DUPLICATE_ACTIVE_CLAIM` gate's unconfirmed-under-concurrency `SELECT`-then-`INSERT` check

### Expected Behavior (Correct)

2.1 WHEN a Player clicks "Claim [Prize]" exactly once for a prize they have not already claimed THEN the system SHALL result in exactly one claim entry being rendered in the Host Claim Inbox for that `(player, prize)` submission, regardless of how many local state transitions (optimistic dispatch, RPC resolution, realtime echo) occur underneath

2.2 WHEN an optimistic local claim entry is later reconciled against its corresponding server-confirmed row (whether via the `rpcSubmitClaim` resolution, a realtime echo, or both) THEN the system SHALL treat them as the same claim and SHALL end up with exactly one entry in `state.claims` for that submission, never two

2.3 WHEN `rpcSubmitClaim` resolves successfully THEN the system SHALL use the server's authoritative `ClaimRow` (including its id) to reconcile the local optimistic entry rather than silently discarding it

2.4 WHEN a realtime `SYNC_REMOTE` event delivers a `claims` row that corresponds to a claim submission already represented locally (optimistically or otherwise) for the same real-world submission THEN the system SHALL deduplicate/reconcile by the claim's real-world identity rather than appending a second entry purely because the row's `id` differs from the optimistic entry's locally-minted id

2.5 WHEN the Host Claim Inbox renders claims THEN the system SHALL render each claim once using its `id` as a stable key (already true today) AND SHALL additionally deduplicate the list it renders from by `id`, so that if a duplicate `id`-bearing or logically-duplicate entry ever appears in `state.claims` for any reason, the Host still never sees more than one card for it

2.6 WHEN a Player rapidly double-clicks (or otherwise triggers two near-simultaneous submissions of) "Claim [Prize]" for the same `(player, prize)` THEN the system SHALL result in at most one PENDING or CONFIRMED claim for that `(player, prize)` pair, both in locally rendered state and in the underlying database, with the second attempt either being prevented client-side (submission lock) or rejected/absorbed server-side without creating a second active row

2.7 WHEN the Claim submission button is in flight (optimistic dispatch issued, server resolution not yet settled) THEN the system SHALL disable the button and SHALL show a "Submitting Claim..." (or equivalent) state, as a secondary, defense-in-depth protection — this requirement does not by itself satisfy 2.1/2.2/2.6; the underlying state-reconciliation fix is required regardless of this UI-level protection

2.8 WHEN two different claim-card entries would otherwise be rendered for a single real-world claim submission and their displayed Ticket references differ THEN, once 2.1-2.4 are satisfied, this scenario SHALL no longer be reachable; if investigation finds a ticket-mismatch cause independent of the duplicate-rendering mechanism, the fix SHALL additionally ensure the Ticket reference rendered on a claim card always matches the Ticket that was actually active for that player at submission time

2.9 WHEN any fix described above is implemented in `supabase/migrations/*.sql` (e.g. an idempotency/uniqueness improvement to `submit_claim` or the `claims` table) THEN the system SHALL only ADD stricter-or-equivalent protection and SHALL NOT loosen, remove, reorder, or change the outcome of any existing gate in `submit_claim`'s current 10-gate validation order (`GAME_NOT_FOUND`, `PLAYER_NOT_FOUND`, `PLAYER_NOT_IN_GAME`, `TICKET_NOT_FOUND`, `TICKET_NOT_OWNED_BY_PLAYER`, `PRIZE_NOT_FOUND`, `DUPLICATE_ACTIVE_CLAIM`, `RESUBMISSION_LIMIT_REACHED`, `PRIZE_CLOSED`, `NOT_ELIGIBLE`)

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a Player's session is genuinely consistent and they submit a single valid claim THEN the system SHALL CONTINUE TO let the join → mark terms → reach Prize eligibility → submit claim → Host confirm flow work exactly as it does today, resulting in exactly one claim and, upon confirmation, exactly one Winner History entry

3.2 WHEN the pre-submission session consistency guard introduced by the prior `claim-player-ticket-identity-mismatch` fix (`getActivePlayerSession()`, `isBackendConfirmed`, the guard inside `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` case, and `CLEAR_STALE_PLAYER`/stale-id invalidation) evaluates a submission THEN the system SHALL CONTINUE TO behave exactly as that spec defined — this fix SHALL NOT alter, bypass, weaken, or duplicate that guard's logic

3.3 WHEN a claim is submitted with a Player ID that is genuinely stale, invalid, or belongs to a different/prior Game THEN the backend SHALL CONTINUE TO reject it with `PLAYER_NOT_IN_GAME` (or the appropriate existing gate code) exactly as today

3.4 WHEN two different Players submit claims (for the same or different prizes) THEN the system SHALL CONTINUE TO never cross-contaminate their claims — each claim's `playerId`, `ticketId`, and displayed Ticket reference SHALL CONTINUE TO belong exclusively to the Player who actually submitted it, with no identity used as a matching key other than the Player's own id (display name SHALL CONTINUE TO NOT be used as an identity key, consistent with the prior spec)

3.5 WHEN the Host reviews the Claim Inbox or Winner History for any claim unaffected by this bug (i.e. one that produced exactly one entry even on the unfixed code) THEN the system SHALL CONTINUE TO show, confirm, and reject claims exactly as today, with no change to `validatePrizeClaim`'s gate order or outcomes, `canConfirmClaim`, or the Reject flow

3.6 WHEN a Player refreshes their browser tab mid-session, or resets/rejoins a game THEN the system SHALL CONTINUE TO restore the same Player/Ticket identity and existing claims exactly as today (no change to `initState()`, `HYDRATE_FROM_REMOTE`, or Reset/rejoin behavior beyond what this fix's claim-dedup logic requires)

3.7 WHEN Supabase is not configured (Local Fallback / dev mode) THEN the system SHALL CONTINUE TO support the full join → mark → claim → confirm flow using the existing pure local reducer/join-service logic exactly as today, since Local Fallback never has a realtime echo to reconcile against

3.8 WHEN work is performed under this spec THEN it SHALL CONTINUE TO occur only on the `deployment` branch; the `main` branch SHALL NOT be touched, committed to, or merged into as part of this fix

3.9 WHEN this fix is implemented THEN it SHALL CONTINUE TO NOT redesign, restyle, or restructure the Claim Inbox or Player claim UI beyond what is strictly required for the "Submitting Claim..." disabled-state protection (Req 2.7) and the dedup-by-id rendering safeguard (Req 2.5)

## Bug Condition (for reference during design/testing)

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type ClaimSubmissionSequence
         { optimisticClaim: PrizeClaim,       // locally dispatched immediately on click, id = localId()
           serverClaimRow: ClaimRow,          // what rpcSubmitClaim resolves to / what the realtime echo delivers
           realtimeEchoReceived: boolean,
           rpcResolutionHandled: boolean }     // whether rpcSubmitClaim's resolved value is ever consumed
  OUTPUT: boolean

  // True when the same real-world claim submission is represented by two
  // (or more) differently-id'd entries that both survive into rendered
  // Host Claim Inbox state.
  RETURN X.optimisticClaim.id <> X.serverClaimRow.id
     AND (X.realtimeEchoReceived OR NOT X.rpcResolutionHandled)
     AND NOT reconciledToSingleEntry(X)
END FUNCTION
```

```pascal
// Property 1: Fix Checking - Single Click Produces Exactly One Claim
FOR ALL X WHERE isBugCondition(X) DO
  result ← renderedClaimInboxEntries'(X)
  ASSERT count(result WHERE result.playerId = X.optimisticClaim.playerId
                        AND result.prizeId = X.optimisticClaim.prizeId) = 1
     AND result[0].ticketRef = activeTicketRefAtSubmission(X)
END FOR
```

```pascal
// Property 2: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT renderedClaimInboxEntries(X) = renderedClaimInboxEntries'(X)
  // i.e. any claim submission sequence that was NOT subject to the
  // duplicate-id reconciliation failure (e.g. Local Fallback with no
  // realtime echo, or a sequence where ids already matched) renders
  // byte-for-byte identically before and after the fix.
END FOR
```

## Required Regression Test Coverage

The following specific test scenarios are non-negotiable acceptance criteria for this fix and MUST be covered (as exploration, fix-checking, or preservation tests, per the design/tasks phases) before this spec is considered complete:

- **single-click-produces-exactly-one-claim**: one click on "Claim [Prize]" results in exactly one rendered Host Claim Inbox entry and exactly one underlying database row.
- **rapid-double-click-produces-at-most-one-active-claim**: two near-simultaneous submissions for the same `(player, prize)` result in at most one PENDING/CONFIRMED claim, client-rendered and server-side.
- **realtime-echo-does-not-duplicate**: a realtime `SYNC_REMOTE` event for a claim row already represented locally (via the optimistic entry) reconciles to one entry, deduplicated by real-world claim identity, not appended as a second entry by raw `id` mismatch.
- **wrong-ticket**: two different Players' claims (submitted concurrently or in sequence) never cross-contaminate — each rendered claim's Ticket reference always matches the Ticket that was actually active for the submitting Player at submission time.
- **refresh-then-claim**: a Player who refreshes their browser tab and then submits a claim produces exactly one claim entry, with no duplicate surviving from before the refresh.
- **reset/rejoin-then-claim**: a Player who goes through a Reset and rejoin flow and then submits a claim produces exactly one claim entry for the new session, with no stale pre-reset claim entry duplicated or resurfacing.

## Required Final Acceptance Criteria

This fix is not considered complete, and the implementation workflow is not considered finished, until BOTH of the following are satisfied and recorded:

**A. Real browser acceptance test.** A manual, real-browser (not automated/headless) acceptance test MUST be executed during the implementation workflow: open a real Player tab and a real Host tab against a live (or realistically simulated) backend, click "Claim [Prize]" exactly once, and visually confirm the Host Claim Inbox shows exactly one card with a Ticket reference matching the Player's own screen. This is a documentation/execution requirement, not an automated test, and MUST be recorded as completed (or explicitly noted as not yet executed, with reason) before the fix is considered done.

**B. 25-item completion summary.** Upon completing implementation, a summary covering all of the following 25 items MUST be produced and recorded:

1. Root cause of duplicate creation (confirmed, not assumed)
2. Whether it was 2 DB rows or 1 DB row rendered twice
3. Whether `onClick`/`onSubmit` double-invocation was involved
4. Whether the realtime echo was involved
5. Whether a retry mechanism was involved
6. Whether a duplicate Realtime subscription was involved
7. Root cause of the "wrong ticket" mapping symptom
8. Whether name-only-join matching was involved
9. Whether a stale `currentPlayerId` was involved
10. Whether stale ticket state was involved
11. Files modified
12. Idempotency protection added (description)
13. Submission lock added (description)
14. Host list dedup added (description)
15. DB/RPC constraint added, if any (description)
16. Whether a manual migration is required (yes/no)
17. Single-click test result
18. Rapid-double-click test result
19. Refresh test result
20. Reset/rejoin test result
21. Ticket-consistency test result
22. Real browser test result (Req A above)
23. `npm run build` result
24. Commit hash
25. Confirmation that `main` branch was not touched

This summary requirement is carried forward as a final acceptance criterion for the design and tasks phases of this spec, and MUST be satisfied at the end of implementation, not merely planned.
