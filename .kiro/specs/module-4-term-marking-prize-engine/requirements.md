# Requirements Document

## Introduction

Module 4 replaces the Cyber Tambola V2 prototype's temporary, visual-only ticket marking and mock prize progress with a real, state-driven marking and prize-eligibility engine. Today, tapping a revealed ticket term only flips a local component-level flag: Prize Progress never moves off its seeded `0/5` / `0/15` values, and refreshing the Player Game screen reverts every marked cell back to unmarked because no Mark is ever persisted.

This module introduces a `Mark` domain record as the single authoritative source of "this player validly marked this term on this ticket." Marks live in the central session store alongside `game`, `players`, and `tickets`; ticket-cell state and every prize's progress are pure derivations from the stored Marks, never from ad-hoc UI state. Marks are persisted through the existing `localStorage` envelope and participate in the existing cross-tab `BroadcastChannel` sync, exactly like the rest of Module 3's live session state.

This module also introduces a pure prize engine that computes progress and eligibility for five prizes (Cyber Five, Firewall Line, Security Line, Data Defender Line, Cyber Full House) from a player's Ticket and their valid Marks, and wires the Player Game screen's progress bars and Claim readiness messaging to that engine's real output.

This remains a single-browser React + TypeScript + Vite prototype. There is no backend, database, WebSocket layer, authentication, or cloud deployment. Final host-side claim adjudication and a persisted winner record remain out of scope; this module only produces a UI-facing "claim ready" signal.

## Glossary

- **Prototype**: The single-browser Cyber Tambola V2 React application described above.
- **Session_Store**: The central React Context + `useReducer` game session state defined in `src/state` (`GameSessionContext.tsx`, `gameSessionReducer.ts`, `gameSessionInitialState.ts`).
- **Game**: The central lifecycle model (`src/types/game.ts`) holding `status`, `currentRound`, `currentTermId`, and `revealedTermIds`.
- **Game_Status**: One of `LOBBY`, `CLUE_ACTIVE`, `ANSWER_REVEALED`, `PAUSED`, `COMPLETED`.
- **Player**: A local participant record (`src/types/player.ts`) with `id`, `gameId`, `displayName`, `employeeDemoId`, `ticketId`, and `joinedAt`.
- **Ticket**: A player's 3x5 cyber-word ticket (`src/types/ticket.ts`) with `id`, `playerId`, `gameId`, `createdAt`, `ref`, and `rows`.
- **Ticket_Cell**: A single cell on a Ticket (`src/types/ticket.ts`) referencing a `termId` plus its `row` (0-2), `col` (0-4), and a `Ticket_Cell_State`.
- **Ticket_Cell_State**: One of `LOCKED`, `AVAILABLE`, `MARKED`.
- **Current_Player**: The Player identified by the `currentPlayerId` field in the Session_Store.
- **Current_Ticket**: The Ticket whose `id` matches the Current_Player's `ticketId`.
- **Cyber_Term**: A cyber-awareness term (`src/types/cyberTerm.ts`) in the term bank `cyberTerms` (`src/data/cyberTerms.ts`).
- **Mark**: A record in the Session_Store's `marks` collection representing one player's authoritative, validated act of marking one term on one ticket. Contains `id`, `gameId`, `playerId`, `ticketId`, `termId`, `markedAt`, and `valid`.
- **Valid_Mark**: A Mark whose `valid` field is `true`.
- **Player_Marks**: The subset of the `marks` collection whose `playerId` matches a given Player.
- **Ticket_Marks**: The subset of a Player's Valid_Marks whose `ticketId` matches a given Ticket.
- **Marked_Term_Ids**: The set of `termId` values present across a given Ticket's Valid_Marks.
- **Prize_Engine**: A collection of pure functions at `src/utils/prizeEngine.ts` that derive `Prize_Progress` for a Ticket from its Valid_Marks.
- **Prize_Id**: One of `CYBER_FIVE`, `FIREWALL_LINE`, `SECURITY_LINE`, `DATA_DEFENDER_LINE`, `CYBER_FULL_HOUSE` (`src/types/prize.ts`).
- **Prize_Progress**: A derived record (`src/types/prize.ts`) with `id` (a Prize_Id), `label`, `current`, and `target`, describing one prize's progress for the Current_Ticket.
- **Prize_Eligible**: The condition that a Prize_Progress's `current` value has reached its `target` value.
- **Line_Prize**: Any of Firewall Line (ticket row 0), Security Line (ticket row 1), or Data Defender Line (ticket row 2).
- **Host_Dashboard**: Screen C at `src/pages/HostDashboard/HostDashboard.tsx`.
- **Player_Game_Screen**: Screen B at `src/pages/PlayerGame/PlayerGame.tsx`.
- **Storage_Key**: The `localStorage` key `cyber-tambola-v2:game` used by the Session_Store.
- **Sync_Channel**: The `BroadcastChannel`-based cross-tab sync mechanism at `src/state/syncChannel.ts`.

