# Implementation Plan: Module 4 — Term Marking & Prize Engine

## Overview

This plan implements Module 4 in dependency order: the `Mark` domain type, then the
pure prize engine and mark-validation pipeline (`src/utils/prizeEngine.ts`), then the
updated `deriveCellState` signature, then the reducer's `MARK_TERM` action and sync
payload extension, then the initial-state seed, then persistence, then the context's
derived selectors, then UI rewiring on `PlayerGame`, then the free `HostDashboard`
reset verification, then cross-cutting integration tests, and finally a full build and
manual Test A–H walkthrough.

The project already has Vitest, @testing-library/react, @testing-library/user-event,
@testing-library/jest-dom, and fast-check installed and wired from Module 3 (task 1) —
no test tooling setup is needed here. Test invocation uses the single-run form
(`vitest run` / `npm test`), never watch mode. Property-based tests reference the 11
correctness properties in `design.md` and tag each test with the feature name and
property number, exactly per Module 3's convention.

## Tasks

- [x] 1. Add the `Mark` domain type
  - [x] 1.1 Create `src/types/mark.ts`
    - Define and export the `Mark` interface: `id`, `gameId`, `playerId`, `ticketId`, `termId`, `markedAt` (ISO string), `valid` (boolean)
    - _Requirements: 1.1_

- [x] 2. Implement the pure prize engine and mark-validation pipeline
  - [x] 2.1 Implement `src/utils/prizeEngine.ts` — mark filtering and prize formulas
    - Export `PRIZES: readonly Prize[]` with the 5 fixed `{id, label, target}` entries in order (`CYBER_FIVE`/5, `FIREWALL_LINE`/5, `SECURITY_LINE`/5, `DATA_DEFENDER_LINE`/5, `CYBER_FULL_HOUSE`/15)
    - Implement `getPlayerTicketMarks(marks, playerId, ticketId)` filtering to one player's Valid_Marks for one ticket, never mutating `marks`
    - Implement `getMarkedTermIds(validMarks)` returning the distinct `Set<string>` of termIds across `valid: true` marks only
    - Implement `getCyberFiveProgress(ticket, validMarks)`: `current = min(markedCount, 5)`, `target = 5`, counting marks regardless of row
    - Implement `getLineProgress(ticket, validMarks, row, prizeId, label)`: `current` = count of marked termIds whose cell is in `row`, `target = 5`
    - Implement `getFullHouseProgress(ticket, validMarks)`: `current` = full marked-count, `target = 15`
    - Implement `getAllPrizeProgress(ticket, validMarks)` returning all 5 `PrizeProgress` entries in `PRIZES` order, calling `getLineProgress` three times via a `LINE_PRIZE_ROWS` map, with no exclusion between prizes
    - Implement `isPrizeEligible(progress)` returning `current >= target`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.2, 10.3, 11.1, 11.2_

  - [x]* 2.2 Write property tests for prize formulas
    - File `src/utils/prizeEngine.cyberFive.test.ts`, `prizeEngine.lineProgress.test.ts`, `prizeEngine.fullHouse.test.ts`, `prizeEngine.nonExclusivity.test.ts`; tag each `// Feature: module-4-term-marking-prize-engine, Property {n}: {title}`; ≥100 iterations
    - **Property 5: Cyber Five progress counts any 5 marked terms regardless of row** — Validates Requirements 8.1, 8.2, 8.3, 8.4
    - **Property 6: Each Line_Prize counts only its own row** (parameterized over the 3 rows/Prize_Ids) — Validates Requirements 9.1, 9.2, 9.3, 9.4, 9.5
    - **Property 7: Cyber Full House tracks every marked term on the ticket** — Validates Requirements 10.1, 10.2, 10.3
    - **Property 8: A single marked term contributes to every prize it qualifies for, without exclusion** — Validates Requirements 11.1, 11.2
    - Use a ticket generator producing valid 3x5 tickets with 15 distinct termIds and a marks generator producing random marked-termId subsets of a given ticket
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.2, 10.3, 11.1, 11.2_

  - [x] 2.3 Implement `validateMarkAttempt` and `canMarkTerm`
    - Export `MarkValidationResult` union with reasons `NO_CURRENT_PLAYER`, `TICKET_NOT_FOUND`, `TERM_NOT_ON_TICKET`, `TERM_NOT_REVEALED`, `GAME_COMPLETED`, `DUPLICATE_MARK`
    - Implement `validateMarkAttempt(state, termId)` running the six gates in order: no player matches `currentPlayerId`; current player's `ticketId` matches no Ticket; `termId` not on that Ticket's cells; `termId` not in `game.revealedTermIds`; `game.status === 'COMPLETED'`; an existing Valid_Mark already has the same `playerId`/`ticketId`/`termId`
    - Implement `canMarkTerm(state, termId)` as a boolean wrapper over `validateMarkAttempt`
    - Never mutate `state` or any of its collections
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x]* 2.4 Write property test for mark validation gates and accepted-branch shape
    - File `src/utils/prizeEngine.validateMarkAttempt.test.ts`; tag `// Feature: module-4-term-marking-prize-engine, Property {n}: {title}`; ≥100 iterations
    - **Property 1: Invalid mark attempts are always rejected without side effects** — Validates Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.4, 13.1, 13.2, 14.1, 14.2, 14.3
    - Use a state-fixture generator that independently toggles each of the six validation gates (missing player, missing ticket, off-ticket term, unrevealed term, `COMPLETED` status, pre-existing duplicate mark) plus a fully-valid baseline fixture
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

