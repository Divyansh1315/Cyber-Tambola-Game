# Requirements Document

## Introduction

Module 3 turns the Cyber Tambola V2 prototype from a single hard-coded demo player into a working local player-joining and dynamic-ticket-generation experience. Employees register on the Join screen with locally validated details, receive a uniquely generated 3x5 cyber-word ticket, and see that ticket react to the host's real reveal history. Multiple players can be created in the same browser, the host sees a live participant count, and player, ticket, and current-player data survive a page refresh through local persistence.

This module also folds in two corrections carried over from Module 2: responsive display of long revealed answers, and removal of a claim/progress inconsistency in the player UI.

This remains a single-browser React + TypeScript + Vite prototype. There is no backend, database, WebSocket layer, real multi-device networking, authentication, cloud deployment, or server-side prize/claim validation. All state lives in the existing React Context + `useReducer` store and browser `localStorage`. Real marking persistence, prize calculation, real claims, and a winner engine remain out of scope and are addressed in later modules.

## Glossary

- **Prototype**: The single-browser Cyber Tambola V2 React application described above.
- **Session_Store**: The central React Context + `useReducer` game session state defined in `src/state` (`GameSessionContext.tsx`, `gameSessionReducer.ts`, `gameSessionInitialState.ts`).
- **Game**: The central lifecycle model (`src/types/game.ts`) holding `status`, `currentRound`, `currentTermId`, and `revealedTermIds`.
- **Game_Status**: One of `LOBBY`, `CLUE_ACTIVE`, `ANSWER_REVEALED`, `PAUSED`, `COMPLETED`.
- **Prototype_Game_Code**: The single active game code `CYBER24`, exported as `SEED_GAME_CODE`.
- **Player**: A local participant record (`src/types/player.ts`) with `id`, `gameId`, `displayName`, `employeeDemoId`, `ticketId`, and `joinedAt`.
- **Ticket**: A player's 3x5 cyber-word ticket (`src/types/ticket.ts`) with `id`, `playerId`, `gameId`, `createdAt`, `ref`, and `rows`.
- **Ticket_Cell**: A single cell on a Ticket referencing a `termId` plus its row/column position and a `TicketCellState`.
- **Ticket_Cell_State**: One of `LOCKED`, `AVAILABLE`, `MARKED`.
- **Cyber_Term**: A cyber-awareness term (`src/types/cyberTerm.ts`) in the term bank `cyberTerms` (`src/data/cyberTerms.ts`), each with an `active` flag.
- **Active_Term**: A Cyber_Term whose `active` flag is `true`.
- **Ticket_Generator**: A pure utility at `src/utils/ticketGenerator.ts` that builds a new Ticket from the Active_Term bank and existing ticket signatures.
- **Ticket_Signature**: The canonical fingerprint of a Ticket, computed as its 15 `termId` values sorted ascending and joined with the `|` character.
- **Current_Player**: The Player identified by the `currentPlayerId` field in the Session_Store.
- **Join_Service**: A helper/action-creator layer (outside the reducer) that builds Player and Ticket objects and dispatches them into the Session_Store.
- **Answer_Reveal_Component**: The component at `src/components/common/AnswerReveal.tsx` (with `AnswerReveal.css`) that displays the revealed answer.
- **Host_Dashboard**: Screen C at `src/pages/HostDashboard/HostDashboard.tsx`.
- **Player_Join_Screen**: Screen A at `src/pages/PlayerJoin/PlayerJoin.tsx`.
- **Player_Game_Screen**: Screen B at `src/pages/PlayerGame/PlayerGame.tsx`.
- **Presentation_View**: Screen D at `src/pages/PresentationView/PresentationView.tsx`.
- **Storage_Key**: The `localStorage` key `cyber-tambola-v2:game` used by the Session_Store.
- **Normalized_Id**: An employee/demo identifier reduced to a comparison form by trimming surrounding whitespace and lower-casing (for example, `DEMO-021` and `demo-021` produce the same Normalized_Id).

## Requirements

### Requirement 1: Responsive display of long revealed answers

**User Story:** As a player or projector viewer, I want long cyber-term answers to stay readable inside their card, so that I can read the answer clearly on any screen size.

