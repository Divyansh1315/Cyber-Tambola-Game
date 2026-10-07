# Implementation Plan: Ticket 3x4 Dimension Refactor

## Overview

This plan implements the refactor in dependency order: first the shared dimension
constants and legacy-ticket detection helper in `ticketGenerator.ts` (the single
source of truth every other module imports from), then the row/col math and type
documentation that consume those constants, then the pure prize/validation engine
(`prizeEngine.ts`) and `deriveCellState.ts`, then the UI layer (`TicketCell.tsx`,
`Ticket.css`, `PlayerGame.tsx`) that consumes the updated engine, then persistence
hydration validation, then the Requirement 31 regression scan, then the full
property-test and unit/example-test suite from the design's Testing Strategy, then
a sweep of pre-existing fixtures/mocks elsewhere in the codebase that still hardcode
the old 15-cell/5-column shape, and finally a full verification pass.

The project already has Vitest, @testing-library/react, @testing-library/user-event,
@testing-library/jest-dom, and fast-check installed and wired from prior modules — no
test tooling setup is needed here. Test invocation uses the single-run form
(`vitest run` / `npm test`), never watch mode. Property-based tests reference the 18
correctness properties in `design.md` and tag each test with the feature name and
property number, consistent with prior specs' convention.

## Tasks

- [x] 1. Introduce renamed dimension constants and legacy-ticket detection
  - [x] 1.1 Update `src/utils/ticketGenerator.ts` constants
    - Replace `TICKET_COLS = 5` with `export const TICKET_COLUMNS = 4`
    - Compute `export const TICKET_SIZE = TICKET_ROWS * TICKET_COLUMNS` (12) instead of a hardcoded `15`
    - Add `export function isLegacyTicket(ticket: Ticket): boolean` returning true when `ticket.rows.length !== TICKET_ROWS` or any row's length `!== TICKET_COLUMNS`
    - _Requirements: 1.1, 1.2, 1.3, 7.5_

  - [x] 1.2 Update all importers of the old `TICKET_COLS` name
    - Update `src/utils/ticketGenerator.test.ts` and any other consumer to import `TICKET_COLUMNS` instead of `TICKET_COLS`
    - _Requirements: 1.3_

