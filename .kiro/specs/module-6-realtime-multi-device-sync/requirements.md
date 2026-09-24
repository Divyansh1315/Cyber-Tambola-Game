# Requirements Document

## Introduction

Module 6 turns Cyber Tambola V2's single-browser illusion of a "shared" game into a real one. Through Module 5, `game`, `players`, `tickets`, `marks`, `claims`, and `winners` all live in one browser's `useReducer` store, persisted to that browser's `localStorage` and mirrored to other tabs of the *same* browser over `BroadcastChannel`. A Host laptop and an employee's phone joining "the same" game today run two independent, unsynchronized games that merely share a seed game code string — nothing the Host does is ever seen by a Player's phone, and vice versa.

This module introduces Supabase (managed Postgres + Realtime) as the single authoritative backend for every piece of state that must be shared across devices — Game, Player, Ticket, Mark, PrizeClaim, and Winner — while keeping `currentPlayerId` exactly where it already lives: client-local, in `localStorage`, on the one device that owns it. The four screens (`/host`, `/player`, `/presentation`, and the join flow) keep their existing `dispatch`-shaped component API; what changes is what sits behind `dispatch` and where the data rendered on screen actually comes from.

The existing `gameSessionReducer` is not replaced. It becomes the client's **optimistic local projection**: a player's tap on a ticket cell still runs through the existing validation logic and repaints instantly, at zero network latency, exactly as it does today. That optimistic update is immediately followed by a write to Supabase (via a `SECURITY DEFINER` RPC that independently re-validates the same gates server-side) and, moments later, by that same write coming back down through a Realtime subscription and reconciling into the reducer via a new `SYNC_REMOTE` action — the authoritative row from Postgres always supersedes the optimistic entry. Host-only actions (start, call-next-word, pause, resume, end, reset, confirm-claim, reject-claim) are exposed only as RPCs gated by a `host_secret` argument that is never sent to a Player device, since there is no Supabase Auth / enterprise identity in this prototype to distinguish "the Host's browser" from "a Player's browser" any other way.

This module is additive on top of Modules 3-5's architecture and must not regress any of their manual-play, manual-mark, manual-claim, host-confirmation, or five-prize behavior. It does not introduce Microsoft Entra ID/SSO/enterprise auth, a self-hosted backend, a UI redesign beyond what real-time wiring requires, or production-scale performance/monitoring work — this module targets a pilot of roughly 10-20 concurrent devices on a single shared game, not a production rollout.

## Glossary

- **System**: The Cyber Tambola V2 application as extended by this module, spanning its React/TypeScript client and its Supabase (Postgres + Realtime) backend.
- **Backend**: The Supabase project's Postgres database, its RPC functions, and its Realtime layer, collectively — the authoritative store for all shared game data.
- **Client**: One device's browser session running the React app (Host laptop, Player phone, or Presentation display).
- **Game**: The central session record (`games` table / `Game` type) holding `status`, `code`, `host_secret`, `current_round`, `current_term_id`, and derived `revealedTermIds`.
- **Game_Status**: One of `LOBBY`, `WORD_ACTIVE`, `PAUSED`, `COMPLETED`.
- **Host_Secret**: A per-game random token stored on the `games` row, known only to the Host's own client memory/session storage, and required as an argument by every host-only RPC.
- **Player**: A participant record (`players` table) uniquely identified within a Game by its normalized Employee/Demo ID.
- **Employee_Demo_Id_Normalized**: The lower-cased, trimmed form of a Player's submitted Employee/Demo ID, used as the uniqueness key within a Game.
- **Ticket**: A Player's 3x5 grid of 15 unique active Cyber Terms (`tickets` table), assigned exactly once per Player.
- **Called_Term**: An entry in the `called_terms` table recording that a specific Cyber Term has been officially called in a specific Game; the set of all Called_Terms for a Game is exposed to the client as `revealedTermIds`.
- **Mark**: A record (`marks` table) of one Player's validated act of marking one Cyber Term on their Ticket.
- **PrizeClaim / Claim**: A record (`claims` table) of one Player's submitted claim for one prize category on their Ticket, carrying a system `validation_status` and a host `host_decision`.
- **Winner**: A record (`winners` table) created only when the Host confirms a valid, still-open claim; at most one Winner exists per (Game, prize) pair.
- **Current_Player_Id**: The client-local identifier of which Player a given device belongs to, persisted only in that device's own `localStorage` and never sent to or stored in the Backend.
- **RPC**: A Postgres `SECURITY DEFINER` function callable from the Client via `supabase-js`, the only permitted write path into any shared table (e.g. `join_game`, `assign_ticket`, `call_next_word`, `submit_mark`, `submit_claim`, `confirm_claim`, `reject_claim`, `pause_game`, `resume_game`, `end_game`, `reset_game`).
- **Realtime_Subscription**: A Client's `postgres_changes`-based subscription to row changes on the shared tables, scoped to one `game_id`.
- **SYNC_REMOTE**: The reducer action that applies one authoritative row change (from a Realtime_Subscription event or an initial fetch) into the Client's local optimistic projection.
- **HYDRATE_FROM_REMOTE**: The one whole-snapshot reducer action, dispatched only on mount or reconnect, that replaces the Client's shared-data slice outright from a fresh set of Backend reads.
- **Local_Fallback**: The pre-existing `localStorage` envelope and same-tab `BroadcastChannel` mechanism, retained only as a non-authoritative dev/offline convenience.
- **Optimistic_Projection**: The Client's locally-computed, pre-confirmation view of shared state, produced by dispatching existing local reducer actions immediately on user interaction, before the matching RPC call resolves.

