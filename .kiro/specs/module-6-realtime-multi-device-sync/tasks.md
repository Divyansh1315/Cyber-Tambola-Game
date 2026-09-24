# Implementation Plan: Module 6 — Real Multi-Device Realtime Synchronization

## Overview

This plan implements Module 6 in dependency order, and it is organized into four
distinct groups that reflect a hard boundary in what a coding agent can actually
execute in this environment:

- **Group A — SQL authoring (agent-executable, file-writing only).** Tasks 1-5 write
  the Postgres schema, RLS policies, and RPC functions as version-controlled `.sql`
  migration files. Writing SQL to disk is ordinary file authorship a coding agent can
  do. What an agent in this environment *cannot* do is provision a live Supabase
  project or run these migrations against one — there is no hosted Supabase project,
  no Supabase CLI session, and no live Postgres instance available here. Every SQL
  task is therefore scoped to "author and locally lint/structure-check the SQL text,"
  not "deploy it." Where a local Supabase CLI/Docker Postgres instance happens to be
  available in the execution environment, integration tests against it are included
  as tasks explicitly marked conditional; they must be skipped (not faked) if no such
  instance is reachable.
- **Group B — Client-side TypeScript integration (agent-executable, fully testable).**
  Tasks 6-14 implement `realtimeClient.ts`, the reducer's `SYNC_REMOTE`/
  `HYDRATE_FROM_REMOTE`/`ROLLBACK_OPTIMISTIC` extensions, `GameSessionContext`
  restructuring, and the four screens' RPC wiring. All of this is testable today with
  the existing Vitest/fast-check/testing-library stack by mocking the Supabase client
  at the `realtimeClient.ts` module boundary — the same pattern used for any other
  external dependency in this codebase.
- **Group C — Environment configuration.** Task 15 covers `.env.example`,
  `getSupabaseConfig`, and the Host Dashboard's local-only-mode notice (Requirement 18).
- **Group D — Manual steps and acceptance runbook (NOT agent-executable, NOT claimed
  as automated).** The final section is a runbook the user performs after
  implementation: creating the real Supabase project, applying the migrations to it,
  populating `.env.local`, and walking through the live multi-device, disconnect/
  reconnect, and simultaneous-player scenarios from Requirements 21-23. No task in
  this section is implemented by the coding agent, and none should ever be checked
  off by an agent claiming to have "run" a live multi-device test — that is
  structurally impossible without real hardware and a live network, and design.md's
  own Definition of Done treats this as a separate, explicit deliverable.

The project already has Vitest, @testing-library/react, @testing-library/user-event,
@testing-library/jest-dom, and fast-check installed and wired from prior modules.
`@supabase/supabase-js` is a new runtime dependency introduced in task 6.1. Test
invocation uses the single-run form (`vitest run` / `npm test`), never watch mode.
Property-based tests reference the 9 correctness properties in `design.md` and tag
each test with the feature name and property number, exactly per the established
convention. Properties 1, 3, 5, and 8 are database-level guarantees (constraints, row
locks, `SECURITY DEFINER` checks) that cannot be meaningfully exercised by a pure-JS
unit test — per design.md's Testing Strategy, these become **conditional integration
tests** against a local Supabase CLI/Postgres instance (tasks 4.2, 4.4, 5.4), run only
when such an instance is reachable in the execution environment, and skipped
(reported as skipped, not passed) otherwise. Properties 2, 4, 6, 7, and 9 are
reducer-level or pure-mapping properties fully testable with mocks and are implemented
as ordinary property tests in Group B.

## Tasks

### Group A — Schema, RLS, and RPC authoring (SQL files only)

- [x] 1. Author the core schema migration
  - [x] 1.1 Create `supabase/migrations/0001_schema.sql`
    - Write the `games`, `called_terms`, `players`, `tickets`, `marks`, `claims`, and `winners` `CREATE TABLE` statements exactly as specified in design.md's "Database schema" section, including all listed columns, `CHECK` constraints, `UNIQUE` constraints, the `employee_demo_id_normalized` generated column, and the `updated_at` trigger function/triggers for each table
    - Add the `alter publication supabase_realtime add table games, called_terms, tickets, marks, claims, winners;` statement
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

  - [x] 1.2 Write a structural lint test for the schema migration
    - File `supabase/migrations/schema.structure.test.ts` (runs under Vitest against the raw SQL text, not a live database); assert the file contains exactly one `CREATE TABLE` per required table name, a `UNIQUE` constraint or `PRIMARY KEY` covering each of the pairs/singletons named in Requirements 1.2-1.7 (`(game_id, term_id)`, `(game_id, employee_demo_id_normalized)`, `player_id`, `(player_id, ticket_id, term_id)`, `(game_id, prize_id)`), and the publication statement naming all six shared tables
    - This is a text-pattern check, not a Postgres parse — it catches an omitted constraint or table before any live database is involved
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

