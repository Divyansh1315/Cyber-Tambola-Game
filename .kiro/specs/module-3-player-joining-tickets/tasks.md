# Implementation Plan: Module 3 — Player Joining & Dynamic Tickets

## Overview

This plan implements Module 3 in dependency order: pure, testable units first
(types → ticket generator → persistence → join service → cell-state derivation →
reducer/state → context), then UI wiring (PlayerJoin, PlayerGame, HostDashboard,
PresentationView), then the Module 2 CSS long-answer fix, and finally end-to-end
verification against manual Tests A–F.

The design uses concrete TypeScript, so all tasks are TypeScript. The project has
no test runner today, so the first task installs Vitest + React Testing Library +
fast-check and wires a single-run `test` script. Property-based tests reference the
22 correctness properties in `design.md` and tag each test with the feature name and
property number per the Testing Strategy.

Test invocation uses the single-run form (`vitest run` / `npm test`), never watch mode.

## Tasks

- [x] 1. Set up test tooling and wire the test script
  - Add devDependencies: `vitest`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `jsdom`, `fast-check`
  - Create `vitest.config.ts` with `environment: 'jsdom'` and a setup file importing `@testing-library/jest-dom`
  - Add npm scripts: `"test": "vitest run"` and `"test:watch": "vitest"` (default runs use `vitest run`, single execution, not watch)
  - Verify the runner executes with a trivial passing smoke test, then remove the smoke test
  - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6_

- [x] 2. Extend domain types for players and ticket cells
  - [x] 2.1 Add `gameId` to `Player` and `row`/`col` to `TicketCell`
    - In `src/types/player.ts` add `gameId: string` to the `Player` interface
    - In `src/types/ticket.ts` add `row: number` (0..2) and `col: number` (0..4) to `TicketCell`
    - Keep the retained UI-facing aliases (`name`, `employeeId`, `ticketRef`, `term`, `state`)
    - _Requirements: 4.1, 7.5_

- [x] 3. Implement the pure ticket generator
  - [x] 3.1 Implement `src/utils/ticketGenerator.ts`
    - Export constants `TICKET_ROWS=3`, `TICKET_COLS=5`, `TICKET_SIZE=15`, `MAX_UNIQUE_ATTEMPTS=50` and the `TicketGenOptions` interface (with injectable `rng`)
    - Implement `getActiveTerms(terms)` selecting only terms whose `active` is exactly boolean `true`
    - Implement `computeSignature(termIds)` = sort ascending, join with a single `|`
    - Implement `generateTicket(terms, existingSignatures, options)`: Fisher-Yates shuffle via `rng`, take 15 distinct active terms, arrange into `rows` with `row=floor(i/5)`, `col=i%5`, `state:'LOCKED'`; regenerate on signature collision up to 50 attempts; throw on `<15` active terms; throw after 50 exhausted attempts; never mutate inputs
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10_

  - [x]* 3.2 Write property tests for the ticket generator
    - File `src/utils/ticketGenerator.test.ts`; tag each with `// Feature: module-3-player-joining-tickets, property {n} — {text}`; ≥100 iterations
    - **Property 1: Ticket has 15 distinct active terms in a 3x5 grid** — Validates Requirements 7.2, 7.3, 7.4
    - **Property 2: Cell row/column indices match grid position** — Validates Requirements 7.5
    - **Property 3: Signature is deterministic and order-independent** — Validates Requirements 7.7
    - **Property 4: Generated signature is absent from the existing set** — Validates Requirements 7.8
    - **Property 5: Generator does not mutate its inputs** (deep-freeze inputs) — Validates Requirements 7.1, 7.9, 7.10
    - **Property 6: Error conditions throw without producing a ticket** (`<15` active; saturated signature space of exactly 15 active terms) — Validates Requirements 7.9, 7.10
    - **Property 7: Randomized selection produces variety** (≥2 distinct signatures over 100 default-RNG calls, bank ≥16) — Validates Requirements 7.6
    - Use a term-bank generator mixing `active: true/false/undefined/null` to exercise strict-`true` selection
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10_

