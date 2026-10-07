# Claim Duplicate Submission Bugfix Design

## Overview

Reading `GameSessionContext.tsx`'s `wrappedDispatch` confirms the bug's structural mechanism exactly as bugfix.md's investigation describes it, with no deviation: the `SUBMIT_PRIZE_CLAIM` case mints `optimisticId` via `localId()`, dispatches the optimistic `PrizeClaim` into `state.claims` under that id, then calls

```ts
rpcSubmitClaim(action.playerId, action.prizeId).catch(rollback)
```

There is no `.then` on this call anywhere in the file. The resolved `ClaimRow` — carrying the server's own `gen_random_uuid()` `id`, structurally unrelated to the client-minted `optimisticId` — is read nowhere and reconciled nowhere. Separately, `gameSessionReducer.ts`'s `SYNC_REMOTE` case for `claims` calls `upsertById(state.claims, mapRowToClaim(row))`, and `remoteRowMappers.ts`'s `upsertById` matches purely by `existing.id === item.id`. Because the optimistic entry's id and the realtime-echoed row's id are two different UUIDs describing the same real-world claim, `upsertById` cannot find a match and appends the echoed row as a second array entry. `HostDashboard.tsx`'s Claim Inbox already renders `claims.map((claim) => <li key={claim.id}>...)`, so two distinct `id` values in `state.claims` render as two distinct `<li>` cards — exactly the reported symptom.

This is confirmed, not merely hypothesized, by direct inspection of the three files: the `.catch`-only call, the id-only `upsertById`, and the absence of any unique constraint on `claims` matching `(player_id, prize_id, host_decision)` in `0001_schema.sql` (unlike `called_terms`, `marks`, `tickets`, `players`, and `winners`, which each carry an explicit unique index). Exploratory tests (Testing Strategy below) still run first, before any fix lands, both to produce the required falsifying/confirming evidence (this spec's own Property 1 obligation per bugfix.md's Introduction) and to pin down the "wrong ticket" symptom's cause empirically rather than by inspection alone.

The fix has four independent parts, each addressing a different requirement cluster and each individually testable:

1. **Root-cause fix (primary mechanism)**: `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` case adds a `.then` to the `rpcSubmitClaim` call that dispatches a new, additive `RECONCILE_CLAIM_ID` action, swapping the optimistic entry's `id` (and every other field) for the server's authoritative `ClaimRow` the moment the RPC resolves — mirroring the existing `optimisticId` pattern (`resolveRollbackTarget`, `localId()`-minted ids injected before dispatch) that the prior spec already established for a structurally identical problem (rollback needed to know which id was really dispatched; this bug is the mirror image — the realtime echo needs to know an optimistic entry already represents this same real-world row). Once this reconciliation has run, the optimistic entry's `id` IS the server's `id`, so when the realtime echo for the same row later arrives, `SYNC_REMOTE`'s existing `upsertById` finds the matching id on the first try and overwrites in place — no second entry is ever created. `SYNC_REMOTE`/`upsertById` itself is **not modified**.
2. **Host Claim Inbox dedup-by-id (defense-in-depth, Req 2.5)**: the Claim Inbox's render path deduplicates `state.claims` by `id` immediately before mapping to `<li>` cards, independent of whether the root-cause fix above ever fails to prevent a duplicate id-pair from occurring in `state.claims` for any reason.
3. **Idempotency / submission lock (Req 2.6, 2.7)**: a client-side `isSubmittingClaim`-per-prize guard disables the Claim button for the specific prize currently in flight, as a UI-level defense-in-depth; and an **additive** partial unique index on `claims(player_id, prize_id) WHERE host_decision IN ('PENDING', 'CONFIRMED')` closes Gate 7's genuine SELECT-then-INSERT race window at the database level, without touching Gate 7's own logic, order, or outcome.
4. **Ticket-mapping symptom (Req 2.8)**: explicitly reasoned about below (Hypothesized Root Cause) and empirically confirmed/refuted by this spec's own exploration tests — not assumed.

No change is made to `claimEngine.ts`, to any of `submit_claim`'s existing 10 gates (their logic, order, or outcome), or to the `claim-player-ticket-identity-mismatch` guard (`getActivePlayerSession`, `isBackendConfirmed`, the pre-submission consistency check, `CLEAR_STALE_PLAYER`). This fix is entirely about never letting one real-world claim submission end up as two differently-id'd entries in `state.claims`, and about making a second near-simultaneous submission for the same `(player, prize)` structurally incapable of producing two active rows, client-rendered or server-side.

## Glossary

