-- Module 6: Real Multi-Device Realtime Synchronization
-- Migration 0002: Row Level Security (RLS)
--
-- Enables RLS on all seven shared tables and grants the anonymous client role
-- (`anon`) read-only access. No client — host or player — can write these
-- tables directly; every write goes through a SECURITY DEFINER RPC (authored
-- in later migrations), which runs as the table owner and bypasses RLS
-- internally only after its own explicit checks (e.g. host_secret).
--
-- Requirements: 2.1, 2.2, 2.3, 2.4

-- ---------------------------------------------------------------------------
-- Enable RLS on every shared table (Requirement 2.1).
-- ---------------------------------------------------------------------------
alter table games enable row level security;
alter table called_terms enable row level security;
alter table players enable row level security;
alter table tickets enable row level security;
alter table marks enable row level security;
alter table claims enable row level security;
alter table winners enable row level security;

-- ---------------------------------------------------------------------------
-- Every shared table: anon may SELECT (read), scoped to nothing narrower than
-- "the whole game" (a Player legitimately needs to see other players' counts,
-- the current word, and the claims inbox is host-only UI, not a table-level
-- restriction). (Requirement 2.2)
-- ---------------------------------------------------------------------------
create policy "anon can read games"        on games         for select to anon using (true);
create policy "anon can read called_terms" on called_terms  for select to anon using (true);
create policy "anon can read players"      on players       for select to anon using (true);
create policy "anon can read tickets"      on tickets       for select to anon using (true);
create policy "anon can read marks"        on marks         for select to anon using (true);
create policy "anon can read claims"       on claims        for select to anon using (true);
create policy "anon can read winners"      on winners       for select to anon using (true);

-- ---------------------------------------------------------------------------
-- Deliberate omission (Requirement 2.3): no INSERT/UPDATE/DELETE policy is
-- created for `anon` on any of the seven tables above, and none should ever
-- be added for `anon` in a future migration. With RLS enabled and no
-- permissive write policy, Postgres's default-deny behavior means `anon`
-- cannot INSERT, UPDATE, or DELETE any row in these tables by any means other
-- than a SECURITY DEFINER RPC (Requirement 2.4) — this is intentional
-- default-deny, not an oversight to be "fixed" later.
-- ---------------------------------------------------------------------------
