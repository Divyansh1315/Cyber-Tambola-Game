-- Module: ticket-3x4-dimension-refactor bugfix
--
-- BUG: this app runs against real Supabase credentials in production
-- (.env.local has VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY set), so ticket
-- generation and claim validation actually run through the Postgres RPC
-- functions assign_ticket (0003_rpc_join_and_tickets.sql) and submit_claim
-- (0005_rpc_lifecycle_and_claims.sql), NOT through the already-fixed
-- client-side src/utils/ticketGenerator.ts / src/utils/prizeEngine.ts (those
-- are only exercised in local-fallback mode when Supabase is unconfigured).
-- Those two SQL functions still hardcoded the old 3-row-by-5-column/15-cell/
-- 5-mark-per-line dimensions, so a brand-new game continued to hand out
-- 15-word tickets even after the client-side fix landed. This migration
-- redefines both functions with the corrected 3-row-by-4-column/12-cell
-- dimensions (line prizes now target 4 marks per row, Cyber Full House now
-- targets all 12 ticket cells; Cyber Five's target of 5 is unrelated to the
-- ticket's row/column shape and is left unchanged).
--
-- Numbering/why-a-new-file note: this project's established convention
-- (see 0008_claims_active_unique_index.sql's own header comment) is that
-- already-numbered migration files (0001-0008) are never edited in place
-- once written. This file instead uses `create or replace function` to
-- redefine assign_ticket and submit_claim with the exact same signatures
-- and return types as their original 0003/0005 definitions, so every
-- existing caller (join_game, the client RPC calls) is unaffected. No line
-- of 0003_rpc_join_and_tickets.sql or 0005_rpc_lifecycle_and_claims.sql is
-- modified by this file.
--
-- MANUAL APPLY REQUIRED: this migration file is NOT auto-applied by any
-- build/deploy step in this project. It must be run manually against the
-- live Supabase project (e.g. via the Supabase SQL editor, or the same
-- migration-apply mechanism already used to apply 0001-0008 for this
-- project) before this fix takes effect in production. After applying it,
-- call reset_game_to_new (or otherwise start a brand new game) — any
-- already-existing in-flight game's players still hold tickets generated
-- under the old 15-cell shape, and this migration does not retroactively
-- reshape those already-issued tickets.

-- ---------------------------------------------------------------------------
-- Redefinition of assign_ticket (originally 0003_rpc_join_and_tickets.sql):
-- shuffle active terms, take 12 (was 15), retry up to 50 times on a
-- signature clash. Cells are built as 3 rows of 4 (was 3 rows of 5): row =
-- (i-1)/4, col = (i-1)%4.
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
  if array_length(p_active_term_ids, 1) < 12 then
    raise exception 'INSUFFICIENT_ACTIVE_TERMS';
  end if;

  loop
    v_attempt := v_attempt + 1;
    -- Fisher-Yates-equivalent: order_by random() over the active id array.
    select array_agg(t order by random()) into v_shuffled
      from unnest(p_active_term_ids) as t;
    v_chosen := v_shuffled[1:12];
    select array_to_string(array(select unnest(v_chosen) order by 1), '|') into v_signature;

    if not exists (select 1 from tickets where game_id = p_game_id and signature = v_signature) then
      exit;
    end if;
    if v_attempt >= 50 then
      raise exception 'TICKET_UNIQUE_RETRY_EXCEEDED';
    end if;
  end loop;

  -- Build the 3x4 cells jsonb; `term` display text is filled in client-side
  -- on read from the bundled bank (cells here only carry termId/row/col),
  -- mirroring how TicketCell.term is already just a denormalized label.
  select jsonb_agg(jsonb_build_object('termId', v_chosen[i], 'row', (i-1)/4, 'col', (i-1)%4))
    into v_cells from generate_series(1, 12) as i;

  insert into tickets(game_id, player_id, ref, signature, cells)
    values (p_game_id, p_player_id, 'Ticket #' || upper(substr(p_player_id::text, 1, 4)), v_signature, v_cells)
    returning * into v_ticket;

  return v_ticket;
end;
$$;

-- ---------------------------------------------------------------------------
-- Redefinition of submit_claim (originally 0005_rpc_lifecycle_and_claims.sql):
-- every gate/line of the original function body is unchanged except Gate
-- 6's prize-target literals — FIREWALL_LINE/SECURITY_LINE/
-- DATA_DEFENDER_LINE now target 4 (was 5, the whole 4-cell row) and
-- CYBER_FULL_HOUSE now targets 12 (was 15, all ticket cells). CYBER_FIVE's
-- target of 5 is unrelated to the ticket's row/column shape and is left
-- unchanged.
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
      when 'FIREWALL_LINE' then v_prize_label := 'Firewall Line'; v_prize_target := 4;
      when 'SECURITY_LINE' then v_prize_label := 'Security Line'; v_prize_target := 4;
      when 'DATA_DEFENDER_LINE' then v_prize_label := 'Data Defender Line'; v_prize_target := 4;
      when 'CYBER_FULL_HOUSE' then v_prize_label := 'Cyber Full House'; v_prize_target := 12;
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
      -- All 12 ticket terms marked (target 12).
      select array_agg(c->>'termId') into v_ticket_term_ids
        from jsonb_array_elements(v_ticket.cells) c;
      select count(*) into v_current
        from unnest(v_ticket_term_ids) t where t = any(v_marked_term_ids);
    else
      -- Line prizes: only marks whose ticket cell is in the matching row
      -- count (row 0 = FIREWALL_LINE, row 1 = SECURITY_LINE,
      -- row 2 = DATA_DEFENDER_LINE), target 4 (the whole row).
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