- [x] 2. Update row/col math and domain type documentation
  - [x] 2.1 Update `generateTicket`'s row/col assignment in `src/utils/ticketGenerator.ts`
    - Compute `row = Math.floor(index / TICKET_COLUMNS)` and `col = index % TICKET_COLUMNS` instead of using the old `TICKET_COLS`-based divisor/modulus
    - Confirm `getActiveTerms`, `computeSignature`, `shuffle`, and the retry loop need no further changes beyond the constants already updated in task 1.1
    - Add the insufficient-active-terms guard referencing `TICKET_SIZE` (12) if not already present
    - _Requirements: 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 4.1, 4.2_

  - [x] 2.2 Update `src/types/ticket.ts` documentation and range comments
    - Update `Ticket`'s doc comment to describe a 3-row by 4-column grid of 12 Cyber_Terms
    - Update `TicketCell.row`/`col` comments to state ranges 0-2 and 0-3 respectively
    - _Requirements: 1.4, 3.1, 3.2, 3.4, 32.1, 32.2_

  - [x]* 2.3 Write property tests for ticket generation shape and signature
    - File `src/utils/ticketGenerator.test.ts` (updated: `TICKET_COLS` → `TICKET_COLUMNS`, `15` → `12` throughout); tag `// Feature: ticket-3x4-dimension-refactor, Property {n}: {title}`; ≥100 iterations
    - **Property 1: Insufficient active terms always rejects generation, exactly at the TICKET_SIZE boundary** — Validates Requirements 1.5, 2.6
    - **Property 2: Generated ticket shape invariants** — Validates Requirements 2.1, 2.2, 3.1, 3.4, 4.1, 4.2
    - **Property 3: Signature collision forces a throw, never a duplicate** — Validates Requirements 2.4, 2.5, 6.4, 6.5
    - **Property 4: Ticket signature is canonical and order-independent over 12 ids** — Validates Requirements 6.1, 6.2, 6.3
    - _Requirements: 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.4, 4.1, 4.2, 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 3. Checkpoint — ticket generation and types pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Update the pure prize/validation engine
  - [x] 4.1 Update `PRIZES` targets in `src/utils/prizeEngine.ts`
    - Import `TICKET_COLUMNS`, `TICKET_SIZE` from `ticketGenerator.ts`
    - Change `FIREWALL_LINE`/`SECURITY_LINE`/`DATA_DEFENDER_LINE` targets from `5` to `TICKET_COLUMNS`, and `CYBER_FULL_HOUSE`'s target from `15` to `TICKET_SIZE`
    - Leave `CYBER_FIVE`'s target as the literal `5` unchanged
    - _Requirements: 20.1, 20.2, 20.3, 21.1, 21.3, 22.1, 22.3, 24.2, 24.3_

  - [x] 4.2 Make `getLineProgress`/`getFullHouseProgress` derive dimensions from the ticket's own shape
    - `getLineProgress`: compute `target = rowCells.length || TICKET_COLUMNS` from `ticket.rows[row]`, so a legacy 3x5 ticket still reports a 5-cell row target
    - `getFullHouseProgress`: compute `target = ticketTermIds.length || TICKET_SIZE` from `ticket.rows.flat()`, so a legacy 15-cell ticket still reports a 15-cell target
    - _Requirements: 4.3, 7.3, 21.1, 21.2, 22.1, 22.2, 23.4_

  - [x] 4.3 Replace `TERM_NOT_REVEALED` with `TERM_NOT_CURRENT` in `validateMarkAttempt`
    - Rename the `MarkValidationResult` reason from `'TERM_NOT_REVEALED'` to `'TERM_NOT_CURRENT'`
    - Change gate 4's check from `!state.game.revealedTermIds.includes(termId)` to `termId !== state.game.currentTermId`
    - Keep gate order and every other gate unchanged; do not read `revealedTermIds` anywhere else in this function
    - _Requirements: 14.1, 14.2, 14.3, 17.1, 17.2, 17.3, 18.1, 18.2, 19.1, 19.2_

  - [x]* 4.4 Write property tests for prize targets and mark validation
    - Files `src/utils/prizeEngine.test.ts` (new or extended) and `src/utils/prizeEngine.markValidation.test.ts` (new); tag `// Feature: ticket-3x4-dimension-refactor, Property {n}: {title}`; ≥100 iterations
    - **Property 10: Only the current term is newly markable** — Validates Requirements 14.1, 14.2, 19.1, 19.2
    - **Property 11: Tapping a non-current cell is a strict, idempotent no-op** — Validates Requirements 15.1, 15.2, 15.3
    - **Property 12: Marks are permanent under repeated taps** — Validates Requirements 16.1, 16.2, 17.4
    - **Property 13: Validation gate ordering is total and deterministic** — Validates Requirements 17.1, 17.2
    - **Property 14: Cyber Five is unchanged by the dimension refactor** — Validates Requirements 20.1, 20.2, 20.3
    - **Property 15: Line prizes require exactly 4 marks in their row** — Validates Requirements 21.1, 21.2, 21.3
    - **Property 16: Cyber Full House requires exactly 12 marks** — Validates Requirements 22.1, 22.2, 22.3
    - _Requirements: 14.1, 14.2, 15.1, 15.2, 15.3, 16.1, 16.2, 17.1, 17.2, 17.4, 19.1, 19.2, 20.1, 20.2, 20.3, 21.1, 21.2, 21.3, 22.1, 22.2, 22.3_

  - [x]* 4.5 Write property test for claim engine / prize engine agreement
    - File `src/utils/claimEngine.test.ts` (new or extended); tag `// Feature: ticket-3x4-dimension-refactor, Property 17: {title}`; ≥100 iterations
    - **Property 17: Claim engine eligibility always agrees with prize engine eligibility** — Validates Requirements 23.1, 23.2, 23.3, 23.4, 23.5
    - Confirm `claimEngine.ts` requires no production code change (per design) — this task is test-only unless the test surfaces a real gap
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5_