- **Bug_Condition (C)**: A single claim submission's optimistic local entry and its server-confirmed counterpart (via RPC resolution and/or realtime echo) end up as two differently-id'd entries in `state.claims` that both survive to be rendered, OR a rapid double-submission for the same `(player, prize)` is not guaranteed to result in at most one active (`PENDING`/`CONFIRMED`) row.
- **Property (P)**: The desired behavior — one click (or one real-world submission) always ends up as exactly one claim entry in rendered state and in the database, regardless of how many underlying transitions (optimistic dispatch, RPC resolution, realtime echo) occur.
- **Preservation**: Every claim-submission flow that was NOT subject to the duplicate-id reconciliation failure (consistent single submissions, Local Fallback with no realtime echo, the `claim-player-ticket-identity-mismatch` guard's own behavior, every other `submit_claim` gate's outcome) must render and record byte-for-byte identically before and after this fix.
- **optimisticId**: The client-minted id (`localId()`) `wrappedDispatch` injects into a `MARK_TERM`/`SUBMIT_PRIZE_CLAIM`/`CONFIRM_CLAIM` action before the single real `dispatch(action)` call, guaranteeing the id applied to React state and the id used for rollback are identical by construction (established by the prior spec; reused, not re-invented, by this fix's reconciliation mechanism).
- **RECONCILE_CLAIM_ID**: The new, additive reducer action this fix introduces. Dispatched from `wrappedDispatch`'s `rpcSubmitClaim(...).then(...)` once the RPC resolves successfully; replaces the optimistic `PrizeClaim` entry (matched by its `optimisticId`) with the server's authoritative `ClaimRow`, mapped via the existing `mapRowToClaim`.
- **upsertById**: The existing pure helper (`remoteRowMappers.ts`) `SYNC_REMOTE` uses to insert-or-replace one row by `id` in a collection. Unmodified by this fix — reconciliation happens earlier (at RPC-resolution time), so by the time a realtime echo for the same row arrives, `upsertById`'s existing id-match logic already finds the (now-reconciled) entry.
- **DUPLICATE_ACTIVE_CLAIM race window**: The gap between Gate 7's `SELECT ... exists(...)` read and the subsequent `INSERT` inside `submit_claim`, during which a second, concurrently-executing call to the same function (same `player_id`/`prize_id`) could also pass Gate 7 before either transaction commits its `INSERT` — because no row lock or unique constraint currently backstops this check (confirmed absent in `0001_schema.sql`, unlike every other table's documented "hard backstop" constraint).
- **isSubmittingClaim**: The new, additive client-side UI state (one flag per in-flight prize submission, not a single global flag — since different prizes' claim buttons must remain independently clickable, consistent with Req 2.5/13.2's "each prize claim block is independently derived" convention already followed by `PlayerGame.tsx`) that disables a specific prize's Claim button while its submission is in flight.

## Bug Details

### Bug Condition

The bug manifests whenever a claim submission's optimistic entry and its server-confirmed counterpart are never reconciled to the same `id` before a realtime echo (or the RPC's own resolved value) is folded into `state.claims`. Confirmed root cause: `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` case never consumes `rpcSubmitClaim`'s resolved `ClaimRow` (no `.then`), so the optimistic entry's `id` and the real row's `id` never converge, and `upsertById`'s correct-but-insufficient id-only matching then has no way to recognize them as the same real-world claim.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT: X of type ClaimSubmissionSequence
         { optimisticClaimId: string,       // minted by localId() before dispatch
           serverClaimRowId: string,        // claims.id, server-generated gen_random_uuid()
           rpcResolutionReconciled: boolean,// whether wrappedDispatch's .then swapped the id
           realtimeEchoReceived: boolean }
  OUTPUT: boolean

  RETURN X.optimisticClaimId <> X.serverClaimRowId
     AND NOT X.rpcResolutionReconciled
     AND (X.realtimeEchoReceived OR true)
     // i.e. the optimistic entry's id was never swapped for the server's id
     // before any subsequent fold-in (echo or otherwise) had a chance to
     // deduplicate by id -- this is true for every submission on the
     // UNFIXED code, since reconciliation never happens at all today.
