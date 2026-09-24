// Feature: winner-history-and-game-reset — conditional integration test for
// host-secret gating on Reset (Property 8)
// Validates Requirements 5.5, 5.6
//
// This suite requires a reachable local Supabase CLI/Postgres instance to
// apply migrations 0001-0006 against a fresh schema and exercise real
// `reset_game_to_new` authorization/side-effect behavior — something a
// text-pattern lint test cannot verify. There is no live Postgres instance
// provisioned in this workspace by default, so this suite probes for one via
// `SUPABASE_TEST_DB_URL` and skips (never fails) when it is absent or
// unreachable, following the exact same conditional-skip convention
// established by module-6-realtime-multi-device-sync's
// `callNextWord.integration.test.ts` and this module's own
// `activeGamePointer.integration.test.ts` (task 1.3).
//
// **Property 8: A mismatched host secret rejects Reset without any side effect**
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const migrationsDir = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION_FILES = [
  '0001_schema.sql',
  '0002_rls.sql',
  '0003_rpc_join_and_tickets.sql',
  '0004_rpc_word_and_marks.sql',
  '0005_rpc_lifecycle_and_claims.sql',
  '0006_active_game_and_winner_history.sql',
]

const TEST_DB_URL = process.env.SUPABASE_TEST_DB_URL

/**
 * Probes whether a Postgres instance is reachable at TEST_DB_URL. Returns
 * the connected client on success, or null if unreachable/misconfigured —
 * callers treat null as "skip," never as a test failure.
 */
async function tryConnect(): Promise<{
  client: import('pg').Client
} | null> {
  if (!TEST_DB_URL) return null
  try {
    // Dynamically imported via a non-literal specifier: `pg` is a dev-only,
    // optional dependency for this conditional suite and is not otherwise
    // used by the application. Building the module specifier at runtime
    // (rather than a static `import('pg')`) prevents Vite/Rollup's import
    // analysis from eagerly resolving it at collection time, which would
    // otherwise hard-fail this whole file when `pg` is not installed —
    // exactly the case in this workspace today, where this suite must skip
    // cleanly, not error.
    const moduleName = 'pg'
    const pg = (await import(/* @vite-ignore */ moduleName)) as typeof import('pg')
    const client = new pg.Client({ connectionString: TEST_DB_URL })
    await client.connect()
    return { client }
  } catch {
    return null
  }
}

const connection = await tryConnect()

if (!connection) {
  console.log(
    '[resetGameToNewAuth.integration.test.ts] Skipping: no reachable Postgres instance ' +
      '(set SUPABASE_TEST_DB_URL to a local Supabase CLI/Postgres connection string to run this suite).',
  )
}

describe.skipIf(!connection)('reset_game_to_new host-secret gating (integration)', () => {
  const { client } = connection ?? {}
  const schemaName = `test_rgtn_auth_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`

  beforeAll(async () => {
    if (!client) return
    await client.query(`create schema ${schemaName}`)
    await client.query(`set search_path to ${schemaName}, public`)
    for (const file of MIGRATION_FILES) {
      const sql = readFileSync(path.join(migrationsDir, file), 'utf-8')
      await client.query(sql)
    }
  })

  afterAll(async () => {
    if (!client) return
    await client.query(`drop schema if exists ${schemaName} cascade`)
    await client.end()
  })

  it('rejects a mismatched host_secret with NOT_AUTHORIZED and leaves the pointer/games table untouched', async () => {
    // Seed one game and point active_game_pointer at it.
    const { rows: gameRows } = await client!.query(
      `insert into games (code) values ('AUTHT1') returning id, host_secret`,
    )
    const seededGame = gameRows[0]
    await client!.query(
      `update active_game_pointer set active_game_id = $1 where id = true`,
      [seededGame.id],
    )

    const { rows: beforeGamesCount } = await client!.query(`select count(*)::int as count from games`)
    const { rows: beforePointer } = await client!.query(
      `select active_game_id from active_game_pointer where id = true`,
    )

    const wrongSecret = '00000000-0000-0000-0000-000000000000'
    expect(wrongSecret).not.toBe(seededGame.host_secret)

    await expect(
      client!.query(`select * from reset_game_to_new($1, $2)`, [seededGame.id, wrongSecret]),
    ).rejects.toThrow(/NOT_AUTHORIZED/)

    // No side effect: active_game_pointer still designates the same game as
    // before the call.
    const { rows: afterPointer } = await client!.query(
      `select active_game_id from active_game_pointer where id = true`,
    )
    expect(afterPointer[0].active_game_id).toBe(beforePointer[0].active_game_id)
    expect(afterPointer[0].active_game_id).toBe(seededGame.id)

    // No side effect: no additional games row exists.
    const { rows: afterGamesCount } = await client!.query(`select count(*)::int as count from games`)
    expect(afterGamesCount[0].count).toBe(beforeGamesCount[0].count)
  })
})
