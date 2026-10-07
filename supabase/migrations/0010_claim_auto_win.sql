-- Module: fix/multiplayer-reliability — automatic first-valid-claim-wins
--
-- BUSINESS RULE: for a single-winner prize, the first VALID claim
-- successfully accepted by the authoritative backend wins automatically.
-- Once that prize is won, every later claim for the same prize is
-- automatically rejected. The host no longer manually confirms/rejects
-- prize-claim winners — the host only sees the auto-determined winner for
-- awareness/announcement.
--
-- WHAT CHANGES: this file redefines submit_claim (originally
-- 0005_rpc_lifecycle_and_claims.sql, then redefined once already by
-- 0009_ticket_3x4_dimension_fix.sql for the 3x4 ticket dimensions). Gates
-- 1-10 are copied verbatim from 0009's version — same order, same codes,
-- same logic, byte-for-byte identical except for comment line-wrap. The
-- ONLY new behavior is what happens immediately AFTER gate 10 passes (i.e.
-- the claim is a VALID claim about to be recorded):
--   * Instead of always inserting the claim as host_decision = 'PENDING',
--     this version ALSO attempts, in the SAME transaction, to insert a row
--     into `winners` for (game_id, prize_id) via
--     `insert ... on conflict (game_id, prize_id) do nothing returning id`.
--     This is the standard, idiomatic Postgres pattern for "first writer
--     wins, atomically, without an explicit application-level lock" — the
--     existing `unique (game_id, prize_id)` constraint on `winners`
--     (0001_schema.sql) is what makes this safe under concurrent callers;
--     no new constraint or custom locking scheme is introduced here.
--   * If that insert returns a row (this transaction won the race), the
--     claim is recorded with host_decision = 'CONFIRMED' and
--     decided_at = now() immediately, and the winners row is populated with
--     this claim's player/ticket/prize/label/name/ticket_ref data,
--     referencing the claim's own id via claim_id. Because the winners
--     row's claim_id must point at this claim's id BEFORE the claims
--     insert's own `returning` would normally hand that id back, this claim
--     id is minted up front into a local `v_claim_id uuid` so both inserts
--     can reference the same value.
--   * If that insert returns no row (conflict — another transaction already
--     won this prize a moment earlier), this (validly eligible) claim is
--     still recorded, but as host_decision = 'REJECTED',
--     decided_at = now(), rejection_reason = 'PRIZE_ALREADY_WON' — a new,
--     specific code distinct from every gate 1-10 code, since this claim
--     passed every gate and simply lost the race to be first.
--   * An INVALID claim (any gate 1-10 failed) is inserted exactly as before
--     — host_decision = 'PENDING', rejection_reason = the failing gate's
--     code, and no attempt whatsoever is made against `winners`. An invalid
--     claim must never be able to lock a prize.
--
-- WHY confirm_claim/reject_claim ARE NOT TOUCHED: those two functions still
-- exist, unmodified, purely for backward compatibility with any claim row
-- that is already sitting at host_decision = 'PENDING' and validation_status
-- = 'VALID' from before this migration was applied (e.g. a claim submitted
-- against a game created under 0009's submit_claim, moments before this
-- migration lands). Going forward, no NEW claim produced by this version of
-- submit_claim will ever reach host_decision = 'PENDING' while
-- validation_status = 'VALID' — every valid claim is auto-decided
-- (CONFIRMED or REJECTED) at submission time — so canConfirmClaim's
-- PENDING-gated UI naturally has nothing left to act on for new claims, and
-- confirm_claim/reject_claim quietly become legacy-only code paths rather
-- than being removed.
--
-- Numbering/why-a-new-file note: per this project's established convention
-- (see 0008's and 0009's own header comments), already-numbered migration
-- files (0001-0009) are never edited in place once written. This file uses
-- `create or replace function` to redefine submit_claim with the exact same
-- signature and return type as its 0005/0009 predecessors, so every
-- existing caller is unaffected. No line of 0001-0009 is modified by this
-- file.
--
-- MANUAL APPLY REQUIRED: this migration file is NOT auto-applied by any
-- build/deploy step in this project. It must be run manually against the
-- live Supabase project (e.g. via the Supabase SQL editor, or the same
-- migration-apply mechanism already used to apply 0001-0009 for this
-- project) before this fix takes effect in production.

