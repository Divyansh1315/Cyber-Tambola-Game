import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import type { Game } from '../types/game'
import type { Mark } from '../types/mark'
import type { Player } from '../types/player'
import type { PrizeId } from '../types/prize'
import type { Ticket, TicketCell } from '../types/ticket'
import {
  PRIZES,
  getAllPrizeProgress,
  getPlayerTicketMarks,
  isPrizeEligible,
} from './prizeEngine'
import { validatePrizeClaim } from './claimEngine'
import { TICKET_COLUMNS } from './ticketGenerator'

const RUNS = 100

const GAME_ID = 'game-1'
const PLAYER_ID = 'player-1'
const TICKET_ID = 'ticket-1'

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
    id: TICKET_ID,
    playerId: PLAYER_ID,
    gameId: GAME_ID,
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

function makeGame(): Game {
  return {
    id: GAME_ID,
    code: 'ABC123',
    status: 'WORD_ACTIVE',
    createdAt: '2024-01-01T00:00:00.000Z',
    currentRound: 1,
    revealedTermIds: [],
  }
}

function makePlayer(): Player {
  return {
    id: PLAYER_ID,
    gameId: GAME_ID,
    displayName: 'Alex',
    ticketId: TICKET_ID,
    joinedAt: '2024-01-01T00:00:00.000Z',
    name: 'Alex',
    ticketRef: 'Ticket #TEST',
  }
}

const prizeIdArb = fc.constantFrom(...PRIZES.map((p) => p.id))

// ---------------------------------------------------------------------------
// Property 17: Claim engine eligibility always agrees with prize engine
// eligibility
// Feature: ticket-3x4-dimension-refactor, Property 17: Claim engine eligibility always agrees with prize engine eligibility
// Validates: Requirements 23.1, 23.2, 23.3, 23.4, 23.5
// ---------------------------------------------------------------------------