## Requirements

### Requirement 1: Central schema for all shared game data

**User Story:** As a developer extending the session store to support multiple devices, I want every piece of shared game state to live in a central Postgres schema, so that no shared fact about a game exists only inside one browser's memory.

#### Acceptance Criteria

1. THE Backend SHALL define a `games` table carrying, at minimum, `id`, `code`, `host_secret`, `status`, `current_round`, `current_term_id`, `created_at`, `started_at`, `ended_at`, and `updated_at`.
2. THE Backend SHALL define a `called_terms` table recording, at minimum, `game_id`, `term_id`, `called_at`, and `round`, with at most one row per distinct `(game_id, term_id)` pair.
3. THE Backend SHALL define a `players` table carrying, at minimum, `id`, `game_id`, `display_name`, `employee_demo_id`, an `employee_demo_id_normalized` derived value, and `joined_at`, with at most one row per distinct `(game_id, employee_demo_id_normalized)` pair.
4. THE Backend SHALL define a `tickets` table carrying, at minimum, `id`, `game_id`, `player_id`, `ref`, `signature`, and `cells` describing a 3-row-by-5-column arrangement of term ids, with at most one row per `player_id`.
5. THE Backend SHALL define a `marks` table carrying, at minimum, `id`, `game_id`, `player_id`, `ticket_id`, `term_id`, and `marked_at`, with at most one row per distinct `(player_id, ticket_id, term_id)` triple.
6. THE Backend SHALL define a `claims` table carrying, at minimum, `id`, `game_id`, `player_id`, `ticket_id`, `prize_id`, `submitted_at`, `validation_status`, `host_decision`, `rejection_reason`, and `decided_at`.
7. THE Backend SHALL define a `winners` table carrying, at minimum, `id`, `game_id`, `prize_id`, `player_id`, `ticket_id`, `claim_id`, and `confirmed_at`, with at most one row per distinct `(game_id, prize_id)` pair.
8. THE System SHALL treat `games`, `called_terms`, `players`, `tickets`, `marks`, `claims`, and `winners` as the sole authoritative source for any data shared across more than one device; no equivalent shared-state authority SHALL exist solely in a single browser's memory or `localStorage`.

### Requirement 2: Read access without a direct client write path

**User Story:** As a developer securing the backend, I want every shared table readable but never directly writable by an ordinary client, so that all shared-state changes are forced through validated, purpose-built entry points.

#### Acceptance Criteria

1. THE Backend SHALL enable row level security on `games`, `called_terms`, `players`, `tickets`, `marks`, `claims`, and `winners`.
2. THE Backend SHALL permit the anonymous client role to read (`SELECT`) all rows of `games`, `called_terms`, `players`, `tickets`, `marks`, `claims`, and `winners`.
3. THE Backend SHALL NOT grant the anonymous client role a direct `INSERT`, `UPDATE`, or `DELETE` policy on any of `games`, `called_terms`, `players`, `tickets`, `marks`, `claims`, or `winners`.
4. THE System SHALL expose every permitted mutation of shared state exclusively through an RPC, such that no Client code path can alter a shared table's row by any means other than an RPC call.

### Requirement 3: Player joins the shared game from any device

**User Story:** As an employee, I want to open the Player URL on my own phone, enter the Game Code and my Name and Employee/Demo ID, and join the same live game everyone else is playing, so that I can participate from my own device without needing the Host's laptop.

#### Acceptance Criteria

