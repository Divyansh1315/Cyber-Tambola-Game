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

// ---------------------------------------------------------------------------
// getAwardedCellTermIds — Properties 10-13
// ---------------------------------------------------------------------------

import { getAwardedCellTermIds } from './prizeEngine'
import type { Winner, PrizeId } from '../types/prize'

const FIXED_PATTERN_PRIZE_IDS = [
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
] as const

const LINE_PRIZE_ROWS_FOR_TEST: Record<string, number> = {
  FIREWALL_LINE: 0,
  SECURITY_LINE: 1,
  DATA_DEFENDER_LINE: 2,
}

function fixedCellSet(ticket: Ticket, prizeId: string): Set<string> {
  const cells =
    prizeId === 'CYBER_FULL_HOUSE'
      ? ticket.rows.flat()
      : ticket.rows[LINE_PRIZE_ROWS_FOR_TEST[prizeId]] ?? []
  return new Set(cells.map((c) => c.termId))
}

function makeWinner(overrides: Partial<Winner>): Winner {
  return {
    id: `winner-${Math.random()}`,
    gameId: 'game-1',
    prizeId: 'FIREWALL_LINE' as PrizeId,
    playerId: 'player-1',
    ticketId: 'ticket-1',
    claimId: 'claim-1',
    confirmedAt: '2024-01-01T00:00:00.000Z',
    prizeLabel: 'Firewall Line',
    playerName: 'Player One',
    ticketRef: 'Ticket #TEST',
    ...overrides,
  }
}

const prizeIdArb = fc.constantFrom(
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
)

const playerIdArb = fc.constantFrom('player-1', 'player-2', 'player-3')
const gameIdArb = fc.constantFrom('game-1', 'game-2')

/** Arbitrary winner whose fields are drawn from a small fixed pool, to produce realistic overlaps. */
const winnerArb = fc.record({
  gameId: gameIdArb,
  prizeId: prizeIdArb,
  playerId: playerIdArb,
}).map((partial) => makeWinner(partial as Partial<Winner>))

const winnersArb = fc.array(winnerArb, { maxLength: 8 })

// Feature: player-ux-improvements, Property 10: a termId is awarded iff some Fixed_Pattern_Prize winner matches and the term is in that prize's fixed cell set
describe('Property 10: a termId is awarded iff some Fixed_Pattern_Prize winner matches and the term is in that prize fixed cell set', () => {
  it('matches the exact union-of-matching-prizes-fixed-cell-sets definition', () => {
    const ticket = makeTicket()

    fc.assert(
      fc.property(winnersArb, (winners) => {
        const result = getAwardedCellTermIds(
          ticket,
          winners,
          'player-1',
          'game-1',
        )

        const expected = new Set<string>()
        for (const prizeId of FIXED_PATTERN_PRIZE_IDS) {
          const won = winners.some(
            (w) =>
              w.gameId === 'game-1' &&
              w.playerId === 'player-1' &&
              w.prizeId === prizeId,
          )
          if (!won) continue
          for (const termId of fixedCellSet(ticket, prizeId)) {
            expected.add(termId)
          }
        }

        expect(result).toEqual(expected)
      }),
      { numRuns: RUNS },
    )
  })
})

// Feature: player-ux-improvements, Property 11: CYBER_FIVE never contributes termIds
describe('Property 11: CYBER_FIVE never contributes termIds', () => {
  it('result is identical whether or not CYBER_FIVE winners are present', () => {
    const ticket = makeTicket()

    fc.assert(
      fc.property(winnersArb, (winners) => {
        const withCyberFive = [
          ...winners,
          makeWinner({ prizeId: 'CYBER_FIVE', gameId: 'game-1', playerId: 'player-1' }),
        ]
        const withoutCyberFive = winners.filter((w) => w.prizeId !== 'CYBER_FIVE')

        const resultWith = getAwardedCellTermIds(
          ticket,
          withCyberFive,
          'player-1',
          'game-1',
        )
        const resultWithout = getAwardedCellTermIds(
          ticket,
          withoutCyberFive,
          'player-1',
          'game-1',
        )

        expect(resultWith).toEqual(resultWithout)
      }),
      { numRuns: RUNS },
    )
  })
})

// Feature: player-ux-improvements, Property 12: a Winner for a different player or game never contributes termIds
describe('Property 12: a Winner for a different playerId or gameId never contributes termIds', () => {
  it('only exact playerId+gameId matches contribute', () => {
    const ticket = makeTicket()

    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...FIXED_PATTERN_PRIZE_IDS), { minLength: 1, maxLength: 4 }),
        fc.constantFrom('player-2', 'player-3'),
        fc.constantFrom('game-2'),
        (prizeIds, otherPlayerId, otherGameId) => {
          const winners: Winner[] = prizeIds.flatMap((prizeId) => [
            makeWinner({ prizeId, playerId: otherPlayerId, gameId: 'game-1' }),
            makeWinner({ prizeId, playerId: 'player-1', gameId: otherGameId }),
          ])

          const result = getAwardedCellTermIds(ticket, winners, 'player-1', 'game-1')
          expect(result.size).toBe(0)
        },
      ),
      { numRuns: RUNS },
    )
  })
})

// Feature: player-ux-improvements, Property 13: overlapping awarded cell sets de-duplicate via Set semantics
describe('Property 13: overlapping awarded cell sets de-duplicate via Set semantics', () => {
  it('a line prize + CYBER_FULL_HOUSE both awarded equals the union of each prize own cell set', () => {
    const ticket = makeTicket()

    fc.assert(
      fc.property(
        fc.constantFrom('FIREWALL_LINE', 'SECURITY_LINE', 'DATA_DEFENDER_LINE'),
        (linePrizeId) => {
          const winners: Winner[] = [
            makeWinner({ prizeId: linePrizeId as PrizeId, playerId: 'player-1', gameId: 'game-1' }),
            makeWinner({ prizeId: 'CYBER_FULL_HOUSE', playerId: 'player-1', gameId: 'game-1' }),
          ]

          const result = getAwardedCellTermIds(ticket, winners, 'player-1', 'game-1')

          const expected = new Set<string>([
            ...fixedCellSet(ticket, linePrizeId),
            ...fixedCellSet(ticket, 'CYBER_FULL_HOUSE'),
          ])

          expect(result).toEqual(expected)
          // CYBER_FULL_HOUSE covers the whole ticket, so the union collapses to it.
          expect(result).toEqual(fixedCellSet(ticket, 'CYBER_FULL_HOUSE'))
        },
      ),
      { numRuns: RUNS },
    )
  })
})