## Requirements

### Requirement 1: Mark domain model and central storage

**User Story:** As a developer, I want a real `Mark` record type stored centrally, so that marking a term is an authoritative, traceable game-state event rather than transient UI state.

#### Acceptance Criteria

1. THE Prototype SHALL define a `Mark` type with the fields `id`, `gameId`, `playerId`, `ticketId`, `termId`, `markedAt`, and `valid`.
2. THE Session_Store SHALL include a `marks` collection of Mark records as part of `GameSessionState`.
3. THE Prototype SHALL NOT store Ticket_Cell marked state as component-local state in the Player_Game_Screen or in any other component.
4. WHEN the Session_Store is first created with no persisted data, THE Session_Store SHALL initialize the `marks` collection to an empty array.

### Requirement 2: Mark validation before creation

**User Story:** As the Prototype, I want every mark attempt validated against the current game state before a Mark is created, so that only legitimate player actions can ever affect a ticket or prize progress.

#### Acceptance Criteria

1. WHEN a mark attempt is made, THE Session_Store SHALL create a Mark only if a Current_Player exists.
2. WHEN a mark attempt is made, THE Session_Store SHALL create a Mark only if the Current_Player's Ticket exists in the `tickets` collection.
3. WHEN a mark attempt is made, THE Session_Store SHALL create a Mark only if the submitted `termId` belongs to one of the Current_Ticket's Ticket_Cells.
4. WHEN a mark attempt is made, THE Session_Store SHALL create a Mark only if the submitted `termId` is present in the Game's `revealedTermIds`.
5. WHEN a mark attempt is made, THE Session_Store SHALL create a Mark only if the Game_Status is a status in which marking is allowed (`CLUE_ACTIVE`, `ANSWER_REVEALED`, or `PAUSED` is NOT allowed to mark; marking is allowed only while `ANSWER_REVEALED` reflects the currently revealed term or any previously revealed term remains eligible per criterion 2.4).
6. WHEN a mark attempt is made, THE Session_Store SHALL create a Mark only if no existing Valid_Mark already has the same `playerId`, `ticketId`, and `termId`.
7. IF any of criteria 2.1 through 2.6 fails, THEN THE Session_Store SHALL NOT create a Mark and SHALL leave the `marks` collection, every Ticket, and every Prize_Progress unchanged.
8. WHEN all of criteria 2.1 through 2.6 pass, THE Session_Store SHALL create exactly one new Mark with `valid` set to `true`, `markedAt` set to the current local timestamp as an ISO string, and `id` generated as a local unique identifier.

### Requirement 3: Reducer action for marking a term

**User Story:** As a developer, I want a dedicated reducer action for marking, so that mark validation and creation follow the same pure, predictable reducer pattern as the rest of the Session_Store.

#### Acceptance Criteria

1. THE Session_Store SHALL provide a `MARK_TERM` reducer action that accepts a `termId` and performs the validation described in Requirement 2 using the reducer's current state.
2. THE Session_Store reducer SHALL remain a pure function when handling `MARK_TERM` and SHALL NOT perform side effects such as reading or writing `localStorage` directly inside the reducer.
3. WHEN the `MARK_TERM` action is dispatched and validation passes, THE Session_Store SHALL append the new Mark to the `marks` collection and SHALL leave `players`, `tickets`, and `game` unchanged.
4. WHEN the `MARK_TERM` action is dispatched and validation fails for any reason in Requirement 2, THE Session_Store SHALL return the same state reference or an equivalent unchanged state, consistent with the reducer's existing convention of ignoring invalid actions safely.

