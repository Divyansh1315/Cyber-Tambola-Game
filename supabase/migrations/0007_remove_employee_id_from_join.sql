-- Migration 0007: remove Employee ID from the player-facing join flow
--
-- The Player Join screen no longer collects an Employee ID / Demo ID. The
-- previous identity/restore mechanism resolved a duplicate join by
-- (game_id, normalized employee_demo_id) -- with that field gone from the
-- form, restore needs a different, non-PII matching key. Player display
-- names are explicitly NOT usable for this (different employees can share
-- a name), so this migration introduces `device_join_token`: an opaque,
-- client-generated UUID persisted in the browser's localStorage (see
-- src/state/joinService.ts's `readOrCreateDeviceJoinToken`), sent by the
-- client in place of employee_demo_id. It carries no personal information
-- and is never displayed anywhere in the UI.
--
-- This migration does NOT drop the employee_demo_id column or its existing
-- data -- "preserve existing player records" -- it only:
--   1. Adds device_join_token (+ its normalized generated column) as the
--      new restore-matching key for all FUTURE joins.
--   2. Makes employee_demo_id nullable (it can no longer be NOT NULL, since
--      new rows will not supply it) and drops its now-obsolete unique
--      constraint together with its normalized column's NOT NULL cast
--      chain, replacing it with an equivalent unique constraint on
--      (game_id, device_join_token_normalized).
--   3. Updates join_game(...) to accept p_device_join_token instead of
--      p_employee_demo_id, matching/restoring on the new column, and to
--      insert new player rows with employee_demo_id left NULL.
--
-- Existing rows keep their employee_demo_id value untouched; they simply
-- have a NULL device_join_token until/unless that same browser rejoins
-- (at which point join_game's restore lookup would only find them again if
-- the device also happens to carry a matching token, which it won't for
-- pre-existing rows -- pre-existing players are unaffected either way,
-- since this only changes behavior for NEW join attempts going forward).
--
-- IMPORTANT: this migration must be applied manually to any live Supabase
-- project the same way migrations 0001-0006 were (see project history --
-- there is no automated migration deployment in this repo). The player
-- join flow described in this change is NOT complete/usable against a
-- live database until this file has been run there.

-- ---------------------------------------------------------------------------
-- 1. New identity column + its normalized generated column.
-- ---------------------------------------------------------------------------
alter table players
  add column device_join_token text,
  add column device_join_token_normalized text
    generated always as (lower(trim(device_join_token))) stored;

-- ---------------------------------------------------------------------------
-- 2. Relax the old employee_demo_id constraints (nullable now; a NEW join
--    never supplies it) and drop its unique constraint, replacing it with
--    one on the new column. A partial unique index is used (rather than a
--    table-level unique constraint) so multiple NULL device_join_token
--    rows -- e.g. any pre-existing players from before this migration --
--    never collide with each other under Postgres's NULL-distinct-in-
--    unique-constraints semantics; this is belt-and-suspenders since
--    NULL <> NULL already means a table-level unique constraint would not
--    conflict on multiple NULLs either, but a partial index makes the
--    intent explicit and avoids indexing rows that don't use this column.
-- ---------------------------------------------------------------------------
alter table players
  alter column employee_demo_id drop not null;

alter table players
  drop constraint if exists players_game_id_employee_demo_id_normalized_key;

create unique index if not exists players_game_id_device_join_token_key
  on players (game_id, device_join_token_normalized)
  where device_join_token_normalized is not null;

-- ---------------------------------------------------------------------------
-- 3. join_game: accept p_device_join_token instead of p_employee_demo_id;
--    match/restore on the new column; insert new rows with
--    employee_demo_id left NULL and device_join_token populated.
-- ---------------------------------------------------------------------------
create or replace function join_game(
  p_game_code text,
  p_display_name text,
  p_device_join_token text,
  p_active_term_ids text[]
)
returns table(player_id uuid, ticket_id uuid) language plpgsql security definer as $$
declare
  v_game games;
  v_player players;
  v_ticket tickets;
begin
  select * into v_game from games where code = p_game_code;
  if v_game.id is null then
    raise exception 'GAME_NOT_FOUND';
  end if;
  if v_game.status = 'COMPLETED' then
    raise exception 'GAME_COMPLETED';
  end if;

  select * into v_player from players
    where game_id = v_game.id
      and device_join_token_normalized = lower(trim(p_device_join_token));

  if v_player.id is not null then
    -- Restore: no new player, no new ticket (same early-return shape as
    -- the original join_game -- see 0003's comment on why the explicit
    -- "return;" is required after "return query").
    select * into v_ticket from tickets where tickets.player_id = v_player.id;
    return query select v_player.id, v_ticket.id;
    return;
  end if;

  insert into players(game_id, display_name, device_join_token)
    values (v_game.id, trim(p_display_name), trim(p_device_join_token))
    returning * into v_player;

  select * into v_ticket from assign_ticket(v_game.id, v_player.id, p_active_term_ids);

  return query select v_player.id, v_ticket.id;
end;
$$;
