import { describe, expect, it } from 'vitest'
import type { HostDecision, PrizeClaim, ValidationStatus } from './claim'
import type { Winner } from './prize'

/**
 * Task 1.3: asserts the Requirement 1.1/1.4-extended `PrizeClaim` and
 * `Winner` shapes compile with every field present, and that a literal of
 * each type round-trips through a plain object equality check (both a JSON
 * round-trip and a spread-copy round-trip).
 *
 * _Requirements: 1.1, 1.4_
 */
describe('PrizeClaim and Winner extended type shapes', () => {
  it('constructs a fully-populated PrizeClaim literal with every Requirement 1.1 field and round-trips it', () => {
    const validationStatus: ValidationStatus = 'INVALID'
    const hostDecision: HostDecision = 'REJECTED'

    const claim: PrizeClaim = {
      id: 'claim-1',
      gameId: 'game-1',
      playerId: 'player-1',
      ticketId: 'ticket-1',
      prizeId: 'CYBER_FIVE',
      submittedAt: '2024-01-01T00:00:00.000Z',
      validationStatus,
      hostDecision,
      rejectionReason: 'NOT_ELIGIBLE',
      decidedAt: '2024-01-01T00:05:00.000Z',
      prizeLabel: 'Cyber Five',
      playerName: 'Divyansh Singh',
      ticketRef: 'T-001',
    }

    // Round-trip through a plain object spread copy.
    const spreadCopy: PrizeClaim = { ...claim }
    expect(spreadCopy).toEqual(claim)

    // Round-trip through JSON serialization.
    const jsonCopy: PrizeClaim = JSON.parse(JSON.stringify(claim))
    expect(jsonCopy).toEqual(claim)
  })

  it('constructs a minimal PrizeClaim literal omitting the optional Requirement 1.1 fields and round-trips it', () => {
    const claim: PrizeClaim = {
      id: 'claim-2',
      gameId: 'game-1',
      playerId: 'player-2',
      ticketId: 'ticket-2',
      prizeId: 'CYBER_FULL_HOUSE',
      submittedAt: '2024-01-01T00:00:00.000Z',
      validationStatus: 'VALID',
      hostDecision: 'PENDING',
      prizeLabel: 'Cyber Full House',
      playerName: 'Asha Rao',
      ticketRef: 'T-002',
    }

    expect(claim.rejectionReason).toBeUndefined()
    expect(claim.decidedAt).toBeUndefined()

    const spreadCopy: PrizeClaim = { ...claim }
    expect(spreadCopy).toEqual(claim)
  })

  it('constructs a fully-populated Winner literal with every Requirement 1.4 field and round-trips it', () => {
    const winner: Winner = {
      id: 'winner-1',
      gameId: 'game-1',
      prizeId: 'FIREWALL_LINE',
      playerId: 'player-3',
      ticketId: 'ticket-3',
      claimId: 'claim-3',
      confirmedAt: '2024-01-01T00:10:00.000Z',
      prizeLabel: 'Firewall Line',
      playerName: 'Meera Iyer',
      ticketRef: 'T-003',
    }

    // Round-trip through a plain object spread copy.
    const spreadCopy: Winner = { ...winner }
    expect(spreadCopy).toEqual(winner)

    // Round-trip through JSON serialization.
    const jsonCopy: Winner = JSON.parse(JSON.stringify(winner))
    expect(jsonCopy).toEqual(winner)
  })
})