- [x] 5. Update `deriveCellState` to the current-term rule
  - [x] 5.1 Update `src/utils/deriveCellState.ts`
    - Change the second parameter from `revealedTermIds: readonly string[]` to `currentTermId: string | undefined`
    - Check `markedTermIds.has(termId)` first (returns `MARKED`), then return `'AVAILABLE'` if `termId === currentTermId`, else `'LOCKED'`
    - Keep the three-value return type (`LOCKED`/`AVAILABLE`/`MARKED`) unchanged
    - _Requirements: 13.5, 14.1, 14.3, 16.1_

  - [x]* 5.2 Write property test for cell-state derivation under the current-term rule
    - File `src/utils/deriveCellState.test.ts` (updated); tag `// Feature: ticket-3x4-dimension-refactor, Property {n}: {title}`; ≥100 iterations
    - Covered jointly by Property 10 (current-term-only marking) and the MARKED-takes-priority assertion already implied by Property 12
    - _Requirements: 13.5, 14.1, 14.3, 16.1_

- [x] 6. Checkpoint — prize/validation engine passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Update the Ticket Cell component and its styles
  - [x] 7.1 Update `src/components/player/TicketCell.tsx`
    - Delete the lock-icon markup entirely for unmarked states (no icon span renders unless `isMarked`)
    - Delete the visible state-text span (`ticket-cell__state`); keep `meta.hint` used only inside `aria-label`
    - Remove `disabled={isLocked}` so unmarked cells remain tappable regardless of internal state
    - Collapse `className` to exactly `ticket-cell--marked` / `ticket-cell--unmarked` (two variants, not three)
    - Unify `STATE_META.LOCKED.hint` and `STATE_META.AVAILABLE.hint` to the single string `'Tap to mark when called'`
    - Keep `aria-pressed={isMarked}` and `aria-label` recomputed from props on every render
    - _Requirements: 10.1, 10.2, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 13.1, 13.2, 13.3, 13.4, 13.5_

  - [x] 7.2 Update `src/components/player/Ticket.css`
    - Change `.ticket-grid__row`'s `grid-template-columns` from `repeat(5, 1fr)` to `repeat(4, 1fr)`
    - Replace `.ticket-cell__term`'s fixed font-size (and any now-redundant `≥480px` media-query override) with `font-size: clamp(0.68rem, 2.6vw, 0.95rem)`
    - Remove `hyphens: auto`; set `overflow-wrap: break-word` and `word-break: normal` so wrapping only occurs at spaces
    - Delete `.ticket-cell--locked`/`.ticket-cell--available` rules; add one `.ticket-cell--unmarked` rule using the current `--available` colors; delete `.ticket-cell__state`
    - Do not add a new max-width rule; keep the ticket grid inside its existing `Card` container
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 13.1_

  - [x]* 7.3 Write property tests and example tests for `TicketCell`
    - File `src/components/player/TicketCell.test.tsx` (new); tag `// Feature: ticket-3x4-dimension-refactor, Property {n}: {title}`; ≥100 iterations
    - **Property 7: Unmarked cells never render a lock icon or state text, regardless of internal state** — Validates Requirements 10.1, 10.2, 11.1
    - **Property 8: LOCKED and AVAILABLE are visually and semantically identical** — Validates Requirements 13.1, 13.4, 13.5
    - **Property 9: Accessible state attributes always reflect the current state** — Validates Requirements 11.5, 11.6
    - _Requirements: 10.1, 10.2, 11.1, 11.5, 11.6, 13.1, 13.4, 13.5_

