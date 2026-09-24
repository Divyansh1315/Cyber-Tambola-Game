-- Module 6: Real Multi-Device Realtime Synchronization
-- Migration 0005: Lifecycle and claim RPC functions
--
-- Authors pause_game, resume_game, end_game, reset_game, submit_claim,
-- confirm_claim, and reject_claim exactly as specified in design.md's
-- "RPC functions" section. All seven are SECURITY DEFINER: they run as the
-- table owner, bypassing RLS internally only after their own explicit
-- checks, and are the only door through which an anon client can change a
-- game's status, submit a claim, or record a winner (see 0002_rls.sql's
-- deliberate anon-write omission).
--
-- pause_game/resume_game/end_game/reset_game are host-only (host_secret
-- checked against games.host_secret) and are a direct, mechanical SQL
-- restatement of gameSessionReducer.ts's PAUSE_GAME/RESUME_GAME/END_GAME/
-- RESET_GAME cases: the reducer's silent "ignore invalid actions" no-op
-- becomes an explicit raised exception here, because an RPC caller (unlike
-- a dispatched action) needs to be told a call had no effect.
--
-- submit_claim is player-callable and mirrors validatePrizeClaim's exact
-- 10-gate order (src/utils/claimEngine.ts): GAME_NOT_FOUND, PLAYER_NOT_FOUND,
-- PLAYER_NOT_IN_GAME, TICKET_NOT_FOUND, TICKET_NOT_OWNED_BY_PLAYER,
-- PRIZE_NOT_FOUND, DUPLICATE_ACTIVE_CLAIM, RESUBMISSION_LIMIT_REACHED,
-- PRIZE_CLOSED, NOT_ELIGIBLE. Unlike submit_mark, every gate failure results
-- in an INSERT with validation_status='INVALID' and rejection_reason set to
-- the gate's code, rather than a raised exception — every submission is
-- recorded, exactly as claimEngine.ts/the SUBMIT_PRIZE_CLAIM reducer case
-- already guarantee client-side (a submitted-but-invalid claim is never
-- silently dropped). p_player_id's own game/ticket are looked up directly
-- (a player row always belongs to exactly one game and has exactly one
-- ticket in this schema), so GAME_NOT_FOUND/PLAYER_NOT_IN_GAME can only ever
-- arise from a stale/malformed p_player_id.
--
-- confirm_claim and reject_claim are host-only and mirror canConfirmClaim
-- (src/utils/winnerEngine.ts) and the REJECT_CLAIM reducer case
-- respectively, each checking host_secret first.
--
-- Eligibility in submit_claim is computed directly against the ticket's
-- `cells` jsonb and the player's own `marks` rows, translating
-- prizeEngine.ts's per-prize rules: CYBER_FIVE counts any 5 distinct marked
-- terms present on the ticket; FIREWALL_LINE/SECURITY_LINE/
-- DATA_DEFENDER_LINE count marked terms in row 0/1/2 respectively (target 5,
-- i.e. the whole row); CYBER_FULL_HOUSE counts all 15 ticket terms marked.
-- No prize-counting logic is reimplemented beyond this direct restatement of
-- the four counting rules already read from prizeEngine.ts.
--
-- Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 12.1, 12.2, 12.3, 12.4, 12.5, 13.1,
-- 13.2, 13.3, 13.4, 13.5, 13.6

-- ---------------------------------------------------------------------------
-- Host-only: pause a game currently WORD_ACTIVE, storing previous_status so
-- resume_game can restore it. Mirrors gameSessionReducer.ts's PAUSE_GAME
-- case; its silent no-op-if-not-WORD_ACTIVE becomes an explicit exception.
-- ---------------------------------------------------------------------------
create or replace function pause_game(p_game_id uuid, p_host_secret uuid)
returns games language plpgsql security definer as $$
declare
  v_game games;
begin
  select * into v_game from games where id = p_game_id for update;
  if v_game.id is null or v_game.host_secret <> p_host_secret then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if v_game.status <> 'WORD_ACTIVE' then
    raise exception 'INVALID_STATE';
  end if;

  update games set
      status = 'PAUSED',
      previous_status = v_game.status,
      updated_at = now()
    where id = p_game_id returning * into v_game;

  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- Host-only: resume a paused game back to its pre-pause status. Mirrors
