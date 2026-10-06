# Bugfix Requirements Document

## Introduction

A Player's claim can be submitted against a stale Player/Ticket identity that no longer matches what the Player screen is showing. In the reported incident, Player "Divyansh" was active in the game with the Player UI showing Ticket #6405 and 5/5 progress on Cyber Five. Submitting the claim produced Player UI message "Claim could not be validated. Your current progress is 5/5." while the Host Claim Inbox recorded the claim as Player: Divyansh, Ticket: #4292, Validation: `PLAYER_NOT_IN_GAME`, Status: INVALID.

Investigation of the current implementation (`src/state/GameSessionContext.tsx`, `src/state/persistence.ts`, `src/state/gameSessionReducer.ts`, `src/pages/PlayerGame/PlayerGame.tsx`, and the `submit_claim`/`join_game` RPCs in `supabase/migrations/0003_rpc_join_and_tickets.sql`, `0005_rpc_lifecycle_and_claims.sql`, `0007_remove_employee_id_from_join.sql`) confirms the mechanism:

- On every mount, `initState()` (`GameSessionContext.tsx`) synchronously restores the full shared envelope (`game`, `players`, `tickets`, `marks`, `claims`, `winners`) from `localStorage` (`persistence.ts`'s `STORAGE_KEY`) and separately restores `currentPlayerId` from its own `localStorage` key, before any network call has been made.
- `isHydrated` is hardcoded to `true` immediately (its own doc comment: "hydration is fully synchronous... there is no real async gap to model"), so `PlayerGame.tsx`'s only redirect guard (`!currentPlayer || !currentTicket`) is satisfied the instant a locally-cached `currentPlayerId` resolves against the locally-cached `players`/`tickets` arrays — regardless of whether the authoritative Supabase fetch (`HYDRATE_FROM_REMOTE`, dispatched asynchronously after `getActiveGame()` + `fetchFullGameState()` resolve, with up to 3 retries and a 1.5s backoff) has completed.
- `currentPlayer`/`currentTicket`/`currentPlayerMarks`/`currentPrizeProgress` are all derived in `GameSessionContext.tsx`'s `useMemo` purely from whatever `state.players`/`state.tickets`/`state.marks` currently are — there is no distinction in the UI between "derived from the authoritative Supabase snapshot" and "derived from the stale local cache."
- The Player's claim button (`PlayerGame.tsx`) dispatches `SUBMIT_PRIZE_CLAIM` with `playerId: currentPlayer.id`, which `GameSessionContext.tsx`'s `wrappedDispatch` forwards to `rpcSubmitClaim(action.playerId, action.prizeId)` → the `submit_claim` RPC. The RPC re-derives `game_id`/`ticket_id` strictly from the server's own `players`/`tickets` rows for the supplied `p_player_id` — it never trusts a client-supplied ticket id or Prize Progress. If `p_player_id` is a stale id (e.g. from a prior game, a prior Reset, or a prior device/session) that still happens to be present in a stale cached `players` array, the server resolves it to whatever real player/ticket that stale id actually belongs to, which can be a different ticket than the one currently rendered — exactly the `#4292` vs `#6405` divergence, with `PLAYER_NOT_IN_GAME` reported because that stale player's `game_id` no longer matches the server's live active game.
- Reset (`reset_game_to_new` RPC and the Local Fallback `RESET_GAME` reducer case) deliberately leaves a Player tab's `currentPlayerId` untouched when the pointer repoints to a new game (by design, so a genuinely active Player tab is never logged out by a Host/Presentation-originated sync). This is correct for the normal "the Player's own row still exists" case, but combined with the stale-local-cache rendering above, it means a Player tab that was last synced before a Reset can go on displaying a fully-formed (but now entirely stale) Player + Ticket + Prize Progress indefinitely, with nothing that re-validates that identity against the live backend before a claim is submitted.

This document defines the required fix behavior and the behavior that must remain unchanged, expressed as a bug condition so the fix can be checked systematically rather than patched around the single reported symptom.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the Player screen renders `currentPlayer`/`currentTicket` from locally cached `localStorage` state (envelope + `currentPlayerId`) before or without the authoritative Supabase snapshot (`HYDRATE_FROM_REMOTE`) having resolved for the live Active Game THEN the system displays a Player/Ticket identity that is not confirmed to match the live backend's current Player/Ticket for this device

1.2 WHEN a Player submits a prize claim while `currentPlayer`/`currentTicket` were derived from such unconfirmed/stale local state THEN the system submits the claim using that stale `playerId`, which the backend resolves against whatever real (and possibly unrelated or expired) Player/Ticket/Game that id happens to still reference, rather than against the Player/Ticket actually shown on screen

1.3 WHEN the claim submitted in 1.2 is rejected by the backend (e.g. with `PLAYER_NOT_IN_GAME`) THEN the system shows the Player a generic "Claim could not be validated. Your current progress is X/Y" message that does not reflect the real cause (a stale/mismatched client-side identity) and gives no path to recover other than guessing

1.4 WHEN the Host Claim Inbox renders the resulting claim THEN it faithfully displays the Ticket reference that was actually used server-side for that claim (e.g. #4292), which can legitimately differ from the Ticket reference currently shown on the Player's own screen (e.g. #6405) with no indication to the Host that the Player device is out of sync

1.5 WHEN a Reset creates a new Game/session THEN a Player tab's `currentPlayerId` may continue to resolve against stale cached `players`/`tickets` data from the prior game for as long as that tab is open, with no explicit invalidation of the old identity and no re-validation before the next claim submission

### Expected Behavior (Correct)

2.1 WHEN the Player screen renders the current Player, Ticket, Marks, and Prize Progress THEN the system SHALL derive all four from a single active-session resolver that is also the one the Claim submission path reads from, so the UI and the submitted claim can never disagree about which Player/Ticket is current

2.2 WHEN a Player triggers "Claim" for a prize THEN the system SHALL run a session consistency guard immediately before submission that re-confirms `activePlayer`, `activeTicket`, and `activeGame` exist and satisfy `activePlayer.gameId === activeGame.id` and `activeTicket.playerId === activePlayer.id && activeTicket.gameId === activeGame.id`, using the same resolver as 2.1, and SHALL block submission (never submit, never fabricate/generate a replacement ticket, never force the claim to VALID) when the guard fails

2.3 WHEN the session consistency guard in 2.2 blocks a submission THEN the system SHALL show the Player a user-friendly recovery message (distinct from the generic "could not be validated" progress message) that explains their session is out of date and directs them to rejoin/refresh, and SHALL additionally surface non-sensitive dev diagnostics (e.g. to the console) describing which check failed, without logging secrets, keys, or credentials

2.4 WHEN the authoritative backend snapshot for the live Active Game has not yet been confirmed for this device (initial load, reconnect, or an active retry/error state) THEN the system SHALL NOT treat a locally cached Player/Ticket identity as authoritative for claim submission purposes, even though it may still optimistically render cached state while the authoritative check is pending

2.5 WHEN `currentPlayerId` stored in `localStorage` does not resolve to a Player belonging to the current Active Game (`Player.gameId === activeGame.id`) THEN the system SHALL treat it as stale, SHALL safely clear it rather than reuse it, and SHALL route the device back through the normal join/restore flow so a correct identity is re-established

2.6 WHEN a Player's device-local ticket resolution would otherwise need to pick among more than one ticket for the same player THEN the system SHALL resolve exactly one active ticket deterministically via `Ticket.playerId === activePlayer.id AND Ticket.gameId === activeGame.id` (never "first ticket in array" or any other non-deterministic/order-dependent selection)

2.7 WHEN a claim payload is constructed for submission THEN the system SHALL derive `gameId`, `playerId`, `ticketId`, and `prizeId` from the same single active-session resolver used for Player UI rendering, Marks, and Prize Progress (Req 2.1), and SHALL NOT read any of these from a separately cached or independently stale value

2.8 WHEN the Host Claim Inbox displays a claim whose recorded Ticket reference does not match the Ticket reference the Player's own screen is currently showing for that Player (i.e. a genuine identity-mismatch case still occurred, pre-fix or in a not-yet-covered edge case) THEN this SHALL remain detectable from the recorded claim/ticket/player data (no information currently captured by the schema is to be removed), so the condition stays diagnosable even if a new variant is discovered later

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a Player's session is genuinely consistent (fresh join, successful claim end-to-end) THEN the system SHALL CONTINUE TO let the join → mark terms → reach Prize eligibility → submit claim → Host confirm flow work exactly as it does today, with the UI Ticket reference matching the Claim Ticket reference matching the Winner History Ticket reference for that same claim

3.2 WHEN a Host or Presentation device performs a Reset (`RESET_GAME` / `reset_game_to_new`) THEN the system SHALL CONTINUE TO retire the old Game's `players`/`tickets`/`marks`/`claims` (not `winners`) and activate a new Game exactly as today, and a Player who rejoins after the reset SHALL use the newly assigned Ticket and SHALL NOT have the old Ticket silently reused or shown

3.3 WHEN a Player refreshes their browser tab mid-session THEN the system SHALL CONTINUE TO restore the same Player/Ticket identity they had before the refresh, with no forced re-join, exactly as today

3.4 WHEN two different Players join using the same display name (whether on the same device at different times, different devices, or different browsers) THEN the system SHALL CONTINUE TO give them distinct Player IDs and distinct Tickets, matched/restored only via the opaque per-device join token (never via `displayName`), and SHALL CONTINUE TO NEVER merge their sessions

3.5 WHEN a claim is submitted with a Player ID that is genuinely stale (belongs to a different/prior Game) THEN the backend SHALL CONTINUE TO reject it with `PLAYER_NOT_IN_GAME` (or the appropriate existing gate code) exactly as today — this fix SHALL NOT remove, weaken, or bypass `PLAYER_NOT_IN_GAME` or any other existing `submit_claim`/`validatePrizeClaim` gate (`PLAYER_NOT_FOUND`, `TICKET_NOT_FOUND`, `TICKET_NOT_OWNED_BY_PLAYER`, `PRIZE_NOT_FOUND`, `DUPLICATE_ACTIVE_CLAIM`, `RESUBMISSION_LIMIT_REACHED`, `PRIZE_CLOSED`, `NOT_ELIGIBLE`)

3.6 WHEN the Host reviews the Claim Inbox or Winner History THEN the system SHALL CONTINUE TO show every submitted claim (valid or invalid), SHALL CONTINUE TO require explicit Host confirmation before any claim becomes a Winner, and SHALL CONTINUE TO NEVER auto-confirm or force a claim to VALID client-side

3.7 WHEN Supabase is not configured (Local Fallback / dev mode) THEN the system SHALL CONTINUE TO support the full join → mark → claim → confirm flow using the existing pure local reducer/join-service logic, unaffected by this fix's Supabase-session-consistency guard

3.8 WHEN marks are submitted, called Cyber Words are revealed, or Prize Progress is computed THEN the system SHALL CONTINUE TO compute these exactly as today for a consistent session (no change to `prizeEngine.ts`, `claimEngine.ts`'s validation rules, `deriveCellState`, or the called-word/reveal flow)

3.9 WHEN the Host Dashboard, Presentation View, routing, or Vercel deployment behavior is exercised outside of the Player claim-submission path described above THEN the system SHALL CONTINUE TO behave exactly as it does today

## Bug Condition (for reference during design/testing)

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type ClaimSubmissionContext
         { localCurrentPlayerId, localPlayers, localTickets,
           backendConfirmed: boolean, // true once HYDRATE_FROM_REMOTE for the live Active Game has completed
           activeGameId }
  OUTPUT: boolean

  // True when a claim would be submitted using a Player/Ticket identity
  // that has not been confirmed against the live backend session for the
  // CURRENT active game.
  RETURN NOT X.backendConfirmed
     OR NOT resolvedPlayer(X).gameId = X.activeGameId
     OR NOT resolvedTicket(X).playerId = resolvedPlayer(X).id
     OR NOT resolvedTicket(X).gameId = X.activeGameId
END FUNCTION
```

```pascal
// Property: Fix Checking - Session Consistency Guard
FOR ALL X WHERE isBugCondition(X) DO
  result ← submitClaim'(X)
  ASSERT result.submitted = false
     AND result.message = userFriendlyRecoveryMessage
     AND result.devDiagnosticsLogged = true
     AND result.secretsLogged = false
END FOR
```

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT submitClaim(X) = submitClaim'(X)
  // i.e. a genuinely consistent session's claim submission (payload sent,
  // RPC gates evaluated, inbox/winner history rendering) is byte-for-byte
  // unchanged by the fix.
END FOR
```