- [x] 8. Update the Player Game screen
  - [x] 8.1 Update `src/pages/PlayerGame/PlayerGame.tsx`
    - Delete the `<ul className="player__legend" aria-label="Ticket cell states">...</ul>` block and any CSS/markup that exists solely to space it from the ticket grid
    - Change `handleTap`'s rule: compute `isCurrent = termId === game.currentTermId` (not `revealedTermIds.includes`); if already marked, no-op; if not current, silent no-op (no dispatch, no hint); otherwise dispatch `MARK_TERM` via `canMarkTerm`
    - Remove the `lockedHint` state, its setter calls, and the `player__locked-hint` status paragraph entirely
    - Update the ticket-rendering `deriveCellState` call site to pass `game.currentTermId` instead of `game.revealedTermIds`
    - _Requirements: 12.1, 12.2, 12.3, 14.1, 14.2, 14.3, 15.1, 15.2, 15.3, 16.1, 16.2_

  - [x]* 8.2 Write example tests for legend removal and non-current-tap no-op
    - Render `PlayerGame` and assert `queryByLabelText('Ticket cell states')` (or equivalent role query) returns `null` (Req 12.1, 12.2)
    - Render `PlayerGame`, tap a non-current cell, and assert no `role="status"` element appears and no Mark is dispatched (Req 15.2)
    - _Requirements: 12.1, 12.2, 15.1, 15.2_

  - [x]* 8.3 Write example test for ticket grid DOM structure
    - File `src/components/player/Ticket.test.tsx` (new or extended); render `Ticket` with a 3x4 fixture and assert exactly 3 `role="row"` elements each containing exactly 4 `role="gridcell"` elements
    - _Requirements: 8.1, 8.3_

- [x] 9. Checkpoint — UI layer passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Add persistence hydration shape validation
  - [x] 10.1 Add `isValidTicketShape` to `src/state/persistence.ts`
    - Validate `ticket.rows` is an array and matches either the current 3x4 shape (3 rows of 4) or the legacy 3x5 shape (3 rows of 5); reject anything else
    - Call it from `parseEnvelope` alongside existing `Array.isArray` checks on `envelope.tickets`; return `null` (fall back to seed state) if any ticket fails
    - _Requirements: 5.4, 7.2_

  - [x]* 10.2 Write property tests for persistence round-trip and malformed-shape rejection
    - File `src/state/persistence.test.ts` (updated fixtures to 3x4) and `src/state/persistence.ticketShape.test.ts` (new); tag `// Feature: ticket-3x4-dimension-refactor, Property {n}: {title}`; ≥100 iterations
    - **Property 5: Persistence round-trips a 12-cell ticket and its marks unchanged** — Validates Requirements 5.1, 5.2, 5.3, 16.3
    - **Property 6: Malformed ticket shape is rejected at hydration, never silently accepted** — Validates Requirements 5.4
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 16.3_