- [x] 4. Implement the versioned persistence codec
  - [x] 4.1 Implement `src/state/persistence.ts`
    - Export `STORAGE_KEY='cyber-tambola-v2:game'`, `PERSIST_VERSION=2`, and the `PersistedEnvelope` interface
    - `toEnvelope(slice)` wraps `{ version:2, game, players, tickets, currentPlayerId }`
    - `parseEnvelope(raw)`: null/empty → null; JSON.parse in try/catch → null on throw; require `version===2`; validate shapes (game has string `id`/`status` and array `revealedTermIds`, `players`/`tickets` are arrays); reconcile dangling `currentPlayerId` to `undefined`; never throw
    - `writeEnvelope(slice)` best-effort write, swallowing quota/availability errors; `readEnvelope()` reads + parses from `localStorage`
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

  - [x]* 4.2 Write property tests for persistence
    - File `src/state/persistence.test.ts`; tag with feature name + property number; ≥100 iterations
    - **Property 20: Persistence round-trips valid envelopes** — Validates Requirements 16.1, 16.2, 16.3
    - **Property 21: Malformed persistence never throws and falls back** (arbitrary strings, malformed JSON, old Module 2 shape without `version`) — Validates Requirements 16.4
    - **Property 22: Dangling current player is reconciled away** — Validates Requirements 16.5
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

- [x] 5. Implement the join service
  - [x] 5.1 Implement `src/state/joinService.ts`
    - Export `JOIN_OUTCOME`/`JoinOutcome` union, `JOINABLE_STATUSES`, and the exact `MESSAGES` (requiredFields, gameNotFound `Game not found or no longer available.`, gameCompleted)
    - Implement `normalizeId` (trim + lowercase), `localId` (`crypto.randomUUID()` with timestamp+random fallback), `shortTicketRef(ticketId)` (`Ticket #` + short token, full id never a substring), `findExistingPlayer(players, employeeDemoId)` by normalized id
    - Implement `validateJoin(form, game, players)`: trim all fields; empty → `error(requiredFields)`; normalized code !== `cyber24` → `error(gameNotFound)`; `status==='COMPLETED'` → `error(gameCompleted)`; normalized-id match → `restore(existing.id)`; else `new` with trimmed fields
    - Implement `buildJoinOutcome({form, game, players, tickets, terms})`: return error/restore unchanged; for `new`, build ids/timestamp, compute `existingSignatures` from tickets, call `generateTicket`, and build a well-formed `Player` (with aliases) and `Ticket`
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 10.2, 10.3_

  - [x]* 5.2 Write property tests for the join service
    - File `src/state/joinService.test.ts`; tag with feature name + property number; ≥100 iterations
    - **Property 8: Join validation normalizes and trims correctly** — Validates Requirements 3.3, 3.5, 4.2, 5.1
    - **Property 9: Unknown or empty inputs are rejected** — Validates Requirements 3.4, 3.6
    - **Property 10: Joinability depends only on status** — Validates Requirements 3.7, 3.8
    - **Property 11: Duplicate identity restores the existing player** — Validates Requirements 5.2, 5.3
    - **Property 12: A built player is well-formed** — Validates Requirements 4.1, 4.2, 4.3
    - **Property 13: Short ticket ref hides the full id** — Validates Requirements 10.2, 10.3
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 10.2, 10.3_

  - [x]* 5.3 Write unit tests for `localId` fallback and error messages
    - Test `localId()` with and without `crypto.randomUUID` present
    - Test `validateJoin` `COMPLETED` branch and exact `gameNotFound`/`gameCompleted` message strings
    - _Requirements: 3.6, 3.8, 4.4_