-- gameSessionReducer.ts's RESUME_GAME case, including its
-- `previousStatus ?? 'WORD_ACTIVE'` default.
-- ---------------------------------------------------------------------------
create or replace function resume_game(p_game_id uuid, p_host_secret uuid)
returns games language plpgsql security definer as $$
declare
  v_game games;
  v_resume_to text;
begin
  select * into v_game from games where id = p_game_id for update;
  if v_game.id is null or v_game.host_secret <> p_host_secret then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if v_game.status <> 'PAUSED' then
    raise exception 'INVALID_STATE';
  end if;

  v_resume_to := coalesce(v_game.previous_status, 'WORD_ACTIVE');

  update games set
      status = v_resume_to,
      previous_status = null,
      updated_at = now()
    where id = p_game_id returning * into v_game;

  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- Host-only: end a game from any status except COMPLETED. Mirrors
-- gameSessionReducer.ts's END_GAME case; its silent
-- no-op-if-already-COMPLETED becomes an explicit exception here, since an
-- RPC call (unlike a dispatched action) needs to be told it had no effect.
-- ---------------------------------------------------------------------------
create or replace function end_game(p_game_id uuid, p_host_secret uuid)
returns games language plpgsql security definer as $$
declare
  v_game games;
begin
  select * into v_game from games where id = p_game_id for update;
  if v_game.id is null or v_game.host_secret <> p_host_secret then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if v_game.status = 'COMPLETED' then
    raise exception 'INVALID_STATE';
  end if;

  update games set
      status = 'COMPLETED',
      ended_at = now(),
      previous_status = null,
      updated_at = now()
    where id = p_game_id returning * into v_game;

  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- Host-only, dev-only: full reset of one game's state back to LOBBY. Unlike
-- the client reducer's RESET_GAME (a full local dev-reset to a freshly
-- generated seed game, per gameSessionInitialState.ts), the SQL version
-- cannot fabricate a brand-new game row identity out from under every
-- connected client's game_id — instead it truncates every child table's rows
-- for this game_id and resets the games row itself to its LOBBY defaults, per
-- design.md's inline comment for this function.
-- ---------------------------------------------------------------------------
create or replace function reset_game(p_game_id uuid, p_host_secret uuid)
returns games language plpgsql security definer as $$
declare
  v_game games;
begin
  select * into v_game from games where id = p_game_id for update;
  if v_game.id is null or v_game.host_secret <> p_host_secret then
    raise exception 'NOT_AUTHORIZED';
  end if;

  delete from winners where game_id = p_game_id;
  delete from claims where game_id = p_game_id;
  delete from marks where game_id = p_game_id;
  delete from tickets where game_id = p_game_id;
  delete from players where game_id = p_game_id;
  delete from called_terms where game_id = p_game_id;

  update games set
      status = 'LOBBY',
      current_round = 0,
      current_term_id = null,
      previous_status = null,
      started_at = null,
      ended_at = null,
      updated_at = now()
    where id = p_game_id returning * into v_game;

  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- Player-callable: submit a claim. Mirrors validatePrizeClaim's gates 1-10
-- (src/utils/claimEngine.ts) in the same order. Every gate failure inserts an
-- INVALID claim row with rejection_reason set to that gate's code rather than
-- raising — every submission is recorded, exactly as claimEngine.ts already
-- guarantees client-side. A passing submission inserts a VALID/PENDING row
-- with rejection_reason null.
-- ---------------------------------------------------------------------------
create or replace function submit_claim(p_player_id uuid, p_prize_id text)
returns claims language plpgsql security definer as $$
declare
  v_player players;
  v_game games;
  v_ticket tickets;
  v_prize_label text;
  v_prize_target int;
  v_row int;
  v_rejected_count int;
  v_has_active_or_won boolean;
  v_is_closed boolean;
  v_marked_term_ids text[];
  v_ticket_term_ids text[];
  v_current int;
  v_reason text;
  v_claim claims;
