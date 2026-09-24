# Requirements Document

## Introduction

Module 5 turns the prize eligibility that Module 4's `Prize_Engine` already calculates into a real claim-and-confirmation workflow. Today, eligibility becoming true (`current >= target`) does nothing on its own — `HostDashboard` shows static `mockClaims`/`mockWinners`, and `PlayerGame`'s "Claim Cyber Five" button only flips local `claimConfirmed` UI state that is never persisted, never validated, and never seen by the host.

This module replaces that placeholder with the project's stated philosophy for prize awarding: **Manual Play + System Validation + Manual Claim + Host Confirmation.** Marking terms stays entirely manual (unchanged from Module 4). Eligibility is still computed automatically by the existing `Prize_Engine`. But nothing is ever auto-declared a win: the player must press a claim button for a *specific* prize category, the system must re-validate that claim against authoritative session state (never trusting a client-supplied "eligible" flag), and a human host must explicitly confirm or reject it before a `Winner` record is created. A `Winner` is the only thing that closes a prize category; closing one prize never ends the game or blocks marking/claiming for the remaining four.

This module is additive on top of Module 4's architecture exactly the way Module 4 was additive on top of Module 3's: one central `useReducer` store behind `GameSessionContext`, one versioned `localStorage` envelope (`PERSIST_VERSION`, currently `3`), one `BroadcastChannel` for same-browser cross-tab sync with the existing `rev` staleness/merge convention, and pure helper modules under `src/utils` with no React or storage access. It reuses `src/types/claim.ts`'s existing `PrizeClaim`/`ClaimStatus` shapes and `src/types/prize.ts`'s existing `Winner` shape as its starting point, extending rather than replacing them, and it reuses Module 4's `prizeEngine.ts` (`getAllPrizeProgress`, `isPrizeEligible`, `getPlayerTicketMarks`) as the single source of truth for eligibility — no duplicate prize-counting logic is written anywhere in this module.

Explicitly out of scope: any production backend/API, database, WebSockets/Socket.IO, Firebase, Supabase, Azure, AWS, Microsoft Entra ID or other enterprise auth, real multi-device networking, or a redesign of the existing Player/Host/Presentation UI beyond what is needed to support claims and winners.

## Glossary