- [x] 6. Implement reveal-driven cell-state derivation
  - [x] 6.1 Implement `deriveCellState`
    - Add a pure `deriveCellState(termId, revealedTermIds, marked)` helper (co-locate with PlayerGame or in `src/utils`): `LOCKED` when termId absent from `revealedTermIds`; `MARKED` when present and locally marked; `AVAILABLE` when present and not marked
    - Must not mutate the stored ticket
    - _Requirements: 8.2, 12.1, 12.2, 12.3, 12.4_

  - [x]* 6.2 Write property test for cell-state derivation
    - File `src/pages/PlayerGame/cellState.test.ts` (or alongside the helper); tag with feature name + property number; ≥100 iterations; metamorphic over changing `revealedTermIds`
    - **Property 14: Cell state is derived solely from reveal history** — Validates Requirements 8.2, 12.1, 12.2, 12.4
    - _Requirements: 8.2, 12.1, 12.2, 12.4_

- [x] 7. Checkpoint — pure logic passes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Extend central session state and reducer
  - [x] 8.1 Update `gameSessionInitialState.ts`
    - Extend `GameSessionState`: add `tickets: Ticket[]` and optional `currentPlayerId?: string`; remove `participantCount` and the single `ticket` field
    - Seed `players: []`, `tickets: []`, `currentPlayerId: undefined`
    - Seed `prizeProgress` to zeroed values with correct targets (Cyber Five 0/5, Firewall Line 0/5, Security Line 0/5, Data Defender Line 0/5, Cyber Full House 0/15) instead of `mockPrizeProgress`
    - Keep `claims`/`winners` from `mockClaims` as clearly-labelled host demo data; remove now-unused `mockPlayer`/`mockTicket`/`mockParticipantCount` imports
    - _Requirements: 14.1, 18.2, 18.5_

  - [x] 8.2 Extend the reducer with JOIN_PLAYER, RESTORE_PLAYER, and RESET_GAME
    - In `src/state/gameSessionReducer.ts` add `{ type:'JOIN_PLAYER'; player; ticket }` and `{ type:'RESTORE_PLAYER'; playerId }` to the action union
    - `JOIN_PLAYER`: append player to `players`, append ticket to `tickets`, set `currentPlayerId = player.id` (pure, no generation)
    - `RESTORE_PLAYER`: set `currentPlayerId = playerId`; leave `players`/`tickets` unchanged; ignore safely if no such player
    - `RESET_GAME`: return seed state via `createSeedGame()`, clearing `players`, `tickets`, `currentPlayerId` and returning game to LOBBY with round 0, no current term, empty `revealedTermIds`
    - Keep the reducer pure; do no random ticket generation
    - _Requirements: 14.2, 14.3, 14.4, 15.1, 15.2_

  - [x]* 8.3 Write property tests for the reducer
    - File `src/state/gameSessionReducer.test.ts`; tag with feature name + property number; ≥100 iterations; deep-freeze input state to enforce purity
    - **Property 15: Reducer is pure across all actions** — Validates Requirements 14.4
    - **Property 16: JOIN_PLAYER appends and sets current player** — Validates Requirements 4.5, 6.3, 14.2
    - **Property 17: RESTORE_PLAYER sets current without creating records** — Validates Requirements 5.2, 14.3
    - **Property 18: RESET_GAME clears session and returns to lobby** — Validates Requirements 15.1, 15.2
    - **Property 19: Participant count equals players length** — Validates Requirements 6.1, 6.3
    - _Requirements: 6.1, 6.3, 14.2, 14.3, 14.4, 15.1, 15.2_

  - [x]* 8.4 Write unit test for zeroed initial prize progress
    - Assert seed `prizeProgress` values are zeroed with correct targets
    - _Requirements: 18.2_

- [x] 9. Wire persistence and selectors into the context provider
  - [x] 9.1 Update `GameSessionContext.tsx`
    - `initState()` uses `readEnvelope()`; merge restored `game`/`players`/`tickets`/`currentPlayerId` over seed, else use seed
    - Persist via `writeEnvelope({ game, players, tickets, currentPlayerId })` in a `useEffect` keyed on `[state.game, state.players, state.tickets, state.currentPlayerId]`
    - Add derived selectors to context value: `currentPlayer?: Player` and `currentTicket?: Ticket`; keep existing `currentTerm`, `revealHistory`, `hasRemainingTerms`
    - _Requirements: 9.1, 16.1, 16.2, 16.6_

