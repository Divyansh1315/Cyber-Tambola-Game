// Feature: winner-history-and-game-reset — structural lint for the new
// get_active_game / generate_new_game_code / reset_game_to_new RPC functions
// (Req 1.2, 5.5, 5.6, 5.7), plus a check that confirm_claim
// (0005_rpc_lifecycle_and_claims.sql) has been updated to populate
// winners.ticket_ref.
//
// This is a text-pattern check against the raw SQL, not a Postgres parse —
// there is no live database in this environment. It exists to catch a
// missing function, an incorrectly scoped delete, or a missed
// NOT_AUTHORIZED/security definer guard before any live database is ever
// involved, mirroring activeGameAndWinnerHistory.structure.test.ts's own
// style.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const migrationsDir = path.dirname(fileURLToPath(import.meta.url))

const activeGameSql = readFileSync(
  path.join(migrationsDir, '0006_active_game_and_winner_history.sql'),
  'utf-8',
)
const lifecycleSql = readFileSync(
  path.join(migrationsDir, '0005_rpc_lifecycle_and_claims.sql'),
  'utf-8',
)

/** Count non-overlapping occurrences of a pattern in some SQL text. */
function countMatches(sql: string, pattern: RegExp): number {
  const matches = sql.match(pattern)
  return matches ? matches.length : 0
}

describe('0006_active_game_and_winner_history.sql RPC structure', () => {
  it('defines get_active_game (Req 1.2)', () => {
    expect(
      /create or replace function\s+get_active_game\s*\(/i.test(activeGameSql),
    ).toBe(true)
  })

  it('defines generate_new_game_code (Req 1.2, 5.3)', () => {
    expect(
      /create or replace function\s+generate_new_game_code\s*\(/i.test(activeGameSql),
    ).toBe(true)
  })

  it('defines reset_game_to_new (Req 1.2, 5.1)', () => {
    expect(
      /create or replace function\s+reset_game_to_new\s*\(/i.test(activeGameSql),
    ).toBe(true)
  })

  it('declares reset_game_to_new as security definer (Req 5.5, 5.6)', () => {
    const fnMatch = activeGameSql.match(
      /create or replace function\s+reset_game_to_new\s*\([^)]*\)[\s\S]*?\$\$;/i,
    )
    expect(fnMatch, 'reset_game_to_new function body not found').not.toBeNull()
    expect(/security definer/i.test(fnMatch![0])).toBe(true)
  })

  it('reset_game_to_new row-locks the old game with a for update lock (Req 5.5, 5.6)', () => {
    const fnMatch = activeGameSql.match(
      /create or replace function\s+reset_game_to_new\s*\([^)]*\)[\s\S]*?\$\$;/i,
    )
    expect(fnMatch, 'reset_game_to_new function body not found').not.toBeNull()
    expect(/for update/i.test(fnMatch![0])).toBe(true)
  })

  it("reset_game_to_new raises exception 'NOT_AUTHORIZED' (Req 5.5, 5.6)", () => {
    const fnMatch = activeGameSql.match(
      /create or replace function\s+reset_game_to_new\s*\([^)]*\)[\s\S]*?\$\$;/i,
    )
    expect(fnMatch, 'reset_game_to_new function body not found').not.toBeNull()
    expect(/raise exception\s+'NOT_AUTHORIZED'/i.test(fnMatch![0])).toBe(true)
  })

  it('reset_game_to_new contains exactly five delete from statements scoped by game_id = p_old_game_id, one each for claims/marks/tickets/players/called_terms (Req 5.7)', () => {
    const fnMatch = activeGameSql.match(
      /create or replace function\s+reset_game_to_new\s*\([^)]*\)[\s\S]*?\$\$;/i,
    )
    expect(fnMatch, 'reset_game_to_new function body not found').not.toBeNull()
    const fnBody = fnMatch![0]

    const scopedDeletePattern = /delete from\s+(\w+)\s+where\s+game_id\s*=\s*p_old_game_id\s*;/gi
    const matches = [...fnBody.matchAll(scopedDeletePattern)]
    expect(matches.length).toBe(5)

    const deletedTables = matches.map((m) => m[1].toLowerCase()).sort()
    expect(deletedTables).toEqual(
      ['called_terms', 'claims', 'marks', 'players', 'tickets'].sort(),
    )
  })

  it('never deletes from winners anywhere in the migration file (Req 1.1, 1.2, 5.7)', () => {
    expect(countMatches(activeGameSql, /delete from\s+winners\b/gi)).toBe(0)
  })
})

describe("0005_rpc_lifecycle_and_claims.sql confirm_claim's ticket_ref column (Req 1.2)", () => {
  it("confirm_claim's insert into winners column list includes ticket_ref", () => {
    const fnMatch = lifecycleSql.match(
      /create or replace function\s+confirm_claim\s*\([^)]*\)[\s\S]*?\$\$;/i,
    )
    expect(fnMatch, 'confirm_claim function body not found').not.toBeNull()

    const insertMatch = fnMatch![0].match(
      /insert into\s+winners\s*\(([^)]*)\)/i,
    )
    expect(insertMatch, 'insert into winners(...) statement not found in confirm_claim').not.toBeNull()

    const columnList = insertMatch![1]
      .split(',')
      .map((col) => col.trim().toLowerCase())
    expect(columnList).toContain('ticket_ref')
  })
})