begin
  -- Gate 1/2: GAME_NOT_FOUND / PLAYER_NOT_FOUND. A stale/malformed
  -- p_player_id is the only way either can occur, since a real players row
  -- always belongs to exactly one existing games row (foreign key).
  select * into v_player from players where id = p_player_id;
  if v_player.id is null then
    v_reason := 'PLAYER_NOT_FOUND';
    v_game.id := null;
  else
    select * into v_game from games where id = v_player.game_id;
    if v_game.id is null then
      v_reason := 'GAME_NOT_FOUND';
    end if;
  end if;

  -- Gate 3: PLAYER_NOT_IN_GAME — structurally unreachable via the foreign
  -- key above (a player row's game_id always references an existing game),
  -- but checked explicitly to keep this function's gate order a literal,
  -- auditable mirror of validatePrizeClaim's.
  if v_reason is null and v_player.game_id <> v_game.id then
    v_reason := 'PLAYER_NOT_IN_GAME';
  end if;

  -- Gate 4/5: TICKET_NOT_FOUND / TICKET_NOT_OWNED_BY_PLAYER.
  if v_reason is null then
    select * into v_ticket from tickets where player_id = v_player.id;
    if v_ticket.id is null then
      v_reason := 'TICKET_NOT_FOUND';
    elsif v_ticket.player_id <> v_player.id then
      v_reason := 'TICKET_NOT_OWNED_BY_PLAYER';
    end if;
  end if;

  -- Gate 6: PRIZE_NOT_FOUND.
  if v_reason is null then
    case p_prize_id
      when 'CYBER_FIVE' then v_prize_label := 'Cyber Five'; v_prize_target := 5;
      when 'FIREWALL_LINE' then v_prize_label := 'Firewall Line'; v_prize_target := 5;
      when 'SECURITY_LINE' then v_prize_label := 'Security Line'; v_prize_target := 5;
      when 'DATA_DEFENDER_LINE' then v_prize_label := 'Data Defender Line'; v_prize_target := 5;
      when 'CYBER_FULL_HOUSE' then v_prize_label := 'Cyber Full House'; v_prize_target := 15;
      else v_reason := 'PRIZE_NOT_FOUND';
    end case;
  end if;

  -- Gate 7/8: DUPLICATE_ACTIVE_CLAIM / RESUBMISSION_LIMIT_REACHED, evaluated
  -- over every prior claim for this exact (player, prize) pair.
  if v_reason is null then
    select
        exists(
          select 1 from claims
          where player_id = v_player.id and prize_id = p_prize_id
            and host_decision in ('PENDING', 'CONFIRMED')
        ),
        count(*) filter (where host_decision = 'REJECTED')
      into v_has_active_or_won, v_rejected_count
      from claims
      where player_id = v_player.id and prize_id = p_prize_id;

    if v_has_active_or_won then
      v_reason := 'DUPLICATE_ACTIVE_CLAIM';
    elsif v_rejected_count >= 2 then
      v_reason := 'RESUBMISSION_LIMIT_REACHED';
    end if;
  end if;

  -- Gate 9: PRIZE_CLOSED — a winners row already exists for this
  -- (game_id, prize_id), mirroring isPrizeClosed.
  if v_reason is null then
    select exists(
        select 1 from winners where game_id = v_game.id and prize_id = p_prize_id
      ) into v_is_closed;
    if v_is_closed then
      v_reason := 'PRIZE_CLOSED';
    end if;
  end if;

  -- Gate 10: NOT_ELIGIBLE — computed from this player's own ticket cells and
  -- marks, translating prizeEngine.ts's per-prize counting rules directly.
  if v_reason is null then
    select array_agg(m.term_id) into v_marked_term_ids
      from marks m where m.player_id = v_player.id and m.ticket_id = v_ticket.id;
    v_marked_term_ids := coalesce(v_marked_term_ids, array[]::text[]);

    if p_prize_id = 'CYBER_FIVE' then
      -- Any 5 distinct marked terms present on the ticket (target 5).
      select array_agg(c->>'termId') into v_ticket_term_ids
        from jsonb_array_elements(v_ticket.cells) c;
      select count(*) into v_current
        from unnest(v_ticket_term_ids) t where t = any(v_marked_term_ids);
    elsif p_prize_id = 'CYBER_FULL_HOUSE' then
      -- All 15 ticket terms marked (target 15).
      select array_agg(c->>'termId') into v_ticket_term_ids
        from jsonb_array_elements(v_ticket.cells) c;
      select count(*) into v_current
        from unnest(v_ticket_term_ids) t where t = any(v_marked_term_ids);
    else
      -- Line prizes: only marks whose ticket cell is in the matching row
      -- count (row 0 = FIREWALL_LINE, row 1 = SECURITY_LINE,
      -- row 2 = DATA_DEFENDER_LINE), target 5 (the whole row).
      v_row := case p_prize_id
        when 'FIREWALL_LINE' then 0
        when 'SECURITY_LINE' then 1
        when 'DATA_DEFENDER_LINE' then 2
      end;
      select count(*) into v_current
        from jsonb_array_elements(v_ticket.cells) c
        where (c->>'row')::int = v_row and (c->>'termId') = any(v_marked_term_ids);
    end if;

    if v_current < v_prize_target then
      v_reason := 'NOT_ELIGIBLE';
    end if;
  end if;

  -- Every submission is recorded regardless of outcome (Req 13.1-13.6):
  -- a passing submission inserts VALID/PENDING with rejection_reason null;
  -- any gate failure inserts INVALID/PENDING with rejection_reason set to
  -- the gate's code.
  insert into claims(
      game_id, player_id, ticket_id, prize_id, validation_status,
      host_decision, rejection_reason, prize_label, player_name, ticket_ref
    )
    values (
      v_game.id, v_player.id, v_ticket.id, p_prize_id,
      case when v_reason is null then 'VALID' else 'INVALID' end,
      'PENDING',
      v_reason,
      coalesce(v_prize_label, 'Unknown prize'),
      coalesce(v_player.display_name, 'Unknown player'),
      coalesce(v_ticket.ref, 'Unknown ticket')
    )
    returning * into v_claim;

  return v_claim;
end;
$$;

-- ---------------------------------------------------------------------------
-- Host-only: confirm a claim. Mirrors canConfirmClaim
-- (src/utils/winnerEngine.ts): validation_status must be VALID,
-- host_decision must be PENDING, and no winners row may already exist for
-- this (game_id, prize_id). Inserts the winners row and marks the claim
-- CONFIRMED atomically; unique(game_id, prize_id) on winners is the hard
-- backstop even under concurrent host confirms.
-- ---------------------------------------------------------------------------
create or replace function confirm_claim(p_claim_id uuid, p_host_secret uuid)
returns winners language plpgsql security definer as $$
declare
  v_claim claims;
  v_game games;
  v_winner winners;
begin
  select * into v_claim from claims where id = p_claim_id for update;
  if v_claim.id is null then
    raise exception 'CLAIM_NOT_CONFIRMABLE';
  end if;

  select * into v_game from games where id = v_claim.game_id;
  if v_game.id is null or v_game.host_secret <> p_host_secret then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if v_claim.validation_status <> 'VALID' or v_claim.host_decision <> 'PENDING' then
    raise exception 'CLAIM_NOT_CONFIRMABLE';
  end if;

  if exists(select 1 from winners where game_id = v_claim.game_id and prize_id = v_claim.prize_id) then
    raise exception 'PRIZE_CLOSED';
  end if;

  insert into winners(game_id, prize_id, player_id, ticket_id, claim_id, prize_label, player_name, ticket_ref)
    values (v_claim.game_id, v_claim.prize_id, v_claim.player_id, v_claim.ticket_id, v_claim.id, v_claim.prize_label, v_claim.player_name, v_claim.ticket_ref)
    returning * into v_winner;
  -- unique(game_id, prize_id) on winners (0001_schema.sql) is the hard
  -- backstop: even under two concurrent confirm_claim calls for different
  -- claims of the same prize, only one INSERT could ever succeed.

  update claims set host_decision = 'CONFIRMED', decided_at = now() where id = v_claim.id;

  return v_winner;
end;
$$;

-- ---------------------------------------------------------------------------
-- Host-only: reject a claim. Mirrors gameSessionReducer.ts's REJECT_CLAIM
-- case: only a currently-PENDING claim may be rejected.
-- ---------------------------------------------------------------------------
create or replace function reject_claim(p_claim_id uuid, p_host_secret uuid, p_reason text)
returns claims language plpgsql security definer as $$
declare
  v_claim claims;
  v_game games;
begin
  select * into v_claim from claims where id = p_claim_id for update;
  if v_claim.id is null then
    raise exception 'CLAIM_NOT_PENDING';
  end if;

  select * into v_game from games where id = v_claim.game_id;
  if v_game.id is null or v_game.host_secret <> p_host_secret then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if v_claim.host_decision <> 'PENDING' then
    raise exception 'CLAIM_NOT_PENDING';
  end if;

  update claims set
      host_decision = 'REJECTED',
      decided_at = now(),
      rejection_reason = p_reason
    where id = v_claim.id
    returning * into v_claim;

  return v_claim;
end;
$$;