- [x] 3. Update `deriveCellState` to derive from Marked_Term_Ids
  - [x] 3.1 Update `src/utils/deriveCellState.ts`
    - Change the signature from `(termId, revealedTermIds, marked: boolean)` to `(termId, revealedTermIds, markedTermIds: ReadonlySet<string>)`
    - `LOCKED` when `termId` absent from `revealedTermIds`; `AVAILABLE` when present and `markedTermIds` does not have `termId`; `MARKED` when present and `markedTermIds` has `termId`
    - Remain a pure lookup with no Session_Store access; never mutate inputs
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [-]* 3.2 Write property test for cell-state derivation
    - File `src/utils/deriveCellState.test.ts`; tag `// Feature: module-4-term-marking-prize-engine, Property {n}: {title}`; ≥100 iterations; metamorphic over changing `revealedTermIds` and `markedTermIds`
    - **Property 4: Cell state is derived solely from reveal history and valid marks** — Validates Requirements 4.1, 4.2, 4.3
    - _Requirements: 4.1, 4.2, 4.3_

- [x] 4. Extend the reducer with `MARK_TERM` and sync-payload marks support
  - [x] 4.1 Add the `MARK_TERM` action and case to `src/state/gameSessionReducer.ts`
    - Add `{ type: 'MARK_TERM'; termId: string }` to the `GameSessionAction` union
    - `MARK_TERM` case: call `validateMarkAttempt(state, action.termId)`; if invalid, `return state` unchanged (same reference); if valid, build a new `Mark` (`id` via the existing `localId()` from `joinService.ts`, `gameId: state.game.id`, `playerId`/`ticketId` from the current player, `termId: action.termId`, `markedAt: now()`, `valid: true`) and return `{ ...state, marks: [...state.marks, newMark] }`
    - Keep the reducer pure: no `localStorage`/`BroadcastChannel` access inside the `MARK_TERM` case
    - _Requirements: 2.8, 3.1, 3.2, 3.3, 3.4_

  - [x] 4.2 Extend `SyncPayload` and `isValidSyncPayload` with `marks`
    - Add `marks: Mark[]` to the `SyncPayload` interface
    - `isValidSyncPayload` continues to NOT require `marks` in its shape check (unchanged gate on `game`/`players`/`tickets`)
    - In the `SYNC_STATE` case, normalize incoming `marks` via `Array.isArray(action.payload.marks) ? action.payload.marks : []` before applying to state
    - _Requirements: 6.1, 6.2, 6.3_

  - [x]* 4.3 Write property tests for reducer purity, sync, and reset
    - File `src/state/gameSessionReducer.markTerm.test.ts`, `gameSessionReducer.syncState.marks.test.ts`, `gameSessionReducer.reset.test.ts`; tag `// Feature: module-4-term-marking-prize-engine, Property {n}: {title}`; ≥100 iterations; deep-freeze input state to enforce purity
    - **Property 2: A valid mark attempt creates exactly one well-formed Mark** — Validates Requirements 2.8, 3.3
    - **Property 3: The reducer's MARK_TERM handling is pure** — Validates Requirements 3.2
    - **Property 10: Cross-tab sync includes, applies, and safely defaults marks** — Validates Requirements 6.1, 6.2, 6.3
    - **Property 11: RESET_GAME clears marks along with the rest of the session** — Validates Requirements 17.1, 17.2, 17.3
    - _Requirements: 2.8, 3.2, 3.3, 6.1, 6.2, 6.3, 17.1, 17.2, 17.3_

