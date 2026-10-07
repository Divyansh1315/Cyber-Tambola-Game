// Feature: presenter-realtime-winner-sync, Property 1: Final Winner Summary includes all five fixed prize categories and only confirmed winners of the active game
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { buildFinalWinnerSummary } from './PresentationView'
import { PRIZES } from '../../utils/prizeEngine'
import type { PrizeId, Winner } from '../../types/prize'

const prizeIdArb: fc.Arbitrary<PrizeId> = fc.constantFrom(
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
)

function makeWinner(overrides: Partial<Winner>): Winner {
  return {
    id: 'WINNER_1',
    gameId: 'GAME_001',
    prizeId: 'CYBER_FIVE',
    playerId: 'PLAYER_1',
    ticketId: 'TICKET_1',
    claimId: 'CLAIM_1',
    confirmedAt: '2026-01-01T09:05:00.000Z',
    prizeLabel: 'Cyber Five',
    playerName: 'Alex',
    ticketRef: 'Ticket #021',
    ...overrides,
  }
}

// Winner generator including an explicit gameId axis (same-game vs other-game)
// plus the usual noise fields, following this codebase's established pattern
// (presentationWinnerViewModel.test.ts / hostWinnerHistoryViewModel.fields.test.ts).
function winnerArbForGame(gameId: string): fc.Arbitrary<Winner> {
  return fc.record({
    id: fc.string({ minLength: 1, maxLength: 10 }),
    gameId: fc.constant(gameId),
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
}

const ACTIVE_GAME_ID = 'GAME_ACTIVE'
const OTHER_GAME_ID = 'GAME_OTHER'

describe('buildFinalWinnerSummary', () => {
  it('all-5-present: returns all five categories, each with its matching confirmed winner', () => {
    const winners = PRIZES.map((prize) =>
      makeWinner({
        id: `WINNER_${prize.id}`,
        gameId: ACTIVE_GAME_ID,
        prizeId: prize.id,
        prizeLabel: prize.label,
        playerName: `Player_${prize.id}`,
        ticketRef: `Ticket #${prize.id}`,
      }),
    )

    const summary = buildFinalWinnerSummary(winners, ACTIVE_GAME_ID)

    expect(summary).toHaveLength(5)
    expect(summary.map((e) => e.prizeId)).toEqual(PRIZES.map((p) => p.id))
    for (const prize of PRIZES) {
      const entry = summary.find((e) => e.prizeId === prize.id)
      expect(entry?.winnerName).toBe(`Player_${prize.id}`)
      expect(entry?.ticketRef).toBe(`Ticket #${prize.id}`)
      expect(entry?.prizeLabel).toBe(prize.label)
    }
  })

  it('some-missing: categories with no winner render winnerName/ticketRef as undefined, never falling back to claim data', () => {
    const winners = [
      makeWinner({ gameId: ACTIVE_GAME_ID, prizeId: 'CYBER_FIVE', playerName: 'Alex', ticketRef: 'Ticket #001' }),
    ]

    const summary = buildFinalWinnerSummary(winners, ACTIVE_GAME_ID)

    expect(summary).toHaveLength(5)
    const cyberFive = summary.find((e) => e.prizeId === 'CYBER_FIVE')
    expect(cyberFive?.winnerName).toBe('Alex')
    expect(cyberFive?.ticketRef).toBe('Ticket #001')

    const others = summary.filter((e) => e.prizeId !== 'CYBER_FIVE')
    expect(others).toHaveLength(4)
    for (const entry of others) {
      expect(entry.winnerName).toBeUndefined()
      expect(entry.ticketRef).toBeUndefined()
    }
  })

  it('cross-game-exclusion: winners belonging to a different gameId are excluded from the per-category match', () => {
    const winners = [
      makeWinner({ gameId: OTHER_GAME_ID, prizeId: 'CYBER_FIVE', playerName: 'Someone Else', ticketRef: 'Ticket #999' }),
    ]

    const summary = buildFinalWinnerSummary(winners, ACTIVE_GAME_ID)

    const cyberFive = summary.find((e) => e.prizeId === 'CYBER_FIVE')
    expect(cyberFive?.winnerName).toBeUndefined()
    expect(cyberFive?.ticketRef).toBeUndefined()
  })

  it('zero winners: returns all five categories with no winner', () => {
    const summary = buildFinalWinnerSummary([], ACTIVE_GAME_ID)

    expect(summary).toHaveLength(5)
    for (const entry of summary) {
      expect(entry.winnerName).toBeUndefined()
      expect(entry.ticketRef).toBeUndefined()
    }
  })

  it('property: for any random Winner[] (including other-game winners), output always has exactly 5 entries in PRIZES order', () => {
    fc.assert(
      fc.property(
        fc.array(winnerArbForGame(ACTIVE_GAME_ID), { maxLength: 10 }),
        fc.array(winnerArbForGame(OTHER_GAME_ID), { maxLength: 10 }),
        (sameGameWinners, otherGameWinners) => {
          const allWinners = [...sameGameWinners, ...otherGameWinners]
          const summary = buildFinalWinnerSummary(allWinners, ACTIVE_GAME_ID)

          expect(summary).toHaveLength(5)
          expect(summary.map((e) => e.prizeId)).toEqual(PRIZES.map((p) => p.id))

          for (const entry of summary) {
            // Every winnerName, when present, must come from a same-game
            // winner for that exact category -- never from an other-game winner.
            if (entry.winnerName !== undefined) {
              const matchingSameGame = sameGameWinners.find(
                (w) => w.prizeId === entry.prizeId && w.playerName === entry.winnerName,
              )
              expect(matchingSameGame).toBeDefined()

              const leakedFromOtherGame = otherGameWinners.some(
                (w) =>
                  w.prizeId === entry.prizeId &&
                  w.playerName === entry.winnerName &&
                  !sameGameWinners.some((sw) => sw.prizeId === w.prizeId && sw.playerName === w.playerName),
              )
              expect(leakedFromOtherGame).toBe(false)
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