### Requirement 4: Derived ticket cell state from Marks

**User Story:** As a player, I want my ticket cells to show LOCKED, AVAILABLE, or MARKED based on real game state, so that what I see always matches what has actually been validated.

#### Acceptance Criteria

1. IF a Ticket_Cell's `termId` is not present in the Game's `revealedTermIds`, THEN THE Player_Game_Screen SHALL derive that Ticket_Cell's state as `LOCKED`.
2. IF a Ticket_Cell's `termId` is present in the Game's `revealedTermIds` and no Valid_Mark exists for the Current_Player, the Current_Ticket, and that `termId`, THEN THE Player_Game_Screen SHALL derive that Ticket_Cell's state as `AVAILABLE`.
3. IF a Valid_Mark exists for the Current_Player, the Current_Ticket, and a Ticket_Cell's `termId`, THEN THE Player_Game_Screen SHALL derive that Ticket_Cell's state as `MARKED`.
4. THE Player_Game_Screen SHALL derive every Ticket_Cell's state solely from the Game's `revealedTermIds` and the `marks` collection in the Session_Store, and SHALL NOT read Ticket_Cell state from component-local state.
5. WHEN the Player_Game_Screen re-renders, navigates away and back, or the Game's `currentTermId` or `revealedTermIds` changes, THE Player_Game_Screen SHALL re-derive every Ticket_Cell's state from the current `marks` collection and `revealedTermIds` rather than from any previously computed or cached value.

### Requirement 5: Mark persistence across refresh

**User Story:** As a player, I want my marked terms to still show as marked after I refresh the page, so that I do not lose my progress.

#### Acceptance Criteria

1. WHEN the `marks` collection changes in the Session_Store, THE Session_Store SHALL persist the current `marks` collection to `localStorage` under the Storage_Key alongside `game`, `players`, `tickets`, and `currentPlayerId`.
2. THE Prototype SHALL extend the existing persisted envelope shape to include a `marks` field rather than introducing a second, competing persistence mechanism.
3. IF valid persisted data exists under the Storage_Key when the Prototype reloads in the same browser, THEN THE Session_Store SHALL restore the `marks` collection so that every restored Mark is identical to its value before the reload.
4. IF the persisted data under the Storage_Key is absent, or has a `marks` field that is missing, `null`, or not an array, THEN THE Session_Store SHALL default the restored `marks` collection to an empty array without throwing an uncaught error.
5. IF the persisted data under the Storage_Key fails overall shape validation for any other reason, THEN THE Session_Store SHALL fall back to seed state, including an empty `marks` collection, without throwing an uncaught error.

### Requirement 6: Mark participation in cross-tab sync

**User Story:** As a player with the game open in multiple tabs, I want my marks to stay in sync across tabs, so that every open view of my session agrees on what I have marked.

#### Acceptance Criteria

1. WHEN the Session_Store broadcasts a session snapshot over the Sync_Channel, THE Session_Store SHALL include the current `marks` collection in the broadcast payload.
2. WHEN the Session_Store receives a session snapshot over the Sync_Channel, THE Session_Store SHALL apply the incoming `marks` collection to its state using the same fail-safe validation convention used for `game`, `players`, and `tickets`.
3. IF an incoming Sync_Channel payload is missing a `marks` field or has a `marks` field that is not an array, THEN THE Session_Store SHALL treat the payload as invalid for that field and SHALL NOT crash, defaulting the applied `marks` collection to an empty array or the prior local value consistent with the existing invalid-payload handling.

### Requirement 7: Pure prize engine

**User Story:** As a developer, I want prize progress computed by pure functions outside any component, so that prize logic is testable and never duplicated inside JSX.

#### Acceptance Criteria

1. THE Prize_Engine SHALL be implemented as pure functions located at `src/utils/prizeEngine.ts` that compute Prize_Progress from a Ticket and a collection of Valid_Marks, and SHALL NOT read from or write to the Session_Store, `localStorage`, or any other external state.
2. THE Prize_Engine SHALL provide a function that returns a Player's Valid_Marks for a given Ticket from the full `marks` collection.
3. THE Prize_Engine SHALL provide a function that returns the Marked_Term_Ids for a given Ticket from a collection of Valid_Marks.
4. THE Prize_Engine SHALL provide a function that computes Prize_Progress for every Prize_Id (`CYBER_FIVE`, `FIREWALL_LINE`, `SECURITY_LINE`, `DATA_DEFENDER_LINE`, `CYBER_FULL_HOUSE`) for a given Ticket and Valid_Marks collection.
5. THE Player_Game_Screen SHALL NOT compute prize progress or eligibility inline inside JSX or component render logic, and SHALL instead call the Prize_Engine.

