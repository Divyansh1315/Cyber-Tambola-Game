-- Module: Winner History and Game Reset
-- Migration 0006: active_game_pointer table, winners.ticket_ref column, RLS, realtime
--
-- This migration introduces a genuine server-side Active_Game_Pointer (a
-- singleton table) so Host Dashboard and Presentation View can resolve "the
-- currently live game" through an explicit mechanism rather than a fixed
-- seed-code lookup, and adds a denormalized `ticket_ref` column to `winners`
-- so Winner_History can render a ticket reference with no join to `tickets`.
--
-- Requirements: 1.1, 1.2, 1.4, 2.3, 3.1, 3.5

-- ---------------------------------------------------------------------------
-- active_game_pointer: singleton table. Exactly one row ever exists (seeded
-- once below); active_game_id is nullable so "no Active_Game" (Req 3.4) is
-- representable without any sentinel game row. The `id` column is pinned to
-- a single fixed value so a second row can never be inserted (Req 3.1, 3.5 —
-- "at most one Game as Active_Game" is enforced by there being at most one
-- pointer row to begin with, not by a partial index over many rows).
-- ---------------------------------------------------------------------------
create table active_game_pointer (
  id              boolean primary key default true check (id),
  active_game_id  uuid references games(id) on delete set null,
  updated_at      timestamptz not null default now()
);

insert into active_game_pointer (id, active_game_id) values (true, null);

-- Reuses the existing set_updated_at() trigger function from
-- 0001_schema.sql, same convention as the games/players triggers.
create trigger active_game_pointer_set_updated_at
  before update on active_game_pointer
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- winners gains ticket_ref, denormalized at confirm_claim time from the
-- confirming claim's own ticket_ref -- so Winner_History (Req 2.3) never
-- needs a join to tickets to render a ticket reference, matching the
-- "no cross-table joins required for display" property already true of
-- prize_label/player_name.
-- ---------------------------------------------------------------------------
alter table winners add column ticket_ref text;
update winners set ticket_ref = 'Unknown ticket' where ticket_ref is null;
alter table winners alter column ticket_ref set not null;

-- ---------------------------------------------------------------------------
-- RLS: anon may read the pointer row (Host/Presentation need this to
-- resolve the Active_Game with only the anon key, exactly like every other
-- shared table). No write policy for anon -- the pointer is only ever
-- written by reset_game_to_new (SECURITY DEFINER), same default-deny
-- convention as every other write path in this schema (0002_rls.sql).
-- ---------------------------------------------------------------------------
alter table active_game_pointer enable row level security;
create policy "anon can read active_game_pointer" on active_game_pointer for select to anon using (true);

-- ---------------------------------------------------------------------------
-- Realtime needs the new table in the publication so pointer changes reach
-- subscribed clients.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table active_game_pointer;

-- ---------------------------------------------------------------------------
-- Read-only, callable by anyone (player, host, or presentation device):
-- resolves the Active_Game strictly through the pointer (Req 3.2, 3.3, 3.4).
-- Returns no row at all when active_game_id is null -- callers must treat
-- "zero rows" as "no Active_Game currently exists," never falling back to
-- any other games query.
-- ---------------------------------------------------------------------------
create or replace function get_active_game()
returns games language sql stable as $$
  select g.*
    from active_game_pointer p
    join games g on g.id = p.active_game_id
    where p.id = true;
$$;

-- ---------------------------------------------------------------------------
-- Internal: generates a New_Game_Code in the SEED_GAME_CODE convention
-- (uppercase alphanumeric, e.g. "CYBER24") and retries on the rare collision
-- with an existing games.code, mirroring assign_ticket's own
-- collision-retry loop shape (0003_rpc_join_and_tickets.sql).
-- ---------------------------------------------------------------------------
create or replace function generate_new_game_code()
returns text language plpgsql as $$
declare
  v_code text;
  v_attempt int := 0;
begin
  loop
    v_attempt := v_attempt + 1;
    -- 4 random uppercase letters + 2 random digits, e.g. "QXKD47" --
    -- alphanumeric and uppercase, matching CYBER24's own shape without
    -- colliding with the fixed dev seed code's exact letter count.
    select
        string_agg(chr(65 + floor(random() * 26)::int), '')
        || lpad(floor(random() * 100)::text, 2, '0')
      into v_code
      from generate_series(1, 4);

    if not exists (select 1 from games where code = v_code) then
      return v_code;
    end if;
    if v_attempt >= 50 then
      raise exception 'GAME_CODE_RETRY_EXCEEDED';
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Host-only: atomically retires the OLD Active_Game and activates a newly
-- created one (Req 5.1-5.7). Requires the OLD game's own host_secret,
-- exactly like every other host-only RPC in 0005_rpc_lifecycle_and_claims.sql
-- (Req 5.5, 5.6). Deletes are scoped to p_old_game_id only and never touch
-- winners (Req 1.1, 1.2, 5.7) -- this is reset_game's replacement.
-- ---------------------------------------------------------------------------
create or replace function reset_game_to_new(p_old_game_id uuid, p_host_secret uuid)
returns table(old_game_id uuid, new_game games) language plpgsql security definer as $$
declare
  v_old_game games;
  v_new_code text;
  v_new_game games;
begin
  select * into v_old_game from games where id = p_old_game_id for update;
  if v_old_game.id is null or v_old_game.host_secret <> p_host_secret then
    raise exception 'NOT_AUTHORIZED';
  end if;

  v_new_code := generate_new_game_code();

  insert into games(code, status) values (v_new_code, 'LOBBY')
    returning * into v_new_game;

  update active_game_pointer set active_game_id = v_new_game.id where id = true;

  -- Scoped strictly to the OLD game (Req 1.2, 5.7): winners is
  -- deliberately absent from this list.
  delete from claims where game_id = p_old_game_id;
  delete from marks where game_id = p_old_game_id;
  delete from tickets where game_id = p_old_game_id;
  delete from players where game_id = p_old_game_id;
  delete from called_terms where game_id = p_old_game_id;

  return query select p_old_game_id, v_new_game;
end;
$$;
