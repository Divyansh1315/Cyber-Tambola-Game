#!/usr/bin/env node
// Deletes all load-test data for GAME_ID (players, tickets, marks, claims,
// called_terms; winners are preserved to mirror reset_game_to_new's own
// behavior, but you can pass --winners to also delete winners rows for this
// game). Requires SUPABASE_SERVICE_ROLE_KEY, same safety rules as
// bootstrap-game.mjs: staging only, never shipped to k6/browser.
//
// Usage (PowerShell):
//   $env:SUPABASE_URL="https://xxxx.supabase.co"
//   $env:SUPABASE_SERVICE_ROLE_KEY="..."
//   $env:GAME_ID="<uuid>"
//   node scripts/cleanup-game.mjs

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const GAME_ID = process.env.GAME_ID
const DELETE_WINNERS = process.argv.includes('--winners')
const CONFIRMED_PROJECT_REFS = (process.env.CONFIRMED_PROJECT_REFS || 'otybqfimodvglcwsaelx')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const TEST_GAME_CODE_PREFIX = 'LOADTEST'

if (!SUPABASE_URL || !SERVICE_KEY || !GAME_ID) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or GAME_ID env vars.')
  process.exit(1)
}

const projectRef = new URL(SUPABASE_URL).host.split('.')[0]
if (!CONFIRMED_PROJECT_REFS.includes(projectRef)) {
  console.error(
    `SUPABASE_URL's project ref ("${projectRef}") is not in CONFIRMED_PROJECT_REFS ("${CONFIRMED_PROJECT_REFS.join(', ')}"). Refusing to delete data.`
  )
  process.exit(1)
}

const restUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1`
const headers = {
  'Content-Type': 'application/json',
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
}

const tablesInOrder = ['claims', 'marks', 'tickets', 'players', 'called_terms']

async function main() {
  // Defense-in-depth: refuse to delete ANYTHING unless the target game's
  // own `code` starts with the test-game prefix. This means a wrong/stale
  // GAME_ID value can never cause a real game's data to be deleted — the
  // check is against the live database's own record of what this game is,
  // not just the caller's say-so.
  const gameRes = await fetch(`${restUrl}/games?id=eq.${GAME_ID}&select=code`, { headers })
  const gameRows = await gameRes.json()
  if (gameRows.length === 0) {
    console.error(`No game found with id=${GAME_ID}. Nothing to clean up.`)
    process.exit(1)
  }
  const gameCode = gameRows[0].code
  if (!gameCode.startsWith(TEST_GAME_CODE_PREFIX)) {
    console.error(
      `Game ${GAME_ID} has code "${gameCode}", which does NOT start with "${TEST_GAME_CODE_PREFIX}". ` +
        `Refusing to delete — this does not look like a load-test game. If this really is a load-test ` +
        `game with a non-standard code, rename it to start with "${TEST_GAME_CODE_PREFIX}" first.`
    )
    process.exit(1)
  }
  console.log(`Confirmed target game ${GAME_ID} has code "${gameCode}" — proceeding with scoped cleanup.\n`)

  for (const table of tablesInOrder) {
    const res = await fetch(`${restUrl}/${table}?game_id=eq.${GAME_ID}`, {
      method: 'DELETE',
      headers,
    })
    console.log(`Deleted from ${table}: HTTP ${res.status}`)
  }

  if (DELETE_WINNERS) {
    const res = await fetch(`${restUrl}/winners?game_id=eq.${GAME_ID}`, {
      method: 'DELETE',
      headers,
    })
    console.log(`Deleted from winners: HTTP ${res.status}`)
  } else {
    console.log('Skipped winners table (pass --winners to also clear it).')
  }

  console.log('\nCleanup complete. The games row and active_game_pointer are left as-is;')
  console.log('re-run bootstrap-game.mjs with the same GAME_CODE to reuse this game next time.')
}

main().catch((err) => {
  console.error('Cleanup failed:', err)
  process.exit(1)
})
