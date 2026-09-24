# Implementation Plan: Module 5 — Direct Cyber Word Call Gameplay Refactor

## Overview

This plan refactors the round/reveal mechanic only, in dependency order: types first
(`GameStatus`, `CyberTerm`), then content data, then the reducer (status collapse +
action rename/merge), then persistence (version bump), then the shared
`CyberWordCard` component, then the three screens (HostDashboard, PlayerGame,
PresentationView), then dead-code removal, then the full regression-test sweep, and
finally a full build. Every task explicitly calls out what must NOT change, per the
requirements' non-regression list (marks, prize engine, ticket generation, join
service, client-local player identity, the `rev` cross-tab staleness gate).

The project already has Vitest, @testing-library/react, @testing-library/user-event,
@testing-library/jest-dom, and fast-check installed and wired. Test invocation uses
the single-run form (`vitest run` / `npm test`), never watch mode.

## Tasks

- [ ] 1. Update the game status and content type models
  - [ ] 1.1 Update `src/types/game.ts`
    - Change `GameStatus` to exactly `'LOBBY' | 'WORD_ACTIVE' | 'PAUSED' | 'COMPLETED'`
    - Remove the unused `Reveal`, `GameSession`, and `CurrentClue` types (confirmed zero non-declaration references anywhere in `src/`)
    - Keep `Game.revealedTermIds` field name, type (`string[]`), and doc comment unchanged apart from updating its comment to describe "officially called" rather than "revealed" terms
    - _Requirements: 1.1, 1.2, 10.4_

  - [ ] 1.2 Update `src/types/cyberTerm.ts`
    - Rename `CyberTerm.clue` to `CyberTerm.definition` and `CyberTerm.learningMessage` to `CyberTerm.awarenessTip`
    - Keep `id`, `term`, `category`, `difficulty`, `active`, and the `CyberCategory`/`CyberDifficulty` unions unchanged
    - _Requirements: 3.1_

- [ ] 2. Migrate the 30-term content bank
  - [ ] 2.1 Update `src/data/cyberTerms.ts`
    - Rename every entry's `clue` field to `definition` and `learningMessage` field to `awarenessTip`; keep `id`, `term`, `category`, `difficulty`, `active` unchanged for all 30 entries
    - Lightly edit any `definition` text that was phrased as a withholding guessing clue so it reads as a direct definition; keep each `definition` to ≤2 short sentences and each `awarenessTip` to 1 short sentence
    - Keep `findCyberTerm` unchanged
    - _Requirements: 3.2, 3.3, 3.4_

  - [ ]* 2.2 Write/update unit test for content shape
    - Assert all 30 entries have non-empty `definition`/`awarenessTip` strings, `definition` length within the short-form guidance, and `active`/`id`/`term`/`category`/`difficulty` values unchanged from before this module
    - _Requirements: 3.3, 3.4_

- [ ] 3. Collapse the reducer's status machine and merge the call actions
  - [ ] 3.1 Update `src/state/gameSessionReducer.ts`
    - Remove `REVEAL_ANSWER` from `GameSessionAction` and delete its case entirely
    - Rename `LOAD_NEXT_CLUE` to `CALL_NEXT_WORD` in the action union
    - `START_GAME`: on success, in the same returned object, set `status: 'WORD_ACTIVE'` and append the selected term's id to `revealedTermIds` (folding in the old `REVEAL_ANSWER` side effect)
    - `CALL_NEXT_WORD`: guard on `game.status !== 'WORD_ACTIVE'` (replacing the old `ANSWER_REVEALED` guard); on success, append the newly selected term's id to `revealedTermIds`, increment `currentRound`, set `currentTermId`, and keep `status: 'WORD_ACTIVE'`; when the term bank is exhausted, transition to `COMPLETED` exactly as `LOAD_NEXT_CLUE` did
    - `PAUSE_GAME`: change its guard from `ACTIVE_STATUSES.includes(status)` to `status === 'WORD_ACTIVE'`; remove the now-unused `ACTIVE_STATUSES` constant
    - `RESUME_GAME`: change its fallback from `previousStatus ?? 'CLUE_ACTIVE'` to `previousStatus ?? 'WORD_ACTIVE'`
    - Leave `END_GAME`, `RESET_GAME`, `JOIN_PLAYER`, `RESTORE_PLAYER`, `SYNC_STATE` (including its `rev` staleness gate), and `MARK_TERM` completely unchanged
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 5.1, 10.4_

  - [ ]* 3.2 Write property tests for the merged call actions and preserved invariants
    - File `gameSessionReducer.callNextWord.test.ts`; tag `// Feature: module-5-direct-word-call-gameplay, Property {n}: {title}`; ≥100 iterations
    - **Property 1: Calling a word never removes or duplicates entries in revealedTermIds** — Validates Requirements 2.4, 2.5, 5.1
    - **Property 2: Calling a word preserves every existing Mark unchanged** — Validates Requirements 5.1, 5.2, 4.5
    - **Property 3: Prize progress never decreases from a call-only action** — Validates Requirements 5.3, 5.4, 11.5
    - _Requirements: 2.4, 2.5, 4.5, 5.1, 5.2, 5.3, 5.4, 11.5_

  - [ ]* 3.3 Write property test for the collapsed status machine
    - File `gameSessionReducer.statusMachine.test.ts`; tag `// Feature: module-5-direct-word-call-gameplay, Property {n}: {title}`; ≥100 iterations
    - **Property 4: The collapsed status machine never produces an invalid transition** — Validates Requirements 1.1, 1.5, 1.6
    - _Requirements: 1.1, 1.5, 1.6, 1.7, 1.8_