END FUNCTION
```

### Examples

- **Reported incident (single click, Supabase mode)**: Player clicks "Claim Cyber Five" once. `wrappedDispatch` dispatches an optimistic `PrizeClaim{ id: 'local-abc', ... }` immediately, then calls `rpcSubmitClaim(...).catch(rollback)` with no `.then`. `submit_claim` inserts a real row `claims.id = 'server-xyz'` and returns it — discarded. Moments later, Realtime delivers an `INSERT` event for `claims.id = 'server-xyz'`; `SYNC_REMOTE` → `upsertById(state.claims, mapRowToClaim(row))` finds no entry with `id === 'server-xyz'` (only `'local-abc'` exists), so it appends a second entry. Host Claim Inbox renders two `<li>` cards, keyed `'local-abc'` and `'server-xyz'`, for what was one click. **Expected after fix**: `rpcSubmitClaim`'s resolution triggers `RECONCILE_CLAIM_ID`, replacing the `'local-abc'` entry in place with the server row (now `id: 'server-xyz'`); when the realtime echo for `'server-xyz'` later arrives, `upsertById` finds the matching id immediately and overwrites it with itself (a no-op in practice) — exactly one entry throughout.
- **Local Fallback (no Supabase configured)**: `wrappedDispatch`'s local-only branch (`if (!supabase) { dispatch(action); ...; return }`) never calls `rpcSubmitClaim` and never receives a realtime echo at all — the bug condition cannot arise here by construction (confirms Req 3.7; this scenario is a Preservation Checking case, not a Fix Checking case).
- **Rapid double-click**: Two near-simultaneous `SUBMIT_PRIZE_CLAIM` dispatches for the same `(player, prize)` each mint their own `optimisticId` and each call `rpcSubmitClaim` independently (today, nothing prevents the second call — there is no `isSubmittingClaim` guard anywhere in `PlayerGame.tsx` or `wrappedDispatch`). Both calls reach `submit_claim`; if both read Gate 7's `SELECT` before either commits its `INSERT`, both pass and both insert a `PENDING` row — two real database rows for one real-world intent, not merely a client-side rendering artifact. **Expected after fix**: the client-side `isSubmittingClaim` guard prevents the second dispatch from ever firing for the same prize while the first is in flight (defense-in-depth); independently, the additive partial unique index makes the second `INSERT` fail at the database level even if two calls somehow both reach Gate 7's `SELECT` concurrently (e.g. from two different devices/tabs holding the same player's identity, which the guard cannot prevent since it is per-tab UI state).
- **Ticket-mismatch, hypothesized explanation (Req 2.8)**: the optimistic entry's `ticketRef` is captured once, at dispatch time, from `action.ticketId` resolved against `before.tickets` (`PlayerGame.tsx`'s dispatch call always passes `currentTicket.id`, itself derived via `getActivePlayerSession`). The server-confirmed row's `ticket_ref` is computed independently, server-side, from `v_ticket.ref` looked up fresh via `tickets where player_id = v_player.id`. For a session that is consistent at submission time (guarded by the prior spec's `isConsistent` check), these two must agree, because both ultimately resolve the same single `Ticket` row for the same player. The two-cards symptom is therefore most consistent with the SAME duplicate-rendering mechanism producing one card from (possibly stale-looking, if rendered mid-flight) optimistic data and a second, correct card from the authoritative echo — not a distinct ticket-resolution bug. This hypothesis is checked, not assumed, by the **wrong-ticket** exploration/fix test below; if refuted, the ticket reference's resolution itself (not just the duplicate-id mechanism) would need a second, separate fix, which is out of scope for this document unless that test demonstrates it.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- A genuinely consistent single-claim submission's full `join → mark → claim → confirm` flow continues to work exactly as today end to end, producing exactly one claim and, on confirmation, exactly one Winner History entry (claims unaffected by this bug already produced exactly one entry even on the unfixed code — Req 3.1, 3.5).
- The `claim-player-ticket-identity-mismatch` guard (`getActivePlayerSession`, `isBackendConfirmed`, the pre-submission consistency check inside `wrappedDispatch`, `CLEAR_STALE_PLAYER`) is read and run exactly as it is today; this fix adds its reconciliation logic strictly AFTER that guard's `isConsistent` check already passed and the RPC call was already made — it does not touch, bypass, weaken, or duplicate that guard (Req 3.2).
- `submit_claim`'s 10-gate validation order and every gate's outcome (`GAME_NOT_FOUND` through `NOT_ELIGIBLE`) are unchanged; the only SQL addition is a new, independent partial unique index, never a change to the function body's gate logic (Req 2.9, 3.3, 3.5).
- `confirmClaim`/`rejectClaim`/`canConfirmClaim`/the Reject flow, and every claim unaffected by this bug, render and behave exactly as today (Req 3.5).
- Refresh-mid-session and reset/rejoin continue to restore the same Player/Ticket identity and existing claims exactly as today; `initState()`, `HYDRATE_FROM_REMOTE`, and Reset/rejoin behavior are not touched beyond what this fix's dedup logic requires (Req 3.6).
- Local Fallback's full `join → mark → claim → confirm` flow is unaffected, since it never calls `rpcSubmitClaim` or receives a realtime echo (Req 3.7).
- No cross-contamination between two different players' claims: `playerId`/`ticketId`/displayed Ticket reference stay exclusively tied to the submitting player, with no identity key other than the player's own id (Req 3.4).

**Scope:**
All inputs that do NOT involve a claim submission whose optimistic entry and server-confirmed row would otherwise diverge in `id` are unaffected. This includes:
- Every host-only lifecycle action (`START_GAME`, `CALL_NEXT_WORD`, `PAUSE_GAME`, `RESUME_GAME`, `END_GAME`, `RESET_GAME`) and `CONFIRM_CLAIM`/`REJECT_CLAIM` — none of these are touched by this fix.
- `MARK_TERM` — uses the same `optimisticId` pattern already, is not touched, and this fix does not generalize `RECONCILE_CLAIM_ID` to marks (out of scope; marks have no reported duplicate-rendering symptom and no requirement calls for it).
- Any claim submission in Local Fallback mode (no RPC, no realtime echo — the mechanism this fix targets cannot occur there).

## Hypothesized Root Cause

Root cause is **confirmed by direct code inspection**, not merely hypothesized (per bugfix.md's own framing, exploration tests below still produce the required empirical confirmation before any fix is implemented):

1. **Missing `.then` on `rpcSubmitClaim`**: `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` case ends with `rpcSubmitClaim(action.playerId, action.prizeId).catch(rollback)` — the resolved `ClaimRow` is never read. This is the direct, sufficient cause of the reconciliation failure: there is no code path, anywhere, that ever updates the optimistic entry's `id` to match the server's.

2. **`upsertById` matches only by `id`, by design**: this is correct and sufficient for every OTHER caller of `SYNC_REMOTE` (marks, winners, tickets, players — none of which have this reconciliation gap, because none of their reducer cases discard their RPC's resolved row the way `SUBMIT_PRIZE_CLAIM` does). `upsertById` itself is not a design flaw; it simply has nothing to match against until reconciliation happens upstream.

3. **No unique constraint on `claims` matching Gate 7's semantics**: `0001_schema.sql`'s `claims` table has no `unique(player_id, prize_id, host_decision)`-equivalent constraint, unlike `called_terms` (`primary key (game_id, term_id)`), `marks` (`unique (player_id, ticket_id, term_id)`), `tickets` (`unique (game_id, signature)` and `unique` on `player_id`), `players` (`unique (game_id, employee_demo_id_normalized)`), and `winners` (`unique (game_id, prize_id)`) — each of these migration's own comments calling out their constraint as "the hard backstop even if application-level logic were ever bypassed." `submit_claim`'s Gate 7 is a plain pre-INSERT `SELECT ... exists(...)` with no row lock, so two near-simultaneous calls for the same `(player_id, prize_id)` could both pass Gate 7 before either commits — whether this is actually exploitable in practice (single-click only ever makes one RPC call) versus only matters for the rapid-double-click/no-UI-guard scenario is exactly what the rapid-double-click exploration test below determines.

4. **No client-side submission lock**: `PlayerGame.tsx`'s Claim button has no disabled/"Submitting..." state tied to an in-flight `SUBMIT_PRIZE_CLAIM` for that specific prize — nothing prevents a second tap from firing a second, fully independent `wrappedDispatch` call before the first's RPC round trip resolves.

5. **Ticket-mismatch symptom**: most likely fully explained by root cause #1 above (see Bug Details → Examples' third bullet for the reasoning) rather than a separate, independent ticket-resolution defect — but this is confirmed or refuted empirically by the **wrong-ticket** test, not assumed.

## Correctness Properties

Property 1: Bug Condition - Single Submission Produces Exactly One Reconciled Claim Entry

_For any_ claim submission where the bug condition holds (the optimistic entry's id has not been reconciled to the server row's id before a subsequent fold-in occurs), the fixed system SHALL dispatch `RECONCILE_CLAIM_ID` upon `rpcSubmitClaim`'s successful resolution, replacing the optimistic entry in place with the server's authoritative `ClaimRow` (same array index, new `id` and fields), SHALL result in exactly one entry in `state.claims` for that `(player, prize)` submission once both the RPC resolution and any realtime echo have been applied, and SHALL render exactly one Host Claim Inbox card whose Ticket reference matches the Ticket active for that player at submission time.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.8**

Property 2: Preservation - Unaffected Submissions and Guards Unchanged

_For any_ claim submission where the bug condition does NOT hold (Local Fallback with no RPC/echo at all, or a submission already blocked earlier by the `claim-player-ticket-identity-mismatch` consistency guard, or any submission whose single optimistic entry was never subject to a second fold-in), the fixed system SHALL produce exactly the same result as the original system: the same dispatched actions, the same `rpcSubmitClaim`/guard behavior, and the same rendered Host Claim Inbox / Winner History output.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

Property 3: Bug Condition - At Most One Active Claim Under Rapid Double-Submission

_For any_ two near-simultaneous `SUBMIT_PRIZE_CLAIM` submissions for the same `(player, prize)` pair where the first has not yet completed (client-side) or committed (server-side) when the second is attempted, the fixed system SHALL result in at most one `PENDING`/`CONFIRMED` claim for that pair, both in client-rendered state and in the underlying database — the second attempt SHALL be prevented client-side by the `isSubmittingClaim` guard where both attempts originate from the same tab, and SHALL be rejected or absorbed without a second active row at the database level (via the additive partial unique index) regardless of origin.

**Validates: Requirements 2.6, 2.7**

Property 4: Preservation - Host Claim Inbox Dedup Is a Pure Rendering Safeguard

_For any_ state of `state.claims` containing no duplicate `id`s, the Host Claim Inbox's dedup-by-id rendering step SHALL produce an identical list of rendered cards, in the same order, as rendering `state.claims` directly without deduplication — the dedup step SHALL only ever remove entries, and only when a true `id` duplicate is present, never altering content, order, or count for any claims list that was already duplicate-free.

**Validates: Requirements 2.5, 3.9**

## Fix Implementation

### Changes Required

**File**: `src/state/gameSessionReducer.ts`

1. **Add `RECONCILE_CLAIM_ID` to `GameSessionAction`**, placed alongside the other additive reconciliation-style actions (`ROLLBACK_OPTIMISTIC`, `CLEAR_STALE_PLAYER`):
   ```ts
   | { type: 'RECONCILE_CLAIM_ID'; optimisticId: string; confirmedClaim: PrizeClaim }
   ```
   `confirmedClaim` is the already-mapped `PrizeClaim` (via `mapRowToClaim(row)`, mapped once in `GameSessionContext.tsx` so the reducer stays a pure, mapper-agnostic function exactly like every other reducer case).

2. **Add the `RECONCILE_CLAIM_ID` case**:
   ```ts
   case 'RECONCILE_CLAIM_ID': {
     // Replace the optimistic entry (matched by optimisticId) with the
     // server-confirmed claim in place -- same array position, new id and
     // every other field now authoritative. If the optimistic entry is no
     // longer present (e.g. already rolled back by a rejected RPC racing
     // this -- cannot happen in practice since .then and .catch are
     // mutually exclusive outcomes of the same promise, but defensive
     // nonetheless), this is a safe no-op, mirroring every other
     // additive action's "ignore if absent" convention (RESTORE_PLAYER,
     // CLEAR_STALE_PLAYER).
     const index = state.claims.findIndex((c) => c.id === action.optimisticId)
     if (index === -1) return state
     const claims = [...state.claims]
     claims[index] = action.confirmedClaim
     return { ...state, claims }
   }
   ```
   This is additive only — no existing case's logic, order, or behavior changes.

**File**: `src/state/GameSessionContext.tsx`

3. **Add a `.then` to the `SUBMIT_PRIZE_CLAIM` case's `rpcSubmitClaim` call**, immediately after the existing consistent-session branch:
   ```ts
   // Consistent session: proceed exactly as today — unchanged request shape.
   rpcSubmitClaim(action.playerId, action.prizeId)
     .then((row) => {
       dispatch({
         type: 'RECONCILE_CLAIM_ID',
         optimisticId: augmentedAction.optimisticId!,
         confirmedClaim: mapRowToClaim(row as unknown as Record<string, unknown>),
       })
     })
     .catch(rollback)
   ```
   `augmentedAction.optimisticId` is guaranteed defined here: `SUBMIT_PRIZE_CLAIM` is always run through the existing `optimisticId` injection (`augmentedAction` computed earlier in `wrappedDispatch`, unconditionally for this action type, before this `switch` runs). `mapRowToClaim` is already imported in this file. This is the ONE code change responsible for the entire root-cause fix: once this reconciliation lands before any realtime echo for the same row is processed, `SYNC_REMOTE`'s existing `upsertById(state.claims, mapRowToClaim(row))` finds the matching `id` on its very first lookup and overwrites in place — no second entry is ever created, and `SYNC_REMOTE`/`upsertById` require zero modification.
   - **Why this mechanism over an id-fallback matcher in `SYNC_REMOTE`**: an alternative design would make `SYNC_REMOTE`'s claims case fall back to matching by `(gameId, playerId, prizeId, hostDecision)` when no `id` match is found. That alternative is strictly more invasive: it adds business-key matching logic to a case (`SYNC_REMOTE`) whose entire contract today is "exactly one authoritative row, matched by id, no business logic" — the same contract every other table's `SYNC_REMOTE` case already relies on — and it would need to handle the ambiguous case of a player resubmitting the same prize after a rejection (two real, distinct claims legitimately sharing `playerId`/`prizeId`, distinguished only by `hostDecision`/time, which a naive business-key match could still conflate). Reconciling the id at the one point where the client already KNOWS the authoritative id (the RPC's own resolved value) is strictly simpler, requires no new matching heuristic, and is the direct structural mirror of the pattern the prior spec already proved out for `optimisticId`/rollback — it was chosen as the single primary mechanism for exactly this reason, not implemented alongside the alternative as a parallel band-aid.

4. **Add per-prize `isSubmittingClaim` state**, exposed via `GameSessionContextValue`:
   ```ts
   const [submittingClaimPrizeIds, setSubmittingClaimPrizeIds] = useState<Set<PrizeId>>(new Set())
   ```
   Set this prize's id in `SUBMIT_PRIZE_CLAIM`'s case the instant the branch is entered (right after the consistency guard passes, before the optimistic dispatch above it — or, more simply, at the very top of the `SUBMIT_PRIZE_CLAIM` case, covering both the guard-blocked and guard-passed paths so a blocked attempt's brief flagged state is harmless and self-correcting); clear it in BOTH the `RECONCILE_CLAIM_ID`-dispatching `.then` and the `.catch(rollback)` branch (a `finally`-equivalent via both continuations, since this is plain promise chaining, not `async/await`), so the flag never gets stuck set after either outcome. Exposed as a derived boolean (`isSubmittingClaim(prizeId): boolean`) on `GameSessionContextValue`, not the raw `Set`, so `PlayerGame.tsx` doesn't need to know the storage representation.

5. **No change** to `resolveRollbackTarget`, `getActivePlayerSession`, `ROLLBACK_OPTIMISTIC`, or any other existing action/case.

**File**: `src/pages/PlayerGame/PlayerGame.tsx`

6. Read the new `isSubmittingClaim(prizeId)` value from `useGameSession()`. In each prize block's Claim button, add `|| isSubmittingClaim(progress.id)` to the existing `disabled={view.buttonDisabled || readOnly}` condition, and swap the button label to `"Submitting Claim..."` while true (mirroring the existing `claimStatusView`-driven label-swap convention already used for `PENDING`/`CONFIRMED` states, so this is a label/disabled change only — no new component, no restructuring, consistent with Req 3.9).

**File**: `src/pages/HostDashboard/HostDashboard.tsx`

7. **Add dedup-by-id to the Claim Inbox's render path (Req 2.5, defense-in-depth)**. `inboxGroups` is currently built as `groupClaimsForHistory(sortClaimsForInbox(state.claims))`. Add a small, pure, additive helper (co-located in `HostDashboard.tsx` next to `toClaimInboxRowViewModel`, consistent with this file's existing convention of small exported pure view-model helpers):
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
   Applied as `groupClaimsForHistory(sortClaimsForInbox(dedupeClaimsById(state.claims)))` — a pure pre-filter ahead of the existing pipeline, which is otherwise completely unmodified. This is independent, defense-in-depth protection: it has no dependency on the root-cause fix above and would mask a duplicate-id symptom even if some other, future bug reintroduced one.

**File**: `supabase/migrations/0006_claims_active_unique_index.sql` (new, additive migration)

8. **Add a partial unique index**, closing the Gate 7 race window at the database level without touching `submit_claim`'s gate logic, order, or outcome:
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
   This makes Gate 7's intent (`DUPLICATE_ACTIVE_CLAIM`) structurally impossible to violate, rather than merely checked-then-hoped: a second concurrent `INSERT` that would create a second `PENDING`/`CONFIRMED` row for the same `(player_id, prize_id)` fails with a unique-violation at the database level regardless of what either transaction's own Gate 7 `SELECT` observed. `submit_claim`'s function body is **not edited** — a unique-violation surfaces to the caller as a Postgres error distinct from any of the 10 existing raised/recorded reasons; `wrappedDispatch`'s existing `.catch(rollback)` already handles any RPC rejection generically (rolls back the optimistic entry), so no new client-side handling is required for this to be safe, though the Testing Strategy below calls for confirming what `RpcError.code` this specific violation surfaces as, for diagnostic completeness only.
   - **Whether a manual migration run is required**: yes — this is a new migration file; applying it against the live Supabase project is a required, explicit step of the implementation task list (not optional), consistent with bugfix.md's Required Final Acceptance Criteria item 16.

**File**: `src/utils/claimEngine.ts`, `supabase/migrations/0001_schema.sql` through `0005_rpc_lifecycle_and_claims.sql`

9. **No changes.** `validatePrizeClaim`'s gate order/outcomes and `submit_claim`'s existing 10-gate order/outcomes are confirmed unmodified by this design — the only SQL change is the strictly additive index in point 8.

## Testing Strategy

### Validation Approach

The testing strategy follows the two-phase bug-condition approach: exploration tests first, run against the unfixed code via the mock Supabase harness (`src/state/testSupport/mockSupabaseClient.ts`, the same harness and pattern used by `GameSessionContext.multiTabReset.integration.test.tsx` and the prior `claim-player-ticket-identity-mismatch` spec's exploration tests), to produce the empirical confirmation bugfix.md's Introduction calls for and to pin down the ticket-mismatch symptom's cause; then Fix Checking and Preservation Checking verify the implemented fix.

### Exploratory Bug Condition Checking

**Goal**: Reproduce, on the real unfixed code, one click producing two different-id'd claims entries in `state.claims` — confirming (or refuting) the root-cause hypothesis above — and determine empirically whether the ticket-mismatch symptom is the same mechanism or a separate one.

**Test Plan**: Using `createMockSupabaseClient()` and `mockGetSupabaseClient`, mount `GameSessionProvider` with a consistent, already-hydrated session (a joined player with a matching ticket, backend confirmed — satisfying the prior spec's `isConsistent` guard so the submission reaches `rpcSubmitClaim`). Queue an RPC response for `submit_claim` with a `ClaimRow` whose `id` differs from the optimistic id the test can observe was dispatched (read via the test's own subscription to `state.claims` after the optimistic dispatch, before the RPC promise resolves). After the RPC promise resolves, fire a realtime `claims` INSERT event via `fireRemoteChange` carrying that same `ClaimRow`. Assert `state.claims.length` and the ids of each entry.

**Test Cases**:
1. **single-click-produces-two-entries (unfixed)**: dispatch one `SUBMIT_PRIZE_CLAIM`, let the queued `submit_claim` RPC resolve, then fire the realtime echo for that row; assert (on unfixed code) `state.claims` ends up with 2 entries sharing `playerId`/`prizeId` but differing `id` — the exact counterexample.
2. **realtime-echo-arrives-before-rpc-resolves (unfixed)**: fire the realtime echo for the server row BEFORE awaiting the queued RPC promise's own resolution (simulating Realtime's typical latency advantage over a slow RPC round trip); assert the same 2-entry duplication occurs regardless of ordering, since neither code path ever reconciles the id.
3. **wrong-ticket-mechanism-check (unfixed)**: in the same 2-entry duplicate from case 1, compare `ticketRef` on both entries; assert they are IDENTICAL (both resolve the same single `Ticket` row for a consistent session) — this is the test that confirms or refutes the Hypothesized Root Cause's point 5. If this assertion fails (the two entries show DIFFERENT `ticketRef` values for a session the guard already confirmed consistent), that is itself the counterexample proving a second, independent ticket-resolution bug exists, and this document's Fix Implementation would need to be revisited before task creation proceeds.
4. **rapid-double-click-race (unfixed)**: dispatch two `SUBMIT_PRIZE_CLAIM` actions for the same `(player, prize)` back-to-back (same synchronous tick, mirroring the existing `stateRef.current` double-dispatch handling already present in `wrappedDispatch`), queue two separate `submit_claim` RPC responses that both resolve successfully (simulating both having passed Gate 7 before either's `INSERT`, i.e. testing the CLIENT's lack of a guard — the actual Gate 7 race itself cannot be reproduced against the mock harness, which has no real transactional database; it is validated separately in the SQL-level reasoning in Fix Implementation point 8, not by a JS-level test); assert (on unfixed code) `rpcSubmitClaim` is called twice and both resolve, with no client-side mechanism having prevented the second call.

**Expected Counterexamples**:
- Exactly 2 entries in `state.claims` for one real-world submission, confirming the `.then`-less reconciliation gap.
- Two `rpcSubmitClaim` calls for one rapid double-click, confirming the absent `isSubmittingClaim` guard.
- Identical (not divergent) `ticketRef` across the duplicate pair, confirming the ticket-mismatch symptom is explained by the same duplicate-rendering mechanism (pending this test actually being run — if it instead finds divergent values, the design's point 5 hypothesis is refuted and must be revisited).

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed system produces the expected behavior.

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  result ← renderedClaimInboxEntries'(X)
  ASSERT count(result WHERE result.playerId = X.optimisticClaim.playerId
                        AND result.prizeId = X.optimisticClaim.prizeId) = 1
     AND result[0].id = X.serverClaimRow.id          // reconciled, not the stale optimistic id
     AND result[0].ticketRef = activeTicketRefAtSubmission(X)
END FOR
```

