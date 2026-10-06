# Player/Ticket Identity Mismatch Bugfix Design

## Overview

The bug is a staleness-of-trust problem, not a data-corruption problem. `GameSessionContext.tsx` already resolves `currentPlayer`/`currentTicket` through a single `useMemo` block, and the `submit_claim` RPC already re-derives `game_id`/`ticket_id` strictly server-side from `p_player_id` (never from a client-supplied ticket id). The actual defect is that nothing in the client ever distinguishes "this `currentPlayerId` has been confirmed to resolve against the live backend's current Active Game" from "this `currentPlayerId` merely happens to still be present in whatever `players` array is currently in memory" — which can be a stale `localStorage` snapshot from a prior game, prior Reset, or prior device session. `isHydrated` is hardcoded `true` and carries none of this distinction, so the Player screen renders a fully-formed Player/Ticket/Prize-Progress block, and the Claim button submits `currentPlayer.id`, with equal confidence whether or not that identity has ever been checked against the live Active Game.

The fix introduces:

1. A single **active-session resolver** (`getActivePlayerSession()`), exposed from `GameSessionContext.tsx`, that both Player UI rendering and Claim submission read from — so UI and claim payload are structurally incapable of disagreeing about "who is playing and on which ticket."
2. A real **backend-confirmation signal** (`isBackendConfirmed`), distinct from the always-true `isHydrated`, that is `true` only once a `HYDRATE_FROM_REMOTE` for the live Active Game has actually completed (or Supabase is not configured at all, i.e. Local Fallback). `isHydrated` keeps gating the existing no-redirect/no-flicker render path unchanged; `isBackendConfirmed` additionally gates claim submission only.
3. A **pre-submission session consistency guard**, run in `GameSessionContext.tsx` immediately before the `SUBMIT_PRIZE_CLAIM` RPC call, re-checking existence and cross-id consistency of `activePlayer`/`activeTicket`/`activeGame` using the same resolver. On failure it blocks the dispatch, returns a distinct recovery outcome the UI renders as a dedicated message, and logs non-sensitive diagnostics.
4. **Stale `currentPlayerId` invalidation**: once the backend is confirmed, if `currentPlayerId` does not resolve to a `Player` whose `gameId` matches the confirmed Active Game's id, it is cleared via the existing `RESTORE_PLAYER`-adjacent machinery and the device falls through to the normal join/restore flow — instead of continuing to render it forever.

No change is made to `claimEngine.ts`, to any `submit_claim` gate, or to any other RPC's validation. The fix is entirely about never feeding `submit_claim` a `playerId` that the client itself has not confirmed matches what it is showing on screen, and about not treating unconfirmed cached state as authoritative for the one action (claim submission) where being wrong has a user-visible, confusing consequence.

## Glossary

- **Bug_Condition (C)**: A claim is submitted (or the UI renders an identity) derived from a `currentPlayerId` that has not been confirmed, against the live backend's current Active Game, to resolve to a `Player`/`Ticket` pair consistent with that Active Game.
- **Property (P)**: The desired behavior — claim submission is blocked with a distinct recovery message (never silently submitted, never fabricated) whenever the consistency guard cannot establish `activePlayer`/`activeTicket`/`activeGame` agree with each other.
- **Preservation**: Name-only join, QR join (same join path, different entry route), refresh-restores-same-identity, duplicate-name-different-players-never-merge, Local Fallback dev mode, and all Host/Presentation/Winner-History rendering must behave exactly as today.
- **activeGame**: `state.game` once `isBackendConfirmed` is `true` (Supabase mode), or `state.game` unconditionally (Local Fallback, which has no "confirmation" concept beyond the synchronous seed).
- **activePlayer**: The `Player` in `state.players` whose `id === state.currentPlayerId`.
- **activeTicket**: The `Ticket` in `state.tickets` whose `playerId === activePlayer.id && gameId === activeGame.id` (never "first ticket found," per Req 2.6).
- **getActivePlayerSession()**: The single resolver function, added to `GameSessionContext.tsx`, returning `{ activeGame, activePlayer, activeTicket, isConsistent }` — the one place both the UI's `currentPlayer`/`currentTicket`/marks/prize-progress memo and the claim-submission guard read from.
- **isBackendConfirmed**: `true` once the live Active Game's `HYDRATE_FROM_REMOTE` snapshot has been applied for the `currentPlayerId` currently held (or always `true` in Local Fallback); flips back to a non-confirmed state while a reconnect/retry is in flight or after `NO_ACTIVE_GAME`.
- **Session consistency guard**: The check run immediately before dispatching `SUBMIT_PRIZE_CLAIM`, validating existence + cross-id agreement of `activePlayer`/`activeTicket`/`activeGame`.
- **Stale currentPlayerId**: A `currentPlayerId` that, once the backend is confirmed, does not resolve to a `Player` whose `gameId` equals the confirmed Active Game's `id`.

