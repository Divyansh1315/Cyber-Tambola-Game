// Feature: module-6-realtime-multi-device-sync — structural lint for the core
// schema migration (Req 1.2, 1.3, 1.4, 1.5, 1.6, 1.7)
//
// This is a text-pattern check against the raw SQL, not a Postgres parse —
// there is no live database in this environment. It exists to catch an
// omitted table or constraint in 0001_schema.sql before any live database
// is ever involved.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '0001_schema.sql',
)
const sql = readFileSync(migrationPath, 'utf-8')

/** Count non-overlapping occurrences of a pattern in the SQL text. */
function countMatches(pattern: RegExp): number {
  const matches = sql.match(pattern)
  return matches ? matches.length : 0
}

const REQUIRED_TABLES = [
  'games',
  'called_terms',
  'players',
  'tickets',
  'marks',
  'claims',
  'winners',
]

describe('0001_schema.sql structure', () => {
  it.each(REQUIRED_TABLES)('contains exactly one CREATE TABLE for "%s" (Req 1.1-1.7)', (table) => {
    const pattern = new RegExp(`create table\\s+${table}\\s*\\(`, 'gi')
    expect(countMatches(pattern)).toBe(1)
  })

  it('enforces at most one row per (game_id, term_id) on called_terms (Req 1.2)', () => {
    // Expressed as the composite primary key per the migration's own comment.
    expect(/primary key\s*\(\s*game_id\s*,\s*term_id\s*\)/i.test(sql)).toBe(true)
  })

  it('enforces at most one row per (game_id, employee_demo_id_normalized) on players (Req 1.3)', () => {
    expect(
      /unique\s*\(\s*game_id\s*,\s*employee_demo_id_normalized\s*\)/i.test(sql),
    ).toBe(true)
  })

  it('enforces at most one row per player_id on tickets (Req 1.4)', () => {
    // Migration expresses this as an inline `unique` modifier on the
    // player_id column reference, not a separate table constraint.
    expect(
      /player_id\s+uuid\s+not null unique references players/i.test(sql),
    ).toBe(true)
  })

  it('enforces at most one row per (player_id, ticket_id, term_id) on marks (Req 1.5)', () => {
    expect(
      /unique\s*\(\s*player_id\s*,\s*ticket_id\s*,\s*term_id\s*\)/i.test(sql),
    ).toBe(true)
  })

  it('enforces at most one row per (game_id, prize_id) on winners (Req 1.7)', () => {
    expect(/unique\s*\(\s*game_id\s*,\s*prize_id\s*\)/i.test(sql)).toBe(true)
  })

  it('claims table is defined with no additional uniqueness constraint required by Req 1.6', () => {
    // Requirement 1.6 lists claims' minimum columns but names no uniqueness
    // pair for it (unlike 1.2-1.5 and 1.7) — every submitted claim attempt,
    // valid or invalid, is recorded. This test only re-asserts the table
    // exists (covered above) so the intent is documented alongside the rest.
    expect(countMatches(/create table\s+claims\s*\(/gi)).toBe(1)
  })

  it('publication statement names all seven shared tables', () => {
    const publicationMatch = sql.match(
      /alter publication supabase_realtime add table\s+([^;]+);/i,
    )
    expect(publicationMatch, 'publication statement not found').not.toBeNull()

    const namedTables = publicationMatch![1]
      .split(',')
      .map((name) => name.trim())

    // players is realtime-enabled too (Host Dashboard's live participant
    // count/roster reads it directly), so it is no longer excluded here.
    const sharedTables = REQUIRED_TABLES
    for (const table of sharedTables) {
      expect(namedTables).toContain(table)
    }
    expect(namedTables).toHaveLength(sharedTables.length)
  })
})
