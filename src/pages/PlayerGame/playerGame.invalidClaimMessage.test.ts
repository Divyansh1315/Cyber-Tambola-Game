import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { PRIZES } from '../../utils/prizeEngine'
import { claimStatusView } from './PlayerGame'
import type { PrizeClaim, PrizeProgress } from '../../types/prize'

const RUNS = 100

function makeClaim(overrides: Partial<PrizeClaim> = {}): PrizeClaim {
  return {
    id: 'claim-1',
    gameId: 'game-1',
    playerId: 'player-1',
    ticketId: 'ticket-1',
    prizeId: 'CYBER_FIVE',
    submittedAt: '2024-01-01T00:00:00.000Z',
    validationStatus: 'INVALID',
    hostDecision: 'PENDING',
    prizeLabel: 'Cyber Five',
    playerName: 'Player One',
    ticketRef: 'Ticket #TEST',
    ...overrides,
  }
}

// Generator: pick a real prize (fixing its target to the real value: 5 or
// 15) and a `current` ranging 0..target, producing a realistic PrizeProgress.
const invalidClaimProgressArb = fc
  .constantFrom(...PRIZES)
  .chain((prize) =>
    fc.integer({ min: 0, max: prize.target }).map((current) => ({
      progress: {
        id: prize.id,
        label: prize.label,
        current,
        target: prize.target,
      } as PrizeProgress,
    })),
  )

describe('PlayerGame.claimStatusView — INVALID claim progress message', () => {
  // Feature: module-5-prize-claim-processing-winner-management, Property 14: An INVALID claim's player-facing message names current progress
  it("property 14: an INVALID own claim's message names the exact current progress", () => {
    fc.assert(
      fc.property(
        invalidClaimProgressArb,
        fc.constantFrom<'ELIGIBLE' | 'NOT_ELIGIBLE' | 'PENDING'>(
          'ELIGIBLE',
          'NOT_ELIGIBLE',
          'PENDING',
        ),
        fc.constantFrom<'PENDING' | 'CONFIRMED' | 'REJECTED'>(
          'PENDING',
          'CONFIRMED',
          'REJECTED',
        ),
        ({ progress }, status, hostDecision) => {
          const ownLatestClaim = makeClaim({
            prizeId: progress.id,
            validationStatus: 'INVALID',
            hostDecision,
          })

          const view = claimStatusView({
            status,
            progress,
            ownLatestClaim,
            isOwnClaimInvalid: true,
          })

          expect(view.message).toBe(
            `Claim could not be validated. Your current progress is ${progress.current}/${progress.target}.`,
          )
        },
      ),
      { numRuns: RUNS },
    )
  })

  it('example: Cyber Five progress 4/5 renders the exact documented message', () => {
    const progress: PrizeProgress = {
      id: 'CYBER_FIVE',
      label: 'Cyber Five',
      current: 4,
      target: 5,
    }
    const ownLatestClaim = makeClaim({
      prizeId: 'CYBER_FIVE',
      validationStatus: 'INVALID',
      hostDecision: 'PENDING',
    })

    const view = claimStatusView({
      status: 'NOT_ELIGIBLE',
      progress,
      ownLatestClaim,
      isOwnClaimInvalid: true,
    })

    expect(view.message).toBe('Claim could not be validated. Your current progress is 4/5.')
  })
})
