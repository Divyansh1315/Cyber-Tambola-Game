// Feature: module-5-prize-claim-processing-winner-management, Property 12: Presentation winner announcements show only the prize label and player name
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { toAnnouncementViewModel } from './PresentationView'
import type { PrizeId, Winner } from '../../types/prize'

const prizeIdArb: fc.Arbitrary<PrizeId> = fc.constantFrom(
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
)

// Winner generator including realistic display fields plus extra
// noise/technical fields (gameId/ticketId/claimId/playerId/prizeId/
// confirmedAt) that must never leak into the announcement view-model.
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
  ticketRef: fc.string({ minLength: 1, maxLength: 20 }),
})

describe('toAnnouncementViewModel (property 12)', () => {
  it('exposes exactly {prizeLabel, playerName} for any Winner, never any other field', () => {
    fc.assert(
      fc.property(winnerArb, (winner) => {
        const viewModel = toAnnouncementViewModel(winner)

        expect(Object.keys(viewModel).sort()).toEqual(['playerName', 'prizeLabel'])
        expect(viewModel.prizeLabel).toBe(winner.prizeLabel)
        expect(viewModel.playerName).toBe(winner.playerName)

        // Never leaks technical/identifying fields.
        expect(viewModel).not.toHaveProperty('id')
        expect(viewModel).not.toHaveProperty('gameId')
        expect(viewModel).not.toHaveProperty('prizeId')
        expect(viewModel).not.toHaveProperty('playerId')
        expect(viewModel).not.toHaveProperty('ticketId')
        expect(viewModel).not.toHaveProperty('claimId')
        expect(viewModel).not.toHaveProperty('confirmedAt')
      }),
      { numRuns: 100 },
    )
  })

  it('does not mutate the input Winner', () => {
    fc.assert(
      fc.property(winnerArb, (winner) => {
        const snapshot = JSON.stringify(winner)
        Object.freeze(winner)
        toAnnouncementViewModel(winner)
        expect(JSON.stringify(winner)).toBe(snapshot)
      }),
      { numRuns: 100 },
    )
  })
})
