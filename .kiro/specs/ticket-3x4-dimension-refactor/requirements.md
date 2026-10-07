# Requirements Document

## Introduction

The Player Ticket currently has 3 rows x 5 columns (15 Cyber Words), with magic numbers (`5`, `15`, `/5`, `%5`) spread across ticket generation, domain types, prize/claim engines, persistence, and tests. This feature changes the ticket to 3 rows x 4 columns (12 Cyber Words) and simplifies the player marking interaction model.

The refactor is cross-cutting: ticket generation, domain types, row/column math, signature-based duplicate detection, the prize engine (line prizes, Cyber Full House), the claim engine, Supabase RPC-backed authoritative validation, persistence/sync round-tripping, the player ticket UI, and the full test suite (unit, integration, fixtures, mocks) are all affected. All ticket-dimension values (row count, column count, total cell count) must be centralized into shared constants and used consistently by both frontend and backend-facing validation so the UI and the authoritative mutation layer cannot disagree about prize eligibility.

This feature also tightens the marking interaction model: a cell becomes markable only while it is the game's single current term, not for the lifetime of the call history, and the UI stops exposing internal cell-state details (lock icon, state text labels, legend) that are no longer relevant once marking is this constrained.

Out of scope: this document does not include git branching/commit instructions or deployment execution steps; those belong to the implementation plan, not these requirements. Historical/completed winner and claim records produced under the old 15-cell format are explicitly preserved unmodified (see Requirement 7).

## Glossary

- **Ticket**: A player's grid of Cyber Word cells for one game, persisted as rows of `TicketCell` records.
- **Ticket_Dimension_Constants**: The shared constants `TICKET_ROWS` (3), `TICKET_COLUMNS` (4), and `TICKET_SIZE` (12), defined once and imported wherever ticket shape is used.
- **Ticket_Cell**: One cell of a Ticket, referencing a single Cyber_Term and carrying a `row`, `col`, and visual state.
- **Cyber_Term**: An entry from the cyber term bank (`cyberTerms.ts`) assignable to a Ticket_Cell.
- **Ticket_Signature**: The deterministic string derived from a Ticket's full set of `termId`s, used to detect duplicate Tickets.
- **Current_Term**: The single Cyber_Term referenced by `Game.currentTermId` that the host has most recently called; the only term eligible for new marks.
- **Call_History**: The ordered list of every Cyber_Term id the host has called this game (`Game.revealedTermIds`), retained for display/history purposes only.
- **Mark**: A record that a Player has validly marked one Ticket_Cell's Cyber_Term.
- **Valid_Mark**: A Mark with `valid === true` for a given Player and Ticket.
- **Line_Prize**: One of Firewall_Line (row 0), Security_Line (row 1), or Data_Defender_Line (row 2); eligible when every cell in that row is marked.
- **Cyber_Five**: The prize eligible when any 5 Ticket_Cells (regardless of row) are marked.
- **Cyber_Full_House**: The prize eligible when every Ticket_Cell on the Ticket is marked.
- **Prize_Progress**: The current/target counters shown for a given prize, derived from Valid_Marks.
- **Claim**: A Player's submission asserting eligibility for a Prize, subject to authoritative validation before being confirmed.
- **Authoritative_Validation**: Validation performed in the shared mutation layer (reducer-level validators and/or Supabase RPC functions) that is not bypassable by client-only state, and whose outcome the UI must match.
- **Legacy_Ticket**: A Ticket created before this feature shipped, with 15 cells arranged 3x5, still referenced by an active (non-completed) game session.

## Requirements

### Requirement 1: Central Ticket Dimension Constants

**User Story:** As a developer, I want a single source of truth for ticket dimensions, so that every part of the codebase stays consistent when the ticket shape changes.

#### Acceptance Criteria

