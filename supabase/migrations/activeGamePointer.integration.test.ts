// Feature: winner-history-and-game-reset — conditional integration test for
// the pointer's at-most-one-row guarantee (Property 5, schema half)
// Validates Requirements 3.1, 3.5
//
// This suite requires a reachable local Supabase CLI/Postgres instance to
// apply migrations 0001-0006 against a fresh schema and exercise real
// primary-key/check-constraint enforcement — something a text-pattern lint
// test cannot verify. There is no live Postgres instance provisioned in
// this workspace by default, so this suite probes for one via
// `SUPABASE_TEST_DB_URL` and skips (never fails) when it is absent or
// unreachable, following the exact same conditional-skip convention
// established by module-6-realtime-multi-device-sync's
// `callNextWord.integration.test.ts`.
//
// **Property 5 (partial): the pointer table never holds more than one row**
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
    '[activeGamePointer.integration.test.ts] Skipping: no reachable Postgres instance ' +
      '(set SUPABASE_TEST_DB_URL to a local Supabase CLI/Postgres connection string to run this suite).',
  )
}

describe.skipIf(!connection)('active_game_pointer at-most-one-row guarantee (integration)', () => {
  const { client } = connection ?? {}
  const schemaName = `test_agp_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`

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

  it('seeds exactly one row with active_game_id is null', async () => {
    const { rows } = await client!.query(
      `select id, active_game_id from active_game_pointer`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].active_game_id).toBeNull()
  })

  it('rejects inserting a second row with a different id value', async () => {
    await expect(
      client!.query(
        `insert into active_game_pointer (id, active_game_id) values (false, null)`,
      ),
    ).rejects.toThrow(/duplicate key|violates.*check constraint/i)
  })

  it('rejects an insert with id = false via the check (id) constraint', async () => {
    // A fresh distinct attempt isolated from the primary-key case above:
    // even if the primary key did not already forbid a second row, the
    // `check (id)` constraint independently forbids `id = false` outright.
    await expect(
      client!.query(
        `insert into active_game_pointer (id, active_game_id) values (false, null)`,
      ),
    ).rejects.toThrow(/violates check constraint|duplicate key/i)
  })
})
