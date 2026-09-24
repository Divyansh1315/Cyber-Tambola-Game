-- Module 6: Real Multi-Device Realtime Synchronization
-- Migration 0004: Next-word and mark-submission RPC functions
--
-- Authors call_next_word and submit_mark exactly as specified in design.md's
-- "RPC functions" section. Both are SECURITY DEFINER: they run as the table
-- owner, bypassing RLS internally only after their own explicit checks, and
-- are the only door through which an anon client can add to called_terms,
-- advance a game's current_term_id/status, or create a Mark (see
-- 0002_rls.sql's deliberate anon-write omission).
--
-- call_next_word is host-only (host_secret checked against games.host_secret)
-- and race-proof by construction: `select ... for update` takes a row lock
-- on the target games row, so two concurrent calls for the same game
-- serialize — the second transaction blocks until the first commits its
-- called_terms insert and games update, then re-reads called_terms and picks
-- a different term. The UNIQUE(game_id, term_id) constraint on called_terms
-- (0001_schema.sql) is the hard backstop even if that locking discipline were
-- ever bypassed.
--
-- submit_mark is player-callable and mirrors validateMarkAttempt's five
-- gates (src/utils/prizeEngine.ts) in the same order, so a modified client
-- can never persist a mark it wasn't entitled to: NO_CURRENT_PLAYER,
-- TICKET_NOT_FOUND, TERM_NOT_ON_TICKET, TERM_NOT_REVEALED, GAME_COMPLETED.
-- The sixth gate, DUPLICATE_MARK, is not re-implemented as an explicit check
-- here — it is enforced by the marks table's
-- UNIQUE(player_id, ticket_id, term_id) constraint (0001_schema.sql), which
-- raises a unique_violation on a duplicate insert that the client treats
-- identically to "already marked, no-op."
--
-- Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 8.1, 8.2, 8.3, 9.1, 9.2, 9.3,
-- 10.1, 10.2, 10.3, 10.4

-- ---------------------------------------------------------------------------
-- Host-only: verified by host_secret. Atomic next-word selection using a row
-- lock on `games` so two concurrent calls for the same game serialize instead
-- of racing (see design.md's concurrency sequence diagram).
-- ---------------------------------------------------------------------------
create or replace function call_next_word(p_game_id uuid, p_host_secret uuid, p_active_term_ids text[])
returns games language plpgsql security definer as $$
declare
  v_game games;
  v_used text[];
  v_available text[];
  v_next text;
begin
  select * into v_game from games where id = p_game_id for update;  -- serializes concurrent callers

  if v_game.id is null or v_game.host_secret <> p_host_secret then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if v_game.status not in ('LOBBY', 'WORD_ACTIVE') then
    raise exception 'INVALID_STATE';
  end if;

  select array_agg(term_id) into v_used from called_terms where game_id = p_game_id;
  select array_agg(t) into v_available
    from unnest(p_active_term_ids) as t where t <> all (coalesce(v_used, array[]::text[]));

  if v_available is null or array_length(v_available, 1) = 0 then
    -- Bank exhausted: transition to COMPLETED rather than raising an
    -- unhandled error (Requirement 7.6).
    update games set status = 'COMPLETED', ended_at = now(), updated_at = now()
      where id = p_game_id returning * into v_game;
    return v_game;
  end if;

  select v_available[1 + floor(random() * array_length(v_available, 1))::int] into v_next;

  -- called_terms insert precedes the games update, and UNIQUE(game_id, term_id)
  -- on called_terms is the hard backstop: even if two transactions somehow
  -- both passed the availability check (they cannot, due to the FOR UPDATE
  -- lock above), only one INSERT could ever succeed for the same term
  -- (Requirements 7.2, 9.1, 9.2).
  insert into called_terms(game_id, term_id, round) values (p_game_id, v_next, v_game.current_round + 1);

  update games set
      status = 'WORD_ACTIVE',
      current_round = v_game.current_round + 1,
      current_term_id = v_next,
      started_at = coalesce(v_game.started_at, now()),
      updated_at = now()
    where id = p_game_id returning * into v_game;

  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- Player-callable: mark a term. Re-validates every gate server-side —
-- mirrors validateMarkAttempt's five checks exactly, so a modified client
-- can never persist a mark it wasn't entitled to, even though the client
-- also runs the same checks locally for instant feedback.
-- ---------------------------------------------------------------------------
create or replace function submit_mark(p_player_id uuid, p_term_id text)
returns marks language plpgsql security definer as $$
declare
  v_player players;
  v_ticket tickets;
  v_game games;
  v_on_ticket boolean;
  v_mark marks;
begin
  select * into v_player from players where id = p_player_id;
  if v_player.id is null then raise exception 'NO_CURRENT_PLAYER'; end if;

  select * into v_ticket from tickets where player_id = v_player.id;
  if v_ticket.id is null then raise exception 'TICKET_NOT_FOUND'; end if;

  select exists(select 1 from jsonb_array_elements(v_ticket.cells) c where c->>'termId' = p_term_id)
    into v_on_ticket;
  if not v_on_ticket then raise exception 'TERM_NOT_ON_TICKET'; end if;

  select * into v_game from games where id = v_player.game_id;
  if not exists(select 1 from called_terms where game_id = v_game.id and term_id = p_term_id) then
    raise exception 'TERM_NOT_REVEALED';
  end if;
  if v_game.status = 'COMPLETED' then raise exception 'GAME_COMPLETED'; end if;

  insert into marks(game_id, player_id, ticket_id, term_id)
    values (v_game.id, v_player.id, v_ticket.id, p_term_id)
    returning * into v_mark;
  -- DUPLICATE_MARK is enforced by the UNIQUE(player_id, ticket_id, term_id)
  -- constraint (0001_schema.sql); a duplicate insert raises a
  -- unique_violation the client treats identically to "already marked,
  -- no-op" (Requirements 8.3, 9.3).

  return v_mark;
end;
$$;