1. THE System SHALL define `TICKET_ROWS` with value 3, `TICKET_COLUMNS` with value 4, and `TICKET_SIZE` with value 12 in exactly one shared module (replacing the current module `src/utils/ticketGenerator.ts`'s existing `TICKET_ROWS=3`, `TICKET_COLS=5`, `TICKET_SIZE=15` exports).
2. THE System SHALL compute `TICKET_SIZE` as `TICKET_ROWS * TICKET_COLUMNS` rather than as an independently hardcoded literal.
3. THE System SHALL remove the old `TICKET_COLS` export name once `TICKET_COLUMNS` is introduced, and SHALL update every importer of the old name (including `src/utils/ticketGenerator.ts` and its test file) to import `TICKET_COLUMNS` instead.
4. WHEN ticket generation, row/column index math, prize progress calculation, claim validation, or ticket signature computation needs a row count, column count, or total cell count, THE System SHALL reference `TICKET_ROWS`, `TICKET_COLUMNS`, or `TICKET_SIZE` instead of a numeric literal.
5. WHEN the term bank contains fewer than `TICKET_SIZE` (12) active Cyber_Terms, THE Ticket_Generator SHALL reject ticket generation and raise an error indicating insufficient active terms.
6. IF a code path represents an unrelated, non-ticket-dimension quantity that happens to equal 5 or 15, THEN THE System SHALL leave that literal unchanged and SHALL NOT replace it with a Ticket_Dimension_Constant.

Note: the current codebase exports the column constant as `TICKET_COLS`; this requirement set targets the renamed `TICKET_COLUMNS` as the standard going forward.

### Requirement 2: Ticket Generation Produces a 3x4 Ticket

**User Story:** As a player, I want my ticket to contain 12 unique Cyber Words arranged in 3 rows of 4, so that gameplay matches the new ticket format.

#### Acceptance Criteria

1. WHEN a new Ticket is generated, THE Ticket_Generator SHALL select exactly `TICKET_SIZE` (12) distinct active Cyber_Terms with no repeated `termId` within the Ticket.
2. WHEN a new Ticket is generated, THE Ticket_Generator SHALL arrange the selected Cyber_Terms into `TICKET_ROWS` (3) rows of `TICKET_COLUMNS` (4) Ticket_Cells each, with exactly one Cyber_Term per cell and no empty cells.
3. WHEN the Ticket_Generator is invoked with different RNG seeds, THE Ticket_Generator SHALL be capable of producing different selections or orderings of Cyber_Terms, consistent with its existing shuffle-based random-selection mechanism.
4. WHEN a new Ticket's computed Ticket_Signature matches a signature in the existing-signatures set, THE Ticket_Generator SHALL retry generation up to its existing maximum-attempt limit.
5. IF the Ticket_Generator exhausts its maximum-attempt limit without finding a unique Ticket_Signature, THEN THE Ticket_Generator SHALL raise an error indicating that a unique ticket could not be generated.
6. IF fewer than `TICKET_SIZE` active Cyber_Terms are available in the term bank, THEN THE Ticket_Generator SHALL raise an error indicating insufficient active terms.

### Requirement 3: Ticket Domain Model Reflects 12-Cell Structure

**User Story:** As a developer, I want the Ticket types, validators, helpers, and fixture builders to describe a 12-cell/4-column ticket, so that type-level and runtime assumptions match the new shape.

#### Acceptance Criteria

1. THE System SHALL define `TicketCell.row` as an integer in the range 0 to 2 inclusive and `TicketCell.col` as an integer in the range 0 to 3 inclusive.
2. THE System SHALL update the `Ticket` interface's documentation comment in `src/types/ticket.ts` to state that a Ticket is a 3-row by 4-column grid of 12 Cyber_Terms (replacing the current "3 x 5 cyber-word ticket (15 terms)" comment).
3. WHEN a test helper, fixture builder, or any other ticket construction/inspection code path (e.g. `createMockTicket`, `getRow`, `buildTicket`, and any test file currently hardcoding a column count of 5 or a size of 15) constructs or inspects a Ticket, THE System SHALL use `TICKET_ROWS`, `TICKET_COLUMNS`, and `TICKET_SIZE` rather than hardcoded 5- or 15-based values.
4. IF a `TicketCell.row` or `TicketCell.col` value falls outside its valid range (0-2 for row, 0-3 for col), THEN THE System SHALL treat that cell as invalid and SHALL NOT include it in a successfully generated Ticket.

Note: the current codebase exports the column constant as `TICKET_COLS`; this requirement targets the renamed `TICKET_COLUMNS` per Requirement 1.

### Requirement 4: Row/Column Index Math Is Dimension-Aware

**User Story:** As a developer, I want row and column index calculations to derive from the shared dimension constants, so that index math stays correct if the ticket shape changes again.

#### Acceptance Criteria

1. WHEN assigning a flat cell index to a row and column during Ticket generation, THE Ticket_Generator SHALL compute `row` as `Math.floor(index / TICKET_COLUMNS)` and `col` as `index % TICKET_COLUMNS`.
2. THE System SHALL ensure that, for the current `TICKET_COLUMNS` value of 4, the row/col computation in Criterion 1 maps flat cell indexes 0-3 to row 0, indexes 4-7 to row 1, and indexes 8-11 to row 2, with `col` cycling 0 to 3 within each row.
3. WHEN the Prize_Engine or any other module performs row/column index math against Ticket_Cells (e.g. row slicing for Line_Prize progress calculation), THE System SHALL derive the divisor and modulus from `TICKET_COLUMNS` rather than a hardcoded literal.

### Requirement 5: Persistence and Sync Round-Trip 12-Cell Tickets

**User Story:** As a player, I want my 12-cell ticket and its marks to survive refresh, reconnect, and multi-device sync without data loss or corruption, so that my progress is reliable.

#### Acceptance Criteria

1. WHEN a 12-cell Ticket is persisted to local storage and later hydrated, THE System SHALL restore all 12 Ticket_Cells with their original `termId`, `row`, and `col` values unchanged.
2. WHEN a 12-cell Ticket is synchronized through the realtime channel (Supabase row changes or the equivalent mock), THE System SHALL serialize and deserialize all 12 Ticket_Cells without dropping or duplicating any cell.
3. WHEN a Player's Valid_Marks are persisted or synchronized alongside a 12-cell Ticket, THE System SHALL preserve the association between each Mark and its correct Ticket_Cell across a hydration or sync cycle.
4. IF persisted or synchronized Ticket data is incomplete, corrupted, or does not contain exactly 12 Ticket_Cells at hydration time, THEN THE System SHALL surface this as an error state rather than silently rendering a partial or malformed Ticket.

### Requirement 6: Ticket Signature and Duplicate Detection Cover 12 Terms

**User Story:** As a host, I want duplicate-ticket detection to keep working correctly after the dimension change, so that no two players ever receive tickets with identical content.

#### Acceptance Criteria

1. WHEN computing a Ticket_Signature, THE System SHALL derive it from exactly the 12 `termId`s present on the Ticket, sorted ascending and joined with a single consistent delimiter character.
2. WHEN two generated Tickets contain the same 12 `termId`s regardless of order, THE System SHALL compute identical Ticket_Signatures for both.
3. WHEN a Ticket is generated, THE System SHALL ensure no `termId` appears more than once within that Ticket's 12 cells.
4. WHEN generating a new Ticket, THE System SHALL retry selection, up to a bounded number of attempts, whenever the candidate Ticket_Signature already exists among previously generated Tickets' signatures for that game.
5. IF the bounded number of retry attempts is exhausted without producing a Ticket_Signature that is unique among existing Tickets, THEN THE System SHALL raise an error rather than returning a duplicate Ticket.

### Requirement 7: Legacy 15-Cell Tickets and Historical Records Are Preserved

**User Story:** As a host, I want existing completed winner and claim records to remain untouched, and existing active 15-cell tickets to not be silently corrupted, so that past results stay accurate and in-progress games are not broken without warning.

#### Acceptance Criteria

1. WHEN this feature ships, THE System SHALL use 12-cell Tickets for every newly created game and newly generated Ticket.
2. THE System SHALL NOT modify, truncate, or recompute any pre-existing Winner or Claim record that was already persisted (created and stored) under the 15-cell Ticket format before this feature shipped.
3. IF an active (non-completed) game session holds a Legacy_Ticket with 15 cells, THEN THE System SHALL NOT automatically truncate, resize, or reinterpret that Legacy_Ticket's cells to fit the 12-cell format, and THAT session SHALL continue operating under its existing 15-cell/5-column rules (including any new Winner or Claim records it produces) until the session is reset.
4. WHILE a game session holds a Legacy_Ticket, THE System SHALL require the existing Reset or New Game action before that session's players receive a 12-cell Ticket.
5. THE System SHALL NOT perform automatic migration of in-progress Legacy_Ticket data from the 15-cell format to the 12-cell format.

### Requirement 8: Player Ticket Grid Renders 3x4

**User Story:** As a player, I want my ticket displayed as a 3x4 grid, so that the layout matches the new 12-word ticket.

#### Acceptance Criteria

1. GIVEN the underlying Ticket data supplies 3 rows of 4 Ticket_Cells each, WHEN the Player Ticket is rendered, THE Ticket component SHALL lay out each row using a 4-column grid (e.g. `grid-template-columns: repeat(4, 1fr)`), producing 3 stacked rows of 4 columns each.
2. THE System SHALL apply the 3x4 grid change only to the Player Ticket's own styles and SHALL NOT alter unrelated 5-column layouts elsewhere in the application.
3. WHEN the Player Ticket is rendered on a 320px-wide viewport, THE Ticket component SHALL display exactly 4 columns and 3 rows with no horizontal page scroll, and each cell's Cyber Word text SHALL remain visible without being clipped.
4. WHEN the Player Ticket is rendered on a tablet or desktop viewport (768px width or greater), THE Ticket component SHALL render the 3x4 layout within a maximum container width bound (consistent with the existing Card/page-content max-width convention) with all 4 columns rendered at equal width, rather than stretching to the full viewport width.

### Requirement 9: Cyber Word Labels Remain Readable

**User Story:** As a player, I want Cyber Word labels to stay readable on my ticket, so that I can recognize the word without it breaking apart mid-word.

#### Acceptance Criteria

1. WHEN a Ticket_Cell's Cyber Word (including two-word phrases such as "Data Classification" or "Social Engineering") fits on one line at the cell's current rendered width, THE Ticket_Cell SHALL render that word on a single line.
2. THE Ticket_Cell SHALL use a `clamp()`-based responsive font-size rule for its Cyber Word text, with a defined minimum and maximum bound, rather than a single fixed font size.
3. THE Ticket_Cell SHALL NOT rely on CSS automatic hyphenation (`hyphens: auto`) to fit Cyber Word text, since hyphenation can visually split a word mid-word.
4. IF a multi-word Cyber Word phrase is too long to fit on one line at a 320px viewport width even at the minimum font-size bound, THEN THE Ticket_Cell SHALL wrap the phrase only at a space between words (word-level wrap) and SHALL NOT break any individual word into separate characters or syllables across lines.

### Requirement 10: Unmarked Ticket Cells Show No Lock Icon

**User Story:** As a player, I want unmarked ticket cells to look clean, so that I am not shown an icon that no longer reflects how marking works.

#### Acceptance Criteria

1. WHEN a Ticket_Cell is unmarked, THE Ticket_Cell SHALL render without a lock icon.
2. THE System SHALL remove the lock icon asset/markup from every unmarked Ticket_Cell visual state (both the previously-named LOCKED and AVAILABLE internal states).

### Requirement 11: Ticket Cells Show No State Text Labels

**User Story:** As a player, I want the Cyber Word itself to be the primary thing I read on a tile, so that the tile is not cluttered with redundant state text.

#### Acceptance Criteria

1. WHEN a Ticket_Cell is rendered in the LOCKED, AVAILABLE, or MARKED state, THE Ticket_Cell SHALL NOT display the visible text labels "Locked", "Available", or "Marked" anywhere on the tile.
2. WHEN a Ticket_Cell is in the LOCKED state, THE Ticket_Cell SHALL indicate the locked state using a lock icon only, without a visible "Locked" text label, and SHALL remain disabled to pointer and keyboard interaction.
3. WHEN a Ticket_Cell is in the AVAILABLE state, THE Ticket_Cell SHALL indicate the available state using an unmarked icon only, without a visible "Available" text label, and SHALL remain enabled to pointer and keyboard interaction.
4. WHEN a Ticket_Cell transitions to the MARKED state, THE Ticket_Cell SHALL indicate the marked state using a green background and a checkmark icon only, without a visible "Marked" text label.
5. WHEN a Ticket_Cell is rendered in any state, THE Ticket_Cell SHALL expose the current state to assistive technology through the `aria-pressed` attribute (reflecting whether the cell is MARKED) and an `aria-label` attribute whose value includes the Cyber Word and a state description equivalent to "Not revealed yet", "Available — tap to mark", or "Marked", even though no corresponding text is visible on the tile.
6. IF a Ticket_Cell's state changes (e.g. from AVAILABLE to MARKED, or from LOCKED to AVAILABLE), THEN THE Ticket_Cell SHALL update its `aria-pressed` and `aria-label` values to reflect the new state immediately, without requiring the player to re-focus or re-render the page manually.

Note: Requirement 13 further restricts LOCKED vs AVAILABLE to be visually indistinguishable on screen; this requirement's references to lock icon/disabled state for LOCKED cells apply only internally/to assistive technology semantics, not to visible styling, consistent with Requirement 13.

### Requirement 12: Ticket Legend Is Removed

**User Story:** As a player, I want the ticket area free of a legend I no longer need, so that the screen has less unnecessary content.

#### Acceptance Criteria

1. THE "Your Cyber Word Ticket" Card on the Player Game screen SHALL NOT render the Locked/Available/Marked legend element (the `<ul aria-label="Ticket cell states">` list) that previously appeared below the ticket grid.
2. THE Player Game screen SHALL NOT render any divider or spacing element that existed solely to separate the ticket grid from the removed legend.
3. Removing the legend SHALL NOT affect the per-cell state icons or text rendered inside individual Ticket_Cells (governed separately by Requirements 10 and 11).

### Requirement 13: Unmarked Tiles Share a Neutral Visual Style

**User Story:** As a player, I want all unmarked tiles to look the same, so that the ticket does not visually reveal which word is currently correct to tap.

#### Acceptance Criteria

1. WHEN a Ticket_Cell is UNMARKED (its internal state is `LOCKED` or `AVAILABLE`), THE Ticket_Cell SHALL render using the same icon, background, border, and text styling regardless of whether its Cyber_Term is the Current_Term, a previously called term, or a never-called term.
2. WHEN a Ticket_Cell is UNMARKED, THE Ticket_Cell SHALL remain tappable (not disabled) regardless of its internal `LOCKED`/`AVAILABLE` state, so that tap-ability itself does not reveal which term is callable.
3. IF a player taps an UNMARKED Ticket_Cell whose internal state is `LOCKED` (its Cyber_Term has not been called), THEN THE System SHALL leave the Ticket_Cell UNMARKED and SHALL NOT change its visual style as a result of the tap.
4. WHEN a Ticket_Cell is UNMARKED, THE Ticket_Cell's accessible name and any text exposed to assistive technology (e.g. aria-label, visually hidden state text) SHALL be identical regardless of its internal `LOCKED`/`AVAILABLE` state, so that assistive-technology users are not given information sighted players cannot see.
5. THE Ticket_Cell visual state SHALL distinguish only MARKED from UNMARKED on screen and to assistive technology; internal distinctions (e.g. retained `LOCKED`/`AVAILABLE` values) MAY exist in code but SHALL NOT produce any visibly or programmatically different presentation.

### Requirement 14: Only the Current Term May Be Newly Marked

**User Story:** As a host, I want players to only be able to mark the word I just called, so that the game stays synchronized with my calling pace and past calls cannot be marked late.

#### Acceptance Criteria

1. WHEN a Player taps a Ticket_Cell whose `termId` equals `Game.currentTermId`, AND the Player, Ticket, and Game ownership relationships are valid, AND no Valid_Mark already exists for that Player/Ticket/termId combination, THE System SHALL record a new Mark for that Ticket_Cell.
2. IF a Ticket_Cell's `termId` is present in Call_History (`Game.revealedTermIds`) but does not equal `Game.currentTermId`, THEN THE System SHALL NOT permit a new Mark to be created for that Ticket_Cell.
3. THE System SHALL retain Call_History for display and other non-marking purposes without granting marking eligibility based on membership in Call_History alone.

### Requirement 15: Tapping a Non-Current Word Is a No-Op

**User Story:** As a player, I want tapping the wrong word to do nothing, so that I am not penalized or confused by incorrect taps.

#### Acceptance Criteria

1. WHEN a Player taps an UNMARKED Ticket_Cell whose `termId` does not equal `Game.currentTermId` (whether that term was never called or was previously called), THE System SHALL make no state change: no Mark is recorded, the Ticket_Cell remains UNMARKED, and its visual appearance and accessible `aria-pressed`/`aria-label` values are unchanged.
2. WHEN a Player taps a Ticket_Cell whose `termId` does not equal `Game.currentTermId`, THE System SHALL NOT display a popup, toast, or error banner, and SHALL NOT apply a penalty.
3. WHEN a Player repeatedly or rapidly taps the same Ticket_Cell whose `termId` does not equal `Game.currentTermId`, THE System SHALL continue to make no state change on each tap, with no cumulative effect across repeated taps.

### Requirement 16: Marks Are Permanent and Idempotent

**User Story:** As a player, I want my marked words to stay marked, so that refreshing or reconnecting never loses my progress or lets me accidentally undo a mark.

#### Acceptance Criteria

1. WHEN a Ticket_Cell has a Valid_Mark, THE Ticket_Cell SHALL render as MARKED (green background with checkmark) and SHALL take visual priority over any other state.
2. WHEN a Player taps an already-MARKED Ticket_Cell, THE System SHALL make no state change and SHALL NOT remove the existing Mark.
3. WHEN a Player refreshes the page or reconnects, THE System SHALL restore every previously recorded Valid_Mark for that Player's Ticket unchanged.

### Requirement 17: Authoritative Mark Validation in the Shared Mutation Layer

**User Story:** As a host, I want mark validation enforced authoritatively, not just in the browser, so that a modified or stale client cannot create invalid marks.

#### Acceptance Criteria

1. WHEN a mark attempt is submitted, THE Authoritative_Validation layer SHALL verify, in order, stopping at the first failing check: the Game exists, the Player belongs to the Game, the Ticket belongs to the Player, the Ticket belongs to the Game, the requested `termId` exists on the Ticket, the requested `termId` equals the Game's current `currentTermId`, and no Valid_Mark already exists for that Player/Ticket/termId combination.
2. IF any check in the Authoritative_Validation pipeline fails, THEN THE System SHALL reject the mark attempt, SHALL NOT persist a Mark, and SHALL return an indication of which check failed.
3. THE System SHALL perform Authoritative_Validation in the shared mutation layer (reducer-level validator and/or Supabase RPC function) rather than relying solely on client-side React state checks.
4. WHEN two mark attempts for the same Player/Ticket/termId combination are submitted concurrently, THE System SHALL ensure that at most one Valid_Mark is ever persisted for that combination.

### Requirement 18: Supabase RPC Mark Validation Matches Current-Term Rule

**User Story:** As a host, I want the backend mark-submission function to enforce the same current-term-only rule as the frontend, so that the two layers cannot disagree.

#### Acceptance Criteria

1. WHEN a Client invokes the mark-submission RPC (e.g. `submit_mark`), THE System SHALL validate, within the same atomic database transaction as the write, that the requested `termId` equals the target Game's `current_term_id` at that instant, rejecting the call if the term was only previously called (present in `revealedTermIds`/`called_terms`) but is no longer the current term.
2. IF the mark-submission RPC is invoked with a `termId` that does not equal the target Game's `current_term_id`, THEN THE System SHALL reject the invocation, SHALL NOT create or modify any row in the `marks` table or any other shared table, and SHALL return an error indication to the caller identifying that the term is not currently active.
3. THE mark-submission RPC SHALL restrict its effect to the invoking Player's own Marks, verifying that the target Mark's Player and Ticket belong to the Player identified by the call, and SHALL reject the invocation without creating or modifying any row if that ownership check fails.
4. IF implementing this requirement requires a new or modified SQL/RPC migration, THEN THE System SHALL document the migration's deployment steps (including the exact commands or console actions required to apply it) within the same pull request or commit as the migration file.

### Requirement 19: Realtime Race Between Host Call and Player Tap Resolves to Backend State

**User Story:** As a player, I want my tap to be judged by the game's true current word, so that a race between the host calling a new word and my tap is resolved fairly and consistently for every client.

#### Acceptance Criteria

1. THE System SHALL evaluate every mark attempt reaching Authoritative_Validation against the authoritative backend's current `currentTermId` value at validation time, not a stale frontend-cached value.
2. IF the authoritative `currentTermId` at validation time does not match the attempted `termId`, THEN THE System SHALL reject the mark attempt, even if the attempt appeared valid against the frontend's locally cached `currentTermId` when the Player tapped.
3. WHEN a mark attempt is rejected due to a `currentTermId` mismatch at validation time, THE System SHALL leave the Ticket_Cell UNMARKED with no Mark persisted, consistent with Requirement 17's no-partial-state rule.
4. WHEN a mark attempt is rejected due to a `currentTermId` mismatch, THE System SHALL cause the Player's client to reconcile its locally cached `currentTermId` to the authoritative value, so that a subsequent tap on the Current_Term's Ticket_Cell is evaluated against the up-to-date value.

### Requirement 20: Cyber Five Remains Unchanged

**User Story:** As a player, I want the Cyber Five prize to keep working the same way, so that this refactor does not change a prize that was not supposed to change.

#### Acceptance Criteria

1. THE System SHALL compute Cyber_Five progress as the count of distinct Marked_Term_Ids on the player's Ticket, counting a Ticket_Cell as marked only if it has a Valid_Mark, regardless of which row the Ticket_Cell belongs to, with the count capped at a maximum of 5.
2. THE System SHALL display Cyber_Five progress as a "current/target" value, where current is the count from Criterion 1 (ranging from 0 to 5) and target is fixed at 5.
3. IF Cyber_Five progress reaches a current value of 5, THEN THE System SHALL mark Cyber_Five as eligible for the player's Ticket.

### Requirement 21: Line Prizes Require 4/4

**User Story:** As a player, I want each line prize to require completing a full row of the new 4-word rows, so that line prizes match the new ticket shape.

#### Acceptance Criteria

1. THE System SHALL compute each Line_Prize's (Firewall_Line, Security_Line, Data_Defender_Line) progress as the count of Valid_Marks within that prize's row, ranging from 0 to `TICKET_COLUMNS` (4), with a target of `TICKET_COLUMNS` (4).
2. WHEN all 4 Ticket_Cells in a Line_Prize's row have Valid_Marks, THE System SHALL report that Line_Prize as eligible.
3. THE System SHALL NOT report any Line_Prize with a target of 5 after this refactor ships.

### Requirement 22: Cyber Full House Requires 12/12

**User Story:** As a player, I want Cyber Full House to require marking every word on my 12-word ticket, so that the prize matches the new ticket size.

#### Acceptance Criteria

1. THE System SHALL compute Cyber_Full_House progress as the count of marked Ticket_Cells across the entire Ticket, with a target of `TICKET_SIZE` (12).
2. WHEN all 12 Ticket_Cells on a Ticket are marked, THE System SHALL report Cyber_Full_House as eligible.
3. THE System SHALL NOT report Cyber_Full_House with a target of 15 after this refactor ships.

### Requirement 23: Prize and Claim Engines Agree With the UI on New Targets

**User Story:** As a host, I want the backend claim validator to use the exact same prize targets as the player-facing UI, so that a claim can never be approved or rejected based on mismatched expectations.

#### Acceptance Criteria

1. THE Claim engine SHALL validate Firewall_Line, Security_Line, and Data_Defender_Line claims by requiring Valid_Marks on all `TICKET_COLUMNS` (4) cells of the respective row, and SHALL reject a claim where any cell in that row lacks a Valid_Mark.
2. THE Claim engine SHALL validate Cyber_Full_House claims by requiring Valid_Marks on all `TICKET_SIZE` (12) Ticket_Cells, and SHALL reject a claim where any cell lacks a Valid_Mark.
3. THE Claim engine SHALL validate Cyber_Five claims using the unchanged rule of 5 or more Valid_Marks anywhere on the Ticket, and SHALL reject a claim with fewer than 5 Valid_Marks.
4. THE Claim engine's row-completion and full-ticket-completion checks SHALL reference `TICKET_COLUMNS` and `TICKET_SIZE` rather than hardcoded literals.
5. WHEN the frontend Prize_Progress calculation and the backend/authoritative Claim validation are evaluated against the same Ticket and Valid_Marks, THE System SHALL produce the same eligibility result (eligible or not eligible) for every prize.

### Requirement 24: Winner Record Logic Preserved Except Where Dimension-Dependent

**User Story:** As a host, I want winner-record handling to stay the same wherever it does not depend on ticket size, so that unrelated behavior is not disturbed by this refactor.

#### Acceptance Criteria

1. THE System SHALL leave Winner record creation, storage, and retrieval logic unchanged except where that logic contains a literal assumption of a 15-cell Ticket total or a 5-cell row length.
2. IF Winner record logic contains a literal assumption of a 15-cell Ticket total, THEN THE System SHALL update that literal to reference `TICKET_SIZE`.
3. IF Winner record logic contains a literal assumption of a 5-cell row length tied to Line_Prize row completion, THEN THE System SHALL update that literal to reference `TICKET_COLUMNS`; THIS SHALL NOT apply to the unrelated Cyber_Five "5 marks anywhere" rule, which SHALL remain the literal value 5 per Requirement 20.

### Requirement 25: Player Prize Progress UI Shows Correct Denominators

**User Story:** As a player, I want my prize progress display to show the correct targets, so that I understand how close I am to winning each prize.

#### Acceptance Criteria

1. WHEN the Player Prize Progress UI displays Cyber_Five progress, THE Player Prize Progress UI SHALL display a target denominator of 5.
2. WHEN the Player Prize Progress UI displays a Line_Prize's progress, THE Player Prize Progress UI SHALL display a target denominator of 4.
3. WHEN the Player Prize Progress UI displays Cyber_Full_House progress, THE Player Prize Progress UI SHALL display a target denominator of 12.
4. WHEN displaying a percentage for a prize's progress, THE Player Prize Progress UI SHALL compute that percentage as `round(current / target * 100)` using the prize's correct target from Criteria 1-3 (e.g. 2 of 4 marked renders as 50%, 6 of 12 marked renders as 50%).
5. IF a prize's target is zero or undefined, THEN THE Player Prize Progress UI SHALL NOT attempt to compute or display a percentage for that prize.

### Requirement 26: Host Claim Inbox Reflects New Targets

**User Story:** As a host, I want the Claim Inbox to show accurate progress and validation details, so that I can make correct decisions on player claims.

#### Acceptance Criteria

1. IF the Host Claim Inbox displays a numeric progress fraction for a Line_Prize claim, THEN THE Host Claim Inbox SHALL present that fraction against a 4/4 target.
2. IF the Host Claim Inbox displays a numeric progress fraction for a Cyber_Full_House claim, THEN THE Host Claim Inbox SHALL present that fraction against a 12/12 target.
3. THE Host Claim Inbox SHALL NOT display a 5/5 target for any Line_Prize claim.
4. THE Host Claim Inbox SHALL NOT display a 15/15 target for any Cyber_Full_House claim.

### Requirement 27: Presenter Winner Flow Audited for Stray Dimension Assumptions

**User Story:** As a host, I want the presenter's winner announcements to show correct prize details, so that the audience never sees an outdated 5/5 or 15/15 reference.

#### Acceptance Criteria

1. THE Presenter winner flow SHALL NOT display a 5/5 target for any of Firewall_Line, Security_Line, or Data_Defender_Line in any display mode (lobby, word-active, winner announcement, or final results).
2. THE Presenter winner flow SHALL NOT display a 15/15 target for Cyber_Full_House in any display mode.
3. WHEN the Presenter winner flow displays a prize's target value, THE Presenter winner flow SHALL display the value matching that prize's actual configured completion count for the active game (5 for Cyber_Five, 4 for each Line_Prize, 12 for Cyber_Full_House).

### Requirement 28: Test Fixtures and Mocks Use 12-Term Tickets

**User Story:** As a developer, I want test fixtures, mocks, and helper functions to reflect the 12-term ticket format, so that the test suite validates the real production shape.

#### Acceptance Criteria

1. WHEN a test, fixture, or mock constructs a current-format Ticket, THE System SHALL construct that Ticket with exactly 12 terms arranged in 3 rows of 4 columns, with no row containing fewer than or more than 4 cells and no ticket containing fewer than or more than 12 cells total.
2. WHEN a test helper function that builds or inspects a Ticket's row/column/cell dimensions (including but not limited to `buildTicketCells`, `buildTicketRows`, `createMockTicket`, `markFirstRow`, `markFullHouse`, `getRow`) references the ticket's row count, column count, or total cell count, THE System SHALL derive that value from the ticket-dimension constants exported by the ticket generator module (`TICKET_ROWS`, `TICKET_COLUMNS`, `TICKET_SIZE`) rather than a hardcoded 5- or 15-based literal.
3. WHEN mock or demo player ticket data representing an in-progress or winning scenario is constructed, THE System SHALL mark a number of cells consistent with that scenario under the 12-cell ticket (e.g. a Full House scenario marks all 12 cells, not 15; a single-row prize scenario marks all 4 cells of one row, not 5).
4. IF a test, fixture, mock, or helper function constructs or returns a Ticket whose total cell count is not exactly 12, or whose row lengths are not exactly 4, THEN THE System SHALL cause that test to fail, so that drift back to the legacy 15-cell shape is caught by the test suite rather than silently accepted.

### Requirement 29: Automated Test Coverage for Dimension-Sensitive Behavior

**User Story:** As a developer, I want automated tests covering every dimension-sensitive behavior, so that regressions in ticket size, row mapping, or prize targets are caught automatically.

#### Acceptance Criteria

1. THE System SHALL include a test asserting `TICKET_ROWS === 3`, `TICKET_COLUMNS === 4`, and `TICKET_SIZE === 12`.
2. THE System SHALL include a test asserting a generated Ticket has exactly 12 Cyber_Terms, exactly 4 per row, and no duplicate `termId` within the Ticket.
3. THE System SHALL include a test asserting flat cell indexes 0-3 map to row 0, indexes 4-7 map to row 1, and indexes 8-11 map to row 2.
4. THE System SHALL include a test asserting Cyber_Five reaches eligibility (`isPrizeEligible` returns true) when exactly 5 Valid_Marks exist on the Ticket.
5. THE System SHALL include a test asserting each Line_Prize reaches eligibility when all 4 Ticket_Cells in its row have Valid_Marks.
6. THE System SHALL include a test asserting Cyber_Full_House reaches eligibility when all 12 Ticket_Cells have Valid_Marks.
7. THE System SHALL include a test asserting that tapping a Ticket_Cell whose `termId` does not equal `currentTermId` results in zero new Mark records and the cell's state remaining UNMARKED.
8. THE System SHALL include a test asserting that a Ticket_Cell whose `termId` is in Call_History but not equal to `currentTermId` yields zero new Mark records when tapped.
9. THE System SHALL include a test asserting that a repeated tap on an already-MARKED Ticket_Cell results in exactly one Valid_Mark continuing to exist for that Player/Ticket/termId combination (no removal, no duplicate).
10. THE System SHALL include a test asserting that, after a simulated persistence save/hydrate cycle or simulated refresh/reconnect, a 12-cell Ticket's cells and its Valid_Marks are identical (same `termId`, `row`, `col`, and Mark associations) to their pre-cycle state.
11. THE System SHALL include a test asserting that, for Cyber_Five, every Line_Prize, and Cyber_Full_House, the frontend Prize_Progress eligibility result and the backend/authoritative Claim validation eligibility result are equal (both eligible or both not eligible) when evaluated against the same Ticket and Valid_Marks.

### Requirement 30: End-to-End Acceptance Scenario

**User Story:** As a stakeholder, I want a single end-to-end scenario that exercises the full refactored flow, so that I can confirm the feature works as a whole, not just in isolated unit tests.

#### Acceptance Criteria

1. WHEN a new game is created and a player joins, THE System SHALL issue that player a Ticket with exactly 12 Ticket_Cells arranged in 3 rows of 4, rendered with no lock icons, no visible state text labels, and no legend.
2. WHEN that player's Ticket is rendered, THE Cyber Word labels SHALL remain readable with no character-level word splitting, per Requirement 9.
3. WHEN the host calls the Current_Term and the player taps the matching Ticket_Cell, THE Ticket_Cell SHALL transition to the MARKED visual state (green background with checkmark) per Requirement 16.
4. WHEN the player taps a Ticket_Cell whose `termId` does not equal the Current_Term, THE Ticket_Cell SHALL show no visible change, per Requirement 15.
5. WHEN the host advances to a new Current_Term and the player taps a Ticket_Cell corresponding to a previously called but unmarked term, THE Ticket_Cell SHALL remain UNMARKED, per Requirement 14.
6. WHEN the player accumulates Valid_Marks across the scenario, THE System SHALL report a Line_Prize as eligible once its row reaches 4/4, Cyber_Five as eligible once 5/5 is reached, and Cyber_Full_House as eligible once 12/12 is reached.
7. WHEN the scenario simulates a page refresh after marks have been recorded, THE System SHALL restore the same 12-cell Ticket and the same set of Valid_Marks.
8. WHEN the player submits a Claim for a prize that has reached eligibility in this scenario, THE System SHALL have the host-side Authoritative_Validation accept that Claim, consistent with the displayed Prize_Progress.
9. IF the player submits a Claim for a prize that has not reached eligibility at that point in the scenario, THEN THE System SHALL have the host-side Authoritative_Validation reject that Claim.
10. THE scenario in Criteria 1-9 SHALL be exercised in a single continuous test session covering Requirements 8, 10-16, 20-23, and 5, so that it validates the integrated behavior rather than relying solely on isolated unit tests.

### Requirement 31: No Remaining Old-Dimension Assumptions

**User Story:** As a developer, I want a final regression check confirming no stale 15-cell/5-column assumptions remain, so that the refactor is complete and consistent.

#### Acceptance Criteria

1. THE System SHALL contain, within the project's source and test directories (excluding `node_modules`, `dist`, and other generated/build output), no usage of `repeat(5`, a Line_Prize or Cyber_Five target literal of 15, a Ticket length check of 15, `Array(15)`, or `% 5` / `/ 5` / `* 5` arithmetic, in any code path listed in Requirement 1 (ticket generation, domain types/row-column math, prize/claim engines, persistence/sync, Player Ticket UI, or test fixtures/mocks) where that literal represents a ticket row count, column count, or cell count.
2. IF a literal matching one of the patterns in Requirement 31.1 is found in a code path listed in Requirement 1 but represents a ticket row count, column count, or cell count other than through `TICKET_ROWS`, `TICKET_COLUMNS`, or `TICKET_SIZE`, THEN THE System SHALL replace that literal with the corresponding Ticket_Dimension_Constant.
3. IF a literal matching one of the patterns in Requirement 31.1 is found outside the code paths listed in Requirement 1, or within one of those code paths but representing a quantity other than a ticket row count, column count, or cell count (e.g. an unrelated numeric value that happens to equal 5 or 15), THEN THE System SHALL leave that literal unchanged and SHALL add a code comment at that location stating that the literal is unrelated to ticket dimensions.
4. THE System SHALL include a repeatable automated search (e.g. a test or lint-style script) over the project's source and test directories that reports every remaining occurrence of the patterns in Requirement 31.1, so that this regression check can be re-run on demand.

### Requirement 32: Documentation Reflects the New Ticket Model

**User Story:** As a developer, I want code comments and documentation to describe the current ticket model, so that future readers are not misled by outdated references.

#### Acceptance Criteria

1. WHERE a code comment or documentation block describes the Ticket as 15-word, as a 3x5 grid, as having 5-cell rows, or as requiring 15/15 for Cyber_Full_House, THE System SHALL update that comment or documentation block to describe the Ticket as 12-word, as a 3x4 grid, as having 4-cell rows, and as requiring 12/12 for Cyber_Full_House.
2. THE System SHALL apply Criterion 1 to, at minimum, the documentation comments in `src/types/ticket.ts`, `src/utils/ticketGenerator.ts`, and `src/utils/prizeEngine.ts` identified during this refactor as containing outdated dimension references.