#### Acceptance Criteria

1. WHEN the Answer_Reveal_Component displays a revealed answer, THE Answer_Reveal_Component SHALL render the complete answer text within the visible bounds of its card with no character clipped or hidden.
2. IF a revealed answer is wider than the available card content width, THEN THE Answer_Reveal_Component SHALL wrap the answer text onto multiple lines within the card.
3. WHEN the Answer_Reveal_Component displays a revealed answer at any viewport width from 320px to 1920px inclusive, THE Answer_Reveal_Component SHALL render the answer with zero horizontal overflow beyond the card's outer edge (the card SHALL not trigger horizontal scrolling).
4. THE Answer_Reveal_Component SHALL scale answer font size using a fluid typography technique such as CSS `clamp()`, bounded to a minimum of 1.25rem and a maximum of 2.5rem at the `player` scale, and a minimum of 2rem and a maximum of 6rem at the `stage` scale.
5. WHEN a revealed answer is 3 characters or fewer, such as `MFA`, THE Answer_Reveal_Component SHALL render the answer at the maximum bound of its scale's font-size range and SHALL not reduce the font size below that maximum.
6. WHEN a revealed answer is a long term of 18 characters or more such as `Social Engineering` or `Suspicious Attachment`, THE Answer_Reveal_Component SHALL render the full answer inside the card at both the `player` and `stage` scales with a rendered font size no smaller than the scale's minimum bound (1.25rem for `player`, 2rem for `stage`).

### Requirement 2: Consistent mock claim eligibility and prize progress

**User Story:** As a player, I want the claim button and its explanatory text to agree with my displayed prize progress, so that I am never told I am eligible while my progress says otherwise.

#### Acceptance Criteria

1. IF the displayed current progress for the prize that gates the Claim control (Cyber Five, target 5) is less than that prize's target count, THEN THE Player_Game_Screen SHALL keep the Claim control disabled.
2. THE Player_Game_Screen SHALL derive the Claim control's explanatory text from the same displayed progress value and eligibility condition that enable or disable the Claim control, such that the text indicates "eligible" only when the Claim control is enabled and indicates the remaining requirement otherwise.
3. WHILE the Claim control is enabled, THE Player_Game_Screen SHALL display, for the gating prize, a current progress value greater than or equal to that prize's target count.
4. IF the displayed current progress for the gating prize is greater than or equal to its target count but the reveal precondition for eligibility is not met, THEN THE Player_Game_Screen SHALL keep the Claim control disabled and present explanatory text that does not indicate eligibility.
5. THE Player_Game_Screen SHALL determine claim eligibility and prize progress using local mock/state data only, without server-side validation.

### Requirement 3: Player registration with local validation on the Join screen

**User Story:** As an employee, I want to join a game by entering a game code, my name, and my ID, so that I can get my own ticket and start playing.

#### Acceptance Criteria

1. THE Player_Join_Screen SHALL provide input fields for Game Code, Employee Name, and Employee ID / Demo ID.
2. THE Player_Join_Screen SHALL limit each of the Game Code, Employee Name, and Employee ID / Demo ID inputs to a maximum of 64 characters.
3. WHEN the player submits the join form, THE Player_Join_Screen SHALL trim leading and trailing whitespace from the Game Code, Employee Name, and Employee ID / Demo ID values before validation.
4. IF the Game Code, Employee Name, or Employee ID / Demo ID is empty after trimming, THEN THE Player_Join_Screen SHALL reject the submission, SHALL NOT navigate to the Player_Game_Screen, and SHALL display a visible validation message indicating that the required field(s) must be filled in.
5. WHEN the player submits a Game Code, THE Player_Join_Screen SHALL compare the trimmed Game Code against the Prototype_Game_Code (`CYBER24`) using a case-insensitive comparison.
6. IF the submitted Game Code does not match the Prototype_Game_Code, THEN THE Player_Join_Screen SHALL reject the submission, SHALL display the message `Game not found or no longer available.`, and SHALL NOT create a Player.
7. WHILE the current Game_Status is `LOBBY`, `CLUE_ACTIVE`, `ANSWER_REVEALED`, or `PAUSED`, THE Player_Join_Screen SHALL allow a submission that passes criteria 4 through 6 to join.
8. IF the current Game_Status is `COMPLETED`, THEN THE Player_Join_Screen SHALL reject the submission, SHALL display a visible message indicating the game is no longer available, and SHALL NOT create a Player.
9. WHEN a join submission passes all validation, THE Player_Join_Screen SHALL navigate to the Player_Game_Screen at route `/player`.