- **Prize_Engine**: The existing pure module `src/utils/prizeEngine.ts` (Module 4) that computes `PrizeProgress` for a ticket from its `Valid_Marks`, and exposes `PRIZES`, `getAllPrizeProgress`, `isPrizeEligible`, `getPlayerTicketMarks`, `getMarkedTermIds`. Module 5 must call these functions, never reimplement their logic.
- **Prize_Id**: One of the five fixed prize category codes: `CYBER_FIVE`, `FIREWALL_LINE`, `SECURITY_LINE`, `DATA_DEFENDER_LINE`, `CYBER_FULL_HOUSE` (`src/types/prize.ts`'s `PrizeId`).
- **Prize_Eligible**: True for a given `Prize_Id` and player/ticket exactly when `isPrizeEligible(progress)` is true for that prize's `PrizeProgress` entry from `getAllPrizeProgress` — i.e. `current >= target`. Computed fresh every time; never cached on the claim itself.
- **Mark / Valid_Mark**: Unchanged from Module 4 (`src/types/mark.ts`); a `Mark` with `valid: true` created by `MARK_TERM`. Module 5 must never create, modify, or remove a `Mark`.
- **Claim_Engine**: The new pure module `src/utils/claimEngine.ts` that holds the single claim-validation pipeline (`validatePrizeClaim`), analogous to Module 4's `validateMarkAttempt`.
- **Winner_Engine**: The new pure module (e.g. `src/utils/winnerEngine.ts`) that holds shared winner/closure lookup helpers (`isPrizeClosed`, `getWinnerForPrize`, `canConfirmClaim`, `getPlayerWinningPrizes`), so this logic is not duplicated across `PlayerGame`, `HostDashboard`, and `PresentationView`.
- **PrizeClaim**: A record of one player's manual claim attempt for one `Prize_Id` on one ticket. Extends the existing `src/types/claim.ts` shape with `gameId`, `playerId`, `ticketId`, `submittedAt`, a system `ValidationStatus`, a host `HostDecision`, and an optional `rejectionReason`/`decidedAt`.
- **ValidationStatus**: The system's own automated verdict on a claim at submission time — `'PENDING'` (not yet evaluated; not used once submission validation always runs synchronously, but reserved for shape parity), `'VALID'` (all Requirement 3 checks passed), or `'INVALID'` (at least one check failed). Set once at submission and never changed afterward.
- **HostDecision**: The host's manual verdict on a `VALID` claim — `'PENDING'` (awaiting host action), `'CONFIRMED'` (host approved; a `Winner` now exists), or `'REJECTED'` (host declined). An `INVALID` claim's `HostDecision` starts and stays `'PENDING'`, but the host is blocked from confirming it (Requirement 8).
- **Winner**: A record created only when a host confirms a `VALID`, still-`PENDING` claim for a still-open prize. Extends the existing `src/types/prize.ts` `Winner` shape with `gameId`, `ticketId`, `claimId`, `confirmedAt` alongside its existing `id`/`prizeId`(`prizeLabel`)/`playerId`(`playerName`).
- **Prize open / Prize closed**: Derived, not stored. A `Prize_Id` is **closed** for a game exactly when `winners.some(w => w.prizeId === prizeId && w.gameId === game.id)` is true; otherwise it is **open**. There is exactly one `Winner` per `Prize_Id` per game in this prototype.
- **Player_Claim_Status**: The single derived status a player sees for one of their own prize categories — one of `NOT_ELIGIBLE`, `ELIGIBLE`, `PENDING`, `CONFIRMED`, `REJECTED`, `CLOSED_BY_OTHER_WINNER`. Produced by one helper, not nested JSX conditionals.
- **Host_Claim_Inbox**: The `HostDashboard` "Prize Claims" section once wired to real `state.claims`, replacing the current `mockClaims` demo list.
- **Rev**: The existing monotonically increasing counter on `GameSessionState` (`state.rev`) used by `SYNC_STATE` to reject stale cross-tab snapshots (Module 5 continues incrementing it for every `claims`/`winners`-mutating action, exactly as Module 4 does for `marks`-mutating actions).

## Requirements

### Requirement 1: Extend the PrizeClaim and Winner domain models

**User Story:** As a developer extending the session store, I want `PrizeClaim` and `Winner` to carry every field the claim workflow needs, so that claim validation, host confirmation, and winner records do not require bolting on ad hoc fields later.

#### Acceptance Criteria

1. THE PrizeClaim type SHALL define the fields `id`, `gameId`, `playerId`, `ticketId`, `prizeId`, `submittedAt`, `validationStatus`, `hostDecision`, `rejectionReason` (optional), and `decidedAt` (optional).
2. THE ValidationStatus type SHALL be exactly one of `'PENDING'`, `'VALID'`, `'INVALID'`.
3. THE HostDecision type SHALL be exactly one of `'PENDING'`, `'CONFIRMED'`, `'REJECTED'`.
4. THE Winner type SHALL define the fields `id`, `gameId`, `prizeId`, `playerId`, `ticketId`, `claimId`, `confirmedAt`.
5. WHERE existing UI components read a PrizeClaim's or Winner's current fields (`prizeLabel`, `playerName`, `ticketRef`, `status`), THE PrizeClaim and Winner types SHALL retain those fields or THE Host_Claim_Inbox and Host Winner Panel SHALL be updated in the same change so no component reads an undefined field.
6. THE Requirement 1 types SHALL be defined in `src/types/claim.ts` and `src/types/prize.ts` respectively, without introducing a second, competing definition of `PrizeClaim` or `Winner` elsewhere in the codebase.

### Requirement 2: Player submits a manual claim for a specific prize category

**User Story:** As a player who has marked enough valid terms, I want to press a claim button for the specific prize I qualify for, so that my win is only recorded when I actively assert it, not automatically the moment eligibility flips true.

#### Acceptance Criteria

1. WHERE a Prize_Id's Prize_Eligible is true for the current player's ticket, THE PlayerGame screen SHALL enable that prize's own dedicated claim button.
2. WHILE a Prize_Id's Prize_Eligible is false for the current player's ticket, THE PlayerGame screen SHALL disable that prize's claim button.
3. WHEN a player presses an enabled claim button for a Prize_Id, THE System SHALL dispatch a claim-submission action carrying only `playerId`, `ticketId`, and `prizeId`.
4. THE System SHALL NOT accept or read any client-supplied eligibility flag as part of a claim-submission action.
5. EACH of the five Prize_Ids SHALL have its own independent claim button, so a claim for one prize never submits or affects any other Prize_Id.

### Requirement 3: System re-validates every claim from authoritative state

**User Story:** As the game host, I want every submitted claim to be checked against the real session state before it ever reaches me, so that I never have to manually verify eligibility myself or trust a possibly-stale client value.

#### Acceptance Criteria

1. WHEN a claim-submission action is dispatched, THE System SHALL recompute Prize_Eligible for the submitted `prizeId` from the authoritative session state using the Prize_Engine, independent of any value supplied by the submitting client.
2. THE System SHALL validate a submitted claim against all of the following conditions: the game referenced exists; the player referenced exists; the player belongs to the current game; the ticket referenced exists; the ticket belongs to the submitting player; the prize category referenced exists among `PRIZES`; the player has no existing active claim for the same `prizeId`; the prize category is currently open; the player's Valid_Marks satisfy that prize's eligibility rule via the Prize_Engine; and only Valid_Marks belonging to the player's assigned ticket are counted.
3. IF every condition in Requirement 3.2 passes, THEN THE System SHALL set the new claim's `validationStatus` to `'VALID'` and `hostDecision` to `'PENDING'`.
4. IF any condition in Requirement 3.2 fails, THEN THE System SHALL set the new claim's `validationStatus` to `'INVALID'` and SHALL store a reason identifying which condition failed.
5. THE System SHALL implement Requirement 3's checks in a single pure function `validatePrizeClaim` in the Claim_Engine, taking `{game, player, ticket, marks, prizeId, winners, existingClaims}` and returning `{valid: boolean, reason?: string}`, so no duplicate validation logic exists in the reducer or in any component.
6. THE Claim_Engine SHALL compute Prize_Eligible exclusively by calling the Prize_Engine's existing functions (`getAllPrizeProgress` / `isPrizeEligible` / `getPlayerTicketMarks`), and SHALL NOT reimplement prize-counting logic.

### Requirement 4: Duplicate and repeat claim prevention

**User Story:** As the host, I want a player to have at most one active claim per prize, so that my claim inbox never fills up with redundant submissions for the same win.

#### Acceptance Criteria

1. IF a player already has a claim for a given `prizeId` with `hostDecision` equal to `'PENDING'`, THEN THE System SHALL reject a new claim submission from that same player for that same `prizeId`.
2. IF a player already has a claim for a given `prizeId` with `hostDecision` equal to `'CONFIRMED'`, THEN THE System SHALL reject any further claim submission from that same player for that same `prizeId`.
3. WHERE a player's prior claim for a `prizeId` has `hostDecision` equal to `'REJECTED'` AND that prize is still open AND current Prize_Eligible for that player/ticket is still true, THE System SHALL accept exactly one resubmitted claim from that player for that `prizeId`.
4. IF a player attempts to resubmit a claim for a `prizeId` whose most recent prior claim from that player was already `'REJECTED'` and has itself been resubmitted once already (Requirement 4.3), THEN THE System SHALL reject the further resubmission.
5. THE System SHALL apply Requirements 4.1–4.4 as part of the same `validatePrizeClaim` pipeline used by Requirement 3, not as separate ad hoc logic.

### Requirement 5: Prize open/closed state is derived from winners

**User Story:** As a developer maintaining the session store, I want prize-closed state to be computed from the winners collection rather than stored redundantly, so that "is this prize still open" can never drift out of sync with the actual winner records.

#### Acceptance Criteria

1. THE System SHALL treat a Prize_Id as closed for the current game exactly when a Winner record exists whose `prizeId` matches and whose `gameId` matches the current game's id.
2. THE System SHALL NOT persist a separate "prize status" or "prize closed" field anywhere in `GameSessionState`.
3. THE System SHALL expose a pure helper `isPrizeClosed(winners, gameId, prizeId)` in the Winner_Engine that all screens use to answer "is this prize closed," rather than each screen recomputing the check inline.
4. WHEN a Winner record is created for a Prize_Id, THE System SHALL cause that Prize_Id to be reported as closed by `isPrizeClosed` on the very next render, with no additional state transition required.
5. THE System SHALL allow at most one Winner record per `prizeId` per `gameId`.

### Requirement 6: Simultaneous claims from multiple players are all preserved

**User Story:** As the host, I want to see every valid claim submitted for a still-open prize even if several players claim it around the same time, so that I retain the choice of who to confirm rather than the system silently dropping or auto-resolving competing claims.

#### Acceptance Criteria

1. WHEN two or more players submit valid claims for the same still-open `prizeId` before the host confirms any of them, THE System SHALL retain every one of those claims in `state.claims`, none overwritten or discarded.
2. THE System SHALL order claims for display by `submittedAt` ascending among those with the same `hostDecision`.
3. THE System SHALL NOT automatically select the earliest-submitted claim as the winner; a Winner record SHALL only be created by an explicit host confirm action (Requirement 8).
4. WHEN the host confirms one claim for a `prizeId`, THE System SHALL leave every other claim for that same `prizeId` in the `claims` collection unchanged in its own fields, with the prize's derived open/closed state (Requirement 5) now reflecting closure.

### Requirement 7: Host Claim Inbox shows real claims, sorted for action

**User Story:** As the host, I want a claims inbox that shows real player submissions instead of sample data, sorted so the claims needing my attention are always on top, so that I can process the queue efficiently during a live session.

#### Acceptance Criteria

1. THE HostDashboard SHALL replace its current `mockClaims`-sourced list with a list rendered from `state.claims`.
2. THE Host_Claim_Inbox SHALL display, per claim, the player's display name, a ticket reference, the prize category label, the submission time, the validation result, the host decision, a Confirm control, and a Reject control.
3. THE Host_Claim_Inbox SHALL NOT display the player's employee/demo id or any other identifying detail not needed for the host's decision.
4. THE Host_Claim_Inbox SHALL sort claims with `hostDecision === 'PENDING'` before claims with any other `hostDecision`, and within each group SHALL sort by `submittedAt` ascending.
5. THE HostDashboard SHALL present claims with `hostDecision` equal to `'CONFIRMED'` or `'REJECTED'` in a separate history subsection, grouped as PENDING CLAIMS, CONFIRMED, and REJECTED/INVALID.

### Requirement 8: Host confirms a valid claim, creating a Winner

**User Story:** As the host, I want to manually confirm a specific claim as the winning one, so that the decision of who wins each prize always requires my explicit action.

#### Acceptance Criteria

1. THE System SHALL allow a host confirm action on a claim only when that claim's `validationStatus` is `'VALID'` AND `hostDecision` is `'PENDING'` AND the claim's `prizeId` is currently open.
2. WHEN the host confirms an eligible claim, THE System SHALL set that claim's `hostDecision` to `'CONFIRMED'` and set its `decidedAt` to the confirmation time.
3. WHEN the host confirms an eligible claim, THE System SHALL create exactly one new Winner record referencing that claim's `gameId`, `prizeId`, `playerId`, `ticketId`, and `id` (as `claimId`), with `confirmedAt` set to the confirmation time.
4. WHEN a Winner record is created for a `prizeId`, THE System SHALL cause that `prizeId` to become closed (Requirement 5), and THE System SHALL prevent any further confirm action on any other claim for that same `prizeId`.
5. THE System SHALL propagate a newly confirmed Winner to the Player Game screen and the Presentation View through the same central store update, without requiring a manual refresh.
6. THE System SHALL NOT modify `marks`, the confirmed player's ticket, or any other Prize_Id's progress or claims as part of a confirm action.
7. IF the host attempts to confirm a claim whose `validationStatus` is `'INVALID'`, THEN THE System SHALL block the confirm action and SHALL NOT create a Winner record.
8. IF the host attempts to confirm a claim for a `prizeId` that is already closed, THEN THE System SHALL block the confirm action and SHALL NOT create a second Winner record for that `prizeId`.

### Requirement 9: Host rejects a claim

**User Story:** As the host, I want to reject a claim that I decide should not win, so that I can keep the queue moving and give the player a clear reason without creating a winner.

#### Acceptance Criteria

1. THE System SHALL allow a host reject action on a claim only when that claim's `hostDecision` is `'PENDING'`.
2. WHEN the host rejects a claim, THE System SHALL set that claim's `hostDecision` to `'REJECTED'` and set its `decidedAt` to the rejection time.
3. WHERE the host supplies a rejection reason, THE System SHALL store it on the claim as `rejectionReason`, selected from a simple fixed set of options ("Duplicate / already won", "Host verification issue", "Invalid event claim", "Other") or free text.
4. WHEN the host rejects a claim, THE System SHALL NOT create a Winner record and SHALL NOT alter the derived open/closed state of that `prizeId`.

### Requirement 10: System-invalid claims cannot be overridden by the host

**User Story:** As the host, I want the system's own eligibility check to be the final word on whether a claim was even legitimate, so that I cannot accidentally confirm a win the player never actually earned.

#### Acceptance Criteria

1. WHERE a claim's `validationStatus` is `'INVALID'`, THE Host_Claim_Inbox SHALL disable that claim's Confirm control.
2. THE Host_Claim_Inbox SHALL display an `'INVALID'` claim in the claims history subsection so the host can still see that it was submitted and why it failed.
3. WHEN a claim is rejected by the system as `'INVALID'` at submission time, THE PlayerGame screen SHALL show the submitting player a message naming their current progress for that prize (for example, "Claim could not be validated. Your current progress is 4/5.") rather than a generic error.

### Requirement 11: Winner state helpers centralize lookup logic

**User Story:** As a developer building the Player, Host, and Presentation screens, I want one shared set of winner-lookup helpers, so that "is this prize closed" or "did this player win" is answered identically everywhere instead of being reimplemented per screen.

#### Acceptance Criteria

1. THE Winner_Engine SHALL export `isPrizeClosed(winners, gameId, prizeId)` returning true exactly per Requirement 5.1.
2. THE Winner_Engine SHALL export `getWinnerForPrize(winners, gameId, prizeId)` returning the matching Winner record or undefined.
3. THE Winner_Engine SHALL export `canConfirmClaim(claim, winners)` returning true exactly under the conditions in Requirement 8.1.
4. THE Winner_Engine SHALL export `getPlayerWinningPrizes(winners, playerId)` returning the list of Prize_Ids for which that player has a confirmed Winner.
5. THE PlayerGame, HostDashboard, and PresentationView screens SHALL call these Winner_Engine helpers rather than each independently deriving open/closed or winner state from `state.claims`/`state.winners`.

### Requirement 12: Player sees a distinct status per prize category

**User Story:** As a player, I want each of my five prize categories to clearly show its own status and the right call to action, so that I always know whether to keep marking, claim, wait, or move on.

#### Acceptance Criteria

1. THE System SHALL provide a single helper that derives one Player_Claim_Status value per Prize_Id from `{progress, claim, winner}`, producing exactly one of `NOT_ELIGIBLE`, `ELIGIBLE`, `PENDING`, `CONFIRMED`, `REJECTED`, `CLOSED_BY_OTHER_WINNER`.
2. THE PlayerGame screen SHALL render each Prize_Id's claim button and status text from that single derived Player_Claim_Status, not from nested conditional checks scattered through the component body.
3. WHILE a Prize_Id's Player_Claim_Status is `NOT_ELIGIBLE`, THE PlayerGame screen SHALL show that prize's current progress (e.g. "4/5") with its claim button disabled.
4. WHEN a Prize_Id's Player_Claim_Status becomes `ELIGIBLE`, THE PlayerGame screen SHALL show a ready message (e.g. "Cyber Five Ready!") and enable that prize's own "Claim {Prize_Label}" button.
5. WHEN a player submits a claim and it is accepted as `VALID`/`PENDING`, THE PlayerGame screen SHALL show that Prize_Id's Player_Claim_Status as `PENDING` with the message "Claim submitted. Waiting for Host confirmation." and a disabled "Claim Pending" control.
6. WHEN the host confirms a player's own claim, THE PlayerGame screen SHALL show that Prize_Id's Player_Claim_Status as `CONFIRMED` with a "Winner Confirmed" label.
7. WHEN the host rejects a player's own claim, THE PlayerGame screen SHALL show that Prize_Id's Player_Claim_Status as `REJECTED` with the message "Claim rejected." plus the rejection reason when one was supplied.
8. WHEN another player's claim for a Prize_Id is confirmed while the current player was eligible or had a pending claim of their own for that same Prize_Id, THE PlayerGame screen SHALL show that Prize_Id's Player_Claim_Status as `CLOSED_BY_OTHER_WINNER` with a message naming the prize as already awarded and inviting the player to continue with remaining prizes, and SHALL disable further claim submission for that Prize_Id.
9. THE PlayerGame screen SHALL communicate every Player_Claim_Status via distinguishable text, not color alone.

### Requirement 13: Player winner feedback is prominent but non-blocking

**User Story:** As a player who wins a prize, I want a clear celebratory confirmation that doesn't stop me from continuing to play, so that I keep marking terms toward the remaining prizes without interruption.

#### Acceptance Criteria

1. WHEN the current player's claim for a Prize_Id is confirmed, THE PlayerGame screen SHALL display a prominent message identifying the win (for example "🏆 CYBER FIVE WINNER — Your Cyber Five claim has been confirmed.").
2. THE winner feedback message in Requirement 13.1 SHALL NOT cover the ticket, the remaining prize categories, or any other prize's claim controls.
3. AFTER the current player wins one Prize_Id, THE PlayerGame screen SHALL keep the player's ticket, marks, and the remaining open prize categories fully interactive.

### Requirement 14: Presentation View announces confirmed winners

**User Story:** As an event host running the projector view, I want a clear on-screen announcement whenever a winner is confirmed, so that the room celebrates the win together before returning to the live game.

#### Acceptance Criteria

1. WHEN the host confirms a claim, THE PresentationView SHALL display a winner announcement showing the prize label and the winning player's display name only (for example "🏆 CYBER FIVE WINNER — Divyansh Singh").
2. THE PresentationView winner announcement SHALL NOT display the player's employee/demo id, ticket identifier, or any other claim/technical detail.
3. THE PresentationView SHALL provide a host-controlled "Dismiss Winner Announcement" action that returns the projector to the current Cyber Word view.
4. WHILE a winner announcement is being dismissed via Requirement 14.3, THE PresentationView SHALL return to reflecting the live `game.status`/`currentTerm` exactly as it would have without the announcement.

### Requirement 15: Host Winner Panel reflects real confirmed winners

**User Story:** As the host, I want a winners panel that shows only real confirmed wins per category, so that I can announce results accurately without cross-checking a separate source.

#### Acceptance Criteria

1. THE HostDashboard SHALL replace its current `mockWinners`-sourced list with a list derived from `state.winners`.
2. THE HostDashboard Winner Panel SHALL list all five Prize_Ids, showing the confirmed winner's display name for each closed prize and an explicit "Not awarded" indicator for each still-open prize.
3. THE HostDashboard Winner Panel SHALL update immediately after a confirm action, without requiring a manual refresh.

### Requirement 16: Claims and winners persist across refresh

**User Story:** As a host or player, I want submitted claims and confirmed winners to survive a page refresh, so that the state of who has won what is never lost mid-session.

#### Acceptance Criteria

1. THE System SHALL extend the existing persisted envelope (`src/state/persistence.ts`) to include `claims: PrizeClaim[]` and `winners: Winner[]` alongside the existing `game`, `rev`, `players`, `tickets`, `marks` fields.
2. WHEN the session state's `claims` or `winners` changes, THE System SHALL persist the updated envelope, mirroring the existing persistence effect used for `marks`.
3. WHEN the application loads and a persisted envelope is present, THE System SHALL restore `claims` and `winners` from that envelope.
4. IF the persisted envelope's `claims` or `winners` field is missing, `null`, or not an array, THEN THE System SHALL default the restored value to `[]` rather than rejecting the rest of the envelope.
5. THE System SHALL treat the addition of `claims`/`winners` to the envelope as additive, consistent with how Module 4 added `marks` without a persistence-version bump beyond what the direct-word-call refactor already required; a version bump SHALL only be introduced if an incompatible shape change is required elsewhere.

### Requirement 17: Claims and winners synchronize across browser tabs

**User Story:** As a host and a player using separate tabs in the same browser, I want a submitted claim to appear in the host inbox automatically and a confirmed/rejected decision to appear on the player and presentation screens automatically, so that neither side has to refresh to stay in sync.

#### Acceptance Criteria

1. THE System SHALL extend the existing `SyncPayload` (`src/state/gameSessionReducer.ts`) to include `claims` and `winners`.
2. WHEN a player submits a claim, THE System SHALL cause the resulting `claims` change to be broadcast to other tabs via the existing sync channel, using the existing `rev` increment/staleness convention.
3. WHEN the host confirms or rejects a claim, THE System SHALL cause the resulting `claims`/`winners` change to be broadcast to other tabs the same way.
4. WHEN a tab receives a `SYNC_STATE` payload, THE System SHALL merge incoming `claims` and `winners` losslessly by record id, following the same union-by-id merge convention already used for incoming `marks`, so a claim or winner created in one tab is never lost or overwritten by a stale snapshot from another tab.
5. IF an incoming `SyncPayload`'s `claims` or `winners` field is missing or not an array, THEN THE System SHALL default the applied value to `[]` for that field rather than rejecting the whole payload.
6. THE System SHALL NOT modify or clear `currentPlayerId` as a result of applying any `claims`/`winners`-bearing sync payload.

### Requirement 18: Claim and winner actions never affect unrelated state

**User Story:** As a developer verifying this module doesn't regress existing gameplay, I want claim and winner actions to be provably scoped to only claims/winners, so that marking, ticket assignment, and prize-progress math can never be silently corrupted by the claim workflow.

#### Acceptance Criteria

1. THE System SHALL NOT create, modify, or remove any `Mark` as a side effect of a claim-submission, confirm, or reject action.
2. THE System SHALL NOT modify any `Ticket` or `Player` record as a side effect of a claim-submission, confirm, or reject action.
3. THE System SHALL NOT alter the `PrizeProgress` values the Prize_Engine computes for any Prize_Id as a side effect of a claim-submission, confirm, or reject action.
4. WHEN a claim-submission, confirm, or reject action is dispatched, THE System SHALL NOT modify `currentPlayerId`.
5. AFTER a player's claim for one Prize_Id is confirmed, THE System SHALL allow that player to continue marking terms and to keep accruing progress toward the remaining open Prize_Ids on the same ticket, with no ticket regeneration.

### Requirement 19: Reset Demo Game clears claims and winners

**User Story:** As the host running a demo, I want the reset control to fully clear out claims and winners along with everything else, so that I can start a clean run without stray prior-session claim data.

#### Acceptance Criteria

1. WHEN the host triggers Reset Demo Game, THE System SHALL clear `state.claims` to `[]` and `state.winners` to `[]`, in addition to the existing reset of `players`, `tickets`, `marks`, `revealedTermIds`, `currentPlayerId`, and game lifecycle status.
2. AFTER a reset, THE System SHALL report every Prize_Id as open per the Requirement 5 derivation, since no Winner records remain.
3. THE System SHALL implement Requirement 19 via the existing seed-state spread already used by `RESET_GAME` (i.e. `gameSessionInitialState.claims`/`winners` seeded to `[]`), consistent with how Module 4 cleared `marks` "for free" through the same mechanism, rather than adding claim/winner-specific logic to `HostDashboard.tsx`.

### Requirement 20: Regression constraints carried forward from prior modules

**User Story:** As the project owner, I want this module to guarantee it does not regress any previously delivered behavior, so that adding claims/winners cannot quietly break marking, identity, or persistence that already worked.

#### Acceptance Criteria

1. THE System SHALL continue to preserve a player's Valid_Marks across new Cyber Word calls (`CALL_NEXT_WORD`) exactly as in Module 4.
2. THE System SHALL continue to preserve `currentPlayerId` identity in a player's tab across any host action, including claim confirm/reject actions dispatched from a host tab.
3. WHEN the application is refreshed after a Mark, a claim submission, or a claim confirmation, THE System SHALL restore the same player, ticket, marks, claims, and winners without loss.
4. THE System SHALL ensure Prize_Progress values for any Prize_Id never decrease as a result of a new Cyber Word call or any claim/winner action.
5. THE System SHALL continue to support the existing direct-word-call gameplay model (`START_GAME`/`CALL_NEXT_WORD`, no separate reveal-answer step) unchanged by this module.

### Requirement 21: Automated test coverage for the claim and winner workflow

**User Story:** As a developer maintaining this module, I want the claim/winner pipeline covered by automated tests, so that regressions in validation, confirmation, closure, and persistence are caught before shipping.

#### Acceptance Criteria

1. THE System SHALL have automated test coverage asserting a valid claim submission is accepted with `validationStatus: 'VALID'` and `hostDecision: 'PENDING'`.
2. THE System SHALL have automated test coverage asserting an ineligible claim submission is recorded with `validationStatus: 'INVALID'` and never produces a Winner.
3. THE System SHALL have automated test coverage asserting duplicate claim submissions for the same player/prize (Requirement 4) never result in more than one active claim.
4. THE System SHALL have automated test coverage asserting a host confirm action on a valid, pending claim creates exactly one Winner and updates that claim's `hostDecision` to `'CONFIRMED'`.
5. THE System SHALL have automated test coverage asserting a host confirm action is blocked for a claim whose `validationStatus` is `'INVALID'`.
6. THE System SHALL have automated test coverage asserting that once a Prize_Id is closed, no further confirm action on any other claim for that Prize_Id succeeds.
7. THE System SHALL have automated test coverage asserting a player can continue marking and accruing progress toward other Prize_Ids after winning one prize, with marks and progress numbers unaffected.
8. THE System SHALL have automated test coverage asserting `claims` and `winners` persist across a simulated rehydration (persisted-envelope round trip).
9. THE System SHALL have automated test coverage asserting `currentPlayerId` is never altered by a claim-submission or claim-decision sync payload.