- [x] 5. Seed `marks` in initial state
  - [x] 5.1 Update `src/state/gameSessionInitialState.ts`
    - Add `marks: Mark[]` to `GameSessionState`, seeded to `[]`
    - Leave `prizeProgress`/`claims`/`winners` seeding unchanged
    - _Requirements: 1.2, 1.4_

  - [x]* 5.2 Write unit test for seeded empty marks
    - Assert `gameSessionInitialState.marks` is `[]` and `PRIZES` contains exactly the 5 expected `{id, label, target}` entries in the documented order
    - _Requirements: 1.4, 7.4_

- [x] 6. Checkpoint — pure logic and reducer pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Extend persistence to cover `marks`
  - [x] 7.1 Update `src/state/persistence.ts`
    - Add `marks: Mark[]` to `PersistedEnvelope` and `PersistedSlice`
    - `toEnvelope` copies `slice.marks` through unchanged
    - `parseEnvelope`: default restored `marks` to `[]` when the field is missing, `null`, or not an array (including legacy Module 3 envelopes with no `marks` key at all), without rejecting the rest of an otherwise-valid envelope; keep `PERSIST_VERSION` at `2`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [-]* 7.2 Write property test for marks persistence round-trip and fail-safe defaulting
    - File `src/state/persistence.marks.test.ts`; tag `// Feature: module-4-term-marking-prize-engine, Property {n}: {title}`; ≥100 iterations
    - **Property 9: Persistence round-trips marks and defaults missing/invalid marks safely** — Validates Requirements 5.1, 5.2, 5.3, 5.4, 5.5
    - Reuse Module 3's malformed-envelope generators, extended with variants that omit `marks`, set it to `null`, or set it to a non-array value
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 8. Wire marks and derived prize selectors into the context provider
  - [x] 8.1 Update `src/state/GameSessionContext.tsx`
    - `initState()`'s restored-slice merge adds `marks: restored.marks`
    - The persistence `useEffect`'s slice object adds `marks: state.marks`; add `state.marks` to its dependency array
    - The sync broadcast payload adds `marks: state.marks`
    - Add `currentPlayerMarks: Mark[]` to the context value, computed via `getPlayerTicketMarks(state.marks, currentPlayer.id, currentTicket.id)` when both exist, else `[]`
    - Add `currentPrizeProgress: PrizeProgress[]` to the context value, computed via `getAllPrizeProgress(currentTicket, currentPlayerMarks)` when `currentTicket` exists, else `[]`
    - _Requirements: 5.1, 6.1, 7.2, 7.4, 15.1_