- [x] 2. Author the Row Level Security migration
  - [x] 2.1 Create `supabase/migrations/0002_rls.sql`
    - Enable RLS on all seven tables and add the seven `anon`-read `SELECT` policies exactly as specified in design.md's "Row Level Security policies" section
    - Add no `INSERT`/`UPDATE`/`DELETE` policy for `anon` on any table, and include a SQL comment stating this omission is deliberate (default-deny) per Requirement 2.3
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]* 2.2 Write a structural lint test for the RLS migration
    - File `supabase/migrations/rls.structure.test.ts`; assert `ENABLE ROW LEVEL SECURITY` appears for all seven table names, exactly seven `for select to anon` policies exist, and no `for insert`/`for update`/`for delete` policy naming role `anon` appears anywhere in the file
    - _Requirements: 2.1, 2.2, 2.3_

- [x] 3. Author the join and ticket-assignment RPC functions
  - [x] 3.1 Create `supabase/migrations/0003_rpc_join_and_tickets.sql`
    - Write `get_or_create_game(p_code text)` and `join_game(p_game_code text, p_display_name text, p_employee_demo_id text)` exactly as specified in design.md, including the existing-player restore branch, the `GAME_NOT_FOUND`/`GAME_COMPLETED` exceptions, and the call into `assign_ticket`
    - Write `assign_ticket(p_game_id uuid, p_player_id uuid, p_active_term_ids text[])` exactly as specified, including the Fisher-Yates-equivalent shuffle, the signature-collision retry loop bounded at 50 attempts, and the `TICKET_UNIQUE_RETRY_EXCEEDED`/`INSUFFICIENT_ACTIVE_TERMS` exceptions
    - All three functions declared `security definer`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 3.2 Write a structural lint test for the join/ticket RPC migration
    - File `supabase/migrations/rpcJoinTickets.structure.test.ts`; assert `security definer` appears on all three function definitions, `raise exception 'GAME_NOT_FOUND'` and `raise exception 'GAME_COMPLETED'` appear in `join_game`, and `raise exception 'TICKET_UNIQUE_RETRY_EXCEEDED'` appears in `assign_ticket`
    - _Requirements: 3.2, 3.3, 5.4_

- [x] 4. Author the next-word and mark-submission RPC functions
  - [x] 4.1 Create `supabase/migrations/0004_rpc_word_and_marks.sql`
    - Write `call_next_word(p_game_id uuid, p_host_secret uuid, p_active_term_ids text[])` exactly as specified in design.md, including the `for update` row lock, the `host_secret` check raising `NOT_AUTHORIZED`, the bank-exhausted branch transitioning to `COMPLETED`, and the `called_terms` insert preceding the `games` update
    - Write `submit_mark(p_player_id uuid, p_term_id text)` exactly as specified, mirroring `validateMarkAttempt`'s five gates (`NO_CURRENT_PLAYER`, `TICKET_NOT_FOUND`, `TERM_NOT_ON_TICKET`, `TERM_NOT_REVEALED`, `GAME_COMPLETED`) before the insert, relying on the `marks` table's `UNIQUE(player_id, ticket_id, term_id)` constraint as the duplicate-mark backstop
    - Both functions declared `security definer`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 8.1, 8.2, 8.3, 9.1, 9.2, 9.3, 10.1, 10.2, 10.3, 10.4_

  - [ ]* 4.2 Write conditional integration tests for `call_next_word` concurrency (Property 3)
    - File `supabase/migrations/callNextWord.integration.test.ts`; **conditional**: at test-file setup, probe for a reachable local Supabase CLI/Postgres instance via a connection-string environment variable (e.g. `SUPABASE_TEST_DB_URL`); if unset or unreachable, call `describe.skip` for the whole suite and log a one-line explanation, rather than reporting a false pass
    - When reachable: apply migrations 0001-0004 against a fresh schema, create a game, fire two concurrent `call_next_word` calls with `Promise.all` (no `await` between them), and assert `called_terms` for that game has zero duplicate `term_id` values afterward
    - **Property 3: A term is never called twice in the same game** — Validates Requirements 7.1, 7.2, 9.1, 9.2
    - _Requirements: 9.1, 9.2_

  - [ ]* 4.3 Write conditional integration test for `submit_mark`'s gates (Property 4, negative case)
    - File `supabase/migrations/submitMark.integration.test.ts`; same conditional-skip pattern as 4.2
    - When reachable: assert `submit_mark` rejects with `TERM_NOT_REVEALED` for a term not yet in `called_terms`, rejects with `TERM_NOT_ON_TICKET` for a term absent from the player's ticket cells, and accepts exactly once then leaves a second identical call a no-op-equivalent (unique violation) with no second row created
    - **Property 4: A mark is accepted if and only if all five gates pass** — Validates Requirements 8.1, 8.2, 8.3
    - _Requirements: 8.1, 8.2, 8.3_

  - [ ]* 4.4 Write conditional integration test for host-secret rejection (Property 8)
    - File `supabase/migrations/hostSecret.integration.test.ts`; same conditional-skip pattern as 4.2
    - When reachable: call `call_next_word` with a wrong `host_secret` and assert it raises `NOT_AUTHORIZED` with `called_terms`/`games` unchanged afterward
    - **Property 8: Host-only RPCs reject every call without a valid host_secret** — Validates Requirements 10.1, 10.2
    - _Requirements: 10.1, 10.2_