1. WHEN a Client submits a Game Code, display name, and Employee/Demo ID to join, THE System SHALL validate the Game Code against the Backend's `games` table via the join RPC rather than against any locally cached game list.
2. IF the submitted Game Code does not match any existing Game, THEN THE System SHALL reject the join attempt and SHALL NOT create a Player or Ticket.
3. IF a Game matching the submitted Game Code has Game_Status `COMPLETED`, THEN THE System SHALL reject the join attempt.
4. WHEN a join attempt's normalized Employee/Demo ID does not match any existing Player in that Game, THE System SHALL create exactly one new Player and assign that Player exactly one new Ticket via the ticket-assignment mechanism (Requirement 5).
5. WHEN a join attempt's normalized Employee/Demo ID matches an existing Player in that Game, THE System SHALL return that existing Player and that existing Player's existing Ticket, and SHALL NOT create a second Player or a second Ticket for that identity.
6. WHEN a join attempt succeeds, THE System SHALL persist the resulting Player's id as Current_Player_Id in the joining device's own `localStorage` only, and SHALL navigate that device to the Player screen.
7. THE System SHALL NOT transmit a Client-supplied Player id as the basis for identifying which Player a join or join-restoration request belongs to; identity resolution SHALL be based on the submitted Game Code and Employee/Demo ID only.

### Requirement 4: Duplicate join always restores, never duplicates

**User Story:** As an employee who accidentally reopens the join page or re-enters my details, I want to be restored to my existing ticket and progress rather than getting a second, empty ticket, so that I never lose my marks by re-joining.

#### Acceptance Criteria

1. FOR ALL pairs of join attempts sharing the same Game and the same normalized Employee/Demo ID, THE System SHALL resolve both attempts to the same Player id and the same Ticket id.
2. THE Backend SHALL enforce, at the database level, that the `players` table never contains two rows sharing the same `(game_id, employee_demo_id_normalized)` pair, independent of any application-level duplicate check.
3. WHEN two join attempts for the same Game and same normalized Employee/Demo ID are submitted concurrently from different devices, THE System SHALL still resolve both to exactly one Player row and exactly one Ticket row.

### Requirement 5: Ticket assignment is centrally authoritative

**User Story:** As a player, I want my ticket to be generated and permanently assigned by the shared backend, not just by whichever device I happen to be using, so that refreshing or switching devices never gives me a different ticket.

#### Acceptance Criteria

1. WHEN a new Player is created during a join, THE System SHALL generate that Player's Ticket via the ticket-assignment RPC rather than in Client-side JavaScript alone.
2. THE System SHALL assign each Player exactly one Ticket containing exactly 15 unique active Cyber Terms arranged in a 3-row-by-5-column grid.
3. THE Backend SHALL enforce, at the database level, that the `tickets` table never contains two rows sharing the same `player_id`.
4. THE System SHALL retry ticket generation on a ticket-signature collision within the same Game, consistent with the existing uniqueness-by-signature convention, up to a bounded number of attempts before reporting an error.
5. WHEN a Player's device refreshes, reconnects, or rejoins, THE System SHALL NOT generate a new Ticket for that Player under any circumstance; the Player's Ticket SHALL be the one assigned at their first successful join.

### Requirement 6: Host starts, pauses, resumes, and ends the game for every connected device

**User Story:** As the host, I want Start Game, Pause, Resume, and End Game to immediately affect every connected Player and Presentation device, so that the whole room stays on the same page without me telling anyone to refresh.

#### Acceptance Criteria

1. WHEN the Host triggers Start Game, THE System SHALL transition the shared Game_Status accordingly via a host-only RPC, and every connected Client subscribed to that Game SHALL receive the updated status without a manual refresh.
2. WHEN the Host triggers Pause, THE System SHALL set the shared Game_Status to `PAUSED` via a host-only RPC while retaining the status to resume into, and every connected Client SHALL reflect the paused state without a manual refresh.
3. WHEN the Host triggers Resume, THE System SHALL restore the shared Game_Status to the status held before pausing via a host-only RPC, and every connected Client SHALL reflect the resumed state without a manual refresh.
4. WHEN the Host triggers End Game, THE System SHALL set the shared Game_Status to `COMPLETED` via a host-only RPC, and every connected Client SHALL reflect the ended state without a manual refresh.
5. THE System SHALL propagate every Requirement 6 status change to connected Clients through the Realtime_Subscription mechanism, not through Client-side polling.

### Requirement 7: Host calls the next Cyber Word centrally and it is broadcast to all clients

**User Story:** As the host, I want pressing "Next Cyber Word" to pick one unused term and immediately show it, its definition, and its safe-practice tip on every connected phone and the presentation screen, so that the whole room experiences the same word at the same time.

#### Acceptance Criteria