- [x] 9. Checkpoint — state and persistence integrate
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Rewire the Player Game screen to real marks and prize progress
  - [x] 10.1 Update `src/pages/PlayerGame/PlayerGame.tsx`
    - Remove the local `marked` `useState<Set<string>>` entirely
    - Compute `markedTermIds = getMarkedTermIds(currentPlayerMarks)` from context once per render; pass it into every cell's `deriveCellState(cell.termId, game.revealedTermIds, markedTermIds)`
    - Replace the tap handler: `LOCKED` → do not dispatch, set `lockedHint` to a message such as `"{term} has not been revealed yet."`; `MARKED` → do not dispatch anything (explicit no-op); `AVAILABLE` → `dispatch({ type: 'MARK_TERM', termId })`
    - Replace the Prize Progress panel's data source with `currentPrizeProgress` from context instead of `state.prizeProgress`
    - Compute Cyber Five eligibility via `currentPrizeProgress.find(p => p.id === 'CYBER_FIVE')` and `isPrizeEligible`
    - Implement `cyberFiveMessage(progress)` returning the exact strings: `'Mark revealed terms to become eligible for prizes.'` (no progress yet), `'Mark 2 more valid terms to become eligible for Cyber Five.'` (remaining === 2), `'Mark 1 more valid term to become eligible for Cyber Five.'` (remaining === 1), `'🎉 Cyber Five Ready!'` (remaining <= 0), and a generalized plural fallback for other remaining counts
    - Enable the Claim control and show `"Prize ready — claim available"` / `"🎉 Cyber Five Ready!"` + `"Claim Cyber Five"` labeling only when `isPrizeEligible(cyberFive)`; do not persist any claim/winner record
    - _Requirements: 4.4, 4.5, 12.1, 12.2, 12.3, 12.4, 13.1, 13.2, 14.1, 14.2, 14.3, 15.1, 15.2, 15.3, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6_

  - [x]* 10.2 Write component tests for PlayerGame marking and prize display
    - Tapping an `AVAILABLE` cell dispatches `MARK_TERM` and the cell re-renders as `MARKED` with its checkmark/"Marked" label, without a page reload
    - Tapping a `LOCKED` cell does not dispatch and shows the "not revealed yet" message while every displayed progress value stays the same
    - Tapping a `MARKED` cell does not dispatch and leaves the cell `MARKED`
    - Prize Progress panel reflects `currentPrizeProgress` (not `state.prizeProgress`) after a mark is created
    - `cyberFiveMessage` returns the exact strings for `current`/`target` = `3/5`, `4/5`, and `5/5`
    - Claim control is disabled with no eligibility text when not eligible, and becomes enabled with `"🎉 Cyber Five Ready!"` / `"Claim Cyber Five"` once Cyber Five reaches `5/5`
    - _Requirements: 12.1, 12.2, 12.4, 13.1, 13.2, 14.1, 14.2, 15.1, 15.2, 15.3, 16.1, 16.2, 16.3, 16.4, 16.5_

- [x] 11. Verify Reset Demo Game clears marks for free
  - [x]* 11.1 Write component/unit test confirming `RESET_GAME` zeroes prize progress end to end
    - Trigger Reset Demo Game from `src/pages/HostDashboard/HostDashboard.tsx`, then join a fresh player and view the Player Game screen; assert every prize renders at its zeroed value (`0/5`, `0/5`, `0/5`, `0/5`, `0/15`) and no residual `MARKED` cells remain
    - No production code change is expected in `HostDashboard.tsx` itself — `RESET_GAME`'s existing spread over `gameSessionInitialState` (now including `marks: []`) already clears marks; this task is verification only, and any gap found must be fixed in task 4.1's reducer or task 5.1's seed rather than in `HostDashboard.tsx`
    - _Requirements: 17.1, 17.2, 17.3_

