// Module: fix/multiplayer-reliability — structural lint for the new
// submit_claim redefinition in 0010_claim_auto_win.sql, confirming the
// first-valid-claim-wins behavior is wired up: all 10 original gate codes
// are still present unchanged, a `winners` insert with
// `on conflict (game_id, prize_id)` exists, and host_decision is set to
// 'CONFIRMED' on a successful winners insert / 'REJECTED' with
// 'PRIZE_ALREADY_WON' on a failed one.
//
// This is a text-pattern check against the raw SQL, not a Postgres parse —
// there is no live database in this environment. Mirrors
// ticket3x4DimensionFix.structure.test.ts's own style.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const migrationsDir = path.dirname(fileURLToPath(import.meta.url))

const autoWinSql = readFileSync(
  path.join(migrationsDir, '0010_claim_auto_win.sql'),
  'utf-8',
)

function getFunctionBody(sql: string, fnName: string): string {
  const fnMatch = sql.match(
    new RegExp(`create or replace function\\s+${fnName}\\s*\\([^)]*\\)[\\s\\S]*?\\$\\$;`, 'i'),
  )
  expect(fnMatch, `${fnName} function body not found`).not.toBeNull()
  return fnMatch![0]
}

describe('0010_claim_auto_win.sql RPC structure', () => {
  it('defines submit_claim via create or replace function', () => {
    expect(
      /create or replace function\s+submit_claim\s*\(/i.test(autoWinSql),
    ).toBe(true)
  })

  describe('submit_claim', () => {
    const fnBody = getFunctionBody(autoWinSql, 'submit_claim')

    const originalGateCodes = [
      'GAME_NOT_FOUND',
      'PLAYER_NOT_FOUND',
      'PLAYER_NOT_IN_GAME',
      'TICKET_NOT_FOUND',
      'TICKET_NOT_OWNED_BY_PLAYER',
      'PRIZE_NOT_FOUND',
      'DUPLICATE_ACTIVE_CLAIM',
      'RESUBMISSION_LIMIT_REACHED',
      'PRIZE_CLOSED',
      'NOT_ELIGIBLE',
    ]

    it.each(originalGateCodes)('still contains the original gate code %s', (code) => {
      expect(fnBody.includes(code)).toBe(true)
    })

    it('attempts an insert into winners with on conflict targeting (game_id, prize_id)', () => {
      expect(/insert into winners[\s\S]*?on conflict\s*\(\s*game_id\s*,\s*prize_id\s*\)/i.test(fnBody)).toBe(
        true,
      )
    })

    it('does nothing on conflict (first-writer-wins, no custom locking)', () => {
      expect(/on conflict\s*\(\s*game_id\s*,\s*prize_id\s*\)\s*do nothing/i.test(fnBody)).toBe(true)
    })

    it("sets host_decision = 'CONFIRMED' tied to a successful winners insert", () => {
      expect(/v_won_winner_id is not null[\s\S]*?'CONFIRMED'/i.test(fnBody)).toBe(true)
    })

    it("sets host_decision = 'REJECTED' with rejection_reason 'PRIZE_ALREADY_WON' tied to a failed winners insert", () => {
      expect(/else[\s\S]*?'REJECTED'[\s\S]*?'PRIZE_ALREADY_WON'/i.test(fnBody)).toBe(true)
    })

    it('mints the claim id up front via gen_random_uuid() so winners.claim_id can reference it', () => {
      expect(/v_claim_id\s*:=\s*gen_random_uuid\(\)/i.test(fnBody)).toBe(true)
    })

    it('still sets host_decision = PENDING for an invalid claim (gate failure path unchanged)', () => {
      expect(/'INVALID'[\s\S]{0,200}'PENDING'/i.test(fnBody)).toBe(true)
    })

    it('does not attempt a winners insert in the invalid-claim branch', () => {
      // The invalid-claim insert block (ending at the first `return v_claim;`)
      // must not contain an actual SQL reference to the winners table
      // (comments mentioning "winners" in prose are fine — only an
      // `insert into winners` / `from winners` style reference matters).
      const invalidBranchMatch = fnBody.match(/if v_reason is not null then[\s\S]*?return v_claim;\s*end if;/i)
      expect(invalidBranchMatch, 'invalid-claim branch not found').not.toBeNull()
      expect(/(insert into|from|update)\s+winners/i.test(invalidBranchMatch![0])).toBe(false)
    })
  })
})
