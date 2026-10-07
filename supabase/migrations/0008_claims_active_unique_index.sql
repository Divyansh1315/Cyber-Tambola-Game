-- Module: claim-duplicate-submission bugfix
-- Additive-only: strictly ADDS a backstop; does not alter submit_claim's
-- existing 10-gate order or any gate's outcome (bugfix.md Req 2.9, 3.5).
-- Mirrors the "hard backstop even if application-level logic were ever
-- bypassed" convention already documented on called_terms/marks/tickets/
-- players/winners in 0001_schema.sql -- claims was the one table in that
-- migration without an equivalent constraint.
--
-- Numbering note: design.md/tasks.md specify this file as
-- "0006_claims_active_unique_index.sql", but 0006 and 0007 are already taken
-- by unrelated migrations (active_game_and_winner_history,
-- remove_employee_id_from_join) that landed after design.md was written.
-- This file is numbered 0008 -- the next available slot -- to avoid
-- clobbering either existing migration. No existing migration file (0001
-- through 0007) is modified by this change.
--
-- MANUAL APPLY REQUIRED: this migration file is NOT auto-applied by any
-- build/deploy step in this project. It must be run manually against the
-- live Supabase project (e.g. via the Supabase SQL editor, or the same
-- migration-apply mechanism already used to apply 0001-0007 for this
-- project) before this backstop takes effect in production. See
-- bugfix.md's Required Final Acceptance Criteria item 16.
create unique index claims_one_active_per_player_prize
  on claims (player_id, prize_id)
  where host_decision in ('PENDING', 'CONFIRMED');
