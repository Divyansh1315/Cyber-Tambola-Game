# Requirements Document

## Introduction

The Cyber Tambola V2 prototype currently implements a guessing-game round flow: the host shows a hidden clue, players think about the answer, and the host performs a separate "Reveal Answer" action before a ticket term becomes markable. This module replaces that flow with a direct word-call model closer to traditional Tambola: the host calls a Cyber Word, and the word's definition and a short safe-practice tip are displayed immediately alongside it — there is no hidden answer and no separate reveal step. As soon as the host calls a word, any matching ticket term becomes available to mark.

This is a **controlled refactor** of the round/reveal mechanic only. It must not disturb already-working, already-fixed behavior: player joining, dynamic ticket generation and uniqueness, current-player identity (client-local, persisted separately, immune to cross-tab sync), mark persistence, existing marked terms surviving further calls/pauses/refreshes, prize progress (Cyber Five, line prizes, Full House), claim readiness, and the cross-tab revision-counter synchronization fix. Where an existing mechanism (e.g. `revealedTermIds`) already correctly supports the new behavior internally, this module reuses it rather than renaming or replacing it, to minimize blast radius.

This remains a single-browser React + TypeScript + Vite prototype. No backend, database, WebSocket layer, production authentication, cloud deployment, new prize categories, content-management screens, or final claim/winner engine are introduced by this module.

## Glossary

- **Prototype**: The single-browser Cyber Tambola V2 React application.
- **Session_Store**: The central React Context + `useReducer` game session state (`src/state/GameSessionContext.tsx`, `gameSessionReducer.ts`, `gameSessionInitialState.ts`).
- **Game**: The central lifecycle model (`src/types/game.ts`).
- **Game_Status**: The lifecycle status of a Game. Before this module: `LOBBY`, `CLUE_ACTIVE`, `ANSWER_REVEALED`, `PAUSED`, `COMPLETED`. After this module: `LOBBY`, `WORD_ACTIVE`, `PAUSED`, `COMPLETED` — `CLUE_ACTIVE` and `ANSWER_REVEALED` collapse into the single `WORD_ACTIVE` status, since there is no longer a separate hidden-clue phase.
- **Cyber_Term**: A cyber-awareness term (`src/types/cyberTerm.ts`) in the term bank `cyberTerms` (`src/data/cyberTerms.ts`).
- **Called_Term**: A Cyber_Term whose `id` is present in the Game's `revealedTermIds` collection. Before this module this collection meant "terms whose answer has been revealed"; after this module it means "terms the host has officially called." The field name `revealedTermIds` is preserved internally to avoid destabilizing ticket/mark/prize logic that already depends on it; user-facing text refers to this concept as "Called Words" or "Previous Cyber Words," never "Reveal History."
- **Current_Called_Term**: The Cyber_Term identified by the Game's `currentTermId`, once it has been called (Game_Status is `WORD_ACTIVE` or `PAUSED` with a previous status of `WORD_ACTIVE`).
- **Ticket_Cell_State**: One of `LOCKED`, `AVAILABLE`, `MARKED`, derived in this priority order: `MARKED` if a Valid_Mark exists, else `AVAILABLE` if the cell's `termId` is a Called_Term, else `LOCKED`.
- **Mark / Valid_Mark**: An authoritative record (`src/types/mark.ts`) of a player validly marking one term on one ticket. Unaffected by this module except that "term has been officially called" (checked against `revealedTermIds`) replaces "term has been revealed" as the English description of the same existing validation gate.
- **Prize_Engine**: The pure functions at `src/utils/prizeEngine.ts` computing prize progress from a Ticket and its Valid_Marks. Unaffected by this module.
- **Current_Player_Id**: The client-local (never cross-tab-synchronized) identifier of the player using the current browser tab, persisted under its own `localStorage` key. Unaffected by this module.
- **Host_Dashboard**: Screen C at `src/pages/HostDashboard/HostDashboard.tsx`.
- **Player_Game_Screen**: Screen B at `src/pages/PlayerGame/PlayerGame.tsx`.
- **Presentation_View**: Screen D at `src/pages/PresentationView/PresentationView.tsx`.
- **Storage_Key**: The `localStorage` key for the shared session envelope (`src/state/persistence.ts`).
- **Persist_Version**: The version marker written into every persisted envelope, used to safely reject incompatible older envelopes.

## Requirements

### Requirement 1: Collapsed game status model

**User Story:** As a developer, I want the game's lifecycle status to reflect that there is only one active round phase, so that the code and UI cannot represent an impossible "clue shown but not yet called" state.

#### Acceptance Criteria

