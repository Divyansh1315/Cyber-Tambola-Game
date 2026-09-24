import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import type { Game } from '../types/game'
import type { Mark } from '../types/mark'
import type { Player } from '../types/player'
import type { HostDecision, PrizeClaim, PrizeId, Winner } from '../types/prize'
import type { Ticket, TicketCell } from '../types/ticket'
import { PRIZES, getAllPrizeProgress, getPlayerTicketMarks, isPrizeEligible } from './prizeEngine'
import { validatePrizeClaim } from './claimEngine'

const RUNS = 100

const GAME_ID = 'game-1'
const PLAYER_ID = 'player-1'
const TICKET_ID = 'ticket-1'
const PRIZE_ID: PrizeId = PRIZES[0].id

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

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: PLAYER_ID,
    gameId: GAME_ID,
    displayName: 'Alex',
    employeeDemoId: 'EMP-1',
    ticketId: TICKET_ID,
    joinedAt: '2024-01-01T00:00:00.000Z',
    name: 'Alex',
    employeeId: 'EMP-1',
    ticketRef: 'Ticket #TEST',
    ...overrides,
  }
}

function makeWinner(overrides: Partial<Winner> = {}): Winner {
  return {
    id: 'winner-x',
    gameId: GAME_ID,
    prizeId: PRIZE_ID,
    playerId: 'someone-else',
    ticketId: 'ticket-other',
    claimId: 'claim-other',
    confirmedAt: '2024-01-01T00:00:00.000Z',
    prizeLabel: 'Cyber Five',
    playerName: 'Someone Else',
    ...overrides,
  }
}

/** Builds a prior PrizeClaim for the fixed (PLAYER_ID, PRIZE_ID) pair with a given hostDecision. */
function makePriorClaim(id: string, hostDecision: HostDecision): PrizeClaim {
  return {
    id,
    gameId: GAME_ID,
    playerId: PLAYER_ID,
    ticketId: TICKET_ID,
    prizeId: PRIZE_ID,
    submittedAt: '2024-01-01T00:00:00.000Z',
    validationStatus: hostDecision === 'REJECTED' ? 'INVALID' : 'VALID',
    hostDecision,
    prizeLabel: 'Cyber Five',
    playerName: 'Alex',
    ticketRef: 'Ticket #TEST',
  }
}

/**
 * Claim-history generator producing a controlled distribution of prior
 * claims for the fixed (PLAYER_ID, PRIZE_ID) pair, precisely exercising the
 * resubmission-budget gate (Req 4.3, 4.4):
 *  - 'none'       - no prior claims
 *  - 'pending'    - one PENDING prior claim (blocks via DUPLICATE_ACTIVE_CLAIM)
 *  - 'confirmed'  - one CONFIRMED prior claim (blocks via DUPLICATE_ACTIVE_CLAIM)
 *  - 'rejected0'  - zero REJECTED prior claims (same as 'none', kept distinct for clarity)
 *  - 'rejected1'  - one REJECTED prior claim (one resubmission still allowed)
 *  - 'rejected2+' - two or more REJECTED prior claims (resubmission budget exhausted)
 */
type HistoryKind = 'none' | 'pending' | 'confirmed' | 'rejected1' | 'rejected2+'

const historyKindArb = fc.constantFrom<HistoryKind>(
  'none',
  'pending',
  'confirmed',
  'rejected1',
  'rejected2+',
)

function buildHistory(kind: HistoryKind): PrizeClaim[] {
  switch (kind) {
    case 'none':
      return []
    case 'pending':
      return [makePriorClaim('prior-1', 'PENDING')]
    case 'confirmed':
      return [makePriorClaim('prior-1', 'CONFIRMED')]
    case 'rejected1':
      return [makePriorClaim('prior-1', 'REJECTED')]
    case 'rejected2+':
      return [
        makePriorClaim('prior-1', 'REJECTED'),
        makePriorClaim('prior-2', 'REJECTED'),
      ]
  }
}

/** The scenario variants exercising the gates that precede the claim-history gates. */
type Scenario =
  | 'GAME_NOT_FOUND'
  | 'PLAYER_NOT_FOUND'
  | 'PLAYER_NOT_IN_GAME'
  | 'TICKET_NOT_FOUND'
  | 'TICKET_NOT_OWNED_BY_PLAYER'
  | 'PRIZE_NOT_FOUND'
  | 'VALID_SHAPE'

