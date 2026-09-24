# Implementation Plan: Winner History and Game Reset

## Overview

This plan implements the module additively on top of Module 6's schema, RPCs, and
client wiring, in the same dependency order the design follows: schema/RPC migration
first (Group A), then the `realtimeClient.ts`/reducer/context client plumbing that
resolves and follows the Active_Game (Group B), then the Host Dashboard Winner_History
UI and the Presentation View / Player Join regression guarantees (Group C), finishing
with cross-cutting checkpoints that exercise the full reset-with-multiple-open-tabs
scenario.

As with Module 6, SQL migration files are authored and structurally lint-tested as
version-controlled text — there is no live Supabase project or Postgres instance
provisioned in this workspace to apply them against. Tasks for the four correctness
properties that are database-level guarantees (Properties 1, 5, 6, 8) are written as
**conditional integration tests** against a local Supabase CLI/Postgres instance,
following the exact same skip-if-unreachable convention `module-6-realtime-multi-device-sync`
already established (`callNextWord.integration.test.ts` et al.), gated on the same
`SUPABASE_TEST_DB_URL`-style probe. Properties 2, 3, 4, 7, 9, 10, 11, 12, 13, and 14 are
pure-function/reducer/mock-client properties, fully testable today with the existing
Vitest + fast-check + Testing Library stack and the existing
`src/state/testSupport/mockSupabaseClient.ts` fixture from Module 6 — no new mocking
infrastructure is introduced.

## Tasks

### Group A — Schema and RPC authoring