- [ ] 4. Confirm the mark-validation and prize-engine status gate compiles against the new union
  - [ ] 4.1 Update `src/utils/prizeEngine.ts` only if required for compilation
    - Confirm `validateMarkAttempt`'s `state.game.status === 'COMPLETED'` gate requires no logic change; update only the `NON_COMPLETED_STATUSES`-style comment/doc references from the old status names to `LOBBY`/`WORD_ACTIVE`/`PAUSED`
    - Do NOT alter any prize formula (`getCyberFiveProgress`, `getLineProgress`, `getFullHouseProgress`, `getAllPrizeProgress`, `isPrizeEligible`) or any of the six mark-validation gates
    - _Requirements: 5.3, 5.4, 10.3_

- [ ] 5. Bump the persisted-state version and confirm safe rejection of legacy envelopes
  - [ ] 5.1 Update `src/state/persistence.ts`
    - Change `PERSIST_VERSION` from `2` to `3`
    - Do not change `PersistedEnvelope`/`PersistedSlice`'s field set, `toEnvelope`, `parseEnvelope`'s shape checks, or the `marks`/`rev`-defaulting logic beyond the version constant
    - _Requirements: 9.1, 9.2, 9.3_

  - [ ]* 5.2 Extend persistence property tests for the version bump
    - File `persistence.test.ts` (extend existing version-mismatch coverage); tag `// Feature: module-5-direct-word-call-gameplay, Property {n}: {title}`; ≥100 iterations
    - **Property 5: An incompatible persisted envelope version always falls back to seed without throwing** — Validates Requirements 9.1, 9.2, 9.3
    - Include an explicit example case: a `version: 2` envelope whose `game.status` is the retired string `'CLUE_ACTIVE'` or `'ANSWER_REVEALED'` is rejected and never throws
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 6. Checkpoint — types, content, reducer, and persistence compile and pass
  - Run `tsc -b`/`npx vitest run` on tasks 1–5's scope; ensure all pure-logic tests pass before touching UI. Ask the user if questions arise.

- [ ] 7. Build the shared CyberWordCard component
  - [ ] 7.1 Create `src/components/common/CyberWordCard.tsx` and `CyberWordCard.css`
    - Props: `term: string`, `definition: string`, `awarenessTip: string`, `scale?: 'player' | 'stage'`
    - Render term, definition, and awareness tip simultaneously with no hidden/waiting branch
    - Reuse `AnswerReveal.css`'s fluid `clamp()` sizing (player `clamp(1.25rem, 6vw, 2.5rem)`; stage `clamp(2rem, 12vw, 6rem)`) and wrapping rules (`overflow-wrap: anywhere`, `hyphens: auto`) for the term; reuse `ClueCard.css`'s eyebrow/definition text treatment; style the tip similarly to `AnswerReveal.css`'s `.answer-reveal__learning`
    - _Requirements: 6.3, 7.1, 8.1, 8.2_

  - [ ]* 7.2 Write component test for CyberWordCard
    - File `CyberWordCard.test.tsx`; assert term/definition/awarenessTip all render together with no hidden-state branch, at both `player` and `stage` scale
    - _Requirements: 7.1, 8.1_