const scenarioArb = fc.constantFrom<Scenario>(
  'GAME_NOT_FOUND',
  'PLAYER_NOT_FOUND',
  'PLAYER_NOT_IN_GAME',
  'TICKET_NOT_FOUND',
  'TICKET_NOT_OWNED_BY_PLAYER',
  'PRIZE_NOT_FOUND',
  'VALID_SHAPE',
)

describe('Property 1: The claim validation pipeline accepts iff every condition holds, and identifies the first failing reason otherwise', () => {
  // Feature: module-5-prize-claim-processing-winner-management, Property 1: The claim validation pipeline accepts iff every condition holds, and identifies the first failing reason otherwise
  it('accepts exactly when every gate passes, and otherwise reports the first failing gate', () => {
    const ticket = makeTicket()

    fc.assert(
      fc.property(
        scenarioArb,
        historyKindArb,
        markedSubsetArb(ticket),
        fc.boolean(), // whether the prize is closed by a winner for someone else
        (scenario, historyKind, markedTermIds, prizeClosedByOther) => {
          const game = makeGame()
          const player = makePlayer()
          const marks = marksFor(ticket, markedTermIds)
          const existingClaims = buildHistory(historyKind)
          const winners = prizeClosedByOther ? [makeWinner()] : []

          let input: {
            game?: Game
            player?: Player
            ticket?: Ticket
            marks: readonly Mark[]
            prizeId: PrizeId
            winners: readonly Winner[]
            existingClaims: readonly PrizeClaim[]
          } = {
            game,
            player,
            ticket,
            marks,
            prizeId: PRIZE_ID,
            winners,
            existingClaims,
          }

          switch (scenario) {
            case 'GAME_NOT_FOUND':
              input = { ...input, game: undefined }
              break
            case 'PLAYER_NOT_FOUND':
              input = { ...input, player: undefined }
              break
            case 'PLAYER_NOT_IN_GAME':
              input = { ...input, player: makePlayer({ gameId: 'other-game' }) }
              break
            case 'TICKET_NOT_FOUND':
              input = { ...input, ticket: undefined }
              break
            case 'TICKET_NOT_OWNED_BY_PLAYER':
              input = {
                ...input,
                ticket: { ...ticket, id: 'someone-elses-ticket' },
              }
              break
            case 'PRIZE_NOT_FOUND':
              input = { ...input, prizeId: 'NOT_A_REAL_PRIZE' as PrizeId }
              break
            case 'VALID_SHAPE':
              break
          }

          const result = validatePrizeClaim(input)

          // Independently recompute each gate's expected outcome, in the
          // documented order, to determine the expected result.
          if (scenario === 'GAME_NOT_FOUND') {
            expect(result).toEqual({ valid: false, reason: 'GAME_NOT_FOUND' })
            return
          }
          if (scenario === 'PLAYER_NOT_FOUND') {
            expect(result).toEqual({ valid: false, reason: 'PLAYER_NOT_FOUND' })
            return
          }
          if (scenario === 'PLAYER_NOT_IN_GAME') {
            expect(result).toEqual({ valid: false, reason: 'PLAYER_NOT_IN_GAME' })
            return
          }
          if (scenario === 'TICKET_NOT_FOUND') {
            expect(result).toEqual({ valid: false, reason: 'TICKET_NOT_FOUND' })
            return
          }
          if (scenario === 'TICKET_NOT_OWNED_BY_PLAYER') {
            expect(result).toEqual({
              valid: false,
              reason: 'TICKET_NOT_OWNED_BY_PLAYER',
            })
            return
          }
          if (scenario === 'PRIZE_NOT_FOUND') {
            expect(result).toEqual({ valid: false, reason: 'PRIZE_NOT_FOUND' })
            return
          }

          // VALID_SHAPE: game/player/ticket/prizeId all well-formed and
          // consistent with each other. Now the claim-history and
          // eligibility gates decide the outcome, in order.
          const hasActiveOrWon = historyKind === 'pending' || historyKind === 'confirmed'
          if (hasActiveOrWon) {
            expect(result).toEqual({
              valid: false,
              reason: 'DUPLICATE_ACTIVE_CLAIM',
            })
            return
          }

          if (historyKind === 'rejected2+') {
            expect(result).toEqual({
              valid: false,
              reason: 'RESUBMISSION_LIMIT_REACHED',
            })
            return
          }

          if (prizeClosedByOther) {
            expect(result).toEqual({ valid: false, reason: 'PRIZE_CLOSED' })
            return
          }

          const validMarks = getPlayerTicketMarks(marks, PLAYER_ID, TICKET_ID)
          const progress = getAllPrizeProgress(ticket, validMarks).find(
            (p) => p.id === PRIZE_ID,
          )!
          const eligible = isPrizeEligible(progress)

          if (!eligible) {
            expect(result).toEqual({ valid: false, reason: 'NOT_ELIGIBLE' })
          } else {
            expect(result).toEqual({ valid: true })
          }
        },
      ),
      { numRuns: RUNS },
    )
  })

  // Feature: module-5-prize-claim-processing-winner-management, Property 1: The claim validation pipeline accepts iff every condition holds, and identifies the first failing reason otherwise
  it('never returns valid:true while any single gate condition is violated', () => {
    const ticket = makeTicket()
    const fullMarks = marksFor(ticket, ticketTermIds(ticket))

    fc.assert(
      fc.property(scenarioArb, historyKindArb, fc.boolean(), (scenario, historyKind, prizeClosedByOther) => {
        // Skip the one combination where every gate is satisfied — that's
        // covered as the accept case by the other test.
        fc.pre(
          !(
            scenario === 'VALID_SHAPE' &&
            historyKind !== 'pending' &&
            historyKind !== 'confirmed' &&
            historyKind !== 'rejected2+' &&
            !prizeClosedByOther
          ),
        )

        const game = makeGame()
        const player = makePlayer()
        const existingClaims = buildHistory(historyKind)
        const winners = prizeClosedByOther ? [makeWinner()] : []

        let input: {
          game?: Game
          player?: Player
          ticket?: Ticket
          marks: readonly Mark[]
          prizeId: PrizeId
          winners: readonly Winner[]
          existingClaims: readonly PrizeClaim[]
        } = {
          game,
          player,
          ticket,
          marks: fullMarks, // fully eligible, so only the targeted gate can fail
          prizeId: PRIZE_ID,
          winners,
          existingClaims,
        }

        switch (scenario) {
          case 'GAME_NOT_FOUND':
            input = { ...input, game: undefined }
            break
          case 'PLAYER_NOT_FOUND':
            input = { ...input, player: undefined }
            break
          case 'PLAYER_NOT_IN_GAME':
            input = { ...input, player: makePlayer({ gameId: 'other-game' }) }
            break
          case 'TICKET_NOT_FOUND':
            input = { ...input, ticket: undefined }
            break
          case 'TICKET_NOT_OWNED_BY_PLAYER':
            input = { ...input, ticket: { ...ticket, id: 'someone-elses-ticket' } }
            break
          case 'PRIZE_NOT_FOUND':
            input = { ...input, prizeId: 'NOT_A_REAL_PRIZE' as PrizeId }
            break
          case 'VALID_SHAPE':
            break
        }

        const result = validatePrizeClaim(input)
        expect(result.valid).toBe(false)
      }),
      { numRuns: RUNS },
    )
  })

  // Feature: module-5-prize-claim-processing-winner-management, Property 1: The claim validation pipeline accepts iff every condition holds, and identifies the first failing reason otherwise
  it('never mutates its inputs', () => {
    const ticket = makeTicket()

    fc.assert(
      fc.property(
        historyKindArb,
        markedSubsetArb(ticket),
        fc.boolean(),
        (historyKind, markedTermIds, prizeClosedByOther) => {
          const game = makeGame()
          const player = makePlayer()
          const marks = marksFor(ticket, markedTermIds)
          const existingClaims = buildHistory(historyKind)
          const winners = prizeClosedByOther ? [makeWinner()] : []

          const gameBefore = structuredClone(game)
          const playerBefore = structuredClone(player)
          const ticketBefore = structuredClone(ticket)
          const marksBefore = structuredClone(marks)
          const winnersBefore = structuredClone(winners)
          const claimsBefore = structuredClone(existingClaims)

          validatePrizeClaim({
            game,
            player,
            ticket,
            marks,
            prizeId: PRIZE_ID,
            winners,
            existingClaims,
          })

          expect(game).toEqual(gameBefore)
          expect(player).toEqual(playerBefore)
          expect(ticket).toEqual(ticketBefore)
          expect(marks).toEqual(marksBefore)
          expect(winners).toEqual(winnersBefore)
          expect(existingClaims).toEqual(claimsBefore)
        },
      ),
      { numRuns: RUNS },
    )
  })
})