### Requirement 4: Create real Player records on join

**User Story:** As the Prototype, I want each successful join to produce a real Player record, so that player identity and ticket ownership are tracked in central state.

#### Acceptance Criteria

1. WHEN a join submission passes validation for a new participant, THE Join_Service SHALL create a Player record containing `id`, `gameId`, `displayName`, `employeeDemoId`, `ticketId`, and `joinedAt`.
2. WHEN the Join_Service creates a Player, THE Join_Service SHALL set `displayName` to the trimmed Employee Name and `employeeDemoId` to the trimmed Employee ID / Demo ID.
3. WHEN the Join_Service creates a Player, THE Join_Service SHALL set `joinedAt` to the current local timestamp as an ISO string.
4. WHEN the Join_Service generates a local identifier for a Player or Ticket, THE Join_Service SHALL use `crypto.randomUUID()` when available and SHALL fall back to a locally generated unique identifier when `crypto.randomUUID()` is unavailable.
5. WHEN the Join_Service creates a Player, THE Join_Service SHALL add the Player to the `players` collection in the Session_Store.

### Requirement 5: Duplicate identity restore

**User Story:** As a returning player, I want joining again with the same ID to restore my existing session, so that I keep my original ticket instead of getting a new one.

#### Acceptance Criteria

1. WHEN a join submission is validated, THE Join_Service SHALL compute the Normalized_Id of the submitted Employee ID / Demo ID.
2. IF a Player already exists in the current Game with a matching Normalized_Id, THEN THE Join_Service SHALL select that existing Player as the Current_Player and SHALL NOT create a second Player.
3. IF an existing Player is restored, THEN THE Join_Service SHALL reuse that Player's existing Ticket and SHALL NOT generate a new Ticket.
4. WHEN an existing Player is restored, THE Player_Join_Screen SHALL navigate to the Player_Game_Screen.
5. WHERE an existing Player is restored, THE Player_Game_Screen SHALL display the message `Existing game session restored.`

### Requirement 6: Participant count derived from central state

**User Story:** As a host, I want the participant count to reflect the actual number of joined players, so that the dashboard shows real participation instead of a fixed number.

#### Acceptance Criteria

1. THE Host_Dashboard SHALL derive the displayed participant count from the length of the `players` collection in the Session_Store.
2. THE Prototype SHALL NOT display the fixed participant value `47` as the participant count.
3. WHEN a new Player is added to the Session_Store, THE Host_Dashboard SHALL display the participant count increased by one.

### Requirement 7: Dynamic ticket generation engine

**User Story:** As the Prototype, I want a pure ticket-generation utility, so that each player receives a valid, unique 3x5 cyber-word ticket.

#### Acceptance Criteria