- [ ] 8. Refactor the Host Dashboard
  - [ ] 8.1 Update `src/pages/HostDashboard/HostDashboard.tsx`
    - Remove the `revealed`/`isActive` booleans and the `canReveal`/`canNext` names; add `canCallNext = status === 'WORD_ACTIVE'`; set `canPause = status === 'WORD_ACTIVE'`
    - Merge the "Current Clue" and "Answer Reveal" cards into one `<Card title="Current Cyber Word">` wrapping `<CyberWordCard term={currentTerm.term} definition={currentTerm.definition} awarenessTip={currentTerm.awarenessTip} scale="stage" />`, with an updated empty-state message removing "clue"/"reveal" wording
    - Delete the "Reveal Answer" button entirely
    - Rename the "Next Clue" button to "Next Cyber Word", dispatching `{ type: 'CALL_NEXT_WORD' }`, gated on `canCallNext`
    - Rename the "Reveal History" card's title to "Called Words"
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 8.2 Update HostDashboard component tests
    - Assert no "Reveal Answer" control exists; assert "Next Cyber Word" dispatches `CALL_NEXT_WORD`; assert the merged current-word panel renders term/definition/tip; assert the history panel is titled "Called Words"
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ] 9. Refactor the Player Game screen
  - [ ] 9.1 Update `src/pages/PlayerGame/PlayerGame.tsx`
    - Remove the `revealed` boolean's clue-phase meaning; replace the clue+answer rendering block with one `CyberWordCard` usage inside `<section aria-label="Current Cyber Word">`, shown whenever `currentTerm` exists and the game is not paused/completed
    - Update the "waiting for the host" fallback copy to remove clue/answer/guessing language
    - Do NOT change `handleTap`, `markedTermIds`, `renderedTicket`/`deriveCellState` usage, the `isHydrated` guard, the redirect guard, `currentPrizeProgress`, `cyberFiveMessage`, or the Claim card
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 4.4, 5.6_

  - [ ]* 9.2 Update PlayerGame component tests
    - Assert no "Think about the cyber term…" text renders anywhere; assert the current-word section shows term/definition/tip together as soon as a term is called; assert manual tap is still required to mark (no auto-mark on call); assert the redirect/hydration/mark-persistence tests from Module 4 still pass unmodified in behavior (fixtures updated to `WORD_ACTIVE`/`CALL_NEXT_WORD` only)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 5.6_

- [ ] 10. Refactor the Presentation View
  - [ ] 10.1 Update `src/pages/PresentationView/PresentationView.tsx`
    - Replace the separate `CLUE_ACTIVE` and `ANSWER_REVEALED` blocks with one `WORD_ACTIVE` block showing `term` (largest), `definition` (readable secondary), and `awarenessTip` (visually distinct secondary)
    - Remove the "Think about the cyber term…" hint entirely
    - Keep the `LOBBY`, `PAUSED`, and `COMPLETED` blocks unchanged apart from the status value comparisons
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 10.2 Update PresentationView tests
    - Change the status table from `['LOBBY', 'CLUE_ACTIVE', 'ANSWER_REVEALED']` to `['LOBBY', 'WORD_ACTIVE']`; assert the merged word/definition/tip block renders under `WORD_ACTIVE`; assert no guessing text renders
    - _Requirements: 8.1, 8.2, 8.5_

- [ ] 11. Update StatusBadge for the collapsed status set
  - [ ] 11.1 Update `src/components/common/StatusBadge.tsx`
    - Update `STATUS_META` to the 4-entry `Record<GameStatus, ...>` (`LOBBY`, `WORD_ACTIVE`, `PAUSED`, `COMPLETED`); let TypeScript's `Record<GameStatus, ...>` typing force completeness
    - _Requirements: 1.1, 1.2_

- [ ] 12. Checkpoint — UI reflects the new gameplay end to end
  - Run the full test suite; manually smoke-test Start Game → Call Next Word → mark → refresh in the dev server. Ask the user if questions arise.