1. THE Prototype SHALL define `Game_Status` as exactly one of `LOBBY`, `WORD_ACTIVE`, `PAUSED`, `COMPLETED`.
2. THE Prototype SHALL NOT define or reference a `CLUE_ACTIVE` or `ANSWER_REVEALED` status value anywhere in production code after this module is complete.
3. WHEN the host starts the game from `LOBBY`, THE Session_Store SHALL transition `Game_Status` directly to `WORD_ACTIVE` with the first selected Cyber_Term already called (Requirement 4).
4. WHEN the host calls the next Cyber_Term while `Game_Status` is `WORD_ACTIVE`, THE Session_Store SHALL keep `Game_Status` at `WORD_ACTIVE` with the newly selected term called (Requirement 5).
5. WHEN the host pauses the game, THE Session_Store SHALL transition `Game_Status` to `PAUSED` and record `WORD_ACTIVE` as the status to resume to, exactly as the existing pause/resume mechanism already does for its prior two active statuses.
6. WHEN the host resumes a paused game, THE Session_Store SHALL transition `Game_Status` back to `WORD_ACTIVE`.
7. WHEN the host ends the game, THE Session_Store SHALL transition `Game_Status` to `COMPLETED` regardless of the prior status.
8. WHEN the active Cyber_Term bank is exhausted and the host attempts to call another term, THE Session_Store SHALL transition `Game_Status` to `COMPLETED` instead of calling a term, and SHALL NOT throw or crash.

### Requirement 2: Single host action to display and call a word

**User Story:** As a host, I want calling a Cyber Word to be one action that immediately shows the word, its definition, and its safe-practice tip, so that I never need a separate step to reveal the answer.

#### Acceptance Criteria

1. THE Prototype SHALL NOT provide a "Reveal Answer" control, action, or equivalent second-step mechanism anywhere in the Host_Dashboard, Player_Game_Screen, or Presentation_View after this module is complete.
2. WHEN the host clicks "Start Game" from `LOBBY`, THE Session_Store SHALL select one unused Active_Term, set it as `currentTermId`, add its `id` to `revealedTermIds`, and set `currentRound` to `1`, all as part of the same action.
3. WHEN the host clicks "Next Cyber Word" while `Game_Status` is `WORD_ACTIVE`, THE Session_Store SHALL select one unused Active_Term not previously present in `revealedTermIds`, set it as `currentTermId`, add its `id` to `revealedTermIds`, and increment `currentRound`, all as part of the same action.
4. THE Prototype SHALL NOT select or display a Cyber_Term whose `id` is already present in `revealedTermIds` during the same game (no duplicate calls).
5. THE Prototype SHALL preserve every previously added `id` in `revealedTermIds` when a new term is called; calling a new term SHALL only ever append to this collection, never remove or replace an existing entry.

### Requirement 3: Word, definition, and safe-practice tip content

**User Story:** As a developer, I want each Cyber Term to carry a definition and an awareness tip that are shown together with the word, so that players and the presentation view can display full context the moment a word is called.

#### Acceptance Criteria

1. THE Prototype SHALL define a Cyber_Term content shape with a `definition` field (short factual description of the term) and an `awarenessTip` field (short safe-practice guidance), in place of the previous `clue`/`learningMessage` field names.
2. WHERE the existing 30 Cyber_Term entries already contain suitable `clue` and `learningMessage` text, THE Prototype SHALL migrate that existing text into `definition` and `awarenessTip` respectively rather than discarding and rewriting it, except where the existing text was written as a guessing clue (withholding the term) and requires light editing to instead directly describe the term as a definition.
3. THE Prototype SHALL retain all 30 existing Cyber_Term entries, their `id` values, `term` names, `category` values, `difficulty` values, and `active` flags unchanged by this module.
4. THE Prototype SHALL keep each `definition` value to no more than 2 short sentences and each `awarenessTip` value to 1 short sentence, suitable for simultaneous display on a mobile screen, the host dashboard, and a projector.

### Requirement 4: Ticket cell state derives from called terms and marks, unchanged priority order

**User Story:** As a player, I want my ticket cells to unlock the moment the host calls a matching word, so that I can mark it without any extra host action.

#### Acceptance Criteria

1. IF a valid Mark exists for the Current_Player, the Current_Ticket, and a Ticket_Cell's `termId`, THEN THE Player_Game_Screen SHALL derive that Ticket_Cell's state as `MARKED`, evaluated before any other condition.
2. IF no valid Mark exists for that `termId` AND the `termId` is present in `revealedTermIds`, THEN THE Player_Game_Screen SHALL derive that Ticket_Cell's state as `AVAILABLE`.
3. IF the `termId` is not present in `revealedTermIds` AND no valid Mark exists for it, THEN THE Player_Game_Screen SHALL derive that Ticket_Cell's state as `LOCKED`.
4. THE Prototype SHALL NOT change the existing `deriveCellState` evaluation order, signature, or its dependency on `revealedTermIds` and the player's valid Marks.
5. WHEN the host calls a new Cyber_Term, THE Player_Game_Screen SHALL transition only that term's matching Ticket_Cells (if any, and if not already `MARKED`) from `LOCKED` to `AVAILABLE`, and SHALL leave every other Ticket_Cell's state exactly as it was.