describe('Property 17: Claim engine eligibility always agrees with prize engine eligibility', () => {
  it('for every prize and every mark subset on a 12-cell/4-column ticket, validatePrizeClaim rejects with NOT_ELIGIBLE iff the prize engine reports ineligible, and otherwise accepts', () => {
    const ticket = makeTicket()
    const game = makeGame()
    const player = makePlayer()

    fc.assert(
      fc.property(prizeIdArb, markedSubsetArb(ticket), (prizeId, markedTermIds) => {
        const marks = marksFor(ticket, markedTermIds)

        const result = validatePrizeClaim({
          game,
          player,
          ticket,
          marks,
          prizeId,
          winners: [],
          existingClaims: [],
        })

        const validMarks = getPlayerTicketMarks(marks, PLAYER_ID, TICKET_ID)
        const progress = getAllPrizeProgress(ticket, validMarks).find(
          (p) => p.id === prizeId,
        )!
        const eligible = isPrizeEligible(progress)

        if (eligible) {
          expect(result).toEqual({ valid: true })
        } else {
          expect(result).toEqual({ valid: false, reason: 'NOT_ELIGIBLE' })
        }
      }),
      { numRuns: RUNS },
    )
  })

  it('Firewall/Security/Data_Defender line claims require exactly all 4 cells of their row (TICKET_COLUMNS), never 5', () => {
    const ticket = makeTicket()
    const game = makeGame()
    const player = makePlayer()

    const lineRows: Record<string, number> = {
      FIREWALL_LINE: 0,
      SECURITY_LINE: 1,
      DATA_DEFENDER_LINE: 2,
    }

    for (const [prizeId, row] of Object.entries(lineRows) as [PrizeId, number][]) {
      const rowTermIds = ticket.rows[row].map((c) => c.termId)
      expect(rowTermIds).toHaveLength(4)

      // 3 of 4 marked -> rejected NOT_ELIGIBLE
      const partialMarks = marksFor(ticket, rowTermIds.slice(0, 3))
      const partialResult = validatePrizeClaim({
        game,
        player,
        ticket,
        marks: partialMarks,
        prizeId,
        winners: [],
        existingClaims: [],
      })
      expect(partialResult).toEqual({ valid: false, reason: 'NOT_ELIGIBLE' })

      // All 4 marked -> accepted
      const fullMarks = marksFor(ticket, rowTermIds)
      const fullResult = validatePrizeClaim({
        game,
        player,
        ticket,
        marks: fullMarks,
        prizeId,
        winners: [],
        existingClaims: [],
      })
      expect(fullResult).toEqual({ valid: true })
    }
  })

  it('Cyber_Full_House claims require exactly all 12 cells (TICKET_SIZE), never 15', () => {
    const ticket = makeTicket()
    const game = makeGame()
    const player = makePlayer()
    const allIds = ticketTermIds(ticket)
    expect(allIds).toHaveLength(12)

    const elevenMarks = marksFor(ticket, allIds.slice(0, 11))
    const elevenResult = validatePrizeClaim({
      game,
      player,
      ticket,
      marks: elevenMarks,
      prizeId: 'CYBER_FULL_HOUSE',
      winners: [],
      existingClaims: [],
    })
    expect(elevenResult).toEqual({ valid: false, reason: 'NOT_ELIGIBLE' })

    const twelveMarks = marksFor(ticket, allIds)
    const twelveResult = validatePrizeClaim({
      game,
      player,
      ticket,
      marks: twelveMarks,
      prizeId: 'CYBER_FULL_HOUSE',
      winners: [],
      existingClaims: [],
    })
    expect(twelveResult).toEqual({ valid: true })
  })

  it('Cyber_Five claims use the unchanged 5-or-more-anywhere rule regardless of the 12-cell dimension change', () => {
    const ticket = makeTicket()
    const game = makeGame()
    const player = makePlayer()
    const allIds = ticketTermIds(ticket)

    const fourMarks = marksFor(ticket, allIds.slice(0, 4))
    const fourResult = validatePrizeClaim({
      game,
      player,
      ticket,
      marks: fourMarks,
      prizeId: 'CYBER_FIVE',
      winners: [],
      existingClaims: [],
    })
    expect(fourResult).toEqual({ valid: false, reason: 'NOT_ELIGIBLE' })

    const fiveMarks = marksFor(ticket, allIds.slice(0, 5))
    const fiveResult = validatePrizeClaim({
      game,
      player,
      ticket,
      marks: fiveMarks,
      prizeId: 'CYBER_FIVE',
      winners: [],
      existingClaims: [],
    })
    expect(fiveResult).toEqual({ valid: true })
  })

  it('claim engine requires no production-code branching on ticket dimensions: it delegates entirely to prizeEngine for eligibility', () => {
    // This is a design-confirmation test, not a dimension test: it asserts
    // that for an arbitrary mark subset, the claim engine's accept/reject
    // decision for the eligibility gate is a pure function of
    // getAllPrizeProgress's output -- i.e. claimEngine.ts contains no
    // row/column/size literal of its own that could disagree with
    // prizeEngine.ts after the 3x4 refactor.
    const ticket = makeTicket()
    const game = makeGame()
    const player = makePlayer()

    fc.assert(
      fc.property(prizeIdArb, markedSubsetArb(ticket), (prizeId, markedTermIds) => {
        const marks = marksFor(ticket, markedTermIds)
        const validMarks = getPlayerTicketMarks(marks, PLAYER_ID, TICKET_ID)
        const progress = getAllPrizeProgress(ticket, validMarks).find(
          (p) => p.id === prizeId,
        )!

        const result = validatePrizeClaim({
          game,
          player,
          ticket,
          marks,
          prizeId,
          winners: [],
          existingClaims: [],
        })

        expect(result.valid).toBe(isPrizeEligible(progress))
      }),
      { numRuns: RUNS },
    )
  })
})