1. WHEN the Host triggers Next Cyber Word, THE System SHALL select one Cyber Term not already present among that Game's Called_Terms via the next-word RPC, running the selection inside the Backend rather than in any single Client's memory.
2. WHEN the next-word RPC selects a term, THE System SHALL record that term as a Called_Term for that Game before returning success, using a mechanism that makes a second, concurrent selection of the same term for the same Game impossible (Requirement 9).
3. WHEN the next-word RPC succeeds, THE System SHALL update the Game's `current_term_id` and Game_Status accordingly in the same operation that recorded the Called_Term.
4. WHEN a term is called, THE System SHALL cause every connected Player, Host, and Presentation Client subscribed to that Game to receive the same word, definition, and safe-practice tip via the Realtime_Subscription mechanism, without a manual refresh.
5. WHEN a term becomes called, THE System SHALL cause any Player Ticket cell containing that term to become derived as available for marking on that Player's device automatically.
6. IF every active Cyber Term has already been called for a Game, THEN THE System SHALL transition that Game's Game_Status to `COMPLETED` in response to a further Next Cyber Word attempt rather than raising an unhandled error.

### Requirement 8: Player marking is validated and persisted centrally

**User Story:** As a player, I want my tap on an available ticket term to be checked and saved by the shared backend, not just accepted by my own phone's screen, so that only legitimate marks ever count toward my prize progress.

#### Acceptance Criteria

1. WHEN a Player submits a mark for a term, THE System SHALL accept and persist that mark via a mark-submission RPC only if all of the following hold: the Player exists; the Ticket referenced belongs to that Player; the term is one of that Ticket's 15 cells; the term is present among that Game's Called_Terms; the Game's Game_Status is not `COMPLETED`; and no prior Mark already exists for that exact (player, ticket, term).
2. IF any condition in Requirement 8.1 fails, THEN THE System SHALL reject the mark submission and SHALL NOT create a Mark row.
3. THE Backend SHALL enforce, at the database level, that the `marks` table never contains two rows sharing the same `(player_id, ticket_id, term_id)` triple, independent of the mark-submission RPC's own duplicate check.
4. WHEN a mark is accepted and persisted, THE System SHALL cause that mark to be reflected on the submitting Player's own device and to remain reflected there after another term is called, after a page refresh, and after a temporary disconnect and reconnect.
5. THE System SHALL continue deriving Ticket cell state and prize progress exclusively from the persisted `marks` rows for a Player's Ticket, and SHALL NOT accept a Client-supplied "already marked" or "eligible" flag as a substitute for that derivation.

### Requirement 9: Repeated or concurrent Host actions never produce duplicate or conflicting effects

**User Story:** As the host, I want double-tapping Next Cyber Word, or accidentally triggering it from two open Host tabs, to never call the same word twice or otherwise corrupt the shared game state, so that I don't have to worry about network lag causing a mistake.

#### Acceptance Criteria

1. FOR ALL pairs of Next Cyber Word invocations for the same Game, whether sequential or concurrent, THE System SHALL ensure no Cyber Term appears more than once among that Game's Called_Terms.
2. WHEN two Next Cyber Word invocations for the same Game are submitted concurrently, THE System SHALL serialize their effect on that Game's row such that the second invocation to execute observes the first invocation's result before selecting its own term.
3. FOR ALL pairs of mark submissions for the same exact (player, ticket, term), THE System SHALL ensure at most one Mark row is ever persisted, regardless of how many times the submission is retried or how close together the attempts occur.
4. FOR ALL pairs of claim-confirmation invocations for the same prize within the same Game, THE System SHALL ensure at most one Winner row is ever created for that (game, prize) pair, regardless of how many valid claims exist or how close together the confirmation attempts occur.

### Requirement 10: Host-only actions are unreachable from Player device code paths

**User Story:** As the host, I want it to be structurally impossible for a player's phone to trigger a host action like calling the next word or confirming a claim, so that the integrity of the game doesn't depend on players simply not trying.

#### Acceptance Criteria

1. THE System SHALL require a Host_Secret argument, checked against the target Game's stored `host_secret`, for every invocation of the next-word, pause, resume, end-game, reset-game, confirm-claim, and reject-claim RPCs.
2. IF an RPC in Requirement 10.1 is invoked with a Host_Secret that does not match the target Game's stored `host_secret`, THEN THE System SHALL reject the invocation and SHALL leave every row in every shared table unchanged.
3. THE System SHALL NOT transmit a Game's `host_secret` to any Player-facing screen, join flow, or Presentation-facing screen, and SHALL NOT include it in any Realtime_Subscription payload delivered to a Client.
4. THE System SHALL retain a Game's `host_secret` only in the Host device's own client-side memory or session storage, obtained once from the Backend when that device opens or creates the Game.