- [x] 10. Checkpoint — state + persistence integrate
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Rewrite the Player Join screen
  - [x] 11.1 Rewrite `PlayerJoin.tsx`
    - Remove prefilled `Divyansh`/`DEMO-021`; name/id start empty (game code may keep `SEED_GAME_CODE`)
    - Add `maxLength={64}` to all three inputs
    - On submit call `buildJoinOutcome({ form, game, players, tickets, terms: cyberTerms })` inside try/catch (generic "Unable to create a ticket right now." on generator failure)
    - `error` → show validation message, no navigation; `restore` → `dispatch(RESTORE_PLAYER)` + `navigate('/player', { state: { restored: true } })`; `new` → `dispatch(JOIN_PLAYER)` + `navigate('/player')`
    - _Requirements: 3.1, 3.2, 3.4, 3.6, 3.8, 3.9, 4.5, 5.4, 9.3_

  - [x]* 11.2 Write component tests for PlayerJoin
    - Three labelled inputs present with `maxLength=64`; empty-field submit shows message and does not navigate; valid new join dispatches `JOIN_PLAYER` and navigates to `/player`; duplicate id dispatches `RESTORE_PLAYER` and navigates
    - _Requirements: 3.1, 3.2, 3.4, 3.9, 4.5, 5.4_

- [x] 12. Rewrite the Player Game screen
  - [x] 12.1 Rewrite `PlayerGame.tsx`
    - Resolve `currentPlayer`/`currentTicket` from context; if none render `<Navigate to="/" replace />` (or `Join a game first.`)
    - Header shows `currentPlayer.displayName` and `shortTicketRef(currentTicket.id)`; never a long id or `mockPlayer`/`Divyansh`
    - Remove local ticket `useState` and the reveal `useEffect` mutation; render each cell through `deriveCellState(termId, revealedTermIds, marked)` with `marked` a local `Set<string>` for tap only; resolve label via `findCyberTerm(termId)?.term ?? termId`
    - Prize progress from `state.prizeProgress`; Claim disabled derives from the same gating value (Cyber Five, target 5); at initial values show exact text `Mark revealed terms to become eligible for prizes.` and keep Claim disabled; show `Existing game session restored.` when navigation state `restored` is true; no claim processing
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 5.5, 8.1, 8.2, 8.3, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3, 11.1, 11.2, 11.3, 11.4, 12.1, 12.2, 12.3, 12.4, 18.1, 18.3, 18.4_

  - [x]* 12.2 Write component tests for PlayerGame
    - No current player redirects / shows `Join a game first.`; header shows `displayName` + `Ticket #XXXX` (not a long id, not `Divyansh`); ticket renders 15 cells from real data; revealing a ticket term flips its cell `LOCKED → AVAILABLE` (Test E); at initial progress Claim is disabled with hint `Mark revealed terms to become eligible for prizes.`; restored session shows `Existing game session restored.`
    - _Requirements: 2.3, 5.5, 9.4, 10.1, 10.2, 10.3, 11.1, 11.2, 12.2, 18.3_

- [x] 13. Update Host Dashboard and confirm Presentation View
  - [x] 13.1 Update `HostDashboard.tsx`
    - Participants value = `state.players.length`; remove `state.participantCount` and the fixed `47`
    - Optional compact participant list renders `player.displayName` only, never `employeeDemoId`
    - Keep sample claims/winners as clearly-labelled demo data
    - _Requirements: 6.1, 6.2, 6.3, 17.1, 17.2, 17.4, 18.5_

  - [x] 13.2 Confirm `PresentationView.tsx` exposes no employee id
    - Verify rendered output contains no `employeeDemoId`; adjust only if needed
    - _Requirements: 17.3_

  - [x]* 13.3 Write component tests for HostDashboard and PresentationView
    - HostDashboard participants equals `players.length` and is not `47`; optional name list shows display names only, never `employeeDemoId`; PresentationView output contains no `employeeDemoId`
    - _Requirements: 6.1, 6.2, 17.2, 17.3, 17.4_

