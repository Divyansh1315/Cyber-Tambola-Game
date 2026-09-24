import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import type { Mark } from '../types/mark'
import type { Ticket, TicketCell } from '../types/ticket'
import { getAllPrizeProgress } from './prizeEngine'

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

function rowOf(ticket: Ticket, termId: string): number {
  for (const row of ticket.rows) {
    if (row.some((c) => c.termId === termId)) return row[0].row
  }
  throw new Error(`termId ${termId} not found on ticket`)
}

function prizeIdForRow(row: number): 'FIREWALL_LINE' | 'SECURITY_LINE' | 'DATA_DEFENDER_LINE' {
  return (['FIREWALL_LINE', 'SECURITY_LINE', 'DATA_DEFENDER_LINE'] as const)[row]
}

describe('prizeEngine.getAllPrizeProgress non-exclusivity', () => {
  // Feature: module-4-term-marking-prize-engine, Property 8: A single marked term contributes to every prize it qualifies for, without exclusion
  it('property 8: adding one more mark never decreases, and strictly increases eligible prizes', () => {
    const ticket = makeTicket()
    const allTermIds = ticketTermIds(ticket)

    fc.assert(
      fc.property(
        markedSubsetArb(ticket),
        fc.integer({ min: 0, max: allTermIds.length - 1 }),
        (markedTermIds, candidateIndex) => {
          const candidate = allTermIds[candidateIndex]
          fc.pre(!markedTermIds.includes(candidate))

          const before = marksFor(ticket, markedTermIds)
          const after = marksFor(ticket, [...markedTermIds, candidate])

          const progressBefore = getAllPrizeProgress(ticket, before)
          const progressAfter = getAllPrizeProgress(ticket, after)

          const byId = (list: typeof progressBefore, id: string) =>
            list.find((p) => p.id === id)!

          const candidateRow = rowOf(ticket, candidate)
          const candidateLinePrizeId = prizeIdForRow(candidateRow)

          for (const prizeId of [
            'CYBER_FIVE',
            'FIREWALL_LINE',
            'SECURITY_LINE',
            'DATA_DEFENDER_LINE',
            'CYBER_FULL_HOUSE',
          ] as const) {
            const before_ = byId(progressBefore, prizeId).current
            const after_ = byId(progressAfter, prizeId).current
            expect(after_).toBeGreaterThanOrEqual(before_) // never decreases
          }

          // Strictly increases CYBER_FIVE (capped at 5) and CYBER_FULL_HOUSE unconditionally...
          const cyberFiveBefore = byId(progressBefore, 'CYBER_FIVE').current
          const cyberFiveAfter = byId(progressAfter, 'CYBER_FIVE').current
          if (cyberFiveBefore < 5) {
            expect(cyberFiveAfter).toBe(cyberFiveBefore + 1)
          } else {
            expect(cyberFiveAfter).toBe(5)
          }

          const fullHouseBefore = byId(progressBefore, 'CYBER_FULL_HOUSE').current
          const fullHouseAfter = byId(progressAfter, 'CYBER_FULL_HOUSE').current
          expect(fullHouseAfter).toBe(fullHouseBefore + 1)

          // ...and strictly increases its own row's Line_Prize.
          const lineBefore = byId(progressBefore, candidateLinePrizeId).current
          const lineAfter = byId(progressAfter, candidateLinePrizeId).current
          expect(lineAfter).toBe(lineBefore + 1)

          // The other two Line_Prizes are untouched by this candidate's mark.
          for (const otherPrizeId of (
            ['FIREWALL_LINE', 'SECURITY_LINE', 'DATA_DEFENDER_LINE'] as const
          ).filter((id) => id !== candidateLinePrizeId)) {
            expect(byId(progressAfter, otherPrizeId).current).toBe(
              byId(progressBefore, otherPrizeId).current,
            )
          }
        },
      ),
      { numRuns: RUNS },
    )
  })

  // Feature: module-4-term-marking-prize-engine, Property 8: A single marked term contributes to every prize it qualifies for, without exclusion
  it('property 8: getAllPrizeProgress always returns all 5 entries in PRIZES order', () => {
    const ticket = makeTicket()

    fc.assert(
      fc.property(markedSubsetArb(ticket), (markedTermIds) => {
        const marks = marksFor(ticket, markedTermIds)
        const progress = getAllPrizeProgress(ticket, marks)

        expect(progress.map((p) => p.id)).toEqual([
          'CYBER_FIVE',
          'FIREWALL_LINE',
          'SECURITY_LINE',
          'DATA_DEFENDER_LINE',
          'CYBER_FULL_HOUSE',
        ])
      }),
      { numRuns: RUNS },
    )
  })
})