### Requirement 5: Existing marks, prize progress, and player identity are not disturbed

**User Story:** As a player, I want my previous marks, prize progress, and login state to remain completely stable while the host calls further words, so that this refactor introduces no regressions in already-fixed behavior.

#### Acceptance Criteria

1. WHEN the host calls a new Cyber_Term, THE Session_Store SHALL leave every existing Mark in the `marks` collection unchanged (no removal, replacement, or mutation of any existing Mark record).
2. WHEN the host calls a new Cyber_Term, pauses the game, or resumes the game, THE Player_Game_Screen SHALL continue to render every previously `MARKED` Ticket_Cell as `MARKED`.
3. THE Prototype SHALL NOT alter the Cyber Five, Firewall Line, Security Line, Data Defender Line, or Cyber Full House calculation logic in `src/utils/prizeEngine.ts` as part of this module.
4. WHEN a term is called and later marked, THE Prize_Engine SHALL compute prize progress using the same validated-Mark-based logic as before this module; prize progress SHALL continue to depend only on valid Marks, never on how many terms have been called.
5. THE Prototype SHALL continue to keep `Current_Player_Id` as client-local state, persisted under its own dedicated `localStorage` key, and excluded from any cross-tab synchronized payload; calling a new Cyber_Term, pausing, or resuming SHALL NOT change or clear `Current_Player_Id` for any browser tab.
6. WHILE `Current_Player_Id`, its matching Player record, and that Player's Ticket all exist, THE Player_Game_Screen SHALL remain on `/player` when a new Cyber_Term is called, the game is paused, the game is resumed, or another tab's synchronized state updates — none of these events SHALL trigger a redirect to the join screen.

### Requirement 6: Host Dashboard reflects the direct-call model

**User Story:** As a host, I want a single current-word panel and a simplified control set, so that running the game requires only "call the next word" with no extra reveal step.

#### Acceptance Criteria

1. THE Host_Dashboard SHALL NOT render a "Reveal Answer" button or any control that dispatches a reveal-only action.
2. THE Host_Dashboard SHALL provide, at minimum, controls labeled to start the game, call the next Cyber Word, pause, resume, and end the game.
3. WHEN a Cyber_Term is the Current_Called_Term, THE Host_Dashboard SHALL display, in a single unified panel, the term's `term` name, its `definition`, and its `awarenessTip`, all simultaneously and without requiring any further host action.
4. THE Host_Dashboard SHALL rename its called-terms history panel's visible title away from "Reveal History" to a label such as "Called Words" or "Previous Cyber Words".
5. THE Host_Dashboard SHALL rename its "Next Clue" control's visible label to "Next Cyber Word" (or equivalent direct-call wording) and its "Current Clue" panel's visible title to "Current Cyber Word" (or equivalent).

### Requirement 7: Player Game screen shows word, definition, and tip without guessing language

**User Story:** As a player, I want to see the called word together with its meaning and a safe-practice tip, so that I do not need to guess anything before I can check my ticket.

#### Acceptance Criteria

1. WHILE a Cyber_Term is the Current_Called_Term, THE Player_Game_Screen SHALL display the term's `term` name, its `definition`, and its `awarenessTip` simultaneously, with no hidden or partially-revealed state.
2. THE Player_Game_Screen SHALL NOT display the text "Think about the cyber term…" or any equivalent guessing prompt.
3. THE Player_Game_Screen SHALL NOT provide a reveal-answer control or any player-facing action required before a ticket cell can become `AVAILABLE`.
4. THE Player_Game_Screen SHALL continue to require an explicit player tap to transition an `AVAILABLE` Ticket_Cell to `MARKED`; no term SHALL be marked automatically as a result of being called.
5. IF no Cyber_Term has yet been called in the current game, THEN THE Player_Game_Screen SHALL display a waiting state that does not reference a clue, an answer, or guessing.

### Requirement 8: Presentation View shows word, meaning, and safe practice as one state

**User Story:** As an event audience, I want the projector to show the called word, its meaning, and the safe-practice tip together, so that the room can read and absorb the information without waiting for a second reveal step.

#### Acceptance Criteria

