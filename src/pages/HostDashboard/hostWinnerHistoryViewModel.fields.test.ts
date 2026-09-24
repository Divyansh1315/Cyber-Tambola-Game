// Feature: winner-history-and-game-reset, Property 4: Winner_History rows carry exactly the required display fields, never an employee/demo id
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { toWinnerHistoryViewModel, type WinnerHistoryGameSummary } from './hostWinnerHistoryViewModel'
import type { PrizeId, Winner } from '../../types/prize'

const prizeIdArb: fc.Arbitrary<PrizeId> = fc.constantFrom(
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
)

// Winner generator including realistic display fields plus extra
// noise/technical fields (id/gameId/prizeId/playerId/ticketId/claimId) that
// must never leak into a Winner_History row.
const winnerArb: fc.Arbitrary<Winner> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: fc.string({ minLength: 1, maxLength: 10 }),
  prizeId: prizeIdArb,
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  claimId: fc.string({ minLength: 1, maxLength: 10 }),
  confirmedAt: fc.constant('2026-01-01T09:05:00.000Z'),
  prizeLabel: fc.constantFrom(
    'Cyber Five',
    'Firewall Line',
    'Security Line',
    'Data Defender Line',
    'Cyber Full House',
  ),
  playerName: fc.string({ minLength: 1, maxLength: 20 }),
  ticketRef: fc.string({ minLength: 1, maxLength: 20 }).map((s) => `Ticket #${s}`),
})

const gameArb: fc.Arbitrary<WinnerHistoryGameSummary> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  code: fc.string({ minLength: 1, maxLength: 10 }),
  createdAt: fc.constant('2026-01-01T08:00:00.000Z'),
})

// An out-of-band employee/demo id value that is never itself part of any
// generated Winner's fields, so its (non-)appearance in rendered rows is
// unambiguous.
const employeeDemoIdArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .map((s) => `EMP-DEMO-${s}`)

describe('toWinnerHistoryViewModel (property 4)', () => {
  it('every row exposes exactly {prizeLabel, playerName, ticketRef, confirmedAt}, never any other field', () => {
    fc.assert(
      fc.property(fc.array(winnerArb, { maxLength: 15 }), fc.array(gameArb, { maxLength: 5 }), (winners, games) => {
        const groups = toWinnerHistoryViewModel(winners, games)

        for (const group of groups) {
          for (const row of group.rows) {
            expect(Object.keys(row).sort()).toEqual(['confirmedAt', 'playerName', 'prizeLabel', 'ticketRef'])

            // Never leaks technical/identifying fields.
            expect(row).not.toHaveProperty('id')
            expect(row).not.toHaveProperty('gameId')
            expect(row).not.toHaveProperty('prizeId')
            expect(row).not.toHaveProperty('playerId')
            expect(row).not.toHaveProperty('ticketId')
            expect(row).not.toHaveProperty('claimId')
          }
        }
      }),
      { numRuns: 100 },
    )
  })

  it('no rendered row ever contains a generated employee/demo id value (Req 2.3, 2.7)', () => {
    fc.assert(
      fc.property(
        fc.array(winnerArb, { minLength: 1, maxLength: 15 }),
        fc.array(gameArb, { maxLength: 5 }),
        employeeDemoIdArb,
        (winners, games, employeeDemoId) => {
          const groups = toWinnerHistoryViewModel(winners, games)

          for (const group of groups) {
            // Group labels never carry the employee/demo id either.
            expect(group.gameCode).not.toBe(employeeDemoId)
            expect(group.gameId).not.toBe(employeeDemoId)

            for (const row of group.rows) {
              for (const value of Object.values(row)) {
                expect(value).not.toBe(employeeDemoId)
                expect(String(value)).not.toContain(employeeDemoId)
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