### Requirement 11: Presentation view reflects shared game state without exposing player-identifying data

**User Story:** As an event host running the projector view, I want the presentation screen to show the live game code, current word, and pause/winner state automatically, so that the room always sees what's actually happening without needing a laptop refresh, and without showing anything private about individual players.

#### Acceptance Criteria

1. WHILE a Game has not yet started, THE Presentation view SHALL display the current Game Code and join instructions, updated automatically if the Game Code changes.
2. WHEN a term is called, THE Presentation view SHALL display the current Cyber Word, its definition, and its safe-practice tip, updated via the Realtime_Subscription mechanism without a manual refresh.
3. WHEN the Host pauses or resumes the Game, THE Presentation view SHALL reflect the paused or resumed state without a manual refresh.
4. WHEN the Host confirms a claim, THE Presentation view SHALL display a winner announcement without a manual refresh.
5. THE Presentation view SHALL NOT display any Player's Employee/Demo ID or any other Player-identifying detail not already permitted by Module 5's Presentation requirements.

### Requirement 12: Claim submission and validation use centrally authoritative state

**User Story:** As the host, I want every claim to still be validated against the real, shared session state before it reaches my inbox, so that a claim's legitimacy never depends on trusting any one device's local computation.

#### Acceptance Criteria

1. WHEN a Player submits a claim for a prize category, THE System SHALL validate that claim via a claim-submission RPC against the Backend's own current `players`, `tickets`, `marks`, `claims`, and `winners` rows for that Game, and SHALL NOT accept a Client-supplied eligibility flag as a substitute for that validation.
2. THE System SHALL apply, within the claim-submission RPC, the same validation gates already established for claim submission in Module 5 (game/player/ticket existence and ownership, prize category validity, no duplicate active claim, prize not already closed, and eligibility computed from that player's own persisted Marks on their own Ticket).
3. WHEN a claim submission passes every gate in Requirement 12.2, THE System SHALL persist that claim with a `VALID` validation status and a `PENDING` host decision.
4. WHEN a claim submission fails any gate in Requirement 12.2, THE System SHALL persist that claim with an `INVALID` validation status rather than silently discarding the attempt.
5. WHEN a Player submits a claim, THE System SHALL cause that claim to appear in the Host's Claim Inbox automatically via the Realtime_Subscription mechanism, without a manual Host-side refresh.

### Requirement 13: Host confirm/reject propagates immediately and closes only the relevant prize

**User Story:** As the host, I want confirming or rejecting a claim to immediately update the affected player's screen and the presentation view, and to close only that one prize category, so that the rest of the game keeps moving without confusion.

#### Acceptance Criteria

1. WHEN the Host confirms a claim whose validation status is `VALID` and host decision is `PENDING` for a prize that is not yet closed, THE System SHALL create exactly one Winner row for that (game, prize) pair via the confirm-claim RPC.
2. IF the Host attempts to confirm a claim whose validation status is `INVALID`, THEN THE System SHALL reject the confirmation and SHALL NOT create a Winner row.
3. IF the Host attempts to confirm a claim for a prize that already has a Winner row for that Game, THEN THE System SHALL reject the confirmation and SHALL NOT create a second Winner row for that (game, prize) pair.
4. WHEN a Winner row is created for a prize, THE System SHALL leave every other prize category's open/closed state and every other player's claims for other prizes unaffected.
5. WHEN the Host confirms or rejects a claim, THE System SHALL cause the affected Player's own device and the Presentation view to reflect the updated claim/winner status via the Realtime_Subscription mechanism, without a manual refresh on either.
6. WHEN the Host rejects a claim, THE System SHALL set that claim's host decision to `REJECTED` via the reject-claim RPC and SHALL NOT create a Winner row.

### Requirement 14: Reconnect and refresh restore identical state without data loss or duplication

**User Story:** As a player whose phone briefly loses signal or whose browser tab reloads, I want to land back in the same spot in the game with all my progress intact, so that a flaky connection never costs me my ticket or my marks.

#### Acceptance Criteria

1. WHEN a Player's device reconnects or reloads, THE System SHALL fetch that Player's current Game, current Cyber Word, called-word history, Player record, Ticket, Marks, prize progress, claim status, and Winner status from the Backend before rendering the Player screen's live game state.
2. THE System SHALL perform the fetch in Requirement 14.1 as a read-only operation with no RPC side effects, creating no new Player, Ticket, Mark, Claim, or Winner row as a byproduct of reconnecting or refreshing.
3. WHEN a reconnect or refresh completes, THE System SHALL resume the Player's session using their existing Ticket and existing Marks, and SHALL NOT require manual reconstruction of any of that state by the player.
4. FOR ALL sequences consisting of a Player joining, marking some terms, optionally submitting claims, and then reconnecting, THE System SHALL restore the exact same Player id, Ticket id, set of Mark rows, set of Claim rows, and any Winner rows for that Player as existed immediately before the reconnect, with no new rows created.

### Requirement 15: Client-local player identity is never overwritten by shared-state synchronization

**User Story:** As a player, I want a host action, a presentation update, or any background sync to never accidentally knock me back to the join screen, so that my session stays stable for the whole event.

#### Acceptance Criteria

1. THE System SHALL persist Current_Player_Id only in the owning device's own `localStorage`, and SHALL NOT transmit it to the Backend as part of any shared table's row.
2. FOR ALL SYNC_REMOTE actions applied to a Client's local state, THE System SHALL leave that Client's Current_Player_Id unchanged before and after the action.
3. FOR ALL HYDRATE_FROM_REMOTE actions applied to a Client's local state, THE System SHALL leave that Client's Current_Player_Id unchanged before and after the action.
4. THE System SHALL NOT cause any Host action, Presentation-facing update, or Realtime_Subscription event to redirect a Player's device to the join screen while that device retains a valid Current_Player_Id.

### Requirement 16: Shared state updates never overwrite newer data with stale data

**User Story:** As a developer relying on the sync design, I want the system to never let an older snapshot silently overwrite a newer one, so that a slow device or a delayed message can never erase another device's progress.

#### Acceptance Criteria

1. THE System SHALL treat the Backend as the single authoritative source for every shared field, such that a Client's Optimistic_Projection for a given row is always superseded by that row's corresponding SYNC_REMOTE update once it arrives.
2. THE System SHALL apply each SYNC_REMOTE update as an upsert-by-id of a single row into the matching local collection, never as a wholesale replacement of an entire collection.
3. WHEN a Host action, Presentation-facing read, or any other Client's activity results in a Realtime event, THE System SHALL NOT cause any previously persisted Mark, Claim, or Winner row to be removed or overwritten as a side effect of that event.
4. THE System SHALL NOT reintroduce a cross-client, snapshot-comparison staleness mechanism (such as a shared monotonic revision counter) for data governed by the Backend in this module.

### Requirement 17: Local prototype fallback remains non-authoritative

**User Story:** As a developer, I want the existing local-only persistence and same-tab sync code to keep working as a convenience when Supabase is not configured, without ever competing with the shared backend once it is configured, so that there is exactly one system of record for shared game data.

#### Acceptance Criteria

1. WHERE Supabase environment configuration is present, THE System SHALL treat the Backend as authoritative for `game`, `players`, `tickets`, `marks`, `claims`, and `winners`, and SHALL overwrite any locally-restored value for those fields with the Backend's data once the initial fetch resolves.
2. WHERE Supabase environment configuration is absent, THE System SHALL continue to render the Host, Player, Presentation, and Join screens using the existing local-only fallback state, with no cross-device synchronization.
3. THE System SHALL NOT maintain two systems that both claim authority over the same shared field at the same time; the Local_Fallback SHALL be used only for Current_Player_Id persistence (always) and as a same-tab, no-authority convenience for the shared slice (only while Supabase configuration is absent or before the initial Backend fetch resolves).
4. THE System SHALL continue to support same-tab `BroadcastChannel` synchronization as a non-authoritative convenience without requiring it for any cross-device requirement in this module.

### Requirement 18: Environment configuration keeps secrets out of source and fails gracefully when absent

**User Story:** As a developer running this prototype, I want Supabase credentials to come from environment variables with a working example file, and I want the app to still start if they're missing, so that I never commit a secret and never get a confusing crash.

#### Acceptance Criteria

1. THE System SHALL read the Supabase project URL and anonymous key exclusively from `VITE_`-prefixed environment variables.
2. THE System SHALL NOT hard-code a Supabase URL, anonymous key, or any other credential in source code committed to the repository.
3. THE System SHALL provide a `.env.example` file listing the required environment variable names with placeholder (non-functional) values.
4. IF the required Supabase environment variables are absent when the application starts, THEN THE System SHALL start successfully in local-only fallback mode (Requirement 17.2) rather than throwing an unhandled error, and SHALL display a visible notice indicating that cross-device sync is disabled.
5. THE System SHALL NOT include a Supabase service-role or other secret server-side key anywhere in Client-side code or environment variables exposed to the browser.

### Requirement 19: No enterprise authentication is introduced

**User Story:** As the project owner, I want this module to keep using Name plus Employee/Demo ID for identification, so that the prototype doesn't take on enterprise identity infrastructure it doesn't need.

#### Acceptance Criteria

1. THE System SHALL NOT integrate Microsoft Entra ID, single sign-on, corporate directory lookup, or Microsoft Graph in this module.
2. THE System SHALL continue to identify Players solely by submitted display name and Employee/Demo ID, with no login step of any kind.
3. THE System SHALL distinguish host-only capability from player capability solely through the Host_Secret mechanism (Requirement 10), not through any user account, role claim, or authentication session.

### Requirement 20: Server-side validation protects every shared write path

**User Story:** As the host running a live session, I want to trust that no player device, however it's modified, can write data it shouldn't be able to, so that the shared game state stays trustworthy for everyone.

#### Acceptance Criteria

1. THE System SHALL re-validate every mark submission, claim submission, and host-only action against Backend-held state inside its RPC, independent of whatever validation already ran on the submitting Client.
2. THE System SHALL restrict a Player's mutating RPC calls (mark submission, claim submission) to affecting only that Player's own Marks and Claims, never another Player's.
3. THE System SHALL sanitize and validate submitted Game Code and Employee/Demo ID values (trimming and normalization) before using them to look up or create a Player.
4. THE System SHALL NOT expose any RPC or table read path that allows a Player-facing Client to execute a host-only action without a valid Host_Secret.

### Requirement 21: Acceptance testing — multi-device live session

**User Story:** As a facilitator preparing to run this game with a room full of employees, I want a documented multi-device scenario that proves the system actually works across separate phones and a laptop, so that I can trust the pilot before running it live.

#### Acceptance Criteria

1. WHEN a Host laptop, a Presentation display, and at least two separate Player phones join the same Game via the same Game Code, THE System SHALL update the Host's visible participant count as each phone joins, without a manual refresh on the Host screen.
2. WHEN the Host triggers Start Game, THE System SHALL update both Player phones and the Presentation display within one Realtime round-trip, without a manual refresh on any device.
3. WHEN the Host triggers Next Cyber Word, THE System SHALL update the current word, definition, and safe-practice tip on both Player phones and the Presentation display, and SHALL cause the matching ticket cell to become available on whichever phone(s) hold that term.
4. WHEN a Player on one phone submits a claim, THE System SHALL cause that claim to appear in the Host's Claim Inbox without a manual refresh, and WHEN the Host confirms it, THE System SHALL update that phone's claim status and the Presentation winner announcement without a manual refresh on either device.
5. WHEN one Player phone is refreshed mid-game, THE System SHALL restore that phone to the same Player, same Ticket, same Marks, and same prize progress, with no duplicate Ticket or Player created.

### Requirement 22: Acceptance testing — disconnect and reconnect

**User Story:** As a facilitator running this on venue wifi, I want to know that a temporary dropped connection doesn't lose or duplicate anyone's progress, so that a flaky network doesn't ruin the game for one unlucky player.

#### Acceptance Criteria

1. WHEN a Player device loses network connectivity mid-game and later regains it, THE System SHALL restore that device to the same Player, same Ticket, same Marks, same current word, and same prize progress that existed immediately before the disconnection.
2. IF a Player device attempts to submit a mark while disconnected, THEN THE System SHALL neither silently persist that mark locally as if it succeeded nor crash, and SHALL resolve the attempt (accept or fail) only once connectivity and validation against the Backend are possible.
3. WHEN a Player device reconnects after a disconnection during which no mark attempts were made, THE System SHALL create no new Player, Ticket, Mark, Claim, or Winner row as a result of the reconnection itself.

### Requirement 23: Acceptance testing — simultaneous players

**User Story:** As a facilitator, I want to know that several employees joining and playing at the same time never see each other's tickets or marks, so that I can trust the game's integrity with a full room of simultaneous players.

#### Acceptance Criteria

1. WHEN at least three Players join the same Game at approximately the same time, THE System SHALL assign each Player a distinct, valid Ticket.
2. WHEN the Host makes one call to Next Cyber Word, THE System SHALL update all connected Player devices' view of the current word from that single call.
3. FOR ALL pairs of distinct Players in the same Game, THE System SHALL ensure that a Mark created by one Player never appears among the Marks associated with the other Player's Ticket.
4. WHEN multiple Players are present in a Game, THE System SHALL report the Host's participant count consistent with the actual number of distinct joined Players.
5. FOR ALL pairs of distinct Players who each submit a claim in the same Game, THE System SHALL keep their claims as separate, independently-tracked rows in the Host's Claim Inbox.

### Requirement 24: Regression protection for Modules 3-5 behavior

**User Story:** As a developer shipping this module, I want to be confident that adding realtime multi-device sync doesn't quietly break any gameplay behavior that already worked, so that the pilot doesn't trade one class of bug for another.

#### Acceptance Criteria

1. WHEN a new Cyber Word is called, THE System SHALL leave every previously persisted Mark unchanged.
2. THE System SHALL NOT cause any Host action or Presentation-facing update to redirect a Player's device to the join screen while that device retains a valid Current_Player_Id.
3. WHEN a Player's device refreshes or reconnects, THE System SHALL restore that Player to the same Ticket they were assigned at their first join, never a different one.
4. WHEN a new Cyber Word is called, THE System SHALL NOT cause any prize's progress value to decrease for any Player.
5. WHEN a Player's device refreshes after submitting a claim, THE System SHALL restore that claim's pending or confirmed status exactly as it was before the refresh.
6. WHEN a Player's device refreshes after winning a prize, THE System SHALL restore the confirmed Winner status for that prize exactly as it was before the refresh.
7. THE System SHALL preserve the existing direct-word-call gameplay model (Cyber Word, definition, and safe-practice tip shown together, with manual matching and manual marking, and no Reveal Answer step) unchanged by this module.

### Requirement 25: Automated test coverage traces to the design's correctness properties

**User Story:** As a developer verifying this module, I want automated tests that exercise the specific guarantees the design promises, so that a regression in any one of them is caught before it reaches a live session.

#### Acceptance Criteria

1. THE System SHALL include an automated test verifying that joining twice with the same Game and normalized Employee/Demo ID yields the same Player id and the same Ticket id both times.
2. THE System SHALL include an automated test verifying that a Player is assigned exactly one Ticket, whose 15 cell term ids never change after creation, across repeated joins, refreshes, or reconnects.
3. THE System SHALL include an automated test verifying that concurrent Next Cyber Word invocations for the same Game never result in the same term being called twice.
4. THE System SHALL include an automated test verifying that a mark submission succeeds only when every gate in Requirement 8.1 passes, and is rejected otherwise, including the case of an unrevealed/uncalled term.
5. THE System SHALL include an automated test verifying that at most one Winner row ever exists per (game, prize) pair, regardless of how many valid claims were submitted or confirmation attempts made.
6. THE System SHALL include an automated test verifying that reconnecting after joining, marking terms, and submitting claims restores the exact same Player id, Ticket id, Mark rows, Claim rows, and Winner rows, with zero new rows created by the reconnect itself.
7. THE System SHALL include an automated test verifying that Current_Player_Id is unchanged before and after any SYNC_REMOTE or HYDRATE_FROM_REMOTE action.
8. THE System SHALL include an automated test verifying that every host-only RPC rejects a call carrying a Host_Secret that does not match the target Game's stored value, with no row changes as a result.
9. THE System SHALL include an automated test verifying that the SQL ticket-assignment function and the existing TypeScript ticket generator both produce tickets containing exactly 15 unique active term ids arranged in a 3-row-by-5-column grid with no duplicate cell positions, for the same input term bank.
10. THE System SHALL include an automated test verifying that a claim submitted by one Player is visible in Host-facing claim state, and that confirming it creates a Winner only for the claimed prize, leaving other prize categories open.

### Requirement 26: Performance target for a pilot-scale session

**User Story:** As the project owner, I want the system to comfortably support a real pilot session with a full room of participants, so that the game doesn't fall over the first time it's actually used at scale.

#### Acceptance Criteria

1. THE System SHALL support at least 10 to 20 concurrent Player devices maintaining an active Realtime_Subscription to the same Game without failure.
2. THE System SHALL NOT impose a hard-coded maximum of 2 or 3 Players per Game anywhere in the join or ticket-assignment path.
3. WHERE the Realtime mechanism in use supports scoping a subscription to a specific Game, THE System SHALL scope every Client's subscription to that Client's own `game_id` rather than subscribing to unfiltered table-wide changes.

## Non-Goals

The following are explicitly out of scope for this module, carried forward from the source requirements and the approved design:

1. Microsoft Entra ID, SSO, role-based enterprise access, corporate directory integration, or Microsoft Graph of any kind.
2. Any large-scale enterprise backend architecture beyond a single managed Supabase project sized for a 10-20 device pilot.
3. A UI redesign beyond what is needed to wire existing screens to realtime shared state.
4. Production-scale performance engineering, load testing beyond the stated pilot target, or advanced monitoring/analytics.
5. A self-hosted realtime backend server; Supabase Realtime is fully managed and no alternative hosting is introduced.
6. Any change to the underlying prize rules, the five prize categories, the manual-mark/manual-claim/host-confirmation model, or the direct-word-call gameplay model, all of which are preserved unchanged from Modules 3-5.
