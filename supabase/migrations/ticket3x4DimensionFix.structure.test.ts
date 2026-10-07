// Feature: ticket-3x4-dimension-refactor — structural lint for the new
// assign_ticket / submit_claim redefinitions in
// 0009_ticket_3x4_dimension_fix.sql, confirming the 15-cell/5-mark
// dimensions are gone and the 12-cell/4-mark dimensions are in place.
//
// This is a text-pattern check against the raw SQL, not a Postgres parse —
// there is no live database in this environment. It exists to catch a
// missed dimension literal or an accidentally-changed gate before any live
// database is ever involved, mirroring rpcActiveGameAndReset.structure.test.ts's
// own style.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const migrationsDir = path.dirname(fileURLToPath(import.meta.url))

const dimensionFixSql = readFileSync(
  path.join(migrationsDir, '0009_ticket_3x4_dimension_fix.sql'),
  'utf-8',
)

function getFunctionBody(sql: string, fnName: string): string {
  const fnMatch = sql.match(
    new RegExp(`create or replace function\\s+${fnName}\\s*\\([^)]*\\)[\\s\\S]*?\\$\\$;`, 'i'),
  )
  expect(fnMatch, `${fnName} function body not found`).not.toBeNull()
  return fnMatch![0]
}

describe('0009_ticket_3x4_dimension_fix.sql RPC structure', () => {
  it('defines assign_ticket via create or replace function', () => {
    expect(
      /create or replace function\s+assign_ticket\s*\(/i.test(dimensionFixSql),
    ).toBe(true)
  })

  it('defines submit_claim via create or replace function', () => {
    expect(
      /create or replace function\s+submit_claim\s*\(/i.test(dimensionFixSql),
    ).toBe(true)
  })

  describe('assign_ticket', () => {
    const fnBody = getFunctionBody(dimensionFixSql, 'assign_ticket');

    it('does not contain the old 15-cell array slice bound', () => {
      expect(/\[1:15\]/.test(fnBody)).toBe(false)
    })

    it('does not contain the old 15-cell generate_series bound', () => {
      expect(/generate_series\(1,\s*15\)/i.test(fnBody)).toBe(false)
    })

    it('does not contain the old < 15 active-term-count check', () => {
      expect(/<\s*15/.test(fnBody)).toBe(false)
    })

    it('contains the new [1:12] array slice bound', () => {
      expect(/\[1:12\]/.test(fnBody)).toBe(true)
    })

    it('contains the new generate_series(1, 12) bound', () => {
      expect(/generate_series\(1,\s*12\)/i.test(fnBody)).toBe(true)
    })

    it('contains the new < 12 active-term-count check', () => {
      expect(/<\s*12/.test(fnBody)).toBe(true)
    })

    it('builds cell row/col math using /4 and %4 (not /5 or %5)', () => {
      expect(/\(i-1\)\/4/.test(fnBody)).toBe(true)
      expect(/\(i-1\)%4/.test(fnBody)).toBe(true)
      expect(/\(i-1\)\/5/.test(fnBody)).toBe(false)
      expect(/\(i-1\)%5/.test(fnBody)).toBe(false)
    })
  })

  describe('submit_claim', () => {
    const fnBody = getFunctionBody(dimensionFixSql, 'submit_claim');

    it('sets v_prize_target := 4 for FIREWALL_LINE/SECURITY_LINE/DATA_DEFENDER_LINE', () => {
      expect(
        /when\s+'FIREWALL_LINE'\s+then[^\n]*v_prize_target\s*:=\s*4\s*;/i.test(fnBody),
      ).toBe(true)
      expect(
        /when\s+'SECURITY_LINE'\s+then[^\n]*v_prize_target\s*:=\s*4\s*;/i.test(fnBody),
      ).toBe(true)
      expect(
        /when\s+'DATA_DEFENDER_LINE'\s+then[^\n]*v_prize_target\s*:=\s*4\s*;/i.test(fnBody),
      ).toBe(true)
    })

    it('sets v_prize_target := 12 for CYBER_FULL_HOUSE', () => {
      expect(
        /when\s+'CYBER_FULL_HOUSE'\s+then[^\n]*v_prize_target\s*:=\s*12\s*;/i.test(fnBody),
      ).toBe(true)
    })

    it('still sets v_prize_target := 5 for CYBER_FIVE (unchanged)', () => {
      expect(
        /when\s+'CYBER_FIVE'\s+then[^\n]*v_prize_target\s*:=\s*5\s*;/i.test(fnBody),
      ).toBe(true)
    })

    it('does not set v_prize_target := 15 anywhere', () => {
      expect(/v_prize_target\s*:=\s*15\s*;/i.test(fnBody)).toBe(false)
    })

    it('does not set the old v_prize_target := 5 for any of the three line prizes', () => {
      expect(
        /when\s+'FIREWALL_LINE'\s+then[^\n]*v_prize_target\s*:=\s*5\s*;/i.test(fnBody),
      ).toBe(false)
      expect(
        /when\s+'SECURITY_LINE'\s+then[^\n]*v_prize_target\s*:=\s*5\s*;/i.test(fnBody),
      ).toBe(false)
      expect(
        /when\s+'DATA_DEFENDER_LINE'\s+then[^\n]*v_prize_target\s*:=\s*5\s*;/i.test(fnBody),
      ).toBe(false)
    })
  })
})
