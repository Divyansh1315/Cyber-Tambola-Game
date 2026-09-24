// Feature: winner-history-and-game-reset — conditional integration test for
// atomic reset and winner retention (Properties 1 and 6)
// Validates Requirements 1.1, 1.2, 1.3, 5.1, 5.2, 5.3, 5.4, 5.7
//
// This suite requires a reachable local Supabase CLI/Postgres instance to
// apply migrations 0001-0006 against a fresh schema and exercise the real
// `reset_game_to_new` RPC's atomic behavior — something a text-pattern lint
// test cannot verify. There is no live Postgres instance provisioned in
// this workspace by default, so this suite probes for one via
// `SUPABASE_TEST_DB_URL` and skips (never fails) when it is absent or
// unreachable, following the exact same conditional-skip convention
// established by module-6-realtime-multi-device-sync's
// `callNextWord.integration.test.ts` and this module's own
// `activeGamePointer.integration.test.ts` (task 1.3).
//
// **Property 1: Reset retains and never touches prior winners**
// **Property 6: Reset always produces a fresh, valid, LOBBY-status game and
// repoints atomically**
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
    // Dynamically imported via a non-literal specifier: see
    // activeGamePointer.integration.test.ts for the full rationale (`pg` is
    // a dev-only, optional dependency for this conditional suite and must
    // not be eagerly resolved by Vite/Rollup's import analysis at
    // collection time, which would otherwise hard-fail this file when `pg`
    // is not installed — exactly the case in this workspace today).
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
    '[resetGameToNew.integration.test.ts] Skipping: no reachable Postgres instance ' +
      '(set SUPABASE_TEST_DB_URL to a local Supabase CLI/Postgres connection string to run this suite).',
  )
}