- [x] 12. Integration tests for marking, persistence, sync, and prize eligibility
  - [x]* 12.1 Write mark-persistence-across-refresh integration test
    - Dispatch `MARK_TERM` for a revealed term, read `localStorage`, remount the provider, assert the same Mark is restored and the corresponding cell renders `MARKED` with matching progress values (Test B)
    - _Requirements: 5.3, 18.2_

  - [x]* 12.2 Write legacy-envelope-upgrade integration test
    - Seed `localStorage` with a Module-3-shaped envelope (`version: 2`, no `marks` key), mount the provider, assert it initializes with `game`/`players`/`tickets` restored and `marks === []` without throwing
    - _Requirements: 5.4_

  - [x]* 12.3 Write cross-tab mark sync integration test
    - Simulate two tabs sharing a `BroadcastChannel`; dispatch `MARK_TERM` in one, assert the other tab's `state.marks` and derived cell state update to match
    - _Requirements: 6.1, 6.2_

  - [x]* 12.4 Write five-distinct-terms Cyber Five eligibility integration test
    - Mark 5 distinct revealed terms on a ticket; assert Cyber Five progress `5/5`, `Prize_Eligible` true, and the Claim control enabled (Test C)
    - _Requirements: 8.3, 18.3_

  - [x]* 12.5 Write full-row Line prize eligibility integration test
    - Mark all 5 cells in ticket row 0; assert Firewall Line `5/5` and eligible; repeat for row 1 (Security Line) and row 2 (Data Defender Line) (Test D)
    - _Requirements: 9.5, 18.4_

  - [x]* 12.6 Write full-ticket Cyber Full House eligibility integration test
    - Reveal and mark all 15 terms on a ticket; assert Cyber Full House `15/15` and eligible (Test E)
    - _Requirements: 10.3, 18.5_

  - [x]* 12.7 Write locked-tap and duplicate-tap rejection integration tests
    - Attempt to mark a `LOCKED` cell: assert no Mark created, every Prize_Progress unchanged, and a clear feedback message shown (Test F)
    - Tap an already-`MARKED` cell: assert no duplicate Mark created, every Prize_Progress unchanged, and the cell remains `MARKED` (Test G)
    - _Requirements: 14.1, 14.2, 14.3, 18.6, 18.7_

- [x] 13. Final checkpoint — full build and manual Test A–H walkthrough
  - Ensure all tests pass and the production build (`tsc -b && vite build`) succeeds with zero TypeScript errors
  - Confirm manual Tests A–H in a single browser: mark-then-progress (A), refresh persistence (B), five-term Cyber Five eligibility (C), full-row line eligibility (D), full-house eligibility (E), locked-tap rejection (F), duplicate-tap rejection (G), reset clears marks and progress (H)
  - Ask the user if questions arise
  - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 19.1_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses for traceability.
- Checkpoints (tasks 6, 9, 13) ensure incremental validation as pure logic, state, and UI come together.
- Property tests validate the 11 universal correctness properties from `design.md`; each test is tagged `// Feature: module-4-term-marking-prize-engine, Property {n}: {title}` and runs ≥100 iterations.
- Component/integration tests validate UI text, tap behavior, and end-to-end flows that are not expressible as pure properties.
- `validateMarkAttempt`/`canMarkTerm` are the single shared validation pipeline used by both the reducer's `MARK_TERM` case and `PlayerGame`'s tap handler — no gate logic is duplicated between them.
- The reducer stays pure: all `Mark` id/timestamp generation reuses the existing `localId()`/`now()` helpers already used by `joinService.ts`, and no `localStorage`/`BroadcastChannel` access happens inside the reducer.
- Task 11 is verification-only per design.md's note that `RESET_GAME` clears `marks` "for free" via the existing seed spread; no `HostDashboard.tsx` code change is expected unless the test surfaces a real gap.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.2"] },
    { "id": 3, "tasks": ["2.4", "4.1", "5.1"] },
    { "id": 4, "tasks": ["4.2", "5.2"] },
    { "id": 5, "tasks": ["4.3", "7.1"] },
    { "id": 6, "tasks": ["7.2", "8.1"] },
    { "id": 7, "tasks": ["10.1"] },
    { "id": 8, "tasks": ["10.2", "11.1"] },
    { "id": 9, "tasks": ["12.1", "12.2", "12.3", "12.4", "12.5", "12.6", "12.7"] }
  ]
}
```
