-- Module 6: Real Multi-Device Realtime Synchronization
-- Migration 0001: Core schema (tables, constraints, updated_at triggers, realtime publication)
--
-- This migration creates the seven tables that become the single authoritative
-- source for every piece of game state shared across more than one device:
-- games, called_terms, players, tickets, marks, claims, winners.
--
-- Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8

-- ---------------------------------------------------------------------------
-- games: one row per session. host_secret is a per-game random token, known
-- only to the device that created the game (the Host laptop), never sent to
-- Player devices, and required by every host-only RPC.
-- ---------------------------------------------------------------------------
create table games (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,           -- e.g. "CYBER24"
  host_secret   uuid not null default gen_random_uuid(),
  status        text not null default 'LOBBY'
                check (status in ('LOBBY','WORD_ACTIVE','PAUSED','COMPLETED')),
  current_round     integer not null default 0,
  current_term_id   text,                        -- references cyberTerms.ts ids (client-bundled bank, not a DB table)
  previous_status   text
                check (previous_status in ('LOBBY','WORD_ACTIVE','PAUSED','COMPLETED')),
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  ended_at      timestamptz,
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- called_terms: append-only log of every term officially called this game.
-- The UNIQUE constraint (expressed here as the primary key) is what makes a
-- duplicate "call next word" race fail cleanly at the database level (see
-- call_next_word, authored in a later migration).
-- ---------------------------------------------------------------------------
create table called_terms (
  game_id     uuid not null references games(id) on delete cascade,
  term_id     text not null,
  called_at   timestamptz not null default now(),
  round       integer not null,
  primary key (game_id, term_id)
);

-- ---------------------------------------------------------------------------
-- players: one row per (game, employee_demo_id). employee_demo_id_normalized
-- is a generated column so "duplicate join restores existing player" can be
-- enforced as a UNIQUE constraint rather than an application-level race.
-- ---------------------------------------------------------------------------
create table players (
  id                     uuid primary key default gen_random_uuid(),
  game_id                uuid not null references games(id) on delete cascade,
  display_name           text not null,
  employee_demo_id       text not null,
  employee_demo_id_normalized text generated always as (lower(trim(employee_demo_id))) stored,
  joined_at              timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (game_id, employee_demo_id_normalized)
);

-- ---------------------------------------------------------------------------
-- tickets: exactly one per player (enforced by UNIQUE), 15 cells inline as
-- jsonb mirroring TicketCell[][] so the client can deserialize directly into
-- the existing Ticket shape without a join across 15 rows.
-- ---------------------------------------------------------------------------
create table tickets (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references games(id) on delete cascade,
  player_id     uuid not null unique references players(id) on delete cascade,
  ref           text not null,
  signature     text not null,                  -- computeSignature() equivalent: sorted term ids joined by '|'
  cells         jsonb not null,                 -- TicketCell[][] - 3 rows x 5 cols, each {termId, term, row, col}
  created_at    timestamptz not null default now(),
  unique (game_id, signature)
);

-- ---------------------------------------------------------------------------
-- marks: one row per (player, ticket, term) the player has validly marked.
-- ---------------------------------------------------------------------------
create table marks (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references games(id) on delete cascade,
  player_id     uuid not null references players(id) on delete cascade,
  ticket_id     uuid not null references tickets(id) on delete cascade,
  term_id       text not null,
  marked_at     timestamptz not null default now(),
  unique (player_id, ticket_id, term_id)          -- DUPLICATE_MARK is a constraint violation, not app logic
);

-- ---------------------------------------------------------------------------
-- claims: one row per submitted claim attempt (valid or invalid; every
-- attempt is recorded, matching the existing claimEngine/reducer behavior).
-- ---------------------------------------------------------------------------
create table claims (
  id                 uuid primary key default gen_random_uuid(),
  game_id            uuid not null references games(id) on delete cascade,
  player_id          uuid not null references players(id) on delete cascade,
  ticket_id          uuid not null references tickets(id) on delete cascade,
  prize_id           text not null
                     check (prize_id in ('CYBER_FIVE','FIREWALL_LINE','SECURITY_LINE','DATA_DEFENDER_LINE','CYBER_FULL_HOUSE')),
  submitted_at       timestamptz not null default now(),
  validation_status  text not null check (validation_status in ('VALID','INVALID')),
  host_decision      text not null default 'PENDING' check (host_decision in ('PENDING','CONFIRMED','REJECTED')),
  rejection_reason   text,
  decided_at         timestamptz,
  prize_label        text not null,
  player_name        text not null,
  ticket_ref         text not null
);

-- ---------------------------------------------------------------------------
-- winners: at most one per (game, prize) — enforced by UNIQUE, mirroring
-- isPrizeClosed's invariant as a hard database guarantee, not just a derived read.
-- ---------------------------------------------------------------------------
create table winners (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references games(id) on delete cascade,
  prize_id      text not null,
  player_id     uuid not null references players(id) on delete cascade,
  ticket_id     uuid not null references tickets(id) on delete cascade,
  claim_id      uuid not null references claims(id) on delete cascade,
  confirmed_at  timestamptz not null default now(),
  prize_label   text not null,
  player_name   text not null,
  unique (game_id, prize_id)
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance trigger.
--
-- Only `games` and `players` carry an `updated_at` column in this schema
-- (see design.md's "Database schema" section); `called_terms`, `tickets`,
-- `marks`, `claims`, and `winners` are append-only/immutable-after-insert
-- rows and intentionally have no `updated_at` column, so no trigger is
-- attached to them here. This single trigger function is reused by both
-- tables that do carry the column.
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger games_set_updated_at
  before update on games
  for each row execute function set_updated_at();

create trigger players_set_updated_at
  before update on players
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Realtime needs every subscribed table in the supabase_realtime publication.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table games, called_terms, players, tickets, marks, claims, winners;