### Requirement 8: Cyber Five prize progress

**User Story:** As a player, I want Cyber Five progress to reflect any five terms I have marked on my ticket, so that I can see how close I am to this prize regardless of which row my marks are in.

#### Acceptance Criteria

1. THE Prize_Engine SHALL compute the `CYBER_FIVE` Prize_Progress `current` value as the smaller of the Current_Ticket's Marked_Term_Ids count and 5.
2. THE Prize_Engine SHALL compute the `CYBER_FIVE` Prize_Progress `target` value as 5.
3. THE Prize_Engine SHALL compute `CYBER_FIVE` as Prize_Eligible when the Current_Ticket's Marked_Term_Ids count is greater than or equal to 5.
4. THE Prize_Engine SHALL count a Marked_Term_Id toward `CYBER_FIVE` regardless of which ticket row its Ticket_Cell occupies.

### Requirement 9: Line prize progress

**User Story:** As a player, I want each ticket row's line prize to track only the marks in that row, so that Firewall Line, Security Line, and Data Defender Line progress reflect the correct part of my ticket.

#### Acceptance Criteria

1. THE Prize_Engine SHALL compute the `FIREWALL_LINE` Prize_Progress `current` value as the count of Marked_Term_Ids whose Ticket_Cell has `row` equal to 0 on the Current_Ticket.
2. THE Prize_Engine SHALL compute the `SECURITY_LINE` Prize_Progress `current` value as the count of Marked_Term_Ids whose Ticket_Cell has `row` equal to 1 on the Current_Ticket.
3. THE Prize_Engine SHALL compute the `DATA_DEFENDER_LINE` Prize_Progress `current` value as the count of Marked_Term_Ids whose Ticket_Cell has `row` equal to 2 on the Current_Ticket.
4. THE Prize_Engine SHALL compute the `target` value as 5 for `FIREWALL_LINE`, `SECURITY_LINE`, and `DATA_DEFENDER_LINE`.
5. THE Prize_Engine SHALL compute each Line_Prize as Prize_Eligible when all 5 Ticket_Cells in its corresponding row are Marked_Term_Ids.

### Requirement 10: Cyber Full House prize progress

**User Story:** As a player, I want Cyber Full House to track every marked term on my ticket, so that I know how close I am to marking the entire ticket.

#### Acceptance Criteria

1. THE Prize_Engine SHALL compute the `CYBER_FULL_HOUSE` Prize_Progress `current` value as the Current_Ticket's Marked_Term_Ids count.
2. THE Prize_Engine SHALL compute the `CYBER_FULL_HOUSE` Prize_Progress `target` value as 15.
3. THE Prize_Engine SHALL compute `CYBER_FULL_HOUSE` as Prize_Eligible when the Current_Ticket's Marked_Term_Ids count equals 15.

### Requirement 11: Marks contribute to multiple prizes simultaneously

**User Story:** As a player, I want a single marked term to count toward every prize it qualifies for at once, so that my progress is never held back by artificial exclusivity between prizes.

#### Acceptance Criteria

1. THE Prize_Engine SHALL allow a single Marked_Term_Id to contribute simultaneously to the `CYBER_FIVE` Prize_Progress, its corresponding Line_Prize Prize_Progress, and the `CYBER_FULL_HOUSE` Prize_Progress.
2. THE Prize_Engine SHALL NOT remove, consume, or otherwise exclude a Marked_Term_Id from consideration for any other Prize_Progress after it has contributed to one Prize_Progress.

### Requirement 12: Marking interaction on the Player Game screen

**User Story:** As a player, I want to tap an available term to mark it and immediately see my progress update, so that marking feels responsive without needing to refresh.

#### Acceptance Criteria