describe.skipIf(!connection)('reset_game_to_new atomic reset and winner retention (integration)', () => {
  const { client } = connection ?? {}
  const schemaName = `test_rgtn_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`

  // Seeded fixture ids/values, populated in beforeAll and reused across
  // assertions within the single `it` block below (the RPC call under test
  // is a single atomic operation, so its effects are asserted together
  // rather than re-seeding per assertion).
  let oldGameId: string
  let oldGameCode: string
  let hostSecret: string
  let playerId: string
  let ticketId: string
  let claimId: string
  let winnerBefore: Record<string, unknown>

  beforeAll(async () => {
    if (!client) return
    await client.query(`create schema ${schemaName}`)
    await client.query(`set search_path to ${schemaName}, public`)
    for (const file of MIGRATION_FILES) {
      const sql = readFileSync(path.join(migrationsDir, file), 'utf-8')
      await client.query(sql)
    }

    // Seed one game with a full set of child rows (players, tickets, marks,
    // claims, called_terms) plus one confirmed winner. Direct inserts are
    // used rather than the join_game/submit_mark/submit_claim/confirm_claim
    // RPCs: this keeps the fixture setup a plain, auditable restatement of
    // the schema's own shape, independent of any of those RPCs' own gate
    // logic, which is exercised by their own dedicated test suites.
    const gameResult = await client.query(
      `insert into games (code, status) values ('OLDG01', 'WORD_ACTIVE') returning id, code, host_secret`,
    )
    oldGameId = gameResult.rows[0].id
    oldGameCode = gameResult.rows[0].code
    hostSecret = gameResult.rows[0].host_secret

    await client.query(
      `insert into called_terms (game_id, term_id, round) values ($1, 'phishing', 1)`,
      [oldGameId],
    )

    const playerResult = await client.query(
      `insert into players (game_id, display_name, employee_demo_id)
         values ($1, 'Alice', 'EMP001') returning id`,
      [oldGameId],
    )
    playerId = playerResult.rows[0].id

    const ticketResult = await client.query(
      `insert into tickets (game_id, player_id, ref, signature, cells)
         values ($1, $2, 'Ticket #ABCD', 'phishing|malware', '[]'::jsonb) returning id`,
      [oldGameId, playerId],
    )
    ticketId = ticketResult.rows[0].id

    await client.query(
      `insert into marks (game_id, player_id, ticket_id, term_id) values ($1, $2, $3, 'phishing')`,
      [oldGameId, playerId, ticketId],
    )

    const claimResult = await client.query(
      `insert into claims (
          game_id, player_id, ticket_id, prize_id, validation_status,
          host_decision, prize_label, player_name, ticket_ref
        ) values ($1, $2, $3, 'CYBER_FIVE', 'VALID', 'CONFIRMED', 'Cyber Five', 'Alice', 'Ticket #ABCD')
        returning id`,
      [oldGameId, playerId, ticketId],
    )
    claimId = claimResult.rows[0].id

    const winnerResult = await client.query(
      `insert into winners (
          game_id, prize_id, player_id, ticket_id, claim_id, prize_label, player_name, ticket_ref
        ) values ($1, 'CYBER_FIVE', $2, $3, $4, 'Cyber Five', 'Alice', 'Ticket #ABCD')
        returning *`,
      [oldGameId, playerId, ticketId, claimId],
    )
    winnerBefore = winnerResult.rows[0]

    // Point the pointer at the old game before reset, so the assertions
    // below can confirm the pointer actually moves.
    await client.query(`update active_game_pointer set active_game_id = $1 where id = true`, [oldGameId])
  })

  afterAll(async () => {
    if (!client) return
    await client.query(`drop schema if exists ${schemaName} cascade`)
    await client.end()
  })

  it('atomically retires the old game, retains its winners, and activates a fresh LOBBY game', async () => {
    const rpcResult = await client!.query(
      `select * from reset_game_to_new($1, $2)`,
      [oldGameId, hostSecret],
    )
    const newGame = rpcResult.rows[0].new_game
    expect(rpcResult.rows[0].old_game_id).toBe(oldGameId)

    // Property 1: the old game's winners rows are byte-identical and present.
    const { rows: winnersAfter } = await client!.query(
      `select * from winners where game_id = $1`,
      [oldGameId],
    )
    expect(winnersAfter).toHaveLength(1)
    expect(winnersAfter[0]).toEqual(winnerBefore)

    // Property 1: the old game's claims/marks/tickets/players/called_terms
    // rows are all gone.
    const { rows: claimsAfter } = await client!.query(`select 1 from claims where game_id = $1`, [oldGameId])
    const { rows: marksAfter } = await client!.query(`select 1 from marks where game_id = $1`, [oldGameId])
    const { rows: ticketsAfter } = await client!.query(`select 1 from tickets where game_id = $1`, [oldGameId])
    const { rows: playersAfter } = await client!.query(`select 1 from players where game_id = $1`, [oldGameId])
    const { rows: calledTermsAfter } = await client!.query(
      `select 1 from called_terms where game_id = $1`,
      [oldGameId],
    )
    expect(claimsAfter).toHaveLength(0)
    expect(marksAfter).toHaveLength(0)
    expect(ticketsAfter).toHaveLength(0)
    expect(playersAfter).toHaveLength(0)
    expect(calledTermsAfter).toHaveLength(0)

    // Property 6: exactly one new games row exists with a new id,
    // status = 'LOBBY', and a code never seen before.
    expect(newGame.id).not.toBe(oldGameId)
    expect(newGame.status).toBe('LOBBY')
    expect(newGame.code).not.toBe(oldGameCode)
    expect(newGame.code).toMatch(/^[A-Z]{4}[0-9]{2}$/)

    const { rows: newGameRows } = await client!.query(`select * from games where id = $1`, [newGame.id])
    expect(newGameRows).toHaveLength(1)

    // The old game row itself is retained, not deleted (Req 5.7).
    const { rows: oldGameRows } = await client!.query(`select * from games where id = $1`, [oldGameId])
    expect(oldGameRows).toHaveLength(1)

    // active_game_pointer.active_game_id now equals the new game's id.
    const { rows: pointerRows } = await client!.query(
      `select active_game_id from active_game_pointer where id = true`,
    )
    expect(pointerRows[0].active_game_id).toBe(newGame.id)

    // get_active_game() returns that new row.
    const { rows: activeGameRows } = await client!.query(`select * from get_active_game()`)
    expect(activeGameRows).toHaveLength(1)
    expect(activeGameRows[0].id).toBe(newGame.id)
    expect(activeGameRows[0].status).toBe('LOBBY')
  })
})