- [x] 14. Remove live mock usage and dangling imports
  - [x] 14.1 Retire live use of `mockPlayers.ts` / `mockTickets.ts`
    - Remove all live imports of `mockPlayers.ts` and `mockTickets.ts`; keep the files only as clearly-labelled dev fixtures if still referenced by tests, otherwise remove
    - Remove any now-unused imports across touched files; run typecheck to confirm no orphaned references
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

- [x] 15. Fix long-answer responsive typography (Module 2 carry-over)
  - [x] 15.1 Update `AnswerReveal.css`
    - Replace fixed answer font sizes with `clamp()` fluid typography per scale: `player` min 1.25rem / max 2.5rem, `stage` min 2rem / max 6rem
    - Add wrapping rules (`overflow-wrap: anywhere` / `word-break: break-word`, `hyphens: auto`) so long terms wrap with zero horizontal overflow at 320–1920px
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x]* 15.2 Write component test for AnswerReveal long-answer text
    - Full `Suspicious Attachment` text present in the DOM and the wrapping class applied (font-size clamp/overflow verified manually since jsdom has no layout)
    - _Requirements: 1.1, 1.2_

- [x] 16. Integration wiring and end-to-end automated coverage
  - [x]* 16.1 Write persistence round-trip integration test through the provider
    - Mount provider, dispatch `JOIN_PLAYER`, read `localStorage`, remount, assert players/tickets/currentPlayerId/game restored identically (Test B)
    - _Requirements: 16.2_

  - [x]* 16.2 Write stale-data fallback integration test
    - Seed `localStorage` with an old Module 2 shape (no `version`) and with garbage; assert provider initializes to seed without throwing
    - _Requirements: 16.4_

  - [x]* 16.3 Write three-distinct-players integration test
    - Join three distinct ids; assert participant count `3` and three distinct ticket signatures (Test D)
    - _Requirements: 6.1, 6.3, 19.4_

  - [x]* 16.4 Write reset integration test
    - Dispatch `RESET_GAME`; assert players/tickets/currentPlayerId cleared, game LOBBY, and persisted storage overwritten with the v2 seed envelope (Tests F)
    - _Requirements: 15.1, 15.2, 16.6_

- [x] 17. Final checkpoint — full build and manual test scenarios
  - Ensure all tests pass and `npm run build` succeeds; then confirm manual Tests A–F in a single browser: new join (A), refresh persistence (B), duplicate restore (C), three distinct tickets (D), reveal-driven LOCKED→AVAILABLE (E), reset clears state (F); plus Requirement 1 layout checks (MFA at max size; long terms wrap with no horizontal scroll at 320px and 1920px)
  - Ask the user if questions arise.
  - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 1.3, 1.5, 1.6_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references specific requirement sub-clauses for traceability.
- Checkpoints (tasks 7, 10, 17) ensure incremental validation as pure logic, state, and UI come together.
- Property tests validate the 22 universal correctness properties from `design.md`; each test is tagged `// Feature: module-3-player-joining-tickets, property {n} — {text}` and runs ≥100 iterations.
- Component/integration tests validate UI text, navigation, and end-to-end flows that are not expressible as pure properties.
- The reducer stays pure: all randomness and `crypto` access live in `joinService`/`ticketGenerator` before dispatch.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2.1"] },
    { "id": 1, "tasks": ["3.1", "4.1", "6.1"] },
    { "id": 2, "tasks": ["3.2", "4.2", "5.1", "6.2"] },
    { "id": 3, "tasks": ["5.2", "5.3", "8.1"] },
    { "id": 4, "tasks": ["8.2", "8.4"] },
    { "id": 5, "tasks": ["8.3", "9.1"] },
    { "id": 6, "tasks": ["11.1", "12.1", "13.1", "13.2", "15.1"] },
    { "id": 7, "tasks": ["11.2", "12.2", "13.3", "14.1", "15.2"] },
    { "id": 8, "tasks": ["16.1", "16.2", "16.3", "16.4"] }
  ]
}
```