1. WHEN a player taps a Ticket_Cell whose derived state is `AVAILABLE`, THE Player_Game_Screen SHALL dispatch a `MARK_TERM` action for that cell's `termId`.
2. WHEN a `MARK_TERM` action successfully creates a Valid_Mark, THE Player_Game_Screen SHALL render the corresponding Ticket_Cell as `MARKED` without requiring a page refresh.
3. WHEN a `MARK_TERM` action successfully creates a Valid_Mark, THE Player_Game_Screen SHALL recompute and display updated Prize_Progress values without requiring a page refresh.
4. WHEN a Ticket_Cell transitions to the `MARKED` state, THE Player_Game_Screen SHALL render a distinct visual indicator (such as a checkmark icon and a "Marked" text label) in addition to color for that cell.

### Requirement 13: Marking is permanent within a session

**User Story:** As a player, I want a term I have marked to stay marked, so that I cannot accidentally lose prize progress by tapping it again.

#### Acceptance Criteria

1. WHEN a player taps a Ticket_Cell whose derived state is `MARKED`, THE Player_Game_Screen SHALL NOT dispatch an action that removes, invalidates, or toggles off the existing Valid_Mark.
2. IF a player taps a Ticket_Cell whose derived state is `MARKED`, THEN THE Player_Game_Screen SHALL leave that Ticket_Cell's state as `MARKED` and SHALL leave every Prize_Progress value unchanged.

### Requirement 14: Invalid and duplicate mark feedback

**User Story:** As a player, I want clear feedback when I try to mark a term that is not allowed, so that I understand why nothing happened.

#### Acceptance Criteria

1. WHEN a player taps a Ticket_Cell whose derived state is `LOCKED`, THE Player_Game_Screen SHALL NOT dispatch a `MARK_TERM` action that creates a Mark, and SHALL display a visible message indicating that the term has not been revealed yet (for example, "This term has not been revealed yet.").
2. WHEN a player taps a Ticket_Cell whose derived state is `LOCKED`, THE Player_Game_Screen SHALL leave every Prize_Progress value unchanged.
3. WHEN a player taps a Ticket_Cell whose derived state is `MARKED`, THE Player_Game_Screen SHALL leave the `marks` collection unchanged, resulting in no duplicate Mark for the same `playerId`, `ticketId`, and `termId`.

### Requirement 15: Real prize progress display

**User Story:** As a player, I want the Prize Progress panel to show my actual marked progress, so that I can trust what the screen tells me.

#### Acceptance Criteria

1. THE Player_Game_Screen SHALL display each prize's progress bar and count using the `current` and `target` values returned by the Prize_Engine for the Current_Ticket and the Current_Player's Valid_Marks.
2. THE Player_Game_Screen SHALL NOT display a hard-coded or mock Prize_Progress value while a Current_Player and Current_Ticket exist.
3. WHEN the `marks` collection changes for the Current_Player's Ticket, THE Player_Game_Screen SHALL update every displayed Prize_Progress value to match the Prize_Engine's recomputed output.

### Requirement 16: Claim readiness signaling

**User Story:** As a player, I want the Claim control to reflect my real eligibility, so that I only see it enabled when I have actually qualified.

#### Acceptance Criteria

1. IF a prize's Prize_Progress is not Prize_Eligible, THEN THE Player_Game_Screen SHALL keep that prize's Claim control disabled.
2. IF a prize's Prize_Progress is Prize_Eligible, THEN THE Player_Game_Screen SHALL enable that prize's Claim control and display the text "Prize ready — claim available".
3. WHILE the `CYBER_FIVE` Prize_Progress `current` value is 3 and `target` is 5, THE Player_Game_Screen SHALL display the text "Mark 2 more valid terms to become eligible for Cyber Five."
4. WHILE the `CYBER_FIVE` Prize_Progress `current` value is 4 and `target` is 5, THE Player_Game_Screen SHALL display the text "Mark 1 more valid term to become eligible for Cyber Five."
5. WHILE the `CYBER_FIVE` Prize_Progress `current` value is 5, THE Player_Game_Screen SHALL display the text "🎉 Cyber Five Ready!" and SHALL enable a "Claim Cyber Five" control.
6. THE Player_Game_Screen SHALL NOT persist a claimed or winner-adjudication record as a result of enabling a Claim control in this module.

