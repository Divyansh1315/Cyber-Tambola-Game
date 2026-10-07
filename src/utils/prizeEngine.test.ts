import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import type { Mark } from '../types/mark'
import type { Ticket, TicketCell } from '../types/ticket'
import {
  PRIZES,
  getAllPrizeProgress,
  getCyberFiveProgress,
  isPrizeEligible,
} from './prizeEngine'
import { TICKET_COLUMNS, TICKET_SIZE } from './ticketGenerator'

const RUNS = 100

/** Builds a 3x4 ticket with 12 distinct termIds `TERM_00`..`TERM_11`. */
function makeTicket(): Ticket {
  const rows: TicketCell[][] = []
  for (let r = 0; r < 3; r++) {
    const row: TicketCell[] = []
    for (let c = 0; c < TICKET_COLUMNS; c++) {
      const index = r * TICKET_COLUMNS + c
      row.push({
        termId: `TERM_${String(index).padStart(2, '0')}`,
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

// ---------------------------------------------------------------------------
// Property 14: Cyber Five is unchanged by the dimension refactor
// Feature: ticket-3x4-dimension-refactor, Property 14: Cyber Five is unchanged by the dimension refactor
// Validates: Requirements 20.1, 20.2, 20.3
// ---------------------------------------------------------------------------

describe('Property 14: Cyber Five is unchanged by the dimension refactor', () => {
  it('still targets 5, caps current at 5, and is eligible iff current reaches 5, on a 12-cell ticket', () => {
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

  it('the static PRIZES entry for CYBER_FIVE keeps the literal target 5, not a dimension constant', () => {
    const cyberFive = PRIZES.find((p) => p.id === 'CYBER_FIVE')!
    expect(cyberFive.target).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Property 15: Line prizes require exactly 4 marks in their row
// Feature: ticket-3x4-dimension-refactor, Property 15: Line prizes require exactly 4 marks in their row
// Validates: Requirements 21.1, 21.2, 21.3
// ---------------------------------------------------------------------------

const LINE_PRIZES = [
  { row: 0, prizeId: 'FIREWALL_LINE' as const },
  { row: 1, prizeId: 'SECURITY_LINE' as const },
  { row: 2, prizeId: 'DATA_DEFENDER_LINE' as const },
]

describe('Property 15: Line prizes require exactly 4 marks in their row', () => {
  it.each(LINE_PRIZES)(
    '$prizeId (row $row) targets TICKET_COLUMNS (4) and is eligible iff all 4 row cells are marked',
    ({ row, prizeId }) => {
      const ticket = makeTicket()

      fc.assert(
        fc.property(markedSubsetArb(ticket), (markedTermIds) => {
          const marks = marksFor(ticket, markedTermIds)
          const progress = getAllPrizeProgress(ticket, marks).find(
            (p) => p.id === prizeId,
          )!

          expect(progress.target).toBe(TICKET_COLUMNS)
          expect(progress.target).toBe(4)
          expect(progress.target).not.toBe(5)

          const rowTermIds = new Set(ticket.rows[row].map((c) => c.termId))
          const expectedCurrent = markedTermIds.filter((id) =>
            rowTermIds.has(id),
          ).length

          expect(progress.current).toBe(expectedCurrent)
          expect(isPrizeEligible(progress)).toBe(expectedCurrent === 4)
        }),
        { numRuns: RUNS },
      )
    },
  )

  it('a Line_Prize is eligible exactly when its 4-cell row is fully marked, and not with only 3', () => {
    const ticket = makeTicket()

    fc.assert(
      fc.property(fc.constantFrom(0, 1, 2), (row) => {
        const rowTermIds = ticket.rows[row].map((c) => c.termId)
        const prizeId = LINE_PRIZES[row].prizeId

        const fullRowMarks = marksFor(ticket, rowTermIds)
        const fullProgress = getAllPrizeProgress(ticket, fullRowMarks).find(
          (p) => p.id === prizeId,
        )!
        expect(isPrizeEligible(fullProgress)).toBe(true)

        const threeOfFour = rowTermIds.slice(0, 3)
        const partialMarks = marksFor(ticket, threeOfFour)
        const partialProgress = getAllPrizeProgress(ticket, partialMarks).find(
          (p) => p.id === prizeId,
        )!
        expect(isPrizeEligible(partialProgress)).toBe(false)
        expect(partialProgress.current).toBe(3)
      }),
      { numRuns: RUNS },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 16: Cyber Full House requires exactly 12 marks
// Feature: ticket-3x4-dimension-refactor, Property 16: Cyber Full House requires exactly 12 marks
// Validates: Requirements 22.1, 22.2, 22.3
// ---------------------------------------------------------------------------

describe('Property 16: Cyber Full House requires exactly 12 marks', () => {
  it('targets TICKET_SIZE (12), tracks every marked term, and is eligible iff all 12 cells are marked', () => {
    const ticket = makeTicket()

    fc.assert(
      fc.property(markedSubsetArb(ticket), (markedTermIds) => {
        const marks = marksFor(ticket, markedTermIds)
        const progress = getAllPrizeProgress(ticket, marks).find(
          (p) => p.id === 'CYBER_FULL_HOUSE',
        )!

        expect(progress.target).toBe(TICKET_SIZE)
        expect(progress.target).toBe(12)
        expect(progress.target).not.toBe(15)
        expect(progress.current).toBe(markedTermIds.length)
        expect(isPrizeEligible(progress)).toBe(markedTermIds.length === 12)
      }),
      { numRuns: RUNS },
    )
  })

  it('is not eligible with 11 of 12 marked, and becomes eligible with all 12 marked', () => {
    const ticket = makeTicket()
    const allIds = ticketTermIds(ticket)
    expect(allIds.length).toBe(12)

    const elevenMarks = marksFor(ticket, allIds.slice(0, 11))
    const elevenProgress = getAllPrizeProgress(ticket, elevenMarks).find(
      (p) => p.id === 'CYBER_FULL_HOUSE',
    )!
    expect(isPrizeEligible(elevenProgress)).toBe(false)

    const twelveMarks = marksFor(ticket, allIds)
    const twelveProgress = getAllPrizeProgress(ticket, twelveMarks).find(
      (p) => p.id === 'CYBER_FULL_HOUSE',
    )!
    expect(isPrizeEligible(twelveProgress)).toBe(true)
  })
})