- [x] 11. Add the Requirement 31 regression scan
  - [x] 11.1 Create `src/regressionScan.dimensionLiterals.test.ts`
    - Walk `src/` (excluding `node_modules`, `dist`, `.git`) over `.ts`/`.tsx` files, scanning each line against the patterns `repeat(5`, `target:\s*15`, `.length\s*===?\s*15`, `Array(15)`, `%\s*5`, `/\s*5`, `*\s*5`
    - Skip any line containing the `not-a-ticket-dimension` allowlist comment
    - Assert zero un-allowlisted matches remain; this test runs as part of `npm test`
    - _Requirements: 31.1, 31.4_

  - [x] 11.2 Allowlist genuinely unrelated literals found by the scan
    - For any un-allowlisted match found that represents a ticket row/column/cell count, replace it with the corresponding `TICKET_ROWS`/`TICKET_COLUMNS`/`TICKET_SIZE` constant
    - For any match that is unrelated to ticket dimensions (e.g. Cyber Five's literal `target: 5`), add a trailing `// not-a-ticket-dimension` comment at that line
    - _Requirements: 31.2, 31.3_

- [x] 12. Checkpoint — persistence and regression scan pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Write remaining property tests
  - [x]* 13.1 Write property test for prize progress percentage rendering
    - File `src/components/player/PrizeProgressList.test.tsx` (new); tag `// Feature: ticket-3x4-dimension-refactor, Property 18: {title}`; ≥100 iterations
    - **Property 18: Prize progress percentage rendering matches round(current/target*100), and is skipped for a zero/undefined target** — Validates Requirements 25.4, 25.5
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5_

- [x] 14. Write unit/example tests for dimension constants, legacy preservation, and the end-to-end scenario
  - [x]* 14.1 Write dimension-constants and row-index-mapping example tests
    - Assert `TICKET_ROWS === 3`, `TICKET_COLUMNS === 4`, `TICKET_SIZE === 12`
    - Assert flat indexes 0-3 map to row 0, 4-7 map to row 1, and 8-11 map to row 2
    - _Requirements: 29.1, 29.2, 29.3_

  - [x]* 14.2 Write legacy-ticket preservation example tests
    - Assert a fixture 15-cell `Ticket` passed through `isLegacyTicket` returns `true`; a 12-cell ticket returns `false`
    - Assert a legacy ticket round-tripped through persistence is unchanged, and an existing `Winner`/`PrizeClaim` fixture is untouched after an unrelated reducer action runs
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 24.1_

  - [x]* 14.3 Write Cyber Five / Line Prize / Cyber Full House eligibility example tests
    - Assert `isPrizeEligible` returns `true` when exactly 5 Valid_Marks exist anywhere on the ticket (Cyber Five)
    - Assert each Line_Prize reaches eligibility when all 4 cells in its row have Valid_Marks
    - Assert Cyber_Full_House reaches eligibility when all 12 cells have Valid_Marks
    - _Requirements: 29.4, 29.5, 29.6_

  - [x]* 14.4 Write non-current-tap and repeated-tap-on-marked example tests
    - Assert tapping a cell whose `termId` is not `currentTermId` yields zero new Mark records and the cell stays UNMARKED
    - Assert a cell whose `termId` is in Call_History but not equal to `currentTermId` yields zero new Mark records when tapped
    - Assert a repeated tap on an already-MARKED cell results in exactly one Valid_Mark continuing to exist (no removal, no duplicate)
    - _Requirements: 29.7, 29.8, 29.9_

  - [x]* 14.5 Write persistence-cycle and frontend/backend-agreement example tests
    - Assert a simulated save/hydrate cycle (or refresh/reconnect) leaves a 12-cell ticket's cells and Valid_Marks identical to their pre-cycle state
    - Assert frontend `Prize_Progress` eligibility and backend/authoritative claim validation eligibility agree for Cyber Five, every Line_Prize, and Cyber_Full_House against the same ticket/marks
    - _Requirements: 29.10, 29.11_

  - [x]* 14.6 Write the end-to-end acceptance scenario test (Requirement 30)
    - File `src/pages/PlayerGame/PlayerGame.endToEnd3x4.test.tsx` (or a reducer-level equivalent): create a game, join a player, receive a 12-cell ticket with no lock icons/state text/legend, call terms, tap the current term to mark it, tap a non-current term (no-op), advance through enough calls to reach each prize's new target (4, 5, 12), submit claims, assert host-side validation accepts eligible claims and rejects ineligible ones, then simulate a refresh and assert the ticket/marks are restored
    - Compose this test from existing reducer actions and `validateMarkAttempt`/`validatePrizeClaim`; no new production code
    - _Requirements: 30.1, 30.2, 30.3, 30.4, 30.5, 30.6, 30.7, 30.8, 30.9, 30.10_

- [x] 15. Checkpoint — full test suite passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Update pre-existing fixtures and mocks to the 12-cell shape
  - [x] 16.1 Update test helper functions that build/inspect ticket dimensions
    - Update `buildTicketCells`, `buildTicketRows`, `createMockTicket`, `markFirstRow`, `markFullHouse`, `getRow`, and any other helper hardcoding a column count of 5 or a size of 15, to derive those values from `TICKET_ROWS`/`TICKET_COLUMNS`/`TICKET_SIZE`
    - _Requirements: 28.1, 28.2_

  - [x] 16.2 Update mock/demo player ticket data for in-progress and winning scenarios
    - Update any Full House demo/mock scenario to mark all 12 cells (not 15), and any single-row prize scenario to mark all 4 cells of one row (not 5)
    - _Requirements: 28.3_

  - [x]* 16.3 Write a failing-by-construction guard test for fixture drift
    - Assert that any test, fixture, mock, or helper constructing a Ticket whose total cell count is not exactly 12, or whose row lengths are not exactly 4, causes a test failure
    - _Requirements: 28.4_

- [x] 17. Final verification pass
  - Run the full test suite (`npm test` / `vitest run`) and confirm all tests pass
  - Run the Requirement 31 regression scan test specifically and confirm zero un-allowlisted matches
  - Run the production build (`npm run build`) and confirm zero TypeScript errors
  - Manually sweep CSS files and any non-`.ts`/`.tsx` source for remaining `repeat(5`, 15-cell, or 5-column dimension literals that the regression scan (task 11) does not cover, since that scan is scoped to `.ts`/`.tsx` files only
  - Ask the user if questions arise
  - _Requirements: 31.1, 31.4_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses for traceability.
- Checkpoints (tasks 3, 6, 9, 12, 15) ensure incremental validation as generation, the prize/validation engine, the UI layer, persistence, and the full test suite come together.
- Property tests validate the 18 universal correctness properties from `design.md`; each test is tagged `// Feature: ticket-3x4-dimension-refactor, Property {n}: {title}` and runs ≥100 iterations.
- `getLineProgress`/`getFullHouseProgress` derive their targets from the ticket's own shape (task 4.2), not from the imported constants directly — this is what makes legacy 15-cell tickets continue to report correct 5/15 targets with zero branching on `isLegacyTicket` inside the engine itself.
- `isLegacyTicket` (task 1.1) is only consulted at the ticket-generation/join boundary to decide what shape of ticket to hand a session next; it is not threaded through the prize/claim engines.
- Per design.md's documented gap: Requirement 18 (Supabase RPC parity) and the backend half of Requirement 19 have no implementable or testable surface in this repository (no SQL/RPC source exists) and are intentionally not covered by any task above.
- Per design.md: Requirements 26 and 27 (Host Claim Inbox / Presenter numeric target display) are confirmed currently vacuous — neither component renders a numeric prize-target fraction today — and are intentionally not covered by any task above.
- Visual/CSS rendering behavior (clamp bounds, actual viewport layout) is not covered by automated tests per design.md, since no layout engine runs in this project's vitest/jsdom setup; task 7.2's CSS changes are verified structurally (DOM/class assertions) and via task 17's manual sweep.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2", "4.1"] },
    { "id": 3, "tasks": ["2.3", "4.2", "5.1"] },
    { "id": 4, "tasks": ["4.3", "5.2"] },
    { "id": 5, "tasks": ["4.4", "4.5"] },
    { "id": 6, "tasks": ["7.1"] },
    { "id": 7, "tasks": ["7.2", "8.1"] },
    { "id": 8, "tasks": ["7.3", "8.2", "8.3"] },
    { "id": 9, "tasks": ["10.1"] },
    { "id": 10, "tasks": ["10.2", "11.1"] },
    { "id": 11, "tasks": ["11.2"] },
    { "id": 12, "tasks": ["13.1", "14.1", "14.2", "14.3", "14.4", "14.5", "14.6"] },
    { "id": 13, "tasks": ["16.1"] },
    { "id": 14, "tasks": ["16.2"] },
    { "id": 15, "tasks": ["16.3"] }
  ]
}
```