1. THE Presentation_View SHALL render exactly one state for an active round rather than separate clue and answer-reveal states.
2. WHILE a Cyber_Term is the Current_Called_Term, THE Presentation_View SHALL display the term's `term` name as the visually largest element, its `definition` as a clearly readable secondary block, and its `awarenessTip` as a visually distinct but secondary element.
3. THE Presentation_View SHALL continue to render its existing `LOBBY` state (branding, game code, join QR area) unchanged.
4. THE Presentation_View SHALL continue to render its existing `PAUSED` and `COMPLETED` states, updated only to reflect the collapsed `Game_Status` values from Requirement 1.
5. THE Presentation_View SHALL NOT render a "Think about the cyber term…" prompt or any other guessing-oriented text.

### Requirement 9: Legacy persisted state is handled safely

**User Story:** As a returning user, I want the application to never crash because my browser has old prototype data from before this change, so that the refactor is safe to deploy over an existing session.

#### Acceptance Criteria

1. THE Prototype SHALL increment `Persist_Version` as part of this module.
2. IF a persisted envelope under Storage_Key has a `Persist_Version` other than the new current value, THEN THE Session_Store SHALL fall back to seed state without throwing an uncaught error, using the same fail-safe convention already implemented for other version mismatches.
3. THE Prototype SHALL NOT attempt to field-by-field migrate an old envelope's `game.status` value of `CLUE_ACTIVE` or `ANSWER_REVEALED` into the new `Game_Status` union; discarding such an envelope via the version-mismatch fallback is an acceptable and preferred safe-migration strategy for this prototype.
4. WHEN an incompatible persisted envelope is discarded, THE Prototype SHALL still allow a fresh join and game session to proceed normally afterward.

### Requirement 10: Preserved subsystems are not modified beyond type-level ripple

**User Story:** As a developer, I want every already-working subsystem untouched by this refactor except where the `Game_Status` type change forces a compile-time update, so that this remains a controlled refactor rather than a rebuild.

#### Acceptance Criteria

1. THE Prototype SHALL NOT modify the player-joining validation, duplicate-identity restore, or Join screen behavior in `src/state/joinService.ts` and `src/pages/PlayerJoin/PlayerJoin.tsx` beyond changes required to keep the code compiling against the updated `Game_Status`/`CyberTerm` types.
2. THE Prototype SHALL NOT modify ticket generation, ticket uniqueness, or the 3x5 ticket layout in `src/utils/ticketGenerator.ts`.
3. THE Prototype SHALL NOT modify the Mark validation gates or Mark record shape in `src/utils/prizeEngine.ts`'s `validateMarkAttempt`, other than continuing to gate on `Game_Status !== 'COMPLETED'` using the new status union.
4. THE Prototype SHALL NOT modify the cross-tab revision-counter (`rev`) staleness mechanism in `src/state/gameSessionReducer.ts`'s `SYNC_STATE` case.
5. THE Prototype SHALL NOT introduce a backend, database, WebSocket layer, production authentication mechanism, cloud deployment configuration, new prize category, content-management screen, or a final claim/winner adjudication engine as part of this module.

### Requirement 11: Manual and automated test coverage for the new round flow

**User Story:** As a facilitator, I want the direct-call gameplay flow verified end to end, so that I can trust the refactor did not regress marking, prizes, or player identity.

#### Acceptance Criteria

1. WHEN the host starts the game (Test A), THE Prototype SHALL display the first called Cyber_Term's word, definition, and awareness tip immediately, with no clue-only screen, no hidden answer, and no reveal control shown anywhere.
2. WHEN the host calls a Cyber_Term (Test B), THE Host_Dashboard, Player_Game_Screen, and Presentation_View SHALL each display that term's word, definition, and awareness tip.
3. WHEN a called Cyber_Term matches a term on the Current_Player's ticket (Test C), THAT Ticket_Cell SHALL be `LOCKED` before the call, `AVAILABLE` immediately after the call, and `MARKED` after the player taps it.
4. WHEN the host calls a second Cyber_Term (Test D), THE Prototype SHALL display the new term everywhere, SHALL retain the first term in the called-words history, and SHALL leave the first term's Mark (if any) `MARKED`; the second term SHALL become `AVAILABLE` only if present on the ticket.
5. WHEN at least 10 Cyber_Terms are called in sequence (Test E), THE Prototype SHALL never call a duplicate term, SHALL grow the called-words history monotonically, SHALL never decrease any previously-attained prize progress value, SHALL keep the Current_Player logged in throughout, and SHALL keep the same ticket assigned throughout.
6. WHEN the Player_Game_Screen is refreshed after multiple calls and Marks (Test F), THE Prototype SHALL restore the same Player, the same Ticket, all Marks, the correct prize progress, the current called term, and the full called-words history, with no redirect to the join screen.
7. WHEN the host pauses and then resumes the game (Test G), THE Player_Game_Screen and Presentation_View SHALL show a paused state while paused and SHALL show the same Current_Called_Term after resuming, with all Marks and prize progress intact throughout.
