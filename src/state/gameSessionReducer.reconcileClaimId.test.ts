// Spec: claim-duplicate-submission — task 9 (unit tests for the
// RECONCILE_CLAIM_ID reducer case).
//
// Validates: Requirements 2.1, 2.2, 2.3
import { describe, it, expect } from 'vitest'
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState, type GameSessionState } from './gameSessionInitialState'
import type { PrizeClaim } from '../types/claim'

function buildClaim(overrides: Partial<PrizeClaim> = {}): PrizeClaim {
  return {
    id: 'claim-1',
    gameId: 'GAME_001',
    playerId: 'P_1',
    ticketId: 'T_1',
    prizeId: 'CYBER_FIVE',
    submittedAt: '2026-01-01T00:00:00.000Z',
    validationStatus: 'VALID',
    hostDecision: 'PENDING',
    prizeLabel: 'Cyber Five',
    playerName: 'Divyansh',
    ticketRef: '6405',
    ...overrides,
  }
}

function stateWithClaims(claims: PrizeClaim[]): GameSessionState {
  return { ...gameSessionInitialState, claims }
}

describe('gameSessionReducer: RECONCILE_CLAIM_ID', () => {
  it('replaces the matching optimistic entry in place at the same array index', () => {
    const optimistic = buildClaim({ id: 'local-abc', ticketRef: '6405' })
    const other1 = buildClaim({ id: 'claim-other-1', prizeId: 'FIREWALL_LINE' })
    const other2 = buildClaim({ id: 'claim-other-2', prizeId: 'SECURITY_LINE' })
    const state = stateWithClaims([other1, optimistic, other2])

    const confirmedClaim = buildClaim({ id: 'SERVER_CLAIM_1', ticketRef: '6405' })

    const next = gameSessionReducer(state, {
      type: 'RECONCILE_CLAIM_ID',
      optimisticId: 'local-abc',
      confirmedClaim,
    })

    // Same array length, same index for the reconciled entry.
    expect(next.claims).toHaveLength(3)
    expect(next.claims[1]).toBe(confirmedClaim)
    expect(next.claims[1].id).toBe('SERVER_CLAIM_1')

    // Every other entry preserved, same reference, same index.
    expect(next.claims[0]).toBe(other1)
    expect(next.claims[2]).toBe(other2)
  })

  it('is a no-op (unchanged state) when optimisticId is absent from state.claims', () => {
    const other1 = buildClaim({ id: 'claim-other-1' })
    const other2 = buildClaim({ id: 'claim-other-2', prizeId: 'FIREWALL_LINE' })
    const state = stateWithClaims([other1, other2])

    const confirmedClaim = buildClaim({ id: 'SERVER_CLAIM_X' })

    const next = gameSessionReducer(state, {
      type: 'RECONCILE_CLAIM_ID',
      optimisticId: 'never-dispatched-id',
      confirmedClaim,
    })

    // Exact same state reference returned — the documented "ignore if
    // absent" convention (RESTORE_PLAYER, CLEAR_STALE_PLAYER).
    expect(next).toBe(state)
    expect(next.claims).toBe(state.claims)
    expect(next.claims).toHaveLength(2)
  })

  it('drops the optimistic entry without duplicating when an echo for the confirmed id already exists', () => {
    // Simulates the echo-arrives-before-RPC-resolves ordering: a realtime
    // echo for this submission's server row has already been folded in by
    // SYNC_REMOTE/upsertById (appended as its own entry, since nothing yet
    // shared its id), while the original optimistic entry is still present
    // too. Dispatching RECONCILE_CLAIM_ID must result in exactly one
    // surviving entry -- the pre-existing echoed one -- not a duplicate.
    const optimistic = buildClaim({ id: 'local-echo-race', ticketRef: '6405' })
    const alreadyEchoed = buildClaim({ id: 'SERVER_CLAIM_RACE', ticketRef: '6405' })
    const other = buildClaim({ id: 'claim-other-1', prizeId: 'FIREWALL_LINE' })
    const state = stateWithClaims([other, alreadyEchoed, optimistic])

    const confirmedClaim = buildClaim({ id: 'SERVER_CLAIM_RACE', ticketRef: '6405' })

    const next = gameSessionReducer(state, {
      type: 'RECONCILE_CLAIM_ID',
      optimisticId: 'local-echo-race',
      confirmedClaim,
    })

    // Exactly one entry survives for this claim id -- the optimistic entry
    // was removed, not overwritten into a second copy.
    const matching = next.claims.filter((c) => c.id === 'SERVER_CLAIM_RACE')
    expect(matching).toHaveLength(1)
    expect(matching[0]).toBe(alreadyEchoed)

    // The pre-existing echoed entry is untouched (same reference), and
    // stays at its original array position; only the optimistic entry is
    // removed.
    expect(next.claims).toHaveLength(2)
    expect(next.claims[0]).toBe(other)
    expect(next.claims[1]).toBe(alreadyEchoed)
    expect(next.claims.some((c) => c.id === 'local-echo-race')).toBe(false)
  })

  it('does not mutate the original claims array', () => {
    const optimistic = buildClaim({ id: 'local-xyz' })
    const state = stateWithClaims([optimistic])
    const originalClaimsRef = state.claims
    const confirmedClaim = buildClaim({ id: 'SERVER_CLAIM_2' })

    const next = gameSessionReducer(state, {
      type: 'RECONCILE_CLAIM_ID',
      optimisticId: 'local-xyz',
      confirmedClaim,
    })

    expect(state.claims).toBe(originalClaimsRef)
    expect(state.claims[0].id).toBe('local-xyz')
    expect(next.claims).not.toBe(originalClaimsRef)
  })
})
