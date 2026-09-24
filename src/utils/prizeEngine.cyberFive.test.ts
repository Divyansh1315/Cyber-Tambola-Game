import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import type { Mark } from '../types/mark'
import type { Ticket, TicketCell } from '../types/ticket'
import { getCyberFiveProgress, isPrizeEligible } from './prizeEngine'

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

/** Builds valid Marks for a subset of the ticket's termIds, for one player/ticket. */
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

// An arbitrary that produces a random subset (any size 0-15) of the fixed
// ticket's 15 termIds.
function markedSubsetArb(ticket: Ticket) {
  return fc.subarray(ticketTermIds(ticket))
}

describe('prizeEngine.getCyberFiveProgress', () => {
  // Feature: module-4-term-marking-prize-engine, Property 5: Cyber Five progress counts any 5 marked terms regardless of row
  it('property 5: counts any 5 marked terms regardless of row', () => {
    const ticket = makeTicket()

    fc.assert(
      fc.property(markedSubsetArb(ticket), (markedTermIds) => {
        const marks = marksFor(ticket, markedTermIds)
        const progress = getCyberFiveProgress(ticket, marks)

        expect(progress.id).toBe('CYBER_FIVE')
        expect(progress.target).toBe(5)
        expect(progress.current).toBe(Math.min(markedTermIds.length, 5))
        expect(isPrizeEligible(progress)).toBe(markedTermIds.length >= 5)
      }),
      { numRuns: RUNS },
    )
  })

  // Feature: module-4-term-marking-prize-engine, Property 5: Cyber Five progress counts any 5 marked terms regardless of row
  it('property 5: count is unaffected by redistributing the same marked termIds across rows', () => {
    const ticketA = makeTicket()
    // A second ticket with the same 15 termIds but shuffled into different
    // row/col positions (reverse the flattened order before re-chunking).
    const shuffledIds = [...ticketTermIds(ticketA)].reverse()
    const rows: TicketCell[][] = []
    for (let r = 0; r < 3; r++) {
      const row: TicketCell[] = []
      for (let c = 0; c < 5; c++) {
        const index = r * 5 + c
        row.push({
          termId: shuffledIds[index],
          term: `Term ${index}`,
          state: 'LOCKED',
          row: r,
          col: c,
        })
      }
      rows.push(row)
    }
    const ticketB: Ticket = { ...ticketA, id: 'ticket-2', rows }

    fc.assert(
      fc.property(markedSubsetArb(ticketA), (markedTermIds) => {
        const marksA = marksFor(ticketA, markedTermIds)
        const marksB = marksFor(ticketB, markedTermIds)

        const progressA = getCyberFiveProgress(ticketA, marksA)
        const progressB = getCyberFiveProgress(ticketB, marksB)

        expect(progressA.current).toBe(progressB.current)
      }),
      { numRuns: RUNS },
    )
  })
})