-- ---------------------------------------------------------------------------
-- Redefinition of submit_claim (originally 0005_rpc_lifecycle_and_claims.sql,
-- dimensions updated by 0009_ticket_3x4_dimension_fix.sql): gates 1-10 are
-- unchanged from 0009's version. The only change is the final insert step,
-- described in this file's header comment above.
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
  v_claim_id uuid;
  v_won_winner_id uuid;
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

  if v_reason is not null then
    -- INVALID claim (some gate 1-10 failed): recorded exactly as before —
    -- host_decision = 'PENDING', rejection_reason = the failing gate's
    -- code, and no attempt is made against `winners` at all. An invalid
    -- claim must never be able to lock a prize (Req 13.1-13.6 preserved).
    insert into claims(
        game_id, player_id, ticket_id, prize_id, validation_status,
        host_decision, rejection_reason, prize_label, player_name, ticket_ref
      )
      values (
        v_game.id, v_player.id, v_ticket.id, p_prize_id,
        'INVALID',
        'PENDING',
        v_reason,
        coalesce(v_prize_label, 'Unknown prize'),
        coalesce(v_player.display_name, 'Unknown player'),
        coalesce(v_ticket.ref, 'Unknown ticket')
      )
      returning * into v_claim;

    return v_claim;
  end if;

  -- VALID claim (every gate passed): attempt to atomically win the prize.
  -- `insert ... on conflict (game_id, prize_id) do nothing returning id` is
  -- the idiomatic Postgres "first writer wins" pattern — the existing
  -- unique(game_id, prize_id) constraint on `winners` (0001_schema.sql) is
  -- the hard backstop that makes this safe under concurrent callers, even
  -- two submit_claim calls committing at nearly the same instant.
  v_claim_id := gen_random_uuid();

  insert into winners(game_id, prize_id, player_id, ticket_id, claim_id, prize_label, player_name, ticket_ref)
    values (v_game.id, p_prize_id, v_player.id, v_ticket.id, v_claim_id, v_prize_label, v_player.display_name, v_ticket.ref)
    on conflict (game_id, prize_id) do nothing
    returning id into v_won_winner_id;

  if v_won_winner_id is not null then
    -- This transaction won the race: the claim is auto-confirmed.
    insert into claims(
        id, game_id, player_id, ticket_id, prize_id, validation_status,
        host_decision, rejection_reason, decided_at, prize_label, player_name, ticket_ref
      )
      values (
        v_claim_id, v_game.id, v_player.id, v_ticket.id, p_prize_id,
        'VALID',
        'CONFIRMED',
        null,
        now(),
        coalesce(v_prize_label, 'Unknown prize'),
        coalesce(v_player.display_name, 'Unknown player'),
        coalesce(v_ticket.ref, 'Unknown ticket')
      )
      returning * into v_claim;
  else
    -- Another transaction already won this prize a moment earlier: this
    -- claim WAS validly eligible, it just lost the race. Recorded as
    -- auto-rejected with a reason code distinct from every gate 1-10 code.
    insert into claims(
        id, game_id, player_id, ticket_id, prize_id, validation_status,
        host_decision, rejection_reason, decided_at, prize_label, player_name, ticket_ref
      )
      values (
        v_claim_id, v_game.id, v_player.id, v_ticket.id, p_prize_id,
        'VALID',
        'REJECTED',
        'PRIZE_ALREADY_WON',
        now(),
        coalesce(v_prize_label, 'Unknown prize'),
        coalesce(v_player.display_name, 'Unknown player'),
        coalesce(v_ticket.ref, 'Unknown ticket')
      )
      returning * into v_claim;
  end if;

  return v_claim;
end;
$$;