- [x] 5. Author the remaining host-lifecycle and claim/winner RPC functions
  - [x] 5.1 Create `supabase/migrations/0005_rpc_lifecycle_and_claims.sql`
    - Write `pause_game`, `resume_game`, `end_game`, `reset_game` exactly mirroring `gameSessionReducer.ts`'s `PAUSE_GAME`/`RESUME_GAME`/`END_GAME`/`RESET_GAME` cases, each checking `host_secret` before any write and each declared `security definer`
    - Write `submit_claim(p_player_id uuid, p_prize_id text)` mirroring `claimEngine.ts`'s `validatePrizeClaim` gate chain (game/player/ticket existence and ownership, prize category validity, duplicate-active-claim and resubmission-limit checks against `claims`, prize-closed check against `winners`, eligibility computed from that player's own `marks`), inserting a `VALID`/`PENDING` or `INVALID`/`PENDING` row per gate outcome
    - Write `confirm_claim(p_claim_id uuid, p_host_secret uuid)` and `reject_claim(p_claim_id uuid, p_host_secret uuid, p_reason text)` mirroring `canConfirmClaim`/the reducer's `REJECT_CLAIM` case, each checking `host_secret` first
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 12.1, 12.2, 12.3, 12.4, 12.5, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

  - [ ]* 5.2 Write a structural lint test for the lifecycle/claims RPC migration
    - File `supabase/migrations/rpcLifecycleClaims.structure.test.ts`; assert `security definer` appears on all six function definitions and a `host_secret`-comparison expression appears in `pause_game`, `resume_game`, `end_game`, `reset_game`, `confirm_claim`, and `reject_claim`
    - _Requirements: 10.1_

  - [ ]* 5.3 Write conditional integration test for `confirm_claim`'s at-most-one-winner guarantee (Property 5)
    - File `supabase/migrations/confirmClaim.integration.test.ts`; same conditional-skip pattern as 4.2
    - When reachable: create two players each with a valid, pending claim on the same prize for the same game; confirm the first (assert a `winners` row is created); attempt to confirm the second and assert it is rejected (e.g. `PRIZE_CLOSED`) with no second `winners` row created
    - **Property 5: At most one winner per prize per game** — Validates Requirements 6.5, 13.1, 13.3
    - _Requirements: 6.5, 13.1, 13.3_

  - [ ]* 5.4 Write conditional integration test for the SQL/TypeScript ticket-shape equivalence (Property 9)
    - File `supabase/migrations/ticketEquivalence.integration.test.ts`; same conditional-skip pattern as 4.2
    - When reachable: run `assign_ticket` against a fixed 30-term active-id array fixture and, in the same test, run the existing `generateTicket` (TypeScript, imported from `src/utils/ticketGenerator.ts`) against the same fixture; assert both outputs contain exactly 15 distinct term ids drawn only from the active set, arranged into a 3-row-by-5-column grid with no duplicate cell positions
    - **Property 9: SQL ticket assignment produces structurally equivalent tickets to the TypeScript generator** — Validates Requirements 5.2, 25.9
    - _Requirements: 5.2, 25.9_

- [x] 6. Checkpoint — schema, RLS, and RPC authoring complete
  - Ensure all structural lint tests pass; run any conditional integration tests and report their skip/pass status explicitly (do not treat a skip as a pass)
  - Ask the user if questions arise

### Group B — Client-side TypeScript integration

