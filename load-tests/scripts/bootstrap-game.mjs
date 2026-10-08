#!/usr/bin/env node
// Bootstraps a dedicated LOBBY-status game on a STAGING Supabase project for
// load testing, and prints the GAME_CODE / GAME_ID / HOST_SECRET values to
// paste into load-tests/.env.
//
// Why this needs a service_role key, once, here only:
// RLS (supabase/migrations/0002_rls.sql) deliberately gives `anon` no INSERT
// policy on `games` or `active_game_pointer` — every write in the real app
// goes through a SECURITY DEFINER RPC. There is no "create_game" RPC in this
// codebase (see supabase/migrations/0006 — reset_game_to_new requires an
// EXISTING game's host_secret, which is a chicken-and-egg problem for a
// brand-new staging project with zero games). A one-time privileged insert
// is the only way to create the very first game. This script:
//   1. Uses SUPABASE_SERVICE_ROLE_KEY ONLY from this local script, ONLY
//      against your staging project, and NEVER writes it to disk or passes
//      it to k6. k6 scripts only ever use the anon key, exactly like a real
//      browser client.
//   2. If you'd rather not use a service_role key at all, skip this script
//      and create the row manually once via the Supabase SQL editor — see
//      README.md's "Manual bootstrap (no service key)" section for the
//      exact SQL.
//
// Usage (PowerShell):
//   $env:SUPABASE_URL="https://xxxx.supabase.co"
//   $env:SUPABASE_SERVICE_ROLE_KEY="..."   # staging project only, never commit
//   node scripts/bootstrap-game.mjs

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const GAME_CODE = process.env.GAME_CODE || 'LOADTEST'
// Explicit allowlist by project ref, same convention as lib/config.js's
// assertSafeTarget(). Set CONFIRMED_PROJECT_REFS to override; defaults to
// this app's current production ref, which load testing has been
// explicitly authorized against (pre-real-users, strict data isolation —
// see README.md).
const CONFIRMED_PROJECT_REFS = (process.env.CONFIRMED_PROJECT_REFS || 'otybqfimodvglcwsaelx')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
// Defense-in-depth: every load-test game's code must start with this
// prefix, so cleanup-game.mjs's own guard (same prefix check) can never be
// satisfied by a real game's code, regardless of what GAME_ID a caller
// passes.
const TEST_GAME_CODE_PREFIX = 'LOADTEST'

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.\n' +
      'See README.md "Bootstrap a test game" section.'
  )
  process.exit(1)
}

const projectRef = new URL(SUPABASE_URL).host.split('.')[0]
if (!CONFIRMED_PROJECT_REFS.includes(projectRef)) {
  console.error(
    `SUPABASE_URL's project ref ("${projectRef}") is not in CONFIRMED_PROJECT_REFS ("${CONFIRMED_PROJECT_REFS.join(', ')}"). Refusing to bootstrap against it.`
  )
  process.exit(1)
}

if (!GAME_CODE.startsWith(TEST_GAME_CODE_PREFIX)) {
  console.error(
    `GAME_CODE ("${GAME_CODE}") must start with "${TEST_GAME_CODE_PREFIX}" so this game is unambiguously identifiable as load-test data, never confusable with a real game.`
  )
  process.exit(1)
}

const restUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1`

async function main() {
  // 1. Create (or reuse) the games row.
  const existing = await fetch(`${restUrl}/games?code=eq.${encodeURIComponent(GAME_CODE)}&select=*`, {
    headers: adminHeaders(),
  }).then((r) => r.json())

  let game
  if (existing.length > 0) {
    game = existing[0]
    console.log(`Reusing existing game row for code "${GAME_CODE}" (id=${game.id}).`)
  } else {
    const created = await fetch(`${restUrl}/games`, {
      method: 'POST',
      headers: { ...adminHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify({ code: GAME_CODE, status: 'LOBBY' }),
    }).then((r) => r.json())
    game = Array.isArray(created) ? created[0] : created
    console.log(`Created new game row for code "${GAME_CODE}" (id=${game.id}).`)
  }

  // 2. Point active_game_pointer at it so get_active_game()/clients resolve it.
  await fetch(`${restUrl}/active_game_pointer?id=eq.true`, {
    method: 'PATCH',
    headers: adminHeaders(),
    body: JSON.stringify({ active_game_id: game.id }),
  })
  console.log('active_game_pointer now points at this game.')

  console.log('\nPaste these into load-tests/.env:\n')
  console.log(`GAME_CODE=${game.code}`)
  console.log(`GAME_ID=${game.id}`)
  console.log(`HOST_SECRET=${game.host_secret}`)
  console.log('\nDone. This game starts empty (LOBBY, no players/tickets/marks/claims).')
}

function adminHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  }
}

main().catch((err) => {
  console.error('Bootstrap failed:', err)
  process.exit(1)
})