1. THE Ticket_Generator SHALL be a pure function located at `src/utils/ticketGenerator.ts` that receives the Active_Term bank and the collection of existing Ticket_Signatures as inputs and returns a new Ticket, and SHALL NOT read from or write to any state outside its input parameters.
2. THE Ticket_Generator SHALL select ticket terms only from Cyber_Terms whose `active` flag is exactly boolean `true`, and SHALL exclude every Cyber_Term whose `active` flag is `false`, `null`, `undefined`, or absent.
3. THE Ticket_Generator SHALL produce a Ticket containing exactly 15 Active_Terms with distinct `termId` values, arranged in exactly 3 rows and exactly 5 columns.
4. THE Ticket_Generator SHALL place each of the 15 distinct Active_Terms in exactly one Ticket_Cell, such that no `termId` appears in more than one cell of the same Ticket.
5. THE Ticket_Generator SHALL store in each Ticket_Cell only the referenced Cyber_Term's `termId` value plus the cell's row index (0 to 2) and column index (0 to 4), and SHALL NOT store any other Cyber_Term field in the cell.
6. WHEN the Ticket_Generator selects terms, THE Ticket_Generator SHALL choose the 15 termIds using a randomized selection such that, across 100 consecutive generations from an Active_Term bank of at least 16 terms, at least 2 distinct term sets are produced.
7. THE Ticket_Generator SHALL compute the Ticket_Signature by taking the Ticket's 15 `termId` values, sorting them in ascending order, and joining them with the single `|` character, with no leading, trailing, or repeated separators.
8. WHEN the Ticket_Generator produces a candidate Ticket whose Ticket_Signature matches any Ticket_Signature in the existing collection, THE Ticket_Generator SHALL discard the candidate and regenerate a new candidate Ticket, repeating up to a maximum of 50 regeneration attempts.
9. IF the Ticket_Generator completes 50 regeneration attempts without producing a Ticket whose Ticket_Signature is absent from the existing collection, THEN THE Ticket_Generator SHALL throw a developer-facing error indicating that a unique ticket could not be generated, SHALL NOT return a Ticket with a duplicate Ticket_Signature, and SHALL leave the input collections unmodified.
10. IF the count of Active_Terms is fewer than 15, THEN THE Ticket_Generator SHALL throw a developer-facing error indicating insufficient active terms, SHALL NOT return a Ticket, and SHALL leave the input collections unmodified.

### Requirement 8: Ticket persistence within a session

**User Story:** As a player, I want to keep the same ticket throughout the game, so that navigating, revealing clues, or re-rendering never changes my ticket.

#### Acceptance Criteria

1. THE Prototype SHALL generate a Player's Ticket only once, during that Player's first successful join.
2. WHEN the Player_Game_Screen navigates, re-renders, receives a clue change, or receives an answer reveal, THE Prototype SHALL retain the Current_Player's existing Ticket unchanged.
3. THE Session_Store SHALL retain each generated Ticket in its `tickets` collection for the lifetime of the session.

### Requirement 9: Current player concept

**User Story:** As a player, I want the game screen to show my own information, so that I see my name and ticket rather than a hard-coded demo player.

#### Acceptance Criteria

1. THE Session_Store SHALL hold an optional `currentPlayerId` identifying the Current_Player.
2. THE Player_Game_Screen SHALL determine the displayed Player information from the Current_Player resolved via `currentPlayerId`.
3. THE Player_Game_Screen SHALL NOT source displayed Player information from `mockPlayer` or a hard-coded player name such as `Divyansh`.
4. IF the Player_Game_Screen is opened with no Current_Player set, THEN THE Player_Game_Screen SHALL redirect to the Player_Join_Screen or SHALL display the message `Join a game first.`

### Requirement 10: Player Game header shows real values

**User Story:** As a player, I want the game header to show my real name and a short ticket reference, so that I can recognize my session without seeing a long internal ID.

#### Acceptance Criteria

1. THE Player_Game_Screen header SHALL display the Current_Player's `displayName`.
2. THE Player_Game_Screen header SHALL display a short ticket reference derived from the Ticket's `id`, formatted as `Ticket #` followed by a short token (for example `Ticket #A72F`).
3. THE Player_Game_Screen SHALL NOT display the Ticket's full identifier or a long UUID in the header.

### Requirement 11: Render ticket from real ticket data

**User Story:** As a player, I want my ticket rendered from real generated data, so that the cells reflect my actual assigned terms.

#### Acceptance Criteria

1. THE Player_Game_Screen SHALL resolve the rendered Ticket by following Current_Player to `ticketId` to the matching Ticket in the Session_Store `tickets` collection.
2. WHEN the Player_Game_Screen renders a Ticket_Cell, THE Player_Game_Screen SHALL resolve the cell's display label from the Cyber_Term matching the cell's `termId`.
3. THE Player_Game_Screen SHALL render the Ticket using the existing 3x5 responsive ticket layout.
4. THE Player_Game_Screen SHALL NOT source the Current_Player's Ticket from `mockTickets.ts`.

### Requirement 12: Reveal-driven ticket cell state

