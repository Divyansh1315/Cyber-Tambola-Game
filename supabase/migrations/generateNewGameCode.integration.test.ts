// Feature: winner-history-and-game-reset — conditional integration test for
// New_Game_Code format and uniqueness (Property 7)
// Validates Requirements 5.3
//
// This suite requires a reachable local Supabase CLI/Postgres instance to
// call the real generate_new_game_code() function and exercise its
// collision-retry loop against real games.code rows — something a
// text-pattern lint test cannot verify. There is no live Postgres instance
// provisioned in this workspace by default, so this suite probes for one
// via `SUPABASE_TEST_DB_URL` and skips (never fails) when it is absent or
// unreachable, following the exact same conditional-skip convention
// established by module-6-realtime-multi-device-sync's
// `callNextWord.integration.test.ts` and this module's own
// `activeGamePointer.integration.test.ts`.
//
// **Property 7: New_Game_Code always matches the established format**
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

const NEW_GAME_CODE_FORMAT = /^[A-Z]{4}[0-9]{2}$/

const GENERATION_ATTEMPTS = 100

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
    '[generateNewGameCode.integration.test.ts] Skipping: no reachable Postgres instance ' +
      '(set SUPABASE_TEST_DB_URL to a local Supabase CLI/Postgres connection string to run this suite).',
  )
}

describe.skipIf(!connection)('generate_new_game_code() format and uniqueness (integration)', () => {
  const { client } = connection ?? {}
  const schemaName = `test_gngc_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`

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

  it(`generates ${GENERATION_ATTEMPTS} codes that all match the format and never repeat an existing games.code`, async () => {
    const seenCodes = new Set<string>()

    for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt += 1) {
      const { rows } = await client!.query<{ generate_new_game_code: string }>(
        `select generate_new_game_code()`,
      )
      const code = rows[0].generate_new_game_code

      expect(code).toMatch(NEW_GAME_CODE_FORMAT)
      expect(seenCodes.has(code)).toBe(false)

      seenCodes.add(code)

      // Progressively seed a minimal games row using each returned code, so
      // subsequent calls must avoid a real collision against games.code —
      // not merely against codes generated so far in this test's own
      // in-memory set.
      await client!.query(`insert into games (code) values ($1)`, [code])
    }

    const { rows: gameRows } = await client!.query<{ count: string }>(
      `select count(*)::text as count from games`,
    )
    expect(Number(gameRows[0].count)).toBe(GENERATION_ATTEMPTS)
  })
})