- [ ] 13. Sweep and update all remaining tests referencing the old status/action names
  - [ ] 13.1 Update reducer and state tests
    - Replace every `CLUE_ACTIVE`/`ANSWER_REVEALED`/`REVEAL_ANSWER`/`LOAD_NEXT_CLUE` fixture, dispatch, or arbitrary in: `gameSessionReducer.test.ts`, `gameSessionReducer.reset.test.ts`, `gameSessionReducer.syncState.marks.test.ts`, `gameSessionReducer.playerIdentity.test.ts`, `gameSessionReducer.markTerm.test.ts`, `gameSessionReducer.markPersistenceAcrossReveals.test.ts`, `staleSyncRejection.test.ts`, `syncState.test.ts`, `prizeEngine.validateMarkAttempt.test.ts`, `joinService.test.ts`, `ticketGenerator.test.ts` with `WORD_ACTIVE`/`CALL_NEXT_WORD` equivalents, without changing any assertion's underlying invariant
    - _Requirements: 1.1, 2.1, 10.1, 10.2, 10.3, 10.4_

  - [ ] 13.2 Update integration tests
    - Replace old status/action references in: `legacyEnvelopeUpgrade.integration.test.tsx`, `playerIdentityHydration.integration.test.tsx`, `session.integration.test.tsx`, `lineProgress.integration.test.tsx`, `markRejection.integration.test.tsx`, `marksSync.integration.test.tsx`, `marks.integration.test.tsx`
    - _Requirements: 5.5, 5.6, 10.4_

  - [ ] 13.3 Replace `AnswerReveal.test.tsx` with `CyberWordCard.test.tsx` coverage
    - Remove the old component test file once its assertions are subsumed by task 7.2's new test
    - _Requirements: 7.1, 8.1_

- [ ] 14. Remove dead old-flow code
  - [ ] 14.1 Delete retired components and confirm no remaining references
    - Delete `src/components/common/ClueCard.tsx`, `ClueCard.css`, `src/components/common/AnswerReveal.tsx`, `AnswerReveal.css` once all call sites use `CyberWordCard`
    - Remove the unused `Reveal`, `GameSession`, `CurrentClue` types from `src/types/game.ts` (task 1.1) if not already removed
    - Remove the now-unused `ACTIVE_STATUSES` constant from the reducer (task 3.1) if not already removed
    - Run a project-wide search for any remaining `CLUE_ACTIVE`, `ANSWER_REVEALED`, `REVEAL_ANSWER`, `LOAD_NEXT_CLUE`, `clue`, `learningMessage` identifiers in `src/` and resolve each
    - _Requirements: 1.2, 2.1_

- [ ] 15. Final checkpoint — full build and manual Test A–G walkthrough
  - Run `tsc -b && vite build` and the full `vitest run` suite; resolve all failures
  - Confirm manual Tests A–G in a single browser across Host/Player/Presentation tabs: immediate first-word display with no clue/reveal UI (A), word+definition+tip shown everywhere (B), LOCKED→AVAILABLE→MARKED ticket transition (C), second-word call preserving history and marks (D), 10+ rounds with no duplicates/no regressed prize progress/stable identity and ticket (E), refresh restoration of player/ticket/marks/progress/current word/history (F), pause/resume preserving marks and current word (G)
  - Ask the user if questions arise
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- `revealedTermIds` keeps its name and mechanism throughout this module — only its English meaning changes from "revealed" to "called." Do not rename this field.
- `LOAD_NEXT_CLUE` is renamed to `CALL_NEXT_WORD` at the action-type level (cheap, one clean rename); `revealedTermIds` is not renamed (expensive, ~25 call sites, zero behavioral gain).
- `ticketGenerator.ts`, `joinService.ts`, `deriveCellState.ts`, `gameEngine.ts`, and every prize formula in `prizeEngine.ts` require zero logic changes — confirmed fully decoupled from the clue/reveal mechanic during design; only their test fixtures reference the old status/action names and need cosmetic updates.
- The client-local `Current_Player_Id` persistence/hydration mechanism and the cross-tab `rev` staleness gate (both fixed in prior bugfix rounds) are not touched by any task in this plan.
- Checkpoints (tasks 6, 12, 15) ensure incremental validation as types, reducer, and UI come together.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1", "5.1"] },
    { "id": 2, "tasks": ["2.2", "3.2", "3.3", "4.1", "5.2"] },
    { "id": 3, "tasks": ["6"] },
    { "id": 4, "tasks": ["7.1", "11.1"] },
    { "id": 5, "tasks": ["7.2", "8.1", "9.1", "10.1"] },
    { "id": 6, "tasks": ["8.2", "9.2", "10.2", "12"] },
    { "id": 7, "tasks": ["13.1", "13.2", "13.3"] },
    { "id": 8, "tasks": ["14.1"] },
    { "id": 9, "tasks": ["15"] }
  ]
}
```
