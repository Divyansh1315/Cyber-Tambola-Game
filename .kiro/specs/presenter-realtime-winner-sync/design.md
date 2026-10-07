# Presenter Realtime Winner Sync Bugfix Design

## Overview

Reading `PresentationView.tsx` confirms the bug's structural mechanism exactly as bugfix.md's investigation describes it: the component's only notion of "which Winner is currently showing" is `findLatestUndismissedWinner(state.winners, dismissedWinnerIds)`, where `dismissedWinnerIds` is a `useState<Set<string>>` seeded empty on every mount. There is no reducer action, no shared field, and no derived selector that connects "the Host clicked Next Cyber Word" to "stop showing the Winner" — `PresentationView.tsx` never reads `game.currentTermId` or `game.currentRound` changes for this purpose at all. The Dismiss button is the only mechanism that clears a shown Winner, and it writes to component-local state that a refresh (or a second Presenter tab) never sees.

Separately, `game.status === 'COMPLETED'` renders a static message and never reads `state.winners`/`state.winnerHistory`, so Problem C (no Final Summary) is simply a missing branch, not a defect in existing logic.

The fix has four independent, individually testable parts:

1. **Primary mechanism (Problems A, B)**: add one new shared, authoritative field — `game.latestWinnerAnnouncementId: string | undefined` — set by `CONFIRM_CLAIM`'s existing reducer case to the newly-created Winner's id, and cleared by `CALL_NEXT_WORD`'s and `START_GAME`'s reducer cases. `RESET_GAME`/`NO_ACTIVE_GAME` require no additional code: both already replace `state` wholesale via `gameSessionInitialState`/a fresh seed game, which carries no `latestWinnerAnnouncementId` (it is `undefined` by construction on a fresh `Game`). This mirrors the `optimisticId`/`lastSessionGuardFailure` convention already established in this codebase: a single, narrowly-scoped additive field, set and cleared by exactly the actions whose semantics govern it, with every other action leaving it untouched.
2. **Presenter display-mode derivation (Problem B, Req 2.10)**: a new pure, exported, testable function `derivePresenterMode(state)` co-located in `PresentationView.tsx`, implementing the exact 4-step priority order from Req 2.10. This replaces `findLatestUndismissedWinner` entirely — the new field directly answers "is there an active, not-yet-superseded Winner," so no reversed-array search over `state.winners` combined with a locally-tracked dismissed-set is needed.
3. **Final Winner Summary (Problems C, D)**: a new pure, exported, testable function `buildFinalWinnerSummary(winners, activeGameId)`, deriving the five fixed prize categories (in `PRIZES`' existing order: Cyber Five, Firewall Line, Security Line, Data Defender Line, Cyber Full House) and each category's confirmed winner (or "No Winner") from `state.winners` filtered to the active game.
4. **`SYNC_REMOTE` game-id guard (Req 2.8)**: investigated below in Hypothesized Root Cause and Fix Implementation. Conclusion: a reachable (if narrow) race exists, because a real Supabase Realtime channel's `unsubscribe()` is an asynchronous teardown over the websocket, not a synchronous guarantee against already-in-flight server-pushed events to already-registered `.on()` callbacks. The guard is added, at the point where it is actually race-free: inside the `subscribeToGame` callback registered in `hydrateForGame`, comparing the incoming change's `row.game_id` against `gameIdRef.current` — the ref holding the id this specific provider instance currently considers active — rather than inside the reducer, which has no way to know "which game id this provider instance currently considers active" independent of `state.game.id` itself (and `state.game.id` is exactly the field a stale event might otherwise be about to corrupt).

`toAnnouncementViewModel` is extended to also return `ticketRef`, preserving its existing exclusion of Employee ID, internal Player ID, Supabase ids, and claim validation codes.

No change is made to `claimEngine.ts`, `prizeEngine.ts`, or `winnerEngine.ts` — their validation/eligibility/confirmation logic, gate order, and outputs are untouched. This fix is scoped to `PresentationView.tsx` (display-mode derivation, Final Summary, removal of the local dismiss mechanism), `gameSessionReducer.ts` (one additive field, set/cleared by two existing cases), and `GameSessionContext.tsx` (the `SYNC_REMOTE`-adjacent `game_id` guard inside `subscribeToGame`'s callback registration). `RESET_GAME`'s existing `winners` → `winnerHistory` fold, `NO_ACTIVE_GAME`'s reset, `CONFIRM_CLAIM`'s confirmed-only invariant, and the pointer-follow effect's unsubscribe-before-subscribe ordering are all preserved exactly as they exist today.

## Glossary

- **Bug_Condition (C)**: the Presenter's rendered display mode disagrees with the priority rule in Req 2.10 — either because Presenter-local-only state (`dismissedWinnerIds`) or a missing FINAL_RESULTS/reset-clearing mechanism causes it to show the wrong thing, or because a stale cross-game Realtime event is applied without a `game_id` check.
- **Property (P)**: for every state, the Presenter's displayed mode and content SHALL match the Req 2.10 priority order exactly: `COMPLETED` → FINAL_RESULTS; else active undismissed Winner → WINNER; else active game with current term → WORD; else LOBBY.
- **Preservation**: ordinary LOBBY/WORD_ACTIVE/PAUSED rendering, the pointer-follow effect's unsubscribe-before-subscribe behavior, `RESET_GAME`'s winners→winnerHistory fold, `NO_ACTIVE_GAME`'s reset, and `CONFIRM_CLAIM`'s confirmed-only invariant must behave exactly as today.
- **latestWinnerAnnouncementId**: the new, additive field on `Game` (`game.latestWinnerAnnouncementId: string | undefined`). Holds the `id` of the most recently confirmed Winner that has not yet been superseded by a Next-Cyber-Word (or Start-Game) action. `undefined` means "no active announcement."
- **derivePresenterMode**: the new pure function in `PresentationView.tsx` that computes the Presenter's display mode (`'LOBBY' | 'WORD' | 'WINNER' | 'FINAL_RESULTS'`) from `GameSessionState`, implementing Req 2.10's priority order.
- **buildFinalWinnerSummary**: the new pure function (co-located with `derivePresenterMode`) that derives the five-category Final Winner Summary from `state.winners` and the active game id.
- **findLatestUndismissedWinner / dismissedWinnerIds**: the existing mechanism this fix removes entirely — a reversed-array search combined with Presenter-local-only `useState`, replaced by reading `game.latestWinnerAnnouncementId` directly.
- **gameIdRef**: the existing `useRef<string | undefined>` in `GameSessionContext.tsx`, already set inside `hydrateForGame` to the Supabase-assigned game id this provider instance currently tracks as active. Reused (not duplicated) as the comparison point for the new `game_id` guard, because it is the one value that is already correctly updated at the right moment (immediately on `hydrateForGame`, before the new channel is even subscribed) and is not itself subject to the same staleness the guard exists to prevent.

## Bug Details

### Bug Condition

The bug manifests whenever the Presenter's rendered mode is derived from `dismissedWinnerIds` (Presenter-local, non-shared, reset to empty on every mount) instead of from shared state that correctly reflects whether a confirmed Winner has since been superseded by a Next-Cyber-Word action, or whenever `game.status === 'COMPLETED'` is reached with no Final Summary logic at all, or whenever a stale cross-game Realtime event is applied with no `game_id` check.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT: X of type PresenterStateTransition
         { priorGameId, currentGameId,
           winnerJustConfirmed: boolean,
           nextWordCalledSinceWinner: boolean,
           gameStatus: 'LOBBY' | 'WORD_ACTIVE' | 'PAUSED' | 'COMPLETED',
           presenterRefreshed: boolean,
           resetOccurred: boolean,
           staleEventGameId?: string }
  OUTPUT: boolean

  RETURN (X.resetOccurred AND NOT fullyResetToNewGame(X))
      OR (X.gameStatus = 'COMPLETED' AND NOT showingFinalResultsSummary(X))
      OR (X.winnerJustConfirmed AND NOT X.nextWordCalledSinceWinner AND NOT showingWinnerAnnouncement(X))
      OR (X.nextWordCalledSinceWinner AND showingWinnerAnnouncement(X))
      OR (X.presenterRefreshed AND renderedDisplayMode(X) <> expectedDisplayMode(X))
      OR (X.staleEventGameId IS DEFINED AND X.staleEventGameId <> X.currentGameId
          AND eventWouldBeApplied(X))
END FUNCTION
```

### Examples

- **Problem A (reported incident)**: Host confirms a Winner for "Cyber Five"; `latestWinnerAnnouncementId` is set; the Presenter shows the announcement. Host then clicks "Reset Game." `RESET_GAME` replaces state wholesale with a fresh seed game (no `latestWinnerAnnouncementId`), folding the old `winners` into `winnerHistory`. Today, `dismissedWinnerIds` (component-local, never cleared by this transition for an already-mounted Presenter tab) is irrelevant to the symptom here because `state.winners` itself is now `[]` — `findLatestUndismissedWinner([], ...)` correctly returns `undefined`. The actual Problem A failure mode is narrower than "the dismiss mechanism leaks a stale Winner across reset" and is instead about Problem C/D's missing summary-clearing and the Req 2.8 Realtime race (see below) — this spec's exploration tests (Testing Strategy) confirm which of these actually reproduces a visible stale Winner post-reset on the current code, rather than assuming the mechanism.
- **Problem B (manual dismiss, no shared state)**: Host confirms a Winner. Presenter A shows the announcement with a "Dismiss Winner Announcement" button. Presenter B (a second tab/device, or the same tab after a refresh) mounts with `dismissedWinnerIds = new Set()` and independently re-derives `findLatestUndismissedWinner(state.winners, new Set())`, which still finds the same Winner — so Presenter B correctly shows it. But if Presenter A's operator clicks Dismiss, only Presenter A's local state changes; Presenter B keeps showing it indefinitely, and even Presenter A loses this tracking on its own next refresh. **Expected after fix**: no dismiss button exists; `latestWinnerAnnouncementId` is shared state, so every Presenter instance — regardless of mount time or refresh — renders identically from the same source of truth, and clears only when the Host calls Next Cyber Word.
- **Problem C (no Final Summary)**: Host clicks "End Game." `game.status` becomes `'COMPLETED'`. Today: static "Game Completed" message, no read of `state.winners`. **Expected after fix**: `derivePresenterMode` returns `'FINAL_RESULTS'` (priority 1, overriding even an active announcement), and `buildFinalWinnerSummary(state.winners, state.game.id)` renders all five categories, each with its confirmed winner's name + ticket reference or "No Winner."
- **Problem D (stale artifact across reset)**: Host resets mid-announcement. **Expected after fix**: `RESET_GAME`'s existing wholesale state replace means `game.latestWinnerAnnouncementId` is `undefined` on the new seed game, `game.currentTermId` is `undefined`, `game.status` is `'LOBBY'`, and `state.winners` is `[]` — `derivePresenterMode` sees none of priorities 1-3 satisfied and falls through to LOBBY, with the new game's own code/QR (never the old one, since `game.code` is part of the same wholesale replace).
- **Req 2.8 edge case (stale Realtime event)**: Reset creates game B while game A's Realtime channel is still finishing its asynchronous unsubscribe handshake with the Supabase server. A `winners` INSERT event for game A, already in flight, is delivered to game A's `.on()` callback a moment after `hydrateForGame` has already dispatched `HYDRATE_FROM_REMOTE` for game B and subscribed game B's channel. Without a guard, `SYNC_REMOTE`'s `winners` case would call `upsertById(state.winners, mapRowToWinner(row))` and insert game A's winner into game B's `state.winners` — a different game's Winner leaking into the new game's state, directly causing a Problem-A-shaped symptom through a different mechanism than the dismiss-button one. **Expected after fix**: the callback registered in `hydrateForGame` checks `row.game_id === gameIdRef.current` before dispatching `SYNC_REMOTE` at all; a stale event for game A fails this check once `gameIdRef.current` has been updated to game B's id (which happens synchronously, before game B's channel is even subscribed) and is dropped.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `RESET_GAME` continues to fold `state.winners` into `state.winnerHistory` and reset `winners`, `claims`, `players`, `tickets`, `game.revealedTermIds`, `game.currentRound`, and `game.code` to the fresh seed game's values, exactly as `gameSessionReducer.ts`'s current case already does (Req 3.1).
- `NO_ACTIVE_GAME` continues to reset `game`/`players`/`tickets`/`marks`/`claims`/`winners` to initial values while preserving `currentPlayerId`, exactly as today (Req 3.2).
- `CONFIRM_CLAIM` continues to only ever create a `Winner` from a claim that passes `canConfirmClaim`, never from a pending/rejected/otherwise-non-confirmed claim (Req 3.3).
- LOBBY, WORD_ACTIVE, and PAUSED rendering — lobby QR/Game Code, circuit background, Cyber Word/definition/awareness-tip layout — are unchanged for any state transition unrelated to Winner announcement, game completion, or reset (Req 3.4).
- The pointer-follow effect's unsubscribe-before-subscribe ordering, and its no-op when the announced id equals the already-tracked active game id, are unchanged (Req 3.5).
- Local Fallback (no Supabase configured) continues to support the full Host-confirms-winner → Presenter-shows-announcement → Host-calls-next-word → Presenter-shows-word flow using the existing local reducer logic alone (Req 3.6).
- This fix does not redesign the Host Dashboard or Player screens, and does not change `prizeEngine.ts`/`claimEngine.ts`/`winnerEngine.ts` validation logic (Req 3.8).
- The Lobby display mode continues to show the currently active game's own code/QR, never a stale one, immediately after a reset exactly as in the non-reset case (Req 3.9).

**Scope:**
All inputs that do NOT involve a Winner-confirmation/Next-Word/game-completion/reset transition, and do NOT involve a cross-game Realtime event, are unaffected. This includes:
- Every LOBBY/WORD_ACTIVE/PAUSED render driven by ordinary mid-game play (marking terms, calling the next word with no pending announcement, pausing/resuming).
- `REJECT_CLAIM` — never creates a Winner, never touches `latestWinnerAnnouncementId`.
- Any Realtime event whose `row.game_id` already matches the currently tracked game id — the new guard is a no-op for every event that was already going to be applied correctly.

## Hypothesized Root Cause

1. **No shared "active announcement" signal**: `findLatestUndismissedWinner` combined with Presenter-local `dismissedWinnerIds` was the only mechanism ever built for "which Winner is showing," and it was never wired to any Host action — there is no code path reacting to `CALL_NEXT_WORD`/`START_GAME` to clear a shown Winner, and no code path making the shown-Winner signal survive a refresh or a second Presenter instance consistently.

2. **No FINAL_RESULTS branch at all**: the `game.status === 'COMPLETED'` render path was built before Winner tracking existed in its current form and was never revisited to read `state.winners`/`state.winnerHistory`. This is a missing feature, not a defect in existing logic — `CONFIRM_CLAIM`'s confirmed-only invariant already gives the Final Summary everything it needs to read correctly.

3. **`SYNC_REMOTE` has no `game_id` guard, and `unsubscribe()` is not a synchronous barrier**: investigated directly (not assumed) by inspecting `GameSessionContext.tsx`'s pointer-follow effect and `hydrateForGame`, and corroborated against Supabase's own documented channel-teardown behavior ([`removeChannel`/`unsubscribe` returns a Promise and performs an async handshake with the Realtime server](https://supabase.com/docs/reference/javascript/removechannel) — it is a teardown request, not an instantaneous local no-op). `gameChannel?.unsubscribe()` is called and then immediately followed, in the same synchronous block, by `subscribeToGame(gameRow.id, ...)` for the new game — but calling `unsubscribe()` does not guarantee the Realtime *server* has stopped pushing already-in-flight or already-queued messages for the old subscription's socket frames before the new subscription's own messages start arriving. Confirmed as a reachable (if narrow) gap: the window exists between `unsubscribe()` being called (client-side, fire-and-forget) and the old channel's subscription actually being torn down server-side. The project's own mock Supabase harness (`mockSupabaseClient.ts`) models `unsubscribe()` as synchronous and immediate (deletes registered listeners synchronously, see `fireRemoteChange`'s doc comment: "A channel that has been `.unsubscribe()`d no longer has any registered listener at all") — which is why this race has never surfaced in the existing test suite: the mock cannot reproduce it. This asymmetry between the mock and the real client is itself part of why Req 1.6/2.8 call for an explicit investigation rather than trusting the existing (mock-based) test suite's silence as evidence of safety.

4. **No reset-aware clearing for Final Summary/announcement state together**: because neither `latestWinnerAnnouncementId` nor a Final Summary existed before this fix, Problem D ("don't retain stale previous-game artifacts") had nothing explicit to clear beyond what `RESET_GAME`'s existing wholesale replace already clears structurally. The fix's job here is almost entirely to make sure the two new pieces of state this spec introduces (`latestWinnerAnnouncementId`, implicitly, and the Final Summary's pure derivation) ride along with that existing wholesale replace rather than needing new, separate reset-handling code.

## Correctness Properties

Property 1: Bug Condition - Presenter Display Mode Follows Req 2.10 Priority At All Times

_For any_ state where the bug condition holds (the rendered display mode would disagree with Req 2.10's priority order — a stale announcement is shown after Next Word, no Final Summary is shown when `COMPLETED`, a stale cross-game Winner leaks into state, or a Presenter refresh/second-instance disagrees with another), the fixed system SHALL derive the display mode via `derivePresenterMode(state)` using shared, authoritative state only (`game.status`, `game.latestWinnerAnnouncementId`, `game.currentTermId`), SHALL return `'FINAL_RESULTS'` whenever `game.status === 'COMPLETED'` regardless of any other field, SHALL return `'WINNER'` only while `game.latestWinnerAnnouncementId` is defined and not yet superseded, and SHALL render a Final Summary that includes all five fixed prize categories and only confirmed winners when in `'FINAL_RESULTS'` mode.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.10**

Property 2: Preservation - Unaffected Transitions and Mechanisms Unchanged

_For any_ state transition where the bug condition does NOT hold (ordinary LOBBY/WORD_ACTIVE/PAUSED rendering with no pending announcement or completion, `RESET_GAME`'s winners→winnerHistory fold, `NO_ACTIVE_GAME`'s reset, `CONFIRM_CLAIM`'s confirmed-only invariant, the pointer-follow effect's unsubscribe-before-subscribe ordering, or any Realtime event whose `game_id` already matches the active game), the fixed system SHALL produce exactly the same result as the original system.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.9**

Property 3: Bug Condition - Ticket Reference Added Without Expanding Exposed Fields

_For any_ Winner announcement rendered on the Presenter, the fixed `toAnnouncementViewModel` SHALL include `ticketRef` in addition to `prizeLabel`/`playerName`, and SHALL continue to exclude Employee ID, internal Player ID, Supabase ids, and claim validation codes from its output.

**Validates: Requirements 2.9**

Property 4: Bug Condition - Stale Cross-Game Realtime Events Rejected

_For any_ Realtime event whose `row.game_id` does not equal the game id this provider instance currently tracks as active (`gameIdRef.current`) at the moment the event is received, the fixed system SHALL NOT dispatch `SYNC_REMOTE` for that event, preventing a stale event from an old, torn-down channel from being applied to a newer game's state.

**Validates: Requirements 2.8**

## Fix Implementation

### Changes Required

**File**: `src/state/gameSessionReducer.ts`

1. **Add `latestWinnerAnnouncementId` to `Game`** — actually declared on the `Game` interface in `src/types/game.ts`, as an additive optional field alongside `previousStatus`:
   ```ts
   /**
    * The id of the most recently confirmed Winner that has not yet been
    * superseded by a Next-Cyber-Word or Start-Game action (presenter-
    * realtime-winner-sync fix). `undefined` means no active announcement.
    * Shared/authoritative — never Presenter-local-only state — so every
    * Presenter instance (any tab, any refresh) renders identically.
    */
   latestWinnerAnnouncementId?: string
   ```

2. **Set it in `CONFIRM_CLAIM`'s existing case**, at the point the new `Winner` is created — additive only, no existing line in this case changes:
   ```ts
   case 'CONFIRM_CLAIM': {
     const claim = state.claims.find((c) => c.id === action.claimId)
     if (!claim || !canConfirmClaim(claim, state.winners)) return state

     const decidedAt = now()
     const updatedClaims = state.claims.map((c) =>
       c.id === claim.id ? { ...c, hostDecision: 'CONFIRMED' as const, decidedAt } : c,
     )
     const newWinner: Winner = {
       id: action.optimisticId ?? localId(),
       gameId: claim.gameId,
       prizeId: claim.prizeId,
       playerId: claim.playerId,
       ticketId: claim.ticketId,
       claimId: claim.id,
       confirmedAt: decidedAt,
       prizeLabel: claim.prizeLabel,
       playerName: claim.playerName,
       ticketRef: claim.ticketRef,
     }
     return {
       ...state,
       claims: updatedClaims,
       winners: [...state.winners, newWinner],
       game: { ...state.game, latestWinnerAnnouncementId: newWinner.id },
     }
   }
   ```

3. **Clear it in `CALL_NEXT_WORD`'s existing case**, in both branches (bank-exhausted → COMPLETED, and the normal next-term branch) — additive only:
   ```ts
   case 'CALL_NEXT_WORD': {
     if (game.status !== 'WORD_ACTIVE') return state

     const next = selectNextTerm(cyberTerms, game.revealedTermIds)
     if (!next) {
       return {
         ...state,
         game: { ...game, status: 'COMPLETED', endedAt: now(), latestWinnerAnnouncementId: undefined },
       }
     }

     return {
       ...state,
       game: {
         ...game,
         currentRound: game.currentRound + 1,
         currentTermId: next.id,
         revealedTermIds: [...game.revealedTermIds, next.id],
         latestWinnerAnnouncementId: undefined,
       },
     }
   }
   ```
   Clearing unconditionally (whether or not an announcement was active) is correct and simpler than conditionally checking first — if `latestWinnerAnnouncementId` was already `undefined`, setting it to `undefined` again is a no-op in effect.

4. **Clear it in `START_GAME`'s existing case** — additive only, same reasoning (Starting a fresh LOBBY→WORD_ACTIVE transition can only happen when there is no in-progress announcement in practice, since a Winner can only be confirmed from a claim, which requires marks, which require an active game — but clearing it defensively here costs nothing and keeps the invariant "every term-advancing action clears the announcement" uniform across both actions that advance `currentTermId`):
   ```ts
   const started: Game = {
     ...game,
     status: 'WORD_ACTIVE',
     startedAt: now(),
     currentRound: 1,
     currentTermId: first.id,
     revealedTermIds: [...game.revealedTermIds, first.id],
     latestWinnerAnnouncementId: undefined,
   }
   ```

5. **No change to `RESET_GAME`/`NO_ACTIVE_GAME`**: both already return a wholesale-replaced state built from `gameSessionInitialState`/`createSeedGame(...)`, neither of which sets `latestWinnerAnnouncementId` — it is `undefined` by construction (a `Game` object literal that never mentions the field has it as `undefined` under the interface's optional-field semantics), exactly mirroring Req 3.1/3.2's "no additional code required" framing.

6. **No change to `PAUSE_GAME`/`RESUME_GAME`/`REJECT_CLAIM`/`MARK_TERM`/`SUBMIT_PRIZE_CLAIM`/any `SYNC_REMOTE`/`SYNC_LOCAL`/`HYDRATE_FROM_REMOTE` case**: none of these create or supersede a Winner announcement, so none read or write `latestWinnerAnnouncementId`. `SYNC_REMOTE`'s `games` case and `HYDRATE_FROM_REMOTE` already replace/merge the full `Game` object (`mapRowToGame(row)` / `snapshot.game`), so once a `latest_winner_announcement_id` column (see Fix Implementation point 10 below for the Supabase-mode mapping note) is added server-side, these two cases pick it up automatically with zero additional reducer code — they are already whole-object replaces.

**File**: `src/types/game.ts`

7. Add the `latestWinnerAnnouncementId?: string` field to the `Game` interface as shown in point 1 above, with its doc comment. No other field changes.

**File**: `src/pages/PresentationView/PresentationView.tsx`

8. **Remove**: the `dismissedWinnerIds` `useState<Set<string>>`, the `findLatestUndismissedWinner` function, and the "Dismiss Winner Announcement" `Button` and its `onClick` handler. These are deleted outright, not deprecated — no caller outside this file uses `findLatestUndismissedWinner` (confirmed: it is only defined and consumed within this file).

9. **Add `derivePresenterMode`**, co-located where `findLatestUndismissedWinner`/`toAnnouncementViewModel` currently live (this file already establishes the convention of small, exported, pure, independently-testable helpers alongside the component that consumes them — a separate module would only add an import with no benefit, since nothing else in the codebase needs this function):
   ```ts
   export type PresenterDisplayMode = 'LOBBY' | 'WORD' | 'WINNER' | 'FINAL_RESULTS'

   /**
    * Implements Req 2.10's exact priority order, reading only shared,
    * authoritative state (never Presenter-local state):
    *   1. game.status === 'COMPLETED'              -> FINAL_RESULTS
    *   2. game.latestWinnerAnnouncementId is set    -> WINNER
    *   3. game.status === 'WORD_ACTIVE' && currentTermId -> WORD
    *   4. otherwise                                  -> LOBBY
    * PAUSED is intentionally folded into the existing separate
    * `game.status === 'PAUSED'` render branch, which this function's
    * callers check independently (see component body) -- PAUSED has no
    * priority conflict with WINNER/FINAL_RESULTS/WORD since a paused game
    * cannot simultaneously be WORD_ACTIVE, and an active announcement
    * during a pause still correctly takes priority per step 2 (a Winner
    * confirmed just before a pause stays visible through the pause,
    * exactly as Req 2.1's "no timer" and Req 3.4's "PAUSED unchanged for
    * transitions unrelated to Winner announcement" both require).
    */
   export function derivePresenterMode(state: GameSessionState): PresenterDisplayMode {
     if (state.game.status === 'COMPLETED') return 'FINAL_RESULTS'
     if (state.game.latestWinnerAnnouncementId !== undefined) return 'WINNER'
     if (state.game.status === 'WORD_ACTIVE' && state.game.currentTermId) return 'WORD'
     return 'LOBBY'
   }
   ```
   The component body replaces its current `latestWinner ? ... : <>{game.status === ...}</>` branching with a `switch (derivePresenterMode(state))`, keeping the existing LOBBY/WORD/PAUSED JSX bodies verbatim (Req 3.4) and adding a new WINNER case (reading the Winner identified by `state.game.latestWinnerAnnouncementId` via `state.winners.find(w => w.id === ...)`) and a new FINAL_RESULTS case. PAUSED is read as today, as a sibling check inside the same switch's default/fallthrough handling for `game.status === 'PAUSED'` (unchanged from current structure — this fix does not restructure that branch beyond threading it through the new `switch`).

10. **Add `buildFinalWinnerSummary`**, co-located next to `derivePresenterMode`:
    ```ts
    export interface FinalWinnerSummaryEntry {
      prizeId: PrizeId
      prizeLabel: string
      winnerName?: string
      ticketRef?: string
    }

    /**
     * Derives the five-category Final Winner Summary live from
     * `state.winners`, filtered to the active game and already
     * confirmed-only by construction (CONFIRM_CLAIM's existing invariant —
     * Req 2.5, 3.3). Never reads state.claims. Category order and labels
     * come from PRIZES (prizeEngine.ts) — the single existing source of
     * truth for prize ids/labels/order — not re-declared here, so this
     * function and prizeEngine.ts can never silently drift out of sync.
     */
    export function buildFinalWinnerSummary(
      winners: readonly Winner[],
      activeGameId: string,
    ): FinalWinnerSummaryEntry[] {
      const gameWinners = winners.filter((w) => w.gameId === activeGameId)
      return PRIZES.map((prize) => {
        const winner = gameWinners.find((w) => w.prizeId === prize.id)
        return {
          prizeId: prize.id,
          prizeLabel: prize.label,
          winnerName: winner?.playerName,
          ticketRef: winner?.ticketRef,
        }
      })
    }
    ```
    `PRIZES` is imported from `../../utils/prizeEngine` (already the canonical source for prize id/label/order, confirmed by direct inspection — `[CYBER_FIVE, FIREWALL_LINE, SECURITY_LINE, DATA_DEFENDER_LINE, CYBER_FULL_HOUSE]`). The FINAL_RESULTS render branch maps this array to one row per category, rendering `winnerName`/`ticketRef` when present or a literal "No Winner" string when `winnerName` is `undefined` — never falling back to any claim data, satisfying Req 2.5's "never display a pending, rejected, or otherwise non-confirmed claim as if it were a winner" by construction (the function's input type is `Winner[]`, which cannot contain a non-confirmed record, per `CONFIRM_CLAIM`'s existing invariant preserved in point 5/6 above).

11. **Extend `toAnnouncementViewModel`**:
    ```ts
    export function toAnnouncementViewModel(winner: Winner): {
      prizeLabel: string
      playerName: string
      ticketRef: string
    } {
      return { prizeLabel: winner.prizeLabel, playerName: winner.playerName, ticketRef: winner.ticketRef }
    }
    ```
    `Winner.ticketRef` already exists on the type (`src/types/prize.ts`); this is a pure additive field in the return shape, continuing to exclude every field this view-model has always excluded (Employee ID, internal Player ID, Supabase ids, claim validation codes — none of which were ever read from `winner` here in the first place).

**File**: `src/state/GameSessionContext.tsx`

12. **Add the `game_id` guard inside `hydrateForGame`'s `subscribeToGame` callback** (Req 2.8), at the exact point the callback is registered — not inside the reducer, because the reducer has no parameter carrying "which game id this provider instance currently considers active" independent of `state.game.id`, and `state.game.id` is precisely the field a stale cross-game event could otherwise be about to overwrite/pollute before the guard even runs. `gameIdRef.current` is the correct, race-free comparison point: it is set synchronously at the top of `hydrateForGame`, strictly before the new channel is even subscribed, so by the time ANY event (old-channel-stale or new-channel-fresh) reaches this callback, `gameIdRef.current` already reflects the newly active game — a stale event's `row.game_id` will correctly fail the comparison, and a fresh event's `row.game_id` will correctly pass it, regardless of exactly when either arrives relative to the asynchronous unsubscribe handshake.
    ```ts
    gameChannel?.unsubscribe()
    gameChannel = subscribeToGame(gameRow.id, (change) => {
      // presenter-realtime-winner-sync fix (Req 2.8): a real Supabase
      // Realtime channel's unsubscribe() is an async teardown over the
      // websocket, not a synchronous guarantee against already-in-flight
      // server-pushed events for the just-unsubscribed old channel. Guard
      // against applying a stale event from a torn-down old game's channel
      // to this (newer) game's state. gameIdRef.current is compared, not
      // state.game.id, because this callback is registered once per
      // hydrateForGame call and must always compare against the game id
      // THIS specific subscription was opened for, which gameIdRef.current
      // already correctly tracks (set synchronously above, before this
      // channel is even subscribed) -- not whatever state.game.id happens
      // to be by the time an event is actually received.
      const incomingGameId = (change.row as Record<string, unknown>).game_id as
        | string
        | undefined
      if (incomingGameId !== undefined && incomingGameId !== gameIdRef.current) {
        return // stale cross-game event -- drop it
      }
      dispatch({ type: 'SYNC_REMOTE', change })
    })
    ```
    This guard is a no-op for `games`-table events, whose row IS the game row itself: `change.row.id` (not `.game_id`) is that row's own primary key, and `games` rows are never keyed by a separate `game_id` column — the guard's `incomingGameId !== undefined` check naturally skips this case (no `.game_id` field exists on a `games` row), preserving today's behavior for that table exactly. Every other table in `RemoteChange['table']` (`called_terms`, `tickets`, `players`, `marks`, `claims`, `winners`) carries a `game_id` column (confirmed by `fetchFullGameState`'s existing `selectRows(supabase, table, gameId)` calls, each filtering by `.eq('game_id', gameId)`), so the guard applies uniformly to all of them.

13. **No change** to the pointer-follow effect's own unsubscribe-before-subscribe ordering, `resolveRollbackTarget`, `getActivePlayerSession`, or any other existing dispatch branch — this is the only code change in this file for this fix.

**File**: `src/pages/HostDashboard/HostDashboard.tsx`

14. **No changes.** `CONFIRM_CLAIM`/`CALL_NEXT_WORD`/`START_GAME` are dispatched exactly as today (`dispatch({ type: 'CONFIRM_CLAIM', claimId: claim.id })`, `dispatchLifecycleAction({ type: 'CALL_NEXT_WORD' })`, `dispatchLifecycleAction({ type: 'START_GAME' })`) — this fix's reducer changes are entirely internal to how those three actions already mutate `game`, requiring no change to any call site or to `HostDashboard.tsx`'s own rendering.

**File**: `src/utils/claimEngine.ts`, `src/utils/prizeEngine.ts`, `src/utils/winnerEngine.ts`

15. **No changes.** `PRIZES` is read (imported), never modified; `canConfirmClaim`'s gate logic, `validatePrizeClaim`'s gates, and `validateMarkAttempt` are untouched.

### Why the shared field (Option A), not pure derivation (Option B)

Option B — deriving "the active announcement" purely from existing fields with no new state at all (e.g. "the most-recently-confirmed Winner whose `confirmedAt` is after the current term's own call time") — was considered and rejected after working through the actual data available, not hand-waved:

- There is no "call time" field on a `CyberTerm` or on `game.currentTermId` today. `game.revealedTermIds` is an append-order array of term ids with no associated timestamp per entry, and `game.currentRound` is a plain incrementing counter — neither carries "when was the current term called," which Option B's own framing (`confirmedAt is after the current term's own call time`) requires as an input.
- Even approximating "call time" via `game.currentRound` comparison (e.g. "a Winner confirmed during round N should be superseded once `currentRound > N`") breaks down across a Reset: `RESET_GAME` resets `currentRound` to `0` on the NEW seed game, so a round number is only meaningful within a single game's lifetime — any derivation keyed on round-number ordering would need a game-id-scoped comparison anyway, which is already most of the complexity of just tracking the id directly.
- A `Winner` record has `confirmedAt` (an ISO timestamp) but comparing it against "the current term's call time" still requires that second timestamp to exist somewhere, which it does not — introducing one would mean adding a new field to `Game`/`CyberTerm` tracking, which is not meaningfully simpler than adding `latestWinnerAnnouncementId` directly, and would require the derivation to handle the Winner-confirmed-after-the-most-recent-call-but-before-the-next-one window correctly, which is exactly what an explicit "is this the active one" flag already encodes directly and unambiguously.
- Option A requires touching exactly two existing reducer cases (`CONFIRM_CLAIM` to set, `CALL_NEXT_WORD`/`START_GAME` to clear) with one line each, needs zero new fields on any OTHER type, and composes for free with `RESET_GAME`/`NO_ACTIVE_GAME`'s existing wholesale-replace semantics (point 5 above) — it is strictly less code and strictly more directly correct than any timestamp- or round-number-based derivation this investigation could construct from the fields that actually exist today.

Option A is adopted as the single primary mechanism.

## Testing Strategy

### Validation Approach

The testing strategy follows the two-phase bug-condition approach: first, write/observe exploration tests reproducing each of Problems A-D (and the Req 2.8 race) on the current (unfixed) code; then verify the fix via Fix Checking (bug-condition inputs now behave correctly) and Preservation Checking (non-bug-condition inputs are provably unchanged). All five scenarios from bugfix.md's "Required Regression Test Coverage" section are covered verbatim below, each attributed to exploration, fix-checking, or preservation.

### Exploratory Bug Condition Checking

**Goal**: surface counterexamples demonstrating each of Problems A-D, and the Req 2.8 race, BEFORE implementing the fix.

**Test Plan**: using `renderHook`/component tests against `GameSessionProvider` plus the existing mock Supabase test harness (`src/state/testSupport/mockSupabaseClient.ts`) for the Req 2.8 scenario (the ONLY scenario among these that requires the mock — the mock's `fireRemoteChange`/`unsubscribe` mechanics are themselves the subject under test for this one case; the other four exercise the Local Fallback reducer/component path directly, since they do not depend on Supabase being configured).

**Test Cases**:
1. **winner-announcement-then-next-word-clears-it (unfixed)**: dispatch `CONFIRM_CLAIM`, mount `PresentationView`, assert the announcement renders; dispatch `CALL_NEXT_WORD`; assert (unfixed) the announcement is NOT cleared by anything in the component except the manual Dismiss button — there is no code path reacting to `CALL_NEXT_WORD` at all, so `findLatestUndismissedWinner` still returns the same Winner, confirming Problem B's root cause directly.
2. **reset-clears-winner-and-returns-to-lobby (unfixed)**: dispatch `CONFIRM_CLAIM`, dispatch `RESET_GAME`; assert `state.winners` is now `[]` (so the OLD mechanism's symptom here is actually absent — document this explicitly, since it is a case where the current code already happens to behave correctly for the data-level reason given in Bug Details' first example) but assert there is still no Final Summary shown for the (unrelated) `COMPLETED` case, and that a Presenter mounted BEFORE the reset with a non-empty `dismissedWinnerIds` demonstrates no regression either way — this test's purpose is to pin down precisely which symptom (if any) is reproducible for Problem A via the dismiss-state mechanism specifically, rather than assuming it.
3. **end-game-shows-full-summary-all-five-categories (unfixed)**: dispatch however many `CONFIRM_CLAIM`s, then `END_GAME`; assert (unfixed) the rendered output is the static "Game Completed" message with no prize category, no winner name, and no read of `state.winners` at all — confirming Problem C directly.
4. **missing-winners-show-no-winner-per-category (unfixed)**: same as above but with zero or partial `CONFIRM_CLAIM`s; assert (unfixed) there is no per-category rendering to even inspect, since no Final Summary exists yet — confirming Problem C's absence covers this scenario too (there is nothing to check per-category because there is no per-category output at all pre-fix).
5. **new-game-pointer-switch-no-stale-winner-leaks (unfixed, Req 2.8)**: using the mock Supabase client, hydrate game A, confirm a Winner for game A, trigger a reset (hydrate game B via a new pointer event), then call `mockSupabaseClient.fireRemoteChange({ table: 'winners', eventType: 'INSERT', row: { ...gameA'sWinnerRow } })` AFTER game B's channel has been subscribed but using game A's OLD channel reference if the mock still allows firing against an unsubscribed channel's listeners (if the mock's `unsubscribe()` already removes listeners synchronously — confirmed by direct inspection of `mockSupabaseClient.ts` — this specific test can only demonstrate the gap by directly invoking the registered callback function reference the fix adds a guard around, rather than through `fireRemoteChange` against an already-unsubscribed mock channel; document this limitation explicitly in the test file, since it is why Req 2.8's fix is informed by code-level/documentation-level investigation of the REAL Supabase client's async teardown behavior rather than by a failing mock-based test — the mock cannot reproduce the real race by construction).

**Expected Counterexamples**:
- No reaction to `CALL_NEXT_WORD` while an announcement is showing (Problem B).
- No Final Summary content at all when `COMPLETED` (Problem C).
- Confirmed: the mock Supabase harness's synchronous `unsubscribe()` cannot reproduce the real async-teardown race, so Req 2.8's guard is justified and verified by code inspection + the guard's own unit test (does the guard function reject a mismatched `game_id`), not by an end-to-end failing-then-passing mock scenario.

### Fix Checking

**Goal**: verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  mode := derivePresenterMode'(input.state)
  ASSERT mode = expectedDisplayMode(input)
  ASSERT (input.state.game.status = 'COMPLETED') IMPLIES mode = 'FINAL_RESULTS'
  ASSERT (mode = 'FINAL_RESULTS') IMPLIES
      allFiveCategoriesShown(buildFinalWinnerSummary(input.state.winners, input.state.game.id))
      AND onlyConfirmedWinnersShown(...)
  ASSERT (mode = 'WINNER') IMPLIES noEmployeeOrInternalIdsShown(toAnnouncementViewModel(winner))
  ASSERT (incomingEvent.game_id <> gameIdRef.current) IMPLIES NOT dispatched('SYNC_REMOTE')
END FOR
```

**Test Cases** (fix-checking versions of the five exploration cases above, now against the fixed code):
1. **winner-announcement-then-next-word-clears-it (fixed)**: dispatch `CONFIRM_CLAIM` → `derivePresenterMode` returns `'WINNER'`; dispatch `CALL_NEXT_WORD` → `game.latestWinnerAnnouncementId` is `undefined`, `derivePresenterMode` returns `'WORD'`, and the newly-called word is shown, with no timer involved anywhere in the mechanism.
2. **reset-clears-winner-and-returns-to-lobby (fixed)**: dispatch `CONFIRM_CLAIM` (mode = WINNER), dispatch `RESET_GAME` → `derivePresenterMode` on the new state returns `'LOBBY'` (fresh seed game, no `latestWinnerAnnouncementId`, `status: 'LOBBY'`), with the new game's own code/QR, no stale announcement or summary.
3. **end-game-shows-full-summary-all-five-categories (fixed)**: confirm 2-3 winners across different prizes, dispatch `END_GAME` → `derivePresenterMode` returns `'FINAL_RESULTS'`; `buildFinalWinnerSummary` returns exactly 5 entries, in `PRIZES`' order, each confirmed winner's name + ticketRef populated.
4. **missing-winners-show-no-winner-per-category (fixed)**: confirm winners for only 2 of 5 prizes, dispatch `END_GAME` → the other 3 entries in `buildFinalWinnerSummary`'s output have `winnerName === undefined` (rendered as "No Winner"), and no pending/rejected claim's data ever appears in any entry (the function's input type structurally forbids it).
5. **new-game-pointer-switch-no-stale-winner-leaks (fixed)**: unit-test the guard function/closure directly: given `gameIdRef.current = 'game-B-id'` and an incoming `change.row.game_id = 'game-A-id'`, assert `dispatch` is never called with that change; given a matching `game_id`, assert `dispatch` IS called exactly as before.

### Preservation Checking

**Goal**: verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT presenterRender_original(input) = presenterRender_fixed(input)
  // ordinary LOBBY / WORD_ACTIVE / PAUSED rendering, pointer-follow channel
  // subscribe/unsubscribe behavior, RESET_GAME's winners->winnerHistory
  // fold, NO_ACTIVE_GAME's reset, CONFIRM_CLAIM's confirmed-only invariant,
  // and SYNC_REMOTE's existing behavior for every game_id-matching event
  // are all byte-for-byte unchanged.
END FOR
```

**Testing Approach**: property-based testing is recommended for `derivePresenterMode` and the `game_id` guard specifically, because:
- It can generate many combinations of `(game.status, latestWinnerAnnouncementId, currentTermId)` far faster than hand-written cases, which is exactly the shape of ambiguity Req 2.10's priority order exists to resolve deterministically.
- It can generate many `(incomingGameId, gameIdRef.current)` pairs to confirm the guard's pass/fail boundary is exact (equal → applied, not-equal → dropped), including the `games`-table-row case where no `.game_id` field exists at all.
- It provides a strong guarantee that every state combination that was already correct pre-fix (every LOBBY/WORD_ACTIVE/PAUSED state with no pending announcement) renders identically after the fix, which is the preservation property this fix cares most about not regressing.

**Test Plan**: first observe, on the UNFIXED code, that ordinary LOBBY/WORD_ACTIVE/PAUSED renders (no Winner ever confirmed, no reset, no completion) produce a specific output; capture that as the baseline. Then write the property-based test asserting the FIXED code's `derivePresenterMode`/component output reproduces that exact baseline for every generated non-bug-condition combination.

**Test Cases**:
1. **Ordinary mid-game play unaffected**: for randomly generated `(status: 'WORD_ACTIVE', currentTermId: <some id>, latestWinnerAnnouncementId: undefined)` states, assert `derivePresenterMode` returns `'WORD'` and the rendered word/definition/tip layout is pixel-for-pixel the existing JSX, exactly as before this fix.
2. **PAUSED unaffected**: for randomly generated paused states with no pending announcement, assert the existing `⏸ Game Paused` message renders exactly as today.
3. **RESET_GAME's data-level fold unaffected**: for randomly generated `state.winners` arrays and pre-existing `state.winnerHistory` arrays, assert `RESET_GAME`'s output `winnerHistory` is always `[...oldWinnerHistory, ...oldWinners]` and every other reset field matches `gameSessionInitialState`/the fresh seed game, exactly as the current implementation already guarantees — this fix adds no new field to touch here.
4. **SYNC_REMOTE game_id-matching events unaffected**: for randomly generated `RemoteChange` events whose `row.game_id` equals `gameIdRef.current` (or whose table is `games`, which has no `.game_id` field), assert `dispatch({ type: 'SYNC_REMOTE', change })` is called exactly as before — the new guard never blocks a legitimately-current event.

### Unit Tests

- `derivePresenterMode` for every combination of `(status, latestWinnerAnnouncementId defined/undefined, currentTermId defined/undefined)`.
- `buildFinalWinnerSummary` for zero winners, partial winners, all five winners, and winners belonging to a DIFFERENT `gameId` (must be excluded).
- `toAnnouncementViewModel` includes `ticketRef` and excludes every previously-excluded field.
- The `game_id` guard function/closure in isolation, for matching, non-matching, and `games`-table (no `.game_id`) inputs.
- `gameSessionReducer`'s `CONFIRM_CLAIM`/`CALL_NEXT_WORD`/`START_GAME` cases set/clear `latestWinnerAnnouncementId` correctly, with every other field in their existing assertions unchanged.

### Property-Based Tests

- Generate random `GameSessionState` combinations and verify `derivePresenterMode`'s output always satisfies Req 2.10's priority order (Property 1).
- Generate random `(row.game_id, gameIdRef.current)` pairs and verify the guard's apply/drop decision is always exactly `incomingGameId === gameIdRef.current` (Property 4).
- Generate random `Winner[]` arrays (including winners from other games) and verify `buildFinalWinnerSummary` always returns exactly 5 entries, in `PRIZES`' fixed order, each either populated from a same-game confirmed winner or `undefined`-name/"No Winner" (Property 1).

### Integration Tests

- Full flow: confirm Winner → Presenter shows WINNER mode with no timer → Next Cyber Word → Presenter shows WORD mode → confirm another Winner for a different prize → Next Cyber Word → clears again → End Game → Presenter shows FINAL_RESULTS with all five categories → Reset → Presenter shows LOBBY with the new game's own code/QR and no stale artifact.
- Local Fallback variant of the same flow with no Supabase configured, confirming Req 3.6.
- Two-Presenter-instance variant (two mounted `PresentationView` components sharing one `GameSessionProvider` in a test, or two providers both reading the same persisted envelope) confirming both render identically from `game.latestWinnerAnnouncementId` with no dependency on either instance's own mount time (directly validating that Problem B's root cause — Presenter-local state — no longer exists).