- [x] 7. Add the Supabase client dependency and mocked-client test infrastructure
  - [x] 7.1 Add `@supabase/supabase-js` to `package.json` dependencies (pinned exact or caret-minor version matching the version researched in design.md) and run install
    - _Requirements: 18.1_

  - [x] 7.2 Create `src/state/testSupport/mockSupabaseClient.ts`
    - Export a `createMockSupabaseClient()` factory returning a fake object shaped like the subset of the `supabase-js` client `realtimeClient.ts` actually calls (`.channel(name).on(event, filter, cb).subscribe()`, `.rpc(name, args)`, `.from(table).select()...`), recording every `.rpc` call's name/args and letting a test script queued responses/errors and manually fire a queued realtime callback
    - Export a `mockGetSupabaseClient` helper that can be substituted for `realtimeClient.ts`'s `getSupabaseClient` export in tests (via the project's existing mocking convention, e.g. `vi.mock`), so reducer-level and component-level tests never need a real network call or real Supabase project
    - _Requirements: 18.1_

  - [x] 7.3 Write unit tests for the mock client fixture itself
    - Assert queued RPC responses/errors resolve/reject in call order, assert a manually-fired realtime callback delivers the exact `RemoteChange` shape passed to it, and assert recorded `.rpc` calls capture the name and args exactly as invoked
    - _Requirements: 18.1_

