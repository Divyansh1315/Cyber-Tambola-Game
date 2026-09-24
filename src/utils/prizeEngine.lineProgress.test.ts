import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import type { Mark } from '../types/mark'
import type { Ticket, TicketCell } from '../types/ticket'
import { getLineProgress, isPrizeEligible } from './prizeEngine'

const RUNS = 100

/** Builds a 3x5 ticket with 15 distinct termIds `TERM_000`..`TERM_014`. */
function makeTicket(): Ticket {
  const rows: TicketCell[][] = []
  for (let r = 0; r < 3; r++) {
    const row: TicketCell[] = []
    for (let c = 0; c < 5; c++) {
      const index = r * 5 + c
      row.push({
        termId: `TERM_${String(index).padStart(3, '0')}`,
        term: `Term ${index}`,
        state: 'LOCKED',
        row: r,
        col: c,
      })
    }
    rows.push(row)
  }
  return {
    id: 'ticket-1',
    playerId: 'player-1',
    gameId: 'game-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    ref: 'Ticket #TEST',
    rows,
  }
}

function ticketTermIds(ticket: Ticket): string[] {
  return ticket.rows.flat().map((c) => c.termId)
}

function marksFor(ticket: Ticket, markedTermIds: readonly string[]): Mark[] {
  return markedTermIds.map((termId, i) => ({
    id: `mark-${i}`,
    gameId: ticket.gameId,
    playerId: ticket.playerId,
    ticketId: ticket.id,
    termId,
    markedAt: '2024-01-01T00:00:00.000Z',
    valid: true,
  }))
}

function markedSubsetArb(ticket: Ticket) {
  return fc.subarray(ticketTermIds(ticket))
}

const ROW_PRIZES = [
  { row: 0, prizeId: 'FIREWALL_LINE' as const, label: 'Firewall Line' },
  { row: 1, prizeId: 'SECURITY_LINE' as const, label: 'Security Line' },
  { row: 2, prizeId: 'DATA_DEFENDER_LINE' as const, label: 'Data Defender Line' },
]

describe('prizeEngine.getLineProgress', () => {
  // Feature: module-4-term-marking-prize-engine, Property 6: Each Line_Prize counts only its own row
  it.each(ROW_PRIZES)(
    'property 6: $prizeId (row $row) counts only its own row',
    ({ row, prizeId, label }) => {
      const ticket = makeTicket()
      const rowTermIds = new Set(ticket.rows[row].map((c) => c.termId))

      fc.assert(
        fc.property(markedSubsetArb(ticket), (markedTermIds) => {
          const marks = marksFor(ticket, markedTermIds)
          const progress = getLineProgress(ticket, marks, row, prizeId, label)

          const expectedCurrent = markedTermIds.filter((id) =>
            rowTermIds.has(id),
          ).length

          expect(progress.id).toBe(prizeId)
          expect(progress.label).toBe(label)
          expect(progress.target).toBe(5)
          expect(progress.current).toBe(expectedCurrent)
          expect(isPrizeEligible(progress)).toBe(expectedCurrent >= 5)
        }),
        { numRuns: RUNS },
      )
    },
  )

  // Feature: module-4-term-marking-prize-engine, Property 6: Each Line_Prize counts only its own row
  it.each(ROW_PRIZES)(
    'property 6: $prizeId (row $row) is unaffected by marks on other rows',
    ({ row, prizeId, label }) => {
      const ticket = makeTicket()
      const otherRowTermIds = ticket.rows
        .filter((_, r) => r !== row)
        .flat()
        .map((c) => c.termId)

      fc.assert(
        fc.property(fc.subarray(otherRowTermIds), (markedOtherRows) => {
          const marks = marksFor(ticket, markedOtherRows)
          const progress = getLineProgress(ticket, marks, row, prizeId, label)

          expect(progress.current).toBe(0)
        }),
        { numRuns: RUNS },
      )
    },
  )
})