## Bug Details

### Bug Condition

The bug manifests whenever a claim submission (or, more broadly, a UI render used to decide whether to show the claim button as actionable) is derived from a `currentPlayerId` whose relationship to the **live, current** Active Game has never been checked. Today this happens because: (a) `isHydrated` is hardcoded `true` so the only redirect guard in `PlayerGame.tsx` (`!currentPlayer || !currentTicket`) is satisfied by a purely local/cached lookup, and (b) nothing re-validates `currentPlayerId` against the confirmed Active Game once hydration *has* actually happened, so a stale id surviving a Reset is never invalidated.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT: X of type ClaimSubmissionContext
         { localCurrentPlayerId, localPlayers, localTickets,
           backendConfirmed: boolean,
           activeGameId }
  OUTPUT: boolean

  RETURN NOT X.backendConfirmed
     OR NOT resolvedPlayer(X).gameId = X.activeGameId
     OR NOT resolvedTicket(X).playerId = resolvedPlayer(X).id
     OR NOT resolvedTicket(X).gameId = X.activeGameId
END FUNCTION
```

### Examples

- **Reported incident**: Player "Divyansh" has a stale `currentPlayerId` left over from before a Reset. The Player screen's `currentPlayer`/`currentTicket` memo resolves it against the stale cached `players`/`tickets` still sitting in `state` (no distinction from confirmed state), rendering Ticket #6405 at 5/5. Clicking Claim dispatches `SUBMIT_PRIZE_CLAIM` with that stale `playerId`. `submit_claim` resolves it server-side to a different, real player/ticket (#4292) belonging to a game that is no longer the Active Game, returning `PLAYER_NOT_IN_GAME`. Expected: once the Active Game is confirmed, the stale id is recognized as not matching that Active Game *before* submission is attempted, submission is blocked client-side with a recovery message, and the device is routed back through join/restore.
- **Fresh join, same session, no reset**: `currentPlayerId` resolves to a `Player` whose `gameId` matches the confirmed Active Game, whose `Ticket.playerId`/`gameId` both agree. Guard passes; claim submits exactly as today; `submit_claim` validates/records it exactly as today.
- **Mid-flight reconnect**: Device loses connectivity briefly; `remoteSyncStatus` is `'syncing'` (retry in progress) and `isBackendConfirmed` is `false` for the in-flight attempt. The Player screen still renders the last-known cached state (no flicker, no forced redirect — Req 2.4, Req 3.3) but the Claim button, if pressed in this window, is blocked by the guard (bug condition holds: `NOT backendConfirmed`) with the recovery message, not silently submitted.
- **Edge case — Local Fallback (no Supabase configured)**: There is no "unconfirmed" state to model (no network round trip exists at all); `isBackendConfirmed` is always `true` in this mode and the guard's existence/cross-id checks still run (and should trivially pass for any session reachable through the pure local reducer), so Local Fallback claim submission is unaffected in practice.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Name-only join and QR join both continue to resolve through `joinGame()` / `buildJoinOutcome()` unchanged; this fix adds no new required input and no new validation step to the join form itself.
- A refresh mid-session continues to restore the same Player/Ticket identity with no forced re-join, as long as that identity is confirmed consistent with the Active Game (this is the overwhelmingly common case and is explicitly preserved — see Property 2).
- Two different players joining with the same display name continue to get distinct `Player` ids/tickets, matched only via the opaque per-device join token, never via `displayName`.
- Local Fallback dev mode continues to support the full join → mark → claim → confirm flow unaffected by the new guard (the guard's checks are satisfied trivially since Local Fallback's `state.players`/`state.tickets` are always internally consistent by construction).
- Host Dashboard, Presentation View, Claim Inbox, and Winner History rendering are not touched structurally; they keep reading `state.claims`/`state.winners` exactly as today.

**Scope:**
All inputs that do NOT involve an unconfirmed or stale `currentPlayerId` at claim-submission time are unaffected. This includes:
- Mouse/tap interaction with every other control on the Player screen (ticket cells, nothing-to-do-with-identity banners).
- Marking terms (`MARK_TERM`) — not gated by this guard; Req 3.8 keeps `markTerm`/prize computation unchanged.
- Host-only actions (`START_GAME`, `CALL_NEXT_WORD`, `PAUSE_GAME`, `RESUME_GAME`, `END_GAME`, `RESET_GAME`, `CONFIRM_CLAIM`, `REJECT_CLAIM`) — none of these read `currentPlayerId` and none are touched by this fix.

## Hypothesized Root Cause

1. **No confirmation signal distinct from synchronous local hydration**: `isHydrated` was deliberately designed (per its own doc comment) to model "the local restore is synchronous," conflating that with "this identity is safe to act on." There is no second signal for "confirmed against the live backend."

2. **`currentPlayer`/`currentTicket` memo has no notion of trust tier**: `GameSessionContext.tsx`'s `useMemo` resolves `currentPlayer`/`currentTicket` purely structurally (`state.players.find(...)`, `state.tickets.find((t) => t.id === currentPlayer.ticketId)`) regardless of whether `state` reflects a confirmed snapshot or a yet-unconfirmed cached one.

3. **No re-validation point before claim submission**: `PlayerGame.tsx`'s claim `onClick` dispatches `SUBMIT_PRIZE_CLAIM` directly with `currentPlayer.id`/`currentTicket.id` with no gate of its own; `wrappedDispatch` in `GameSessionContext.tsx` forwards straight to `rpcSubmitClaim(action.playerId, action.prizeId)` with no pre-flight consistency check.

4. **No stale-id invalidation after Reset**: `RESET_GAME`/`reset_game_to_new` intentionally leave a Player tab's `currentPlayerId` untouched (by design, so a genuinely active tab isn't logged out by someone else's reset) — but there is no corresponding mechanism that later recognizes "the backend's confirmed Active Game no longer has a player with this id in it" and clears the id. The two correct-in-isolation designs (don't log out active tabs; always trust local cache once hydrated) combine into the bug.

## Correctness Properties

Property 1: Bug Condition - Claim Submission Blocked for Unconfirmed/Inconsistent Session

_For any_ claim-submission attempt where the bug condition holds (`isBugCondition` returns true — the backend is not yet confirmed for the current `currentPlayerId`, or `activePlayer`/`activeTicket`/`activeGame` do not mutually agree), the fixed system SHALL NOT dispatch `SUBMIT_PRIZE_CLAIM` or call `rpcSubmitClaim`, SHALL instead show the player a distinct recovery message directing them to rejoin/refresh, and SHALL log non-sensitive dev diagnostics (`ACTIVE_GAME_ID`, `CURRENT_PLAYER_ID`, `ACTIVE_TICKET_ID`, which check failed) without logging secrets.

**Validates: Requirements 2.2, 2.3, 2.4, 2.7**

Property 2: Preservation - Consistent Session Claim Submission Unchanged

_For any_ claim-submission attempt where the bug condition does NOT hold (the backend is confirmed and `activePlayer`/`activeTicket`/`activeGame` mutually agree), the fixed system SHALL produce exactly the same result as the original system: the same `SUBMIT_PRIZE_CLAIM` payload is dispatched, the same `rpcSubmitClaim` call is made, and the same `submit_claim` RPC gates (`PLAYER_NOT_FOUND`, `PLAYER_NOT_IN_GAME`, `TICKET_NOT_FOUND`, `TICKET_NOT_OWNED_BY_PLAYER`, `PRIZE_NOT_FOUND`, `DUPLICATE_ACTIVE_CLAIM`, `RESUBMISSION_LIMIT_REACHED`, `PRIZE_CLOSED`, `NOT_ELIGIBLE`) evaluate and record the claim exactly as before.

**Validates: Requirements 3.1, 3.5, 3.6, 3.8**

Property 3: Bug Condition - Stale currentPlayerId Invalidated, Not Rendered Indefinitely

_For any_ confirmed Active Game state where `currentPlayerId` does not resolve to a `Player` with `gameId` equal to that Active Game's id, the fixed system SHALL clear `currentPlayerId` (never silently continue rendering the stale resolution) and SHALL route the device back through the normal join/restore flow, exactly like a device with no `currentPlayerId` at all.

**Validates: Requirements 2.5, 1.5**

Property 4: Preservation - UI and Claim Payload Never Diverge

_For any_ render of the Player screen and any claim submitted from it in the same consistent session, the Ticket reference shown on the Player screen, the Ticket reference recorded on the submitted claim, and the Ticket reference later shown in the Host Claim Inbox / Winner History for that same claim SHALL all be identical, because both are derived from the single `getActivePlayerSession()` resolver (Req 2.1, 2.7).

**Validates: Requirements 2.1, 2.7, 2.8, 3.1**

## Fix Implementation

### Changes Required

**File**: `src/state/GameSessionContext.tsx`

1. **Add `isBackendConfirmed` state**, parallel to the existing `hasActiveGame` state:
   - `useState<boolean>(true)` initially — this matches today's "Local Fallback has no confirmation gap" behavior and `isHydrated`'s existing semantics for the very first synchronous render.
   - Set to `false` the moment the mount-time effect discovers Supabase IS configured and begins its first `resolveInitialGame` attempt (mirrors `remoteSyncStatus` flipping to `'syncing'`), i.e. before any claim has a chance to be evaluated against possibly-stale cached `players`/`tickets`.
   - Set to `true` inside `hydrateForGame(...)`, immediately after dispatching `HYDRATE_FROM_REMOTE` — this is the first point at which `state.players`/`state.tickets` are guaranteed to reflect the live Active Game.
   - Set to `false` again whenever `NO_ACTIVE_GAME` is dispatched (no Active Game to be confirmed against) and whenever a pointer-change event triggers a new `getActiveGame()`/`hydrateForGame` round trip, until that round trip's own `HYDRATE_FROM_REMOTE` lands.
   - Deliberately NOT used to gate `isHydrated` or the `PlayerGame.tsx` redirect guard — `isHydrated` keeps its current always-`true` value and current meaning, so the no-flicker/no-forced-rejoin behavior (Req 3.3) is unaffected. `isBackendConfirmed` is an *additional*, narrower-purpose signal consumed only by the claim-submission guard.

2. **Add `getActivePlayerSession()`** inside the `value` memo, next to the existing `currentPlayer`/`currentTicket` derivation (which it supersedes as the one source of truth — `currentPlayer`/`currentTicket`/`currentPlayerMarks`/`currentPrizeProgress` are now *derived from* this resolver's output rather than independently re-deriving the same `.find(...)` calls):
   ```ts
   function getActivePlayerSession(): {
     activeGame: GameSessionState['game']
     activePlayer?: Player
     activeTicket?: Ticket
     isConsistent: boolean
     inconsistencyReason?:
       | 'NOT_BACKEND_CONFIRMED'
       | 'PLAYER_NOT_FOUND'
       | 'PLAYER_NOT_IN_GAME'
       | 'TICKET_NOT_FOUND'
       | 'TICKET_NOT_OWNED_BY_PLAYER'
   }
   ```
   Resolution order, mirroring Req 2.2/2.6 and `claimEngine.ts`'s existing gate vocabulary (reused for consistency, not re-invented):
   - `activeGame := state.game`
   - `activePlayer := state.players.find(p => p.id === state.currentPlayerId)`
   - `activeTicket := state.tickets.find(t => t.playerId === activePlayer?.id && t.gameId === activeGame.id)` — the deterministic single-ticket resolution Req 2.6 requires (never "first ticket in array").
   - `isConsistent := isBackendConfirmed && !!activePlayer && !!activeTicket && activePlayer.gameId === activeGame.id && activeTicket.playerId === activePlayer.id && activeTicket.gameId === activeGame.id`
   - This function is pure given `state`/`isBackendConfirmed` (no side effects) so it is safe to call both from the render-time memo and from the guard.

3. **Rendering continues to use the resolver's `activePlayer`/`activeTicket`** output unconditionally (i.e. even when `isConsistent` is `false`) for `currentPlayer`/`currentTicket`/`currentPlayerMarks`/`currentPrizeProgress` — this preserves today's no-flicker optimistic rendering (Req 2.4: the UI may still show cached state while unconfirmed). Only claim *submission* is gated on `isConsistent`.

4. **Add the pre-submission guard inside `wrappedDispatch`**, specifically in the `SUBMIT_PRIZE_CLAIM` case, before calling `rpcSubmitClaim`:
   - Call `getActivePlayerSession()` against `before` (the state captured at the top of `wrappedDispatch`, consistent with how `resolveRollbackTarget` already uses `before`/`after`).
   - If `isConsistent` is `false`: do NOT call `rpcSubmitClaim`. Do NOT fabricate/synthesize a replacement ticket or player. Roll back the optimistic `SUBMIT_PRIZE_CLAIM` dispatch that already ran earlier in `wrappedDispatch` (same `rollback()` helper already wired via `resolveRollbackTarget`, so the optimistic claim entry that was just added to `state.claims` is removed rather than left dangling as a phantom PENDING claim the backend never saw).
   - Dispatch a new lightweight, additive action (e.g. `SESSION_GUARD_BLOCKED`) carrying `inconsistencyReason`, so the Player screen can render the distinct recovery message (see below) without `GameSessionContext` reaching into React state setters it doesn't otherwise own; alternatively, expose a `lastSessionGuardFailure` value directly on `GameSessionContextValue` set via a `useState` inside the provider (chosen implementation: a `useState<SessionGuardFailure | undefined>` cleared on the next successful consistent submission or on navigation, since this is purely ephemeral UI feedback, not shared/persisted session state — it must never be written to `localStorage` or broadcast via `syncChannel`).
   - If `isConsistent` is `true`: proceed exactly as today — call `rpcSubmitClaim(action.playerId, action.prizeId)`, same rollback-on-rejection behavior, byte-for-byte unchanged.

5. **Add stale-`currentPlayerId` invalidation**, as a new effect in `GameSessionProvider` that runs whenever `isBackendConfirmed` flips to `true` (i.e. right after a `HYDRATE_FROM_REMOTE`):
   - Compute `activePlayer := state.players.find(p => p.id === state.currentPlayerId)`.
   - If `state.currentPlayerId` is set AND (`activePlayer` is undefined OR `activePlayer.gameId !== state.game.id`): dispatch a new, additive action `CLEAR_STALE_PLAYER` (reducer case: `return { ...state, currentPlayerId: undefined }`, mirroring `RESTORE_PLAYER`'s existing "ignore if absent" convention but for the inverse case). This also clears the persisted `CURRENT_PLAYER_STORAGE_KEY` via the existing `writeCurrentPlayerId(undefined)` effect that already runs off `state.currentPlayerId` changes — no new persistence code needed.
   - This effect intentionally does NOT run while `isBackendConfirmed` is `false` (mid-retry/no Active Game) — a transient disconnection must never be mistaken for "this player's game is gone" and must never clear a genuinely-active tab's identity (Req 2.4's "still render cached state while pending" would otherwise be defeated by this very effect).
   - Once cleared, `PlayerGame.tsx`'s existing `!currentPlayer || !currentTicket` redirect guard fires on the next render exactly as it already does for a brand-new device with no `currentPlayerId` at all — no new redirect logic needed, just correct input to the existing one.

**File**: `src/state/gameSessionReducer.ts`

6. Add two small, additive reducer cases (no existing case is modified):
   - `CLEAR_STALE_PLAYER`: `{ ...state, currentPlayerId: undefined }`.
   - `SESSION_GUARD_BLOCKED` is NOT a reducer action (see point 4 — implemented as provider-local `useState`, not shared state) to avoid persisting/broadcasting purely-ephemeral UI feedback through the shared envelope or `syncChannel`.

**File**: `src/pages/PlayerGame/PlayerGame.tsx`

7. Read the new `lastSessionGuardFailure` (or equivalent) value from `useGameSession()`. When set and matching the prize just attempted, render the distinct recovery message instead of (or alongside) the existing per-prize `claimStatusView` message — worded distinctly from the generic `"Claim could not be validated. Your current progress is X/Y."` string (Req 2.3), e.g.: `"Your session is out of date. Please refresh or rejoin to continue."` with a visible "Refresh" action (reusing the existing `Button`/`Card` components already used for the `remoteSyncStatus === 'error'` notice, for visual consistency).
8. No change to the `Navigate to="/player"` redirect guard itself — it continues to fire purely off `currentPlayer`/`currentTicket` being absent, which is exactly what `CLEAR_STALE_PLAYER` now ensures happens for a stale identity once confirmed.

**File**: `src/pages/PlayerEntry.tsx` / join flow

9. No changes required: once `currentPlayerId` is cleared, `PlayerEntry.tsx`'s existing routing to `PlayerJoin` (because there is no `currentPlayer`) already re-engages the normal join/restore path, including the existing device-join-token restore lookup in `join_game` — a device that still has a legitimately-active player in the (new) Active Game will be restored automatically via that same token lookup, not asked to re-enter their name.

**File**: `supabase/migrations/*.sql`, `src/utils/claimEngine.ts`

10. **No changes.** `submit_claim` already re-derives `game_id`/`ticket_id`/the player row strictly server-side from `p_player_id`, and its 10-gate order already rejects a genuinely stale/mismatched player id with `PLAYER_NOT_IN_GAME` or the appropriate code. This fix does not touch, weaken, or duplicate any of that — it only prevents the client from calling it with an id the client itself has not confirmed is current.

### Temporary Diagnostic Logging (Req 2.3)

- Logged only from the guard-failure branch in `wrappedDispatch` (point 4 above), guarded behind a single `if (import.meta.env.DEV)` check (or an equivalent existing dev-only convention already used in this codebase, e.g. mirroring `console.info` calls already present in `realtimeClient.ts` for channel status) so it is inert in a production build without a separate feature flag to maintain.
- Logs exactly: `ACTIVE_GAME_ID` (`state.game.id`), `CURRENT_PLAYER_ID` (`state.currentPlayerId`), `ACTIVE_TICKET_ID` (`activeTicket?.id`), and `inconsistencyReason`. No display names, no device join tokens, no host secrets, no full `players`/`tickets` arrays.
- Implemented as a single `console.warn('[session-guard]', { ... })` call (or a tiny local helper if reused in more than one place) — trivially greppable and removable as a single line/block.
- Final removal (or down-leveling to a quieter signal if it proves useful long-term) happens during task execution once the fix is verified against the regression test plan below, not as a separate, undocumented follow-up — the task list for this spec will include an explicit task to remove or down-level this logging after the exploratory/fix/preservation tests all pass.

## Testing Strategy

### Validation Approach

The testing strategy follows the two-phase bug-condition approach: first, write/observe tests that demonstrate the bug on the current (unfixed) code to confirm the root-cause hypothesis above; then verify the fix via Fix Checking (bug-condition inputs now behave correctly) and Preservation Checking (non-bug-condition inputs are provably unchanged).

### Exploratory Bug Condition Checking

**Goal**: Surface a concrete counterexample reproducing the reported incident shape (stale `currentPlayerId` across a Reset, submitted claim resolves to a different ticket than the one rendered) BEFORE implementing the fix, confirming the root-cause hypothesis.

**Test Plan**: Using the existing mock Supabase test harness (`src/state/testSupport/mockSupabaseClient.ts`) already used by `GameSessionContext.multiTabReset.integration.test.tsx` and `realtimeClient.activeGamePointer.test.ts`, construct a scenario where: a player joins Game A, game A is reset (new Active Game B created, pointer repointed), a second player independently joins Game B reusing the same `id` namespace collision is not needed — simply confirm the *first* tab's `currentPlayerId` (now referencing a player row that belongs to Game A, no longer the Active Game) is never invalidated and still renders a full ticket/prize-progress block on the unfixed code, and that attempting `SUBMIT_PRIZE_CLAIM` with it is not blocked client-side.

**Test Cases**:
1. **Stale identity renders fully after reset (unfixed)**: Join Game A, trigger `reset_game_to_new`, assert `currentPlayer`/`currentTicket` are STILL non-undefined and fully resolved on the unfixed code (demonstrating Req 1.1/1.5's defect).
2. **Claim submission not blocked pre-fix**: From that same stale state, dispatch `SUBMIT_PRIZE_CLAIM`; assert (unfixed) that `rpcSubmitClaim` is called with the stale `playerId` with no client-side pre-check.
3. **Unconfirmed-state submission not blocked pre-fix**: Simulate `isHydrated === true` immediately on mount before any `HYDRATE_FROM_REMOTE` resolves (i.e. before the mock's `getActiveGame` promise settles); assert claim submission is not blocked despite the backend snapshot being unconfirmed.

**Expected Counterexamples**:
- `currentPlayer`/`currentTicket` remain defined (and renderable) using data that no longer belongs to the confirmed Active Game.
- `rpcSubmitClaim`/`submitClaim` mock is invoked with a `playerId` that does not resolve to a player in the confirmed Active Game — this is the exact `PLAYER_NOT_IN_GAME` condition from the incident report.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior (submission blocked, recovery message shown, stale id eventually cleared).

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := wrappedDispatch_fixed({ type: 'SUBMIT_PRIZE_CLAIM', ... }, input)
  ASSERT result.rpcSubmitClaimCalled = false
  ASSERT result.claimAddedToState = false   // optimistic entry rolled back
  ASSERT result.recoveryMessageShown = true
  ASSERT result.devDiagnosticsLogged = true
  ASSERT result.secretsLogged = false
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT wrappedDispatch_original(SUBMIT_PRIZE_CLAIM, input)
       = wrappedDispatch_fixed(SUBMIT_PRIZE_CLAIM, input)
  // same rpcSubmitClaim call, same resulting claims entry, same rendered
  // Ticket reference on the Player screen, Claim Inbox, and Winner History
END FOR
```

**Testing Approach**: Property-based testing is recommended for the cross-id consistency checks (`activePlayer.gameId === activeGame.id`, `activeTicket.playerId === activePlayer.id`, `activeTicket.gameId === activeGame.id`) because:
- It can generate many combinations of (player, ticket, game) id agreement/disagreement far faster than hand-written cases, which is exactly the shape of bug this incident was.
- It catches an asymmetric case a manual test might miss (e.g. `activePlayer.gameId` matches but `activeTicket.gameId` doesn't, which is a different, equally-valid route into the bug condition than the reported one).
- It provides a strong guarantee that `getActivePlayerSession()`'s `isConsistent` output is byte-for-byte unchanged in behavior for every genuinely-consistent combination, which is the preservation property this fix cares most about not regressing.

**Test Plan**: First, observe on the UNFIXED code that a consistent session's full join → mark → claim → confirm flow produces a specific sequence of dispatched actions / rpc calls / rendered Ticket references; capture that as the baseline. Then write the property-based test asserting the FIXED code's `getActivePlayerSession()` and `wrappedDispatch` reproduce that exact baseline for every generated consistent combination, and block for every generated inconsistent one.

**Test Cases**:
1. **Exact ticket match (consistent session)**: Join → mark to eligibility → claim. Assert Player screen's `shortTicketRef(currentTicket.id)`, the submitted claim's `ticketRef`, and the eventual Winner History `ticketRef` are identical.
2. **Reset/rejoin**: Host resets; a Player tab with a now-stale `currentPlayerId` has it cleared once the backend is confirmed for the new Active Game; the Player screen redirects to join; rejoining issues a new ticket (never reuses the retired one).
3. **Refresh mid-session**: A genuinely consistent Player refreshes; `currentPlayerId` restores from `localStorage`; once confirmed, the guard's checks pass trivially; no redirect, no guard failure, claim submission (if attempted) behaves exactly as pre-refresh.
4. **Duplicate name, different devices**: Two devices join with the same `displayName`; each gets a distinct `playerId`/`ticketId` via distinct device join tokens; each device's `getActivePlayerSession()` resolves independently and consistently to its own player/ticket, never the other's.
5. **Genuinely stale player from a different game, post-fix**: Construct a `playerId` whose `gameId` really does belong to a different (non-Active) game. Assert the client-side guard blocks it with the recovery message BEFORE any RPC call is made — and, separately, confirm (unit/integration test directly against `submit_claim`'s SQL behavior, unchanged) that if such an id were ever submitted anyway, the server still independently rejects it with `PLAYER_NOT_IN_GAME`, proving the server-side gate remains intact as a backstop and was not weakened by this fix.
6. **Ticket reference consistency across surfaces**: For a single successfully-submitted, then host-confirmed claim, assert the Ticket reference is identical across the Player screen's header, the Host Claim Inbox row for that claim, and the Winner History entry for that confirmed claim.

### Unit Tests

- `getActivePlayerSession()`: existence checks (missing player, missing ticket), each of the four cross-id agreement checks individually (so a failure in any one is independently attributable, matching the dev-diagnostic reason codes), and the `isBackendConfirmed` gate.
- `wrappedDispatch`'s `SUBMIT_PRIZE_CLAIM` branch: guard-blocked path never calls `rpcSubmitClaim`, correctly rolls back the optimistic claim entry, and surfaces the distinct failure value; guard-passed path is behaviorally identical to today's implementation.
- `CLEAR_STALE_PLAYER` reducer case: clears `currentPlayerId` when absent/mismatched, is a no-op convention consistent with `RESTORE_PLAYER`'s existing style when there's nothing to clear.
- `PlayerGame.tsx`: renders the distinct recovery message (not the generic "could not be validated" string) when a guard failure is present; existing per-prize message rendering unchanged otherwise.

### Property-Based Tests

- Generate random `(player.gameId, ticket.playerId, ticket.gameId, activeGame.id, isBackendConfirmed)` tuples and assert `getActivePlayerSession().isConsistent` matches the exact boolean formula in the Bug Condition's formal specification for every generated tuple.
- Generate random sequences of join → (optional reset) → (optional refresh) → claim and assert the Ticket reference invariant (Property 4) holds across Player screen / Claim Inbox / Winner History for every generated sequence that never hits the bug condition.
- Generate random claim-eligible sessions and assert that for every one classified as NOT bug-condition, the fixed `wrappedDispatch` issues an RPC call with payload identical to what the pre-fix implementation would have issued (regression-free preservation across many scenarios, not just the hand-picked ones).

### Integration Tests

- Full flow: join (Supabase mode, mocked) → mark to Cyber Five eligibility → claim → host confirms → Winner History shows the same ticket ref as the Player screen showed throughout.
- Reset mid-session: Player A is active in Game 1; Host resets to Game 2; Player A's tab (not rejoined) has its stale identity cleared once Game 2 is confirmed, and is redirected to join; Player A rejoins Game 2 and gets a fresh ticket.
- Transient disconnect: simulate the mock Supabase client's initial fetch failing twice then succeeding (reusing the existing retry/backoff test pattern already present for `remoteSyncStatus`); assert claim submission attempted during the two failed attempts is blocked by the guard, and succeeds normally once confirmed.
- Dev diagnostics: assert the specific non-sensitive fields are logged on a guard failure and that no secret-shaped value (host secret, device join token) ever appears in any logged argument.