- [x] 8. Implement `realtimeClient.ts`
  - [x] 8.1 Create `src/state/realtimeClient.ts`
    - Implement `getSupabaseConfig()` reading `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` from `import.meta.env`, returning `null` when either is absent, exactly as specified in design.md
    - Implement `getSupabaseClient()` as a lazily-created singleton, returning `null` when `getSupabaseConfig()` returns `null`
    - Implement the `RemoteChange` interface and `subscribeToGame(gameId, onChange)` exactly as specified, subscribing to `postgres_changes` on all six shared tables filtered by `game_id=eq.<id>` (and `id=eq.<id>` for the `games` table itself, per design.md's explicit callout), returning `null` when no client is configured
    - Implement thin RPC wrapper functions for every RPC in Group A (`getOrCreateGame`, `joinGame`, `callNextWord`, `pauseGame`, `resumeGame`, `endGame`, `resetGame`, `submitMark`, `submitClaim`, `confirmClaim`, `rejectClaim`), each calling `getSupabaseClient()?.rpc(...)` and throwing a typed error carrying the RPC's exception code on failure
    - _Requirements: 18.1, 18.2, 18.4_

  - [ ]* 8.2 Write unit tests for `getSupabaseConfig`/`getSupabaseClient` fallback behavior
    - Assert `getSupabaseConfig()` returns `null` when either env var is unset and a populated object when both are set (using Vite's env-mocking convention for `import.meta.env`)
    - Assert `getSupabaseClient()` returns `null` without throwing when unconfigured, and returns the same singleton instance across repeated calls when configured
    - _Requirements: 18.4_

  - [ ]* 8.3 Write unit tests for `subscribeToGame`'s table/filter wiring
    - Using the mock client from task 7.2, assert `subscribeToGame` registers exactly one `postgres_changes` listener per one of the six shared tables, each filtered by the given `gameId` (`games` filtered by `id`, the rest by `game_id`), and that firing a queued change invokes the `onChange` callback with the expected `RemoteChange` shape
    - _Requirements: 26.3_

- [x] 9. Extend the reducer with `SYNC_REMOTE`, `HYDRATE_FROM_REMOTE`, and `ROLLBACK_OPTIMISTIC`
  - [x] 9.1 Update `src/state/gameSessionReducer.ts`
    - Add `SYNC_REMOTE`, `HYDRATE_FROM_REMOTE`, and `ROLLBACK_OPTIMISTIC` to the `GameSessionAction` union, replacing `SYNC_STATE`'s role for all Supabase-backed fields (`game`, `players`, `tickets`, `marks`, `claims`, `winners`) while leaving `currentPlayerId` untouched by all three
    - Implement the `SYNC_REMOTE` case exactly as specified in design.md: `games` rows replace `state.game`; `called_terms` rows fold into `state.game.revealedTermIds` via set-union; `tickets`/`marks`/`claims`/`winners` rows upsert-by-id into their respective arrays via a shared `upsertById` helper; `DELETE` events on `marks` are a defensive no-op
    - Implement `HYDRATE_FROM_REMOTE` as a one-shot whole-slice replace of `game`/`players`/`tickets`/`marks`/`claims`/`winners` from a provided snapshot, leaving `currentPlayerId` untouched
    - Implement `ROLLBACK_OPTIMISTIC` removing a single optimistic-only entry (by a caller-supplied predicate/id) from the relevant local collection when its matching RPC call is rejected, leaving `currentPlayerId` untouched
    - _Requirements: 14.1, 14.2, 14.3, 15.2, 15.3, 16.1, 16.2, 16.3, 16.4_

  - [ ]* 9.2 Write property tests for `SYNC_REMOTE`'s currentPlayerId invariance and upsert behavior (Properties 7 and part of 6)
    - File `src/state/gameSessionReducer.syncRemote.test.ts`; tag `// Feature: module-6-realtime-multi-device-sync, Property {n}: {title}`; ≥100 iterations; generate synthetic `RemoteChange` sequences across all six tables and event types
    - **Property 7: currentPlayerId is never mutated by a remote change** — Validates Requirements 15.2
    - **Property 6 (upsert half): SYNC_REMOTE applies each change as an upsert-by-id, never a wholesale collection replacement** — Validates Requirements 16.2
    - _Requirements: 15.2, 16.2_

  - [ ]* 9.3 Write property test for `HYDRATE_FROM_REMOTE`'s currentPlayerId invariance (Property 7, continued)
    - File `src/state/gameSessionReducer.hydrateFromRemote.test.ts`; tag `// Feature: module-6-realtime-multi-device-sync, Property 7: {title}`; ≥100 iterations
    - **Property 7: currentPlayerId is never mutated by a remote change** — Validates Requirements 15.3
    - _Requirements: 15.3_

  - [ ]* 9.4 Write property test for the row-mapping round-trip (`mapRowToGame`/`mapRowToTicket`/`mapRowToMark`/`mapRowToClaim`/`mapRowToWinner`)
    - File `src/state/gameSessionReducer.rowMapping.test.ts`; tag `// Feature: module-6-realtime-multi-device-sync, Property {n}: {title}`; ≥100 iterations
    - **Property (mapping round-trip): for any valid row shape from each table, mapping into the existing domain type and back preserves every field the existing UI selectors read** — Validates Requirements 1.8, 16.1
    - _Requirements: 1.8, 16.1_

- [x] 10. Checkpoint — reducer extension integrates
  - Ensure all tests pass, ask the user if questions arise

- [x] 11. Restructure `GameSessionContext.tsx` for fetch/subscribe/reconcile
  - [x] 11.1 Update `src/state/GameSessionContext.tsx`
    - Add the mount-time effect that, only when `getSupabaseClient()` returns non-null, calls `get_or_create_game(SEED_GAME_CODE)`, fetches the full current game state (game, called_terms→revealedTermIds, players, tickets, marks, claims, winners), dispatches `HYDRATE_FROM_REMOTE`, then calls `subscribeToGame` and dispatches `SYNC_REMOTE` for each incoming change; unsubscribe on unmount
    - Wrap every host-only and player-mutating dispatch call site (`START_GAME`, `CALL_NEXT_WORD`, `PAUSE_GAME`, `RESUME_GAME`, `END_GAME`, `RESET_GAME`, `JOIN_PLAYER`/`RESTORE_PLAYER`, `MARK_TERM`, `SUBMIT_PRIZE_CLAIM`, `CONFIRM_CLAIM`, `REJECT_CLAIM`) with: dispatch the existing optimistic action first (unchanged), then call the matching `realtimeClient.ts` RPC wrapper; on RPC rejection, dispatch `ROLLBACK_OPTIMISTIC` for the just-added optimistic entry
    - Keep the existing `currentPlayerId` persistence effect, the dev-fallback envelope-persistence effect, and the `BroadcastChannel` effect unchanged in behavior, demoted to "no authority" per design.md
    - When `getSupabaseClient()` returns `null`, skip the fetch/subscribe effect entirely and fall back to the existing local/seed-only behavior unchanged
    - _Requirements: 3.1, 3.6, 6.1, 8.4, 11.2, 11.3, 11.4, 12.5, 13.5, 14.1, 14.2, 14.3, 17.1, 17.2, 17.3_

  - [ ]* 11.2 Write unit tests for the mount-time fetch/subscribe/hydrate sequence using the mock client
    - Using the mock client from task 7.2, assert that on mount with a configured client, `get_or_create_game` is called before the full-state fetch, `HYDRATE_FROM_REMOTE` is dispatched with the fetched snapshot before `subscribeToGame` is called, and a subsequently-fired mock realtime event results in a `SYNC_REMOTE` dispatch
    - Assert that with no configured client (`getSupabaseClient()` returns `null`), no RPC call is attempted and the provider renders using the existing local/seed fallback unchanged
    - _Requirements: 17.1, 17.2_

  - [ ]* 11.3 Write unit tests for optimistic-dispatch-then-RPC-rollback wiring
    - Using the mock client, queue an RPC rejection for `submit_mark`; dispatch the corresponding player action through the context; assert the optimistic `Mark` appears immediately, then assert it is removed via `ROLLBACK_OPTIMISTIC` once the queued rejection resolves
    - Repeat for one host-only action (e.g. `call_next_word` rejecting with `NOT_AUTHORIZED`) and assert the optimistic `game`/`called_terms` change is rolled back
    - _Requirements: 20.1_

- [x] 12. Checkpoint — context provider integrates with mocked Supabase
  - Ensure all tests pass, ask the user if questions arise

- [x] 13. Wire the four screens to the restructured context
  - [x] 13.1 Update `src/pages/PlayerJoin/PlayerJoin.tsx`
    - Replace `buildJoinOutcome`'s client-side ticket-generation/duplicate-check branch with a call through the context's join action (which now calls the `join_game` RPC per task 11.1), keeping the existing pure field-level `validateJoin` checks (required fields, trimming) for instant form feedback
    - On an RPC rejection (`GAME_NOT_FOUND`, `GAME_COMPLETED`), surface the existing rejection messaging unchanged
    - _Requirements: 3.1, 3.2, 3.3, 3.7_

  - [x] 13.2 Update `src/pages/HostDashboard/HostDashboard.tsx`
    - Ensure every existing button (`Start Game`, `Next Cyber Word`, `Pause`, `Resume`, `End Game`, `Confirm`, `Reject`, `Reset`) continues to dispatch its existing optimistic action (unchanged from Module 5) and now additionally flows through the context's wrapped RPC call from task 11.1, supplying `game.hostSecret` obtained once via `get_or_create_game`, kept only in memory/`sessionStorage`, never written to any shared field a Player screen reads
    - _Requirements: 10.3, 10.4_

  - [x] 13.3 Verify `src/pages/PlayerGame/PlayerGame.tsx` and `src/pages/PresentationView/PresentationView.tsx` require no JSX/selector changes
    - Confirm both screens already read exclusively through `useGameSession()`'s derived selectors (`currentTerm`, `currentPrizeProgress`, `revealHistory`, etc.), which recompute identically regardless of whether `state` was produced by a local reducer action or by `SYNC_REMOTE`/`HYDRATE_FROM_REMOTE`; make no changes unless this verification surfaces a real gap, in which case fix the selector rather than adding screen-level Supabase calls
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [ ]* 13.4 Write component tests for join-through-RPC and host-action-through-RPC wiring
    - Using the mock client, assert `PlayerJoin` submitting valid details calls the join RPC wrapper and navigates to `/player` on success, and shows the existing rejection message on `GAME_NOT_FOUND`/`GAME_COMPLETED` without navigating
    - Assert clicking "Next Cyber Word" on `HostDashboard` calls the `call_next_word` RPC wrapper with the game's `host_secret`, and that the secret is never present in any prop passed to `PlayerGame` or `PresentationView`
    - _Requirements: 3.2, 3.3, 10.3, 10.4_

- [x] 14. Checkpoint — all four screens integrate with the restructured sync path
  - Ensure all tests pass, ask the user if questions arise

### Group C — Environment configuration

- [x] 15. Add environment configuration and the local-only-mode notice
  - [x] 15.1 Create `.env.example` at the project root
    - List `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with placeholder, non-functional values and a comment pointing to the Supabase project's Settings > API page, exactly as specified in design.md's Environment Configuration section
    - _Requirements: 18.1, 18.3_

  - [x] 15.2 Add a local-only-mode notice to `src/pages/HostDashboard/HostDashboard.tsx`
    - When `getSupabaseConfig()` (from `realtimeClient.ts`) returns `null`, render a visible, dismissable-or-persistent one-line notice: "Running in local-only mode — set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY for cross-device sync"
    - When configuration is present, render no such notice
    - _Requirements: 18.4_

  - [ ]* 15.3 Write component test for the local-only-mode notice
    - Assert the notice renders when `getSupabaseConfig()` returns `null` and does not render when it returns a populated config (using the mock/stub convention established in task 7.2/8.2)
    - _Requirements: 18.4_

- [x] 16. Checkpoint — environment configuration integrates
  - Ensure all tests pass, ask the user if questions arise

### Cross-cutting regression tests

- [ ] 17. Write regression tests for Modules 3-5 behavior under the restructured sync path
  - [x] 17.1 Write regression test: a new word call never alters existing marks
    - Dispatch `MARK_TERM` (optimistic) followed by a simulated `SYNC_REMOTE` for a `called_terms` insert; assert every previously-persisted `Mark` in state is unchanged
    - _Requirements: 24.1_

  - [x] 17.2 Write regression test: no Host/Presentation-facing action redirects a Player with a valid `currentPlayerId`
    - Dispatch a sequence of `SYNC_REMOTE`/`HYDRATE_FROM_REMOTE` actions representing host actions and assert `currentPlayerId` (and therefore the Player route guard's condition) is unaffected throughout
    - _Requirements: 24.2_

  - [x] 17.3 Write regression test: refresh/reconnect restores the same ticket, never a different one
    - Simulate `HYDRATE_FROM_REMOTE` with a snapshot matching a player's existing ticket; assert the resulting `currentTicket` id is unchanged from before the simulated reconnect
    - _Requirements: 24.3_

  - [x] 17.4 Write regression test: a new word call never decreases any prize's progress
    - Dispatch a `SYNC_REMOTE` `called_terms` insert and assert `currentPrizeProgress` values are monotonically non-decreasing across the transition
    - _Requirements: 24.4_

  - [~] 17.5 Write regression test: claim/winner status survives a simulated refresh
    - Simulate `HYDRATE_FROM_REMOTE` with a snapshot containing a pending claim and, separately, a confirmed winner; assert both statuses are restored exactly as they were in the snapshot
    - _Requirements: 24.5, 24.6_

  - [~] 17.6 Write regression test: the direct-word-call gameplay model is unchanged
    - Assert a `SYNC_REMOTE` `games` update setting `current_term_id` and `status: 'WORD_ACTIVE'` produces the same single-step `currentTerm` derivation as the existing local `CALL_NEXT_WORD` case, with no intermediate "reveal answer" state introduced
    - _Requirements: 24.7_

- [~] 18. Final checkpoint — full verification
  - Run the full test suite and confirm zero failures (conditional integration tests from Group A report explicit skip status when no local Postgres instance is reachable, and this is not treated as a failure)
  - Run the TypeScript project build (`tsc -b`) and confirm zero type errors
  - Run the production build (`vite build`) and confirm it succeeds
  - Ask the user if questions arise
  - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 25.10_

## Manual steps and acceptance runbook (NOT agent-executable — required for this module's Definition of Done)

The tasks above produce every file this module needs: migrations, RPCs, the realtime
client, the extended reducer, the restructured context, and the four wired screens —
all verified against mocks and (where a local Postgres instance is available)
conditional integration tests. None of that constitutes a live, cross-device system
yet. The following steps close that gap and are performed by the user, not the coding
agent, because they require a real hosted service, real credentials, and real physical
devices on a real network — none of which exist inside this workspace. Per design.md's
own Definition of Done, this module is not complete until these steps are performed
and their outcomes are recorded, even though no step below is a coding task.

- [~] 19. Provision the real Supabase project and apply migrations
  - Create a new Supabase project via the Supabase dashboard (or `supabase projects create` with the CLI, if installed locally)
  - Apply migrations `0001` through `0005` from `supabase/migrations/` against the new project (e.g. `supabase db push`, or by pasting each file into the SQL editor in order)
  - Confirm in the dashboard's Table Editor that all seven tables exist, RLS shows as enabled on each, and the seven RPC functions listed in `database > functions` are present
  - Copy the project's URL and anon/public key from Settings > API

- [~] 20. Populate local environment configuration
  - Copy `.env.example` to `.env.local` at the project root
  - Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with the real values from task 19
  - Confirm `.env.local` is covered by `.gitignore` and is never committed
  - Run `npm run dev` and confirm the Host Dashboard's local-only-mode notice (task 15.2) no longer appears

- [~] 21. Acceptance runbook — multi-device live session (Requirement 21)
  - Open `/host` on a laptop, `/presentation` on a second display, and `/join` → `/player` on at least two separate physical phones (or separate browser profiles on separate machines), all against the same deployed build and the same game code
  - Confirm each phone's join increments the Host's visible participant count with no manual refresh on the Host screen
  - Confirm "Start Game" updates both phones and the Presentation display within one realtime round-trip, with no manual refresh on any device
  - Confirm "Next Cyber Word" updates the word/definition/safe-practice tip on both phones and the Presentation display, and that the matching ticket cell becomes available on whichever phone(s) hold that term
  - Confirm a claim submitted on one phone appears in the Host's Claim Inbox with no manual refresh, and that confirming it updates that phone's claim status and the Presentation winner announcement with no manual refresh on either
  - Refresh one phone mid-game and confirm it restores the same player, same ticket, same marks, and same prize progress, with no duplicate ticket or player created
  - Record the outcome of each check (pass/fail with notes) in the module's completion report

- [~] 22. Acceptance runbook — disconnect and reconnect (Requirement 22)
  - On one Player phone, mid-game, enable airplane mode or use browser dev-tools' offline toggle to drop connectivity
  - Attempt a mark while offline and confirm the app neither silently accepts it as if persisted nor crashes
  - Restore connectivity and confirm the phone restores the same player, same ticket, same marks, same current word, and same prize progress that existed immediately before the disconnection, with no duplicate rows created by the reconnect itself
  - Record the outcome in the module's completion report

- [~] 23. Acceptance runbook — simultaneous players (Requirement 23)
  - Join at least three Player devices to the same game at approximately the same time
  - Confirm each receives a distinct, valid ticket
  - Make one "Next Cyber Word" call from the Host and confirm all connected devices' current word updates from that single call
  - Confirm marks made on one device never appear against another device's ticket, the Host's participant count matches the actual number of joined players, and claims submitted by different players remain separate, independently-tracked rows in the Host's Claim Inbox
  - Record the outcome in the module's completion report

- [~] 24. Write the module completion report
  - Cover every item design.md's "Definition of Done" section lists: technology chosen and why, every file created/modified, every new environment variable, the final schema, how player identity stays client-local, how cross-device joining/ticket-assignment/word-calling/marking/claims work, how reconnect works, how stale-state overwrite is prevented, automated tests added, the production build result, exact run steps for Host + Player phones on the same network, known limitations, and what would be needed before real production readiness (Supabase Auth for a real host identity, rate limiting, monitoring, and load testing beyond the 10-20 device pilot target)
  - Include the recorded outcomes from tasks 21-23

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks (schema/RLS/RPC authoring, client wiring, screen wiring, env config) are never optional.
- Conditional integration tests (4.2, 4.3, 4.4, 5.3, 5.4) run only when a local Supabase CLI/Postgres instance is reachable via a connection-string environment variable; when unreachable they report as explicitly skipped, never as a false pass, and their absence does not block any checkpoint.
- Tasks 19-24 are a manual runbook, not coding tasks. No coding agent should mark them complete on the basis of writing code, running an automated test, or reasoning about expected behavior — they require a real deployed Supabase project and real physical devices on a real network, and are only complete once a human has actually performed them and recorded the outcome.
- Each task references specific requirement sub-clauses for traceability.
- Checkpoints (tasks 6, 10, 12, 14, 16, 18) ensure incremental validation as SQL authoring, reducer extension, context restructuring, screen wiring, and environment configuration come together.
- Property tests validate the 9 universal correctness properties from `design.md`; each test is tagged `// Feature: module-6-realtime-multi-device-sync, Property {n}: {title}` and runs ≥100 iterations where implemented as a pure/mocked property test, or is implemented as a conditional integration test where the property is a database-level guarantee (Properties 1, 3, 5, 8, and the integration half of 9).
- `submit_mark`/`call_next_word`/`submit_claim`/`confirm_claim` in SQL are the single authoritative gate chains for their respective mutations once Supabase is configured; the existing TypeScript `validateMarkAttempt`/`validatePrizeClaim`/`canConfirmClaim` remain the client's optimistic pre-check and are not deleted or bypassed — no gate logic is removed from the client, only supplemented by server-side re-validation.
- `realtimeClient.ts`'s mocked-client test fixture (task 7.2) is the shared test infrastructure every later Group B unit/component test depends on; it must land before tasks 8.2 onward.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "7.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "7.2"] },
    { "id": 2, "tasks": ["2.2", "3.1", "7.3", "8.1"] },
    { "id": 3, "tasks": ["3.2", "4.1", "8.2", "8.3", "9.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "5.1", "9.2", "9.3", "9.4"] },
    { "id": 5, "tasks": ["5.2", "5.3", "5.4", "11.1"] },
    { "id": 6, "tasks": ["11.2", "11.3"] },
    { "id": 7, "tasks": ["13.1", "13.2", "13.3", "15.1", "15.2"] },
    { "id": 8, "tasks": ["13.4", "15.3"] },
    { "id": 9, "tasks": ["17.1", "17.2", "17.3", "17.4", "17.5", "17.6"] }
  ]
}
```
