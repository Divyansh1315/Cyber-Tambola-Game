// Feature: winner-history-and-game-reset — structural lint for the
// active_game_pointer / winners.ticket_ref migration (Req 1.2, 2.3, 3.1, 3.5)
//
// This is a text-pattern check against the raw SQL, not a Postgres parse —
// there is no live database in this environment. It exists to catch an
// omitted table, constraint, or policy in
// 0006_active_game_and_winner_history.sql before any live database is ever
// involved, mirroring schema.structure.test.ts's own style.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '0006_active_game_and_winner_history.sql',
)
const sql = readFileSync(migrationPath, 'utf-8')

/** Count non-overlapping occurrences of a pattern in the SQL text. */
function countMatches(pattern: RegExp): number {
  const matches = sql.match(pattern)
  return matches ? matches.length : 0
}

describe('0006_active_game_and_winner_history.sql structure', () => {
  it('contains exactly one CREATE TABLE for "active_game_pointer" (Req 3.1, 3.5)', () => {
    const pattern = /create table\s+active_game_pointer\s*\(/gi
    expect(countMatches(pattern)).toBe(1)
  })

  it('defines the "id" column as a boolean primary key (Req 3.1, 3.5)', () => {
    expect(/id\s+boolean primary key/i.test(sql)).toBe(true)
  })

  it('constrains "id" with a check (id) constraint (Req 3.1, 3.5)', () => {
    expect(/check\s*\(\s*id\s*\)/i.test(sql)).toBe(true)
  })

  it('contains exactly one seed insert into active_game_pointer (Req 3.1, 3.5)', () => {
    const pattern = /insert into\s+active_game_pointer\b/gi
    expect(countMatches(pattern)).toBe(1)
  })

  it('adds, backfills, and constrains winners.ticket_ref in that relative order (Req 1.2, 2.3)', () => {
    const addColumnMatch = sql.match(
      /alter table\s+winners\s+add column\s+ticket_ref\b[^;]*;/i,
    )
    const backfillMatch = sql.match(
      /update\s+winners\s+set\s+ticket_ref\s*=[^;]*;/i,
    )
    const setNotNullMatch = sql.match(
      /alter table\s+winners\s+alter column\s+ticket_ref\s+set not null\s*;/i,
    )

    expect(addColumnMatch, 'add column ticket_ref statement not found').not.toBeNull()
    expect(backfillMatch, 'backfill update statement not found').not.toBeNull()
    expect(setNotNullMatch, 'set not null statement not found').not.toBeNull()

    const addColumnIndex = sql.indexOf(addColumnMatch![0])
    const backfillIndex = sql.indexOf(backfillMatch![0])
    const setNotNullIndex = sql.indexOf(setNotNullMatch![0])

    expect(addColumnIndex).toBeLessThan(backfillIndex)
    expect(backfillIndex).toBeLessThan(setNotNullIndex)
  })

  it('enables row level security on active_game_pointer (Req 3.1, 3.5)', () => {
    expect(
      /alter table\s+active_game_pointer\s+enable row level security\s*;/i.test(sql),
    ).toBe(true)
  })

  it('has a "for select to anon" policy for active_game_pointer (Req 3.1, 3.5)', () => {
    const pattern =
      /create policy[^;]*on\s+active_game_pointer\s+for select to anon[^;]*;/i
    expect(pattern.test(sql)).toBe(true)
  })

  it('has no insert/update/delete policy naming anon for active_game_pointer (Req 3.1, 3.5)', () => {
    const pattern =
      /create policy[^;]*on\s+active_game_pointer\s+for (insert|update|delete)[^;]*to anon[^;]*;/gi
    expect(countMatches(pattern)).toBe(0)
  })

  it('publication statement names active_game_pointer (Req 3.1, 3.5)', () => {
    const publicationMatches = [
      ...sql.matchAll(/alter publication supabase_realtime add table\s+([^;]+);/gi),
    ]
    expect(publicationMatches.length).toBeGreaterThan(0)

    const namedTables = publicationMatches.flatMap((match) =>
      match[1].split(',').map((name) => name.trim()),
    )
    expect(namedTables).toContain('active_game_pointer')
  })
})
