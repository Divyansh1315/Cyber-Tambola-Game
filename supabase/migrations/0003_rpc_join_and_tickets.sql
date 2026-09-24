-- Module 6: Real Multi-Device Realtime Synchronization
-- Migration 0003: Join and ticket-assignment RPC functions
--
-- Authors get_or_create_game, join_game, and assign_ticket exactly as
-- specified in design.md's "RPC functions" section. All three are
-- SECURITY DEFINER: they run as the table owner, bypassing RLS internally
-- only after their own explicit checks, and are the only door through which
-- an anon client can create/read a Game, create/restore a Player, or create
-- a Ticket (see 0002_rls.sql's deliberate anon-write omission).
--
-- Correction from design.md's shown signature: design.md's join_game excerpt
-- is written as join_game(p_game_code text, p_display_name text,
-- p_employee_demo_id text) and its body calls
-- `select * into v_ticket from assign_ticket(v_game.id, v_player.id)` with
-- only two arguments. assign_ticket's own signature (also specified in
-- design.md, and reproduced below) requires a third argument,
-- p_active_term_ids text[] — the client-bundled active-terms bank, since the
-- database has no other source for which of the 30 static cyberTerms.ts rows
-- are currently active. join_game cannot satisfy assign_ticket's contract
-- without that array, so this migration adds a p_active_term_ids text[]
-- parameter to join_game and threads it straight through to assign_ticket.
-- This is a necessary correction to make the two functions composable, not
-- a new design decision.
--
-- Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 5.5

-- ---------------------------------------------------------------------------
-- Player-callable: create the seed game if absent, or return the existing
-- one. (Dev convenience; a real pilot pre-creates the one game code before
-- the session, but this keeps `npm run dev` runnable without a manual
-- insert.)
-- ---------------------------------------------------------------------------
create or replace function get_or_create_game(p_code text)
returns games language plpgsql security definer as $$
declare g games;
begin
  select * into g from games where code = p_code;
  if g.id is null then
    insert into games(code) values (p_code) returning * into g;
  end if;
  return g;
end;
$$;

-- ---------------------------------------------------------------------------
-- Internal-atomic ticket assignment. Mirrors ticketGenerator.ts's algorithm:
-- shuffle active terms, take 15, retry up to 50 times on a signature clash.
-- The active-terms bank is passed in from the client's bundled cyberTerms.ts
-- (30 static rows) as a text[] of active term ids so the SQL side never
-- needs its own copy of content data — only the algorithm is duplicated.
-- ---------------------------------------------------------------------------
create or replace function assign_ticket(p_game_id uuid, p_player_id uuid, p_active_term_ids text[])
returns tickets language plpgsql security definer as $$
declare
  v_shuffled text[];
  v_chosen text[];
  v_signature text;
  v_cells jsonb;
  v_ticket tickets;
  v_attempt int := 0;
begin
  if array_length(p_active_term_ids, 1) < 15 then
    raise exception 'INSUFFICIENT_ACTIVE_TERMS';
  end if;

  loop
    v_attempt := v_attempt + 1;
    -- Fisher-Yates-equivalent: order_by random() over the active id array.
    select array_agg(t order by random()) into v_shuffled
      from unnest(p_active_term_ids) as t;
    v_chosen := v_shuffled[1:15];
    select array_to_string(array(select unnest(v_chosen) order by 1), '|') into v_signature;

    if not exists (select 1 from tickets where game_id = p_game_id and signature = v_signature) then
      exit;
    end if;
    if v_attempt >= 50 then
      raise exception 'TICKET_UNIQUE_RETRY_EXCEEDED';
    end if;
  end loop;

  -- Build the 3x5 cells jsonb; `term` display text is filled in client-side
  -- on read from the bundled bank (cells here only carry termId/row/col),
  -- mirroring how TicketCell.term is already just a denormalized label.
  select jsonb_agg(jsonb_build_object('termId', v_chosen[i], 'row', (i-1)/5, 'col', (i-1)%5))
    into v_cells from generate_series(1, 15) as i;

  insert into tickets(game_id, player_id, ref, signature, cells)
    values (p_game_id, p_player_id, 'Ticket #' || upper(substr(p_player_id::text, 1, 4)), v_signature, v_cells)
    returning * into v_ticket;

  return v_ticket;
end;
$$;

-- ---------------------------------------------------------------------------
-- Player-callable: join or restore. Never trusts a client-supplied player id;
-- identity resolution is by (game_id, normalized employee_demo_id) only.
--
-- p_active_term_ids is the necessary correction described above: it is not
-- part of design.md's shown join_game signature, but is required to satisfy
-- assign_ticket's contract when a brand-new Player must be assigned a Ticket.
-- ---------------------------------------------------------------------------
create or replace function join_game(
  p_game_code text,
  p_display_name text,
  p_employee_demo_id text,
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
    where game_id = v_game.id and employee_demo_id_normalized = lower(trim(p_employee_demo_id));

  if v_player.id is not null then
    -- Restore: no new player, no new ticket (Req: duplicate id restores).
    -- The explicit "return;" here is required: "return query" only
    -- appends rows to the result set, it does not exit the function, so
    -- without it execution would fall through into the insert below on
    -- every restore, raising a duplicate-key violation on every repeat join.
    select * into v_ticket from tickets where tickets.player_id = v_player.id;
    return query select v_player.id, v_ticket.id;
    return;
  end if;

  insert into players(game_id, display_name, employee_demo_id)
    values (v_game.id, trim(p_display_name), trim(p_employee_demo_id))
    returning * into v_player;

  -- assign_ticket is defined above and is itself atomic/unique-checked.
  select * into v_ticket from assign_ticket(v_game.id, v_player.id, p_active_term_ids);

  return query select v_player.id, v_ticket.id;
end;
$$;