- [x] 1. Author the migration adding `active_game_pointer` and `winners.ticket_ref`
  - [x] 1.1 Create `supabase/migrations/0006_active_game_and_winner_history.sql`
    - Write the `active_game_pointer` table (`id boolean primary key default true check (id)`, nullable `active_game_id uuid references games(id) on delete set null`, `updated_at timestamptz not null default now()`), its seed `insert`, and its `updated_at` trigger reusing the existing `set_updated_at()` function
    - Add `alter table winners add column ticket_ref text;`, the backfill `update winners set ticket_ref = 'Unknown ticket' where ticket_ref is null;`, and `alter table winners alter column ticket_ref set not null;`, in that order
    - Enable RLS on `active_game_pointer` and add the single `anon`-read `select` policy, with no `insert`/`update`/`delete` policy for `anon` (matching `0002_rls.sql`'s default-deny convention)
    - Add `alter publication supabase_realtime add table active_game_pointer;`
    - _Requirements: 1.1, 1.2, 1.4, 2.3, 3.1, 3.5_

  - [x] 1.2 Write a structural lint test for the new migration
    - File `supabase/migrations/activeGameAndWinnerHistory.structure.test.ts` (text-pattern assertions against the raw SQL, mirroring `schema.structure.test.ts`'s existing style)
    - Assert exactly one `CREATE TABLE active_game_pointer` with a `boolean primary key` `id` column and a `check (id)` constraint, exactly one seed `insert into active_game_pointer`, the `alter table winners add column ticket_ref` / backfill `update` / `set not null` statements appear in that relative order, the `enable row level security` and `for select to anon` policy for `active_game_pointer` are present, no `for insert`/`for update`/`for delete` policy naming `anon` appears for `active_game_pointer`, and the publication statement names `active_game_pointer`
    - _Requirements: 1.2, 2.3, 3.1, 3.5_

  - [x] 1.3 Write a conditional integration test for the pointer's at-most-one-row guarantee (Property 5, schema half)
    - File `supabase/migrations/activeGamePointer.integration.test.ts`; same conditional-skip pattern as Module 6's `callNextWord.integration.test.ts` (probe `SUPABASE_TEST_DB_URL`, `describe.skip` with a logged reason if unreachable)
    - When reachable: apply migrations 0001-0006 against a fresh schema, assert exactly one row exists in `active_game_pointer` with `active_game_id is null`, attempt to insert a second row with a different `id` value and assert it is rejected by the primary key/check constraint, and attempt an insert with `id = false` and assert it is rejected by the `check (id)` constraint
    - **Property 5 (partial): the pointer table never holds more than one row** — Validates Requirements 3.1, 3.5
    - _Requirements: 3.1, 3.5_

- [x] 2. Author `get_active_game()`, `generate_new_game_code()`, and `reset_game_to_new()`, and update `confirm_claim`
  - [x] 2.1 Append the three new RPC functions to `supabase/migrations/0006_active_game_and_winner_history.sql`
    - Write `get_active_game()` exactly as specified in design.md: `security invoker`-default `language sql stable`, joins `active_game_pointer` to `games`, returns zero rows when `active_game_id is null`
    - Write `generate_new_game_code()` exactly as specified: `plpgsql`, generates a 4-uppercase-letter + 2-digit code, retries on collision against `games.code` up to 50 attempts, raises `GAME_CODE_RETRY_EXCEEDED` on exhaustion, mirroring `assign_ticket`'s existing retry-loop shape
    - Write `reset_game_to_new(p_old_game_id uuid, p_host_secret uuid)` exactly as specified: `security definer`, row-locks the old game with `for update`, raises `NOT_AUTHORIZED` when the game does not exist or `host_secret` mismatches (before any write), creates the new `games` row with a freshly generated code and `status = 'LOBBY'`, updates `active_game_pointer` to point at it, and scopes `delete` statements to `claims`/`marks`/`tickets`/`players`/`called_terms` filtered by `game_id = p_old_game_id` only — `winners` is never referenced by a `delete` in this function
    - Return `table(old_game_id uuid, new_game games)` from `reset_game_to_new`
    - _Requirements: 3.2, 3.3, 3.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 1.1, 1.2_

  - [x] 2.2 Update `confirm_claim` in `supabase/migrations/0005_rpc_lifecycle_and_claims.sql` to populate `ticket_ref`
    - Add `ticket_ref` to `confirm_claim`'s `insert into winners(...)` column list and value list, sourcing it from the confirmed claim's own `v_claim.ticket_ref`
    - _Requirements: 1.1_

  - [x] 2.3 Write a structural lint test for the new RPC functions
    - File `supabase/migrations/rpcActiveGameAndReset.structure.test.ts`
    - Assert `get_active_game` and `generate_new_game_code` and `reset_game_to_new` are all defined in `0006_active_game_and_winner_history.sql`, `reset_game_to_new` is declared `security definer`, contains a `for update` row lock, contains `raise exception 'NOT_AUTHORIZED'`, contains exactly five `delete from` statements scoped by `game_id = p_old_game_id` (`claims`, `marks`, `tickets`, `players`, `called_terms`), and contains no `delete from winners` anywhere in the file
    - Assert `0005_rpc_lifecycle_and_claims.sql`'s `confirm_claim` insert statement's column list includes `ticket_ref`
    - _Requirements: 1.2, 5.5, 5.6, 5.7_

  - [x] 2.4 Write a conditional integration test for atomic reset and winner retention (Properties 1 and 6)
    - File `supabase/migrations/resetGameToNew.integration.test.ts`; same conditional-skip pattern as task 1.3
    - When reachable: seed a game with players/tickets/marks/claims/called_terms and at least one confirmed winner, call `reset_game_to_new` with the correct host secret, then assert: the old game's `winners` rows are byte-identical and present; the old game's `claims`/`marks`/`tickets`/`players`/`called_terms` rows are all gone; exactly one new `games` row exists with a new `id`, `status = 'LOBBY'`, and a `code` never seen before; `active_game_pointer.active_game_id` now equals the new game's `id`; and `get_active_game()` returns that new row
    - **Property 1: Reset retains and never touches prior winners** — Validates Requirements 1.1, 1.2, 1.3, 5.7
    - **Property 6: Reset always produces a fresh, valid, LOBBY-status game and repoints atomically** — Validates Requirements 5.1, 5.2, 5.3, 5.4
    - _Requirements: 1.1, 1.2, 1.3, 5.1, 5.2, 5.3, 5.4, 5.7_

  - [x] 2.5 Write a conditional integration test for host-secret gating on Reset (Property 8)
    - File `supabase/migrations/resetGameToNewAuth.integration.test.ts`; same conditional-skip pattern as task 1.3
    - When reachable: call `reset_game_to_new` with a `host_secret` that does not match the seeded game's stored secret, assert it raises `NOT_AUTHORIZED`, and assert afterward that `active_game_pointer` still designates the same game as before the call and no additional `games` row exists
    - **Property 8: A mismatched host secret rejects Reset without any side effect** — Validates Requirements 5.5, 5.6
    - _Requirements: 5.5, 5.6_

  - [x] 2.6 Write a conditional integration test for New_Game_Code format and uniqueness (Property 7)
    - File `supabase/migrations/generateNewGameCode.integration.test.ts`; same conditional-skip pattern as task 1.3
    - When reachable: call `generate_new_game_code()` a large number of times against a database progressively seeded with each returned code, and assert every returned value matches `^[A-Z]{4}[0-9]{2}$` and none repeats a `games.code` value already present
    - **Property 7: New_Game_Code always matches the established format** — Validates Requirements 5.3
    - _Requirements: 5.3_

- [x] 3. Checkpoint — schema and RPC authoring complete
  - Ensure all structural lint tests pass; run any conditional integration tests and report their skip/pass status explicitly (a skip is not a pass); ask the user if questions arise

### Group B — Client-side resolution and following of the Active_Game

- [x] 4. Add `realtimeClient.ts` exports for the Active_Game pointer and winner history
  - [x] 4.1 Add `getActiveGame`, `resetGameToNew`, `subscribeToActiveGamePointer`, and `fetchAllWinnersWithGames` to `src/state/realtimeClient.ts`
    - Implement each exactly as specified in design.md: `getActiveGame` returns `undefined` when `get_active_game()` yields no row; `resetGameToNew` calls the `reset_game_to_new` RPC and unwraps its single returned row; `subscribeToActiveGamePointer` subscribes to `postgres_changes` on `active_game_pointer` with no filter and invokes its callback with the new `active_game_id` (`string | null`); `fetchAllWinnersWithGames` runs the two unfiltered `select`s against `winners` and `games` in parallel and returns both raw row arrays
    - _Requirements: 2.1, 2.6, 3.2, 3.3, 3.4, 5.1, 5.5, 6.1, 6.5_

  - [x] 4.2 Write unit tests for the four new `realtimeClient.ts` exports using the existing mock Supabase client
    - Using `src/state/testSupport/mockSupabaseClient.ts` (Module 6): assert `getActiveGame` returns `undefined` when the mocked `get_active_game` RPC resolves with zero rows, and returns the row when one is queued
    - Assert `resetGameToNew` calls the `reset_game_to_new` RPC with `p_old_game_id`/`p_host_secret` and unwraps `{old_game_id, new_game}` from the first returned row
    - Assert `subscribeToActiveGamePointer` registers exactly one `postgres_changes` listener on `active_game_pointer` with no filter, and that firing a queued change invokes the callback with the new row's `active_game_id`
    - Assert `fetchAllWinnersWithGames` issues one unfiltered `select` against `winners` and one against `games`, and returns both result sets
    - _Requirements: 2.1, 2.6, 3.2, 3.4, 6.1_

- [ ] 5. Extend `gameSessionReducer.ts` and `gameSessionInitialState.ts` for `NO_ACTIVE_GAME` and Local Fallback history
  - [x] 5.1 Add the `NO_ACTIVE_GAME` action and `hasActiveGame` flag
    - Add `{ type: 'NO_ACTIVE_GAME' }` to `GameSessionAction` in `src/state/gameSessionReducer.ts`; its case resets `state` to `gameSessionInitialState` (empty `game.id` sentinel, unchanged from today's falsy-id convention) while leaving `currentPlayerId` untouched
    - Thread a `hasActiveGame: boolean` flag through `GameSessionContextValue` (`src/state/GameSessionContext.tsx`), set to `false` on `NO_ACTIVE_GAME` and `true` on any successful `HYDRATE_FROM_REMOTE`
    - _Requirements: 3.4, 4.3_

  - [-] 5.2 Add `winnerHistory` to `GameSessionState` and rework the Local Fallback `RESET_GAME` case
    - Add `winnerHistory: Winner[]` to `GameSessionState` in `src/state/gameSessionInitialState.ts`, defaulting to `[]`
    - Add `generateLocalGameCode()` to `gameSessionInitialState.ts`, matching the `4 uppercase letters + 2 digits` format, and give `createSeedGame` an optional `code` parameter defaulting to `SEED_GAME_CODE`
    - Update `RESET_GAME` in `src/state/gameSessionReducer.ts` to fold `state.winners` into `winnerHistory` and reseed `game` via `createSeedGame(generateLocalGameCode())`, per design.md's Local Fallback section
    - _Requirements: 9.1, 9.3_

  - [x] 5.3 Write reducer unit tests for `NO_ACTIVE_GAME`
    - Assert dispatching `NO_ACTIVE_GAME` from an arbitrary populated state resets `game`/`players`/`tickets`/`marks`/`claims`/`winners` to initial values and leaves `currentPlayerId` unchanged
    - _Requirements: 3.4, 4.3_

  - [x] 5.4 Write a property test for Local Fallback winner retention across resets (Property 13)
    - File `src/state/gameSessionReducer.resetGame.winnerHistory.test.ts`; tag `// Feature: winner-history-and-game-reset, Property 13: {title}`; ≥100 iterations; generate arbitrary sequences of "add winners then RESET_GAME" dispatches
    - **Property 13: Local Fallback retains every prior winner across any number of resets** — Validates Requirements 9.1
    - _Requirements: 9.1_

  - [x] 5.5 Write a property test for Local Fallback reset producing a fresh, correctly formatted game identity (Property 14)
    - File `src/state/gameSessionReducer.resetGame.newIdentity.test.ts`; tag `// Feature: winner-history-and-game-reset, Property 14: {title}`; ≥100 iterations
    - **Property 14: Local Fallback reset always produces a fresh game identity and correctly formatted code** — Validates Requirements 9.3
    - _Requirements: 9.3_

- [x] 6. Checkpoint — reducer and Local Fallback extensions integrate
  - Ensure all tests pass, ask the user if questions arise

- [x] 7. Rework `GameSessionContext.tsx`'s mount effect to follow the Active_Game via the pointer
  - [x] 7.1 Replace the `get_or_create_game(SEED_GAME_CODE)` mount call with the pointer-follow effect
    - Implement `hydrateForGame` and the mount effect exactly as specified in design.md: resolve via `getActiveGame()`; on a resolved game, hydrate state and open a per-game channel via the existing `subscribeToGame`; on no resolved game, dispatch `NO_ACTIVE_GAME`; subscribe to `subscribeToActiveGamePointer` for the lifetime of the provider, unsubscribing the old per-game channel before/while opening the new one on every pointer change, and treating a `newActiveGameId === gameIdRef.current` announcement as a no-op
    - Ensure the cleanup function unsubscribes both the per-game channel and the pointer channel
    - _Requirements: 3.2, 3.3, 4.1, 4.2, 4.3, 4.4, 6.1, 6.2, 6.4, 8.1, 8.2_

  - [x] 7.2 Wire the Host Dashboard's Reset action through `resetGameToNew`
    - Update the context's `RESET_GAME`-dispatching call site so that, when a Supabase client is configured, it calls `resetGameToNew(gameIdRef.current, hostSecret)` instead of the old `reset_game` RPC wrapper, and relies on the pointer-follow effect (task 7.1) — not a direct local dispatch of the new game — to hydrate the switched-to game once the pointer-change event arrives
    - When no Supabase client is configured, keep dispatching the existing optimistic `RESET_GAME` action unchanged (now handled by task 5.2's reworked reducer case)
    - _Requirements: 5.1, 9.3_

  - [x] 7.3 Write integration tests for the pointer-follow effect using the mock Supabase client
    - Using the mock client: assert mount with `get_active_game` resolving to a game hydrates state and opens exactly one per-game channel scoped to that game's id
    - Assert mount with `get_active_game` resolving to no row dispatches `NO_ACTIVE_GAME` and opens no per-game channel, but still opens the pointer channel
    - Assert firing a pointer-change event with a new `active_game_id` unsubscribes the old per-game channel before/while subscribing a new one scoped to the new id, and that a subsequent per-game event tagged with the *old* game id no longer results in a `SYNC_REMOTE` dispatch (**Property 10: events tagged with a superseded game id are never applied after a switch** — Validates Requirements 6.3)
    - Assert the post-switch state's `game`/`players`/`tickets`/`marks`/`claims`/`winners` equal exactly the new snapshot's values with no field surviving from the prior game (**Property 11: switching Active_Game fully replaces displayed per-game state with no residual fields** — Validates Requirements 4.3, 6.4, 8.1, 8.2)
    - Assert firing a pointer-change event announcing `null` dispatches `NO_ACTIVE_GAME` and unsubscribes the current per-game channel
    - _Requirements: 4.3, 6.1, 6.2, 6.3, 6.4, 8.1, 8.2_

  - [x] 7.4 Write a property test for the channel-swap invariant (Property 9)
    - File `src/state/GameSessionContext.pointerSwap.test.ts`; tag `// Feature: winner-history-and-game-reset, Property 9: {title}`; ≥100 iterations; generate arbitrary sequences of pointer-change events (including repeats and nulls) against the mock client's channel bookkeeping
    - **Property 9: A pointer change always yields exactly one live subscription, scoped to the new game** — Validates Requirements 6.1, 6.2
    - _Requirements: 6.1, 6.2_

- [x] 8. Checkpoint — pointer-follow context integrates with mocked Supabase
  - Ensure all tests pass, ask the user if questions arise

### Group C — Winner_History UI, Presentation View, and Player Join regression guarantees

- [x] 9. Implement `hostWinnerHistoryViewModel.ts`
  - [x] 9.1 Create `src/pages/HostDashboard/hostWinnerHistoryViewModel.ts`
    - Implement `WinnerHistoryRowViewModel`, `WinnerHistoryGroupViewModel`, and `toWinnerHistoryViewModel(winners, games)` exactly as specified in design.md: groups by `gameId`, orders groups by descending `gameCreatedAt`, labels each group with that game's own `code`/`createdAt`, and narrows each row to `prizeLabel`/`playerName`/`ticketRef`/`confirmedAt` only
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7_

  - [x] 9.2 Write a property test for complete, non-duplicated winner coverage (Property 2)
    - File `src/pages/HostDashboard/hostWinnerHistoryViewModel.coverage.test.ts`; tag `// Feature: winner-history-and-game-reset, Property 2: {title}`; ≥100 iterations; generate arbitrary sets of winners spanning arbitrary numbers of games
    - **Property 2: Winner_History includes every winner across every game** — Validates Requirements 2.1, 2.6
    - _Requirements: 2.1, 2.6_

  - [x] 9.3 Write a property test for group ordering and labeling (Property 3)
    - File `src/pages/HostDashboard/hostWinnerHistoryViewModel.ordering.test.ts`; tag `// Feature: winner-history-and-game-reset, Property 3: {title}`; ≥100 iterations; generate arbitrary games with distinct `createdAt` values and arbitrary winner distributions
    - **Property 3: Winner_History groups are ordered newest-game-first and correctly labeled** — Validates Requirements 2.2, 2.4
    - _Requirements: 2.2, 2.4_

  - [x] 9.4 Write a property test for row field narrowing and employee/demo-id exclusion (Property 4)
    - File `src/pages/HostDashboard/hostWinnerHistoryViewModel.fields.test.ts`; tag `// Feature: winner-history-and-game-reset, Property 4: {title}`; ≥100 iterations; generate arbitrary `Winner` values
    - **Property 4: Winner_History rows carry exactly the required display fields, never an employee/demo id** — Validates Requirements 2.3, 2.7
    - _Requirements: 2.3, 2.7_

  - [x] 9.5 Write unit tests for both Supabase-row and Local-Fallback inputs feeding the same view-model
    - Assert `toWinnerHistoryViewModel` produces equivalent grouped output whether fed mapped Supabase `winners`/`games` rows or a Local-Fallback-shaped `winnerHistory` + current-session `winners` + locally-tracked past-game summaries
    - _Requirements: 9.2_

- [x] 10. Wire the Winner_History section into `HostDashboard.tsx`
  - [x] 10.1 Add the second, unfiltered winners subscription and render the Winner_History section
    - Add the independent effect specified in design.md: on mount, call `fetchAllWinnersWithGames()`, map rows, feed `toWinnerHistoryViewModel`, store the result; subscribe (no filter) to `INSERT` events on `winners` via a second Realtime channel and `refetch()` on each event; unsubscribe on unmount
    - When Supabase is not configured, feed the same view-model from `state.winnerHistory` concatenated with `state.winners` and a locally-tracked list of past local games' `{id, code, createdAt}`, per design.md's Local Fallback section
    - Render a "Winner_History" section listing each group's game code/creation timestamp header followed by its rows' prize label, player name, ticket reference, and confirmation timestamp
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 9.2_

  - [x] 10.2 Write component tests for the Winner_History section's rendering and live update
    - Assert the section renders grouped/ordered entries matching a seeded set of winners/games (via the mock client), and that firing a mocked `INSERT` event on `winners` causes the section to refetch and display the new entry without a manual refresh
    - Assert no rendered Winner_History row or group label ever contains an `employeeDemoId`-shaped value, for any seeded winner/player combination
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7_

- [x] 11. Checkpoint — Host Dashboard Winner_History integrates
  - Ensure all tests pass, ask the user if questions arise

- [x] 12. Confirm and, if needed, adjust `PresentationView.tsx`'s mount logic to follow the Active_Game via context
  - [x] 12.1 Verify `PresentationView.tsx` already resolves its game exclusively through `useGameSession()` (the shared `GameSessionContext`) and has no separate mount-time `get_or_create_game`/`getActiveGame` call of its own
    - If a separate mount-time resolution path is found, replace it so `PresentationView.tsx` relies entirely on the context's pointer-follow effect (task 7.1) for both initial resolution and live pointer-change updates, matching Host Dashboard's behavior
    - Confirm the QR code / join instructions component already renders `game.code` reactively from context state, so a pointer-driven `HYDRATE_FROM_REMOTE` naturally updates it with no additional wiring
    - _Requirements: 4.2, 6.1, 6.4, 6.5, 8.1, 8.2_

  - [x] 12.2 Extend `PresentationView.test.tsx` with a regression assertion that Winner_History is never rendered
    - Add a sibling assertion alongside the existing "PresentationView never exposes an Employee/Demo ID (Req 17.3)" test block confirming no Winner_History markup, group header, or row text appears anywhere in `PresentationView.tsx`'s rendered output, for both a Supabase-configured and a Local-Fallback render
    - Re-run the existing Req 17.3 "never exposes an Employee/Demo ID" assertions unmodified to confirm they still pass after the mount-effect changes from task 12.1
    - _Requirements: 2.5, 9.4_

  - [x] 12.3 Write a component test that the QR/join-code display updates live on a pointer change
    - Using the mock client, seed an initial Active_Game, render `PresentationView`, fire a pointer-change event to a new game, and assert the rendered QR/join-code text updates to the new game's `code` without a remount
    - _Requirements: 8.1, 8.2_

  - [x] 12.4 Write a property test for Player Join's code field being unaffected by pointer changes (Property 12)
    - File `src/pages/PlayerJoin/PlayerJoin.pointerIndependence.test.tsx`; tag `// Feature: winner-history-and-game-reset, Property 12: {title}`; ≥100 iterations; generate arbitrary sequences of pointer-change events fired while `PlayerJoin` is mounted with an arbitrary typed code value
    - **Property 12: Player Join's code field is never altered by a pointer change** — Validates Requirements 7.2, 7.3
    - _Requirements: 7.2, 7.3_

  - [x] 12.5 Write a regression test confirming `PlayerJoin.tsx` never imports the new pointer functions
    - Static-source assertion (reading `PlayerJoin.tsx`'s own module text, or an import-graph check consistent with existing conventions) that `getActiveGame`, `subscribeToActiveGamePointer`, and `resetGameToNew` are never imported by `PlayerJoin.tsx`, and that its join call still resolves a game only via a client-submitted code through the existing `join_game` RPC path
    - _Requirements: 7.1, 7.4_

- [x] 13. Checkpoint — Presentation View and Player Join regressions confirmed
  - Ensure all tests pass, ask the user if questions arise

### Cross-cutting regression and end-to-end checkpoints

- [x] 14. Write integration tests for multi-tab pointer propagation and cross-reset winner accumulation
  - [x] 14.1 Write an integration test for a Reset propagating live to multiple open Host/Presentation clients
    - Using the mock client's shared channel-firing mechanism, simulate two independently-mounted `GameSessionContext` instances (representing two open tabs) both subscribed to the same mocked pointer channel; fire one simulated `reset_game_to_new` response followed by the corresponding pointer-change event; assert both instances' state converges on the new game with no stale per-game data remaining in either
    - _Requirements: 6.1, 6.2, 6.4, 6.5_

  - [x] 14.2 Write an integration test confirming winners survive multiple consecutive resets
    - Simulate three consecutive reset cycles (each adding at least one winner to the then-current game before resetting), and assert `fetchAllWinnersWithGames`-equivalent state (or, for Local Fallback, `winnerHistory` plus current `winners`) contains every winner from all three games afterward, correctly grouped by their own owning game
    - _Requirements: 1.1, 1.3, 9.1_

  - [x] 14.3 Write an integration test confirming Winner_History shows entries from more than one past game after resets
    - Using the view-model from task 9.1 fed by the accumulated state from task 14.2, assert the rendered/derived Winner_History groups include at least two distinct game groups, each correctly labeled with its own game's code and creation timestamp
    - _Requirements: 2.1, 2.2, 2.4_

- [x] 15. Final checkpoint — full verification
  - Run the full test suite and confirm zero failures (conditional integration tests from Group A report explicit skip status when no local Postgres instance is reachable, and this is not treated as a failure)
  - Run the TypeScript project build (`tsc -b`) and confirm zero type errors
  - Run the production build (`vite build`) and confirm it succeeds
  - Ask the user if questions arise

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; core implementation tasks are never marked optional.
- Conditional integration tests (Properties 1, 5, 6, 8 and the schema/RPC structural checks) require a reachable local Supabase CLI/Postgres instance and are skipped, not failed, when none is available — matching Module 6's established convention.
- Each task references specific requirements for traceability; checkpoints validate incremental integration before moving to the next group.
- `reset_game` (the old RPC) is left in place in `0005_rpc_lifecycle_and_claims.sql` per design.md's decision table (nothing else in this module drops it), but no client code path calls it once task 7.2 is complete.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.6"] },
    { "id": 3, "tasks": ["4.1", "5.1", "5.2"] },
    { "id": 4, "tasks": ["4.2", "5.3", "5.4", "5.5", "7.1"] },
    { "id": 5, "tasks": ["7.2", "9.1"] },
    { "id": 6, "tasks": ["7.3", "7.4", "9.2", "9.3", "9.4", "9.5", "10.1"] },
    { "id": 7, "tasks": ["10.2", "12.1"] },
    { "id": 8, "tasks": ["12.2", "12.3", "12.4", "12.5"] },
    { "id": 9, "tasks": ["14.1", "14.2"] },
    { "id": 10, "tasks": ["14.3"] }
  ]
}
```
