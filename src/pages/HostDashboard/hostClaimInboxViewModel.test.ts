// Feature: module-5-prize-claim-processing-winner-management, Property 11: Host claim inbox rows show only the fields the host needs
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { toClaimInboxRowViewModel } from './HostDashboard'
import type { HostDecision, PrizeClaim, ValidationStatus } from '../../types/claim'
import type { PrizeId } from '../../types/prize'

const RUNS = 100

const prizeIdArb: fc.Arbitrary<PrizeId> = fc.constantFrom(
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
)

const validationStatusArb: fc.Arbitrary<ValidationStatus> = fc.constantFrom(
  'PENDING',
  'VALID',
  'INVALID',
)

const hostDecisionArb: fc.Arbitrary<HostDecision> = fc.constantFrom(
  'PENDING',
  'CONFIRMED',
  'REJECTED',
)

// Claim generator including realistic display fields plus the identifying/
// technical fields (id/gameId/playerId/ticketId/prizeId/decidedAt) that must
// never leak into the inbox row view-model.
const claimArb: fc.Arbitrary<PrizeClaim> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: fc.string({ minLength: 1, maxLength: 10 }),
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  prizeId: prizeIdArb,
  submittedAt: fc.constant('2026-01-01T09:05:00.000Z'),
  validationStatus: validationStatusArb,
  hostDecision: hostDecisionArb,
  rejectionReason: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
  decidedAt: fc.option(fc.constant('2026-01-01T10:00:00.000Z'), { nil: undefined }),
  prizeLabel: fc.constantFrom(
    'Cyber Five',
    'Firewall Line',
    'Security Line',
    'Data Defender Line',
    'Cyber Full House',
  ),
  playerName: fc.string({ minLength: 1, maxLength: 20 }),
  ticketRef: fc.string({ minLength: 1, maxLength: 15 }),
})

const NEEDED_KEYS = [
  'hostDecision',
  'playerName',
  'prizeLabel',
  'rejectionReason',
  'submittedAt',
  'ticketRef',
  'validationStatus',
]

describe('toClaimInboxRowViewModel (property 11)', () => {
  it('contains exactly the fields the host needs and never any identifying/technical field', () => {
    fc.assert(
      fc.property(claimArb, (claim) => {
        const row = toClaimInboxRowViewModel(claim)

        // Only display-safe keys are present (rejectionReason may be
        // undefined but is always an own-listable key of the object shape
        // we intentionally construct it with).
        const presentKeys = Object.keys(row).sort()
        for (const key of presentKeys) {
          expect(NEEDED_KEYS).toContain(key)
        }

        expect(row.playerName).toBe(claim.playerName)
        expect(row.ticketRef).toBe(claim.ticketRef)
        expect(row.prizeLabel).toBe(claim.prizeLabel)
        expect(row.submittedAt).toBe(claim.submittedAt)
        expect(row.validationStatus).toBe(claim.validationStatus)
        expect(row.hostDecision).toBe(claim.hostDecision)
        expect(row.rejectionReason).toBe(claim.rejectionReason)

        // Never leaks technical/identifying fields.
        expect(row).not.toHaveProperty('id')
        expect(row).not.toHaveProperty('gameId')
        expect(row).not.toHaveProperty('playerId')
        expect(row).not.toHaveProperty('ticketId')
        expect(row).not.toHaveProperty('prizeId')
        expect(row).not.toHaveProperty('decidedAt')
      }),
      { numRuns: RUNS },
    )
  })

  it('does not mutate the input PrizeClaim', () => {
    fc.assert(
      fc.property(claimArb, (claim) => {
        const snapshot = JSON.stringify(claim)
        Object.freeze(claim)
        toClaimInboxRowViewModel(claim)
        expect(JSON.stringify(claim)).toBe(snapshot)
      }),
      { numRuns: RUNS },
    )
  })
})