Concretely: re-run exploration test cases 1 and 2 above against the FIXED code; assert `state.claims.length === 1` in both orderings (RPC-resolves-first and echo-arrives-first), and that the single surviving entry's `id` equals the server row's `id` (never the stale optimistic id). Re-run case 4 against the fixed `PlayerGame.tsx` + `isSubmittingClaim`; assert the second tap's dispatch never occurs (button already disabled) rather than asserting on two RPC calls. Add a dedicated test for the additive migration's intent: directly unit-test `dedupeClaimsById` (point 7) with a hand-constructed `PrizeClaim[]` containing a true `id` duplicate, asserting only the first occurrence survives and order is preserved for every other entry.

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed system produces the same result as the original system.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT wrappedDispatch_original(SUBMIT_PRIZE_CLAIM, X) = wrappedDispatch_fixed(SUBMIT_PRIZE_CLAIM, X)
  // same optimistic dispatch, same rpcSubmitClaim call shape/args, same
  // guard behavior, same rendered Claim Inbox / Winner History output
END FOR
```

**Testing Approach**: Property-based testing is not required here (the bug condition's input space — id-match vs id-mismatch, echo-before vs echo-after, single vs double submission — is small and enumerable, unlike the prior spec's cross-id consistency combinatorics), but every preservation scenario is still captured as an explicit, observation-first test: first observe the UNFIXED code's exact behavior for each scenario below, then write the test asserting the FIXED code reproduces it exactly.

**Test Plan**: Observe, on the UNFIXED code: (a) a consistent single submission with NO realtime echo configured at all (echo simply never fires in the test) — confirm it already produces exactly 1 entry even unfixed, since there is nothing to duplicate against; (b) a submission blocked by the prior spec's consistency guard — confirm `rpcSubmitClaim` is never called, matching that spec's own Fix Checking assertions; (c) a Local Fallback submission — confirm it produces exactly 1 entry with no RPC/echo involved at all. Capture each as the baseline, then assert the FIXED code reproduces each baseline exactly.

**Test Cases** (mirroring bugfix.md's Required Regression Test Coverage verbatim):
1. **single-click-produces-exactly-one-claim**: one click results in exactly one rendered Host Claim Inbox entry and exactly one underlying database row (fix-checking case, re-asserted here as the headline preservation-of-intent case for the normal path).
2. **rapid-double-click-produces-at-most-one-active-claim**: two near-simultaneous submissions for the same `(player, prize)` result in at most one `PENDING`/`CONFIRMED` claim, client-rendered and (via the migration, documented as a SQL-level reasoning check, not a JS-level test) server-side.
3. **realtime-echo-does-not-duplicate**: a realtime `SYNC_REMOTE` event for a claim row already represented locally reconciles to one entry, not appended as a second.
4. **wrong-ticket**: two different players' claims never cross-contaminate; each rendered claim's Ticket reference always matches the Ticket active for the submitting player at submission time (both before AND after this fix, for any submission the bug condition does not affect).
5. **refresh-then-claim**: a player who refreshes and then submits a claim produces exactly one claim entry, with no duplicate surviving from before the refresh (exercises `HYDRATE_FROM_REMOTE`'s existing whole-slice replace, unmodified by this fix — the fresh `state.claims` after a refresh already contains, at most, the server's own already-deduplicated rows).
6. **reset/rejoin-then-claim**: a player who resets/rejoins and then submits a claim produces exactly one claim entry for the new session, with no stale pre-reset entry duplicated or resurfacing (exercises `RESET_GAME`/`NO_ACTIVE_GAME`'s existing full-slice reseed, unmodified by this fix).

### Unit Tests

- `RECONCILE_CLAIM_ID` reducer case: replaces the matching optimistic entry in place; no-ops safely if the `optimisticId` is absent.
- `dedupeClaimsById`: removes true duplicates, preserves order and content of everything else, is a no-op on an already-duplicate-free list (Property 4).
- `isSubmittingClaim` state transitions: set on submission start, cleared on both the `.then` and `.catch` continuations, independent per `prizeId`.

### Property-Based Tests

- `dedupeClaimsById` as a pure function: for any generated `PrizeClaim[]` (with or without duplicate ids), the output's length never exceeds the input's, every output `id` is unique, and the relative order of first-occurrences is preserved — this is the one piece of new logic in this fix that is naturally and cheaply property-testable as a pure array transform.

### Integration Tests

- Full `join (mock RPC) → mark → claim (mock RPC + realtime echo in both orderings) → confirm` flow against the mock Supabase harness, asserting exactly one Claim Inbox entry and one Winner History entry throughout.
- Rapid double-click against the mounted `PlayerGame` component (via React Testing Library's `fireEvent.click` twice in the same tick), asserting the second click is a no-op because the button is already disabled by `isSubmittingClaim`.

## Required Final Acceptance Criteria (carried forward from bugfix.md)

This design does not relax, narrow, or reinterpret bugfix.md's **Required Final Acceptance Criteria** section (the real-browser acceptance test, and the 25-item completion summary). Both remain in force unchanged and are carried forward verbatim as acceptance criteria for the tasks phase of this spec; they are not restated here to avoid drift between the two documents, and the tasks phase MUST reference bugfix.md directly for their exact wording when creating the corresponding checkpoint task(s).