**User Story:** As a player, I want my ticket cells to unlock as terms are revealed, so that my ticket reacts to the host's real reveal history.

#### Acceptance Criteria

1. IF a Ticket_Cell's `termId` is not present in the Game's `revealedTermIds`, THEN THE Player_Game_Screen SHALL render that Ticket_Cell in the `LOCKED` state.
2. IF a Ticket_Cell's `termId` is present in the Game's `revealedTermIds`, THEN THE Player_Game_Screen SHALL render that Ticket_Cell in the `AVAILABLE` state.
3. THE Player_Game_Screen SHALL derive Ticket_Cell states from the Game's live `revealedTermIds` rather than from hard-coded cell states in `mockTickets.ts`.
4. WHEN the Game's `revealedTermIds` changes, THE Player_Game_Screen SHALL update the affected Ticket_Cell states to match the current reveal history.

### Requirement 13: Single source of truth for live player and ticket data

**User Story:** As a developer, I want live player and ticket behavior driven by central state only, so that there are no competing sources of truth.

#### Acceptance Criteria

1. THE Prototype SHALL source live Player and Ticket behavior from the Session_Store.
2. THE Prototype SHALL NOT use `mockPlayers.ts` or `mockTickets.ts` as a source for live Player or Ticket behavior.
3. WHERE `mockPlayers.ts` or `mockTickets.ts` remain in the codebase, THE Prototype SHALL retain them only as clearly labelled development fixtures.
4. THE Prototype SHALL remove imports of `mockPlayers.ts` and `mockTickets.ts` that are no longer used for live behavior.

### Requirement 14: Extend central session state and reducer actions

**User Story:** As a developer, I want the central store extended with players, tickets, and current-player fields plus predictable actions, so that joining and restoring are handled cleanly.

#### Acceptance Criteria

1. THE Session_Store SHALL include a `players` collection of Player records, a `tickets` collection of Ticket records, and an optional `currentPlayerId`.
2. THE Session_Store SHALL provide a reducer action that adds a joining Player with a pre-built Ticket and sets that Player as the Current_Player.
3. THE Session_Store SHALL provide a reducer action that restores an existing Player as the Current_Player without creating a new Player or Ticket.
4. THE Session_Store reducer SHALL be a pure function and SHALL NOT perform random Ticket generation.
5. WHEN a Player joins, THE Join_Service SHALL build the Player and Ticket before dispatch and SHALL pass the pre-built Player and Ticket into the dispatched action.

### Requirement 15: Reset clears players, tickets, and current player

**User Story:** As a host, I want Reset Demo Game to clear all players and tickets and return the game to the lobby, so that I can restart a clean demo.

#### Acceptance Criteria

1. WHEN the host triggers Reset Demo Game, THE Session_Store SHALL clear the `players` collection, the `tickets` collection, and the `currentPlayerId`.
2. WHEN the host triggers Reset Demo Game, THE Session_Store SHALL set the Game_Status to `LOBBY`, `currentRound` to `0`, no current term, and an empty `revealedTermIds` collection.

### Requirement 16: Local persistence of players, tickets, and current player

**User Story:** As a player, I want my player, ticket, and current-player state to survive a page refresh, so that reloading the browser does not lose my session.

#### Acceptance Criteria

1. WHEN the `players` collection, `tickets` collection, `currentPlayerId`, or Game changes in the Session_Store, THE Session_Store SHALL persist the current `players`, `tickets`, `currentPlayerId`, and Game to `localStorage` under the Storage_Key.
2. IF valid persisted data exists under the Storage_Key when the Prototype reloads in the same browser, THEN THE Session_Store SHALL restore the `players`, `tickets`, `currentPlayerId`, and Game so that each restored value is identical to its value before the reload.
3. THE Session_Store SHALL include a version marker with value `2` in the persisted shape.
4. IF the persisted data is absent, is missing the version marker, has a version marker other than `2`, or fails shape validation, THEN THE Session_Store SHALL fall back to seed state without throwing an uncaught error.
5. IF a restored `currentPlayerId` does not reference any Player in the restored `players` collection, THEN THE Session_Store SHALL clear the `currentPlayerId`.
6. WHEN the host triggers Reset Demo Game, THE Session_Store SHALL overwrite the persisted state under the Storage_Key with the reset seed state including the version marker `2`.