### Requirement 17: Reset clears marks and derived prize state

**User Story:** As a host, I want Reset Demo Game to clear all marks along with the rest of the session, so that a fresh demo starts every player's prize progress at zero.

#### Acceptance Criteria

1. WHEN the host triggers Reset Demo Game, THE Session_Store SHALL clear the `marks` collection to an empty array in addition to clearing `players`, `tickets`, `currentPlayerId`, and `revealedTermIds`.
2. WHEN the host triggers Reset Demo Game, THE Session_Store SHALL overwrite the persisted state under the Storage_Key with the reset seed state including an empty `marks` collection.
3. AFTER the host triggers Reset Demo Game and a player subsequently joins and views the Player_Game_Screen, THE Prize_Engine SHALL compute every Prize_Progress as `0/5` for Cyber Five, `0/5` for Firewall Line, `0/5` for Security Line, `0/5` for Data Defender Line, and `0/15` for Cyber Full House.

### Requirement 18: Manual test scenarios

**User Story:** As a facilitator, I want the marking and prize scenarios to pass, so that I can verify Module 4 behavior end to end in a single browser.

#### Acceptance Criteria

1. WHEN a revealed ticket term is tapped once (Test A), THE Prototype SHALL transition that Ticket_Cell from `AVAILABLE` to `MARKED` and SHALL display Cyber Five progress `1/5`, the corresponding Line_Prize progress `1/5`, and Cyber Full House progress `1/15`.
2. WHEN the browser is refreshed after Test A (Test B), THE Prototype SHALL restore the Current_Player, Current_Ticket, and the created Mark such that the previously marked Ticket_Cell renders as `MARKED` and every Prize_Progress value matches its value before the refresh.
3. WHEN 5 distinct valid revealed terms on the Current_Ticket are marked (Test C), THE Prototype SHALL display Cyber Five progress `5/5`, SHALL compute `CYBER_FIVE` as Prize_Eligible, and SHALL enable the corresponding Claim control.
4. WHEN all 5 terms in ticket row 0 are marked (Test D), THE Prototype SHALL display Firewall Line progress `5/5` and SHALL compute `FIREWALL_LINE` as Prize_Eligible (the same behavior SHALL apply to row 1 for Security Line and row 2 for Data Defender Line).
5. WHEN all 15 terms on the Current_Ticket are revealed and marked (Test E), THE Prototype SHALL display Cyber Full House progress `15/15` and SHALL compute `CYBER_FULL_HOUSE` as Prize_Eligible.
6. WHEN a player attempts to mark a Ticket_Cell that is `LOCKED` (Test F), THE Prototype SHALL create no Mark, SHALL leave every Prize_Progress value unchanged, and SHALL display a clear feedback message.
7. WHEN a player taps a Ticket_Cell that is already `MARKED` (Test G), THE Prototype SHALL create no duplicate Mark, SHALL leave every Prize_Progress value unchanged, and SHALL leave that Ticket_Cell's state as `MARKED`.
8. WHEN the host triggers Reset Demo Game after any of Tests A through G (Test H), THE Prototype SHALL clear all Marks, SHALL clear `players` and `tickets` per existing reset behavior, and SHALL return every Prize_Progress to its zeroed initial value.

### Requirement 19: Build integrity

**User Story:** As a developer, I want the project to build cleanly after this module's changes, so that Module 4 meets the same definition of done as prior modules.

#### Acceptance Criteria

1. THE Prototype SHALL build successfully via the project's existing production build command (`tsc -b && vite build` or equivalent) with zero TypeScript errors after Module 4's changes are applied.

### Requirement 20: Out-of-scope boundaries

**User Story:** As a developer, I want Module 4 to stay within its prototype boundaries, so that no premature backend or adjudication work is introduced.

#### Acceptance Criteria

1. THE Prototype SHALL NOT implement a production backend, a database, a WebSocket layer, authentication, or Azure/AWS deployment in this module.
2. THE Prototype SHALL NOT implement final host-side claim adjudication or persisted winner records in this module.
3. THE Prototype SHALL NOT implement enterprise analytics in this module.
4. THE Prototype SHALL keep all Module 4 marking, persistence, and prize-engine behavior local to a single browser and its Sync_Channel-connected tabs.
