import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import type { Mark } from '../types/mark'
import type { Ticket, TicketCell } from '../types/ticket'
import { getFullHouseProgress, isPrizeEligible } from './prizeEngine'

const RUNS = 100

/**
 * Builds a legacy-shaped 3x5 ticket with 15 distinct termIds
 * `TERM_000`..`TERM_014`, deliberately exercising `getFullHouseProgress`'s
 * design decision to derive its target from the ticket's own shape (so a
 * legacy 15-cell ticket still reports a 15-cell Full House target, not the
 * current 12-cell constant).
 */
function makeTicket(): Ticket {
  const rows: TicketCell[][] = []
  for (let r = 0; r < 3; r++) {
    const row: TicketCell[] = []
    for (let c = 0; c < 5; c++) {
      const index = r * 5 + c // not-a-ticket-dimension (deliberately legacy 3x5 shape, see below)
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

describe('prizeEngine.getFullHouseProgress', () => {
  // Feature: module-4-term-marking-prize-engine, Property 7: Cyber Full House tracks every marked term on the ticket
  it('property 7: tracks every marked term on the ticket', () => {
    const ticket = makeTicket()

    fc.assert(
      fc.property(markedSubsetArb(ticket), (markedTermIds) => {
        const marks = marksFor(ticket, markedTermIds)
        const progress = getFullHouseProgress(ticket, marks)

        expect(progress.id).toBe('CYBER_FULL_HOUSE')
        expect(progress.target).toBe(15) // not-a-ticket-dimension (legacy 3x5 fixture's own shape, by design)
        expect(progress.current).toBe(markedTermIds.length)
        expect(isPrizeEligible(progress)).toBe(markedTermIds.length === 15) // not-a-ticket-dimension (legacy 3x5 fixture's own shape, by design)
      }),
      { numRuns: RUNS },
    )
  })

  // Feature: module-4-term-marking-prize-engine, Property 7: Cyber Full House tracks every marked term on the ticket
  it('property 7: marks for termIds not on the ticket do not count', () => {
    const ticket = makeTicket()

    fc.assert(
      fc.property(
        markedSubsetArb(ticket),
        fc.array(fc.string({ minLength: 1 }), { maxLength: 5 }),
        (onTicketIds, foreignIds) => {
          // Ensure foreign ids never accidentally collide with real termIds.
          const cleanForeign = foreignIds
            .map((id) => `FOREIGN_${id}`)
            .filter((id) => !ticketTermIds(ticket).includes(id))

          const marks = marksFor(ticket, [...onTicketIds, ...cleanForeign])
          const progress = getFullHouseProgress(ticket, marks)

          expect(progress.current).toBe(onTicketIds.length)
        },
      ),
      { numRuns: RUNS },
    )
  })
})