### Requirement 17: Host participant visibility

**User Story:** As a host, I want to see how many participants have joined, so that I can gauge engagement during the game.

#### Acceptance Criteria

1. THE Host_Dashboard SHALL display a participant area showing at minimum `Participants:` followed by the participant count derived from the `players` collection.
2. WHERE a compact participant name list is shown, THE Host_Dashboard SHALL list Player display names only.
3. THE Presentation_View SHALL NOT display any Player's Employee ID / Demo ID.
4. THE Host_Dashboard SHALL NOT display any Player's Employee ID / Demo ID on the projector-facing participant area.

### Requirement 18: Prize progress does not contradict ticket state

**User Story:** As a player, I want prize progress in this module to stay consistent with my ticket, so that the displayed progress does not contradict what my ticket shows.

#### Acceptance Criteria

1. THE Player_Game_Screen SHALL display prize progress as visual/mock values that do not contradict the Current_Player's Ticket state.
2. THE Player_Game_Screen SHALL initialize prize progress values to `0/5` for Cyber Five, `0/5` for Firewall Line, `0/5` for Security Line, `0/5` for Data Defender Line, and `0/15` for Cyber Full House.
3. WHILE prize progress is at its initial values, THE Player_Game_Screen SHALL keep the Claim control disabled and SHALL display the text `Mark revealed terms to become eligible for prizes.`
4. THE Player_Game_Screen SHALL NOT perform claim processing in this module.
5. WHERE host sample claim cards remain, THE Host_Dashboard SHALL keep them clearly separated from real game state.

### Requirement 19: Manual test scenarios

**User Story:** As a facilitator, I want the six manual test scenarios to pass, so that I can verify Module 3 behavior end to end in a single browser.

#### Acceptance Criteria

1. WHEN a valid Game Code, a new Employee Name, and a new Employee ID / Demo ID are submitted (Test A), THE Prototype SHALL create a new Player, generate that Player's Ticket, and navigate to the Player_Game_Screen showing the new Player's name and ticket (new player join).
2. WHEN the browser is refreshed after a join (Test B), THE Prototype SHALL restore the same Player, Ticket, and Current_Player so the Player_Game_Screen shows the same name and ticket as before the refresh (persistence across refresh).
3. WHEN a join is submitted with an Employee ID / Demo ID whose Normalized_Id matches an existing Player in the current Game (Test C), THE Prototype SHALL restore the existing Player and reuse the existing Ticket without generating a new Ticket (duplicate identity restore).
4. WHEN three distinct players join in the same browser (Test D), THE Prototype SHALL show a participant count of `3` and SHALL assign each Player a Ticket with a distinct Ticket_Signature (multiple local players with distinct tickets).
5. WHEN the host reveals a term whose `termId` appears on the Current_Player's Ticket (Test E), THE Player_Game_Screen SHALL change that Ticket_Cell from `LOCKED` to `AVAILABLE` (reveal-driven LOCKED to AVAILABLE).
6. WHEN the host triggers Reset Demo Game (Test F), THE Prototype SHALL clear the `players` collection, the `tickets` collection, and the `currentPlayerId`, and SHALL return the Game to `LOBBY` with `currentRound` `0` and an empty `revealedTermIds` collection (reset clears players/tickets/current player).

### Requirement 20: Out-of-scope boundaries

**User Story:** As a developer, I want Module 3 to stay within its prototype boundaries, so that no premature backend or validation work is introduced.

#### Acceptance Criteria

1. THE Prototype SHALL NOT implement real marking persistence, real mark validation, prize calculation, real claims, or a winner engine in this module.
2. THE Prototype SHALL NOT introduce a backend, an external API, a WebSocket/Socket.IO layer, a database, or a cloud service such as Firebase, Supabase, Azure, or AWS in this module.
3. THE Prototype SHALL NOT implement authentication or real mobile-to-host synchronization in this module.
4. THE Prototype SHALL keep all Module 3 player, ticket, and persistence behavior local to a single browser.
