// Spec: claim-duplicate-submission — task 9 (unit + property-based tests
// for the Host Claim Inbox dedup-by-id rendering safeguard).
//
// Property 4: Preservation - Host Claim Inbox Dedup Is a Pure Rendering
// Safeguard (design.md Correctness Properties).
//
// Validates: Requirements 2.5, 3.9
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { dedupeClaimsById } from './HostDashboard'
import type { PrizeClaim } from '../../types/claim'
import type { PrizeId } from '../../types/prize'

function buildClaim(id: string, overrides: Partial<PrizeClaim> = {}): PrizeClaim {
  return {
    id,
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

describe('dedupeClaimsById: unit cases', () => {
  it('removes true duplicates, keeping the first occurrence', () => {
    const first = buildClaim('dup-1', { playerName: 'Divyansh' })
    const second = buildClaim('dup-1', { playerName: 'StaleEcho' })
    const unique = buildClaim('unique-1', { playerName: 'Rohan' })

    const result = dedupeClaimsById([first, second, unique])

    expect(result).toHaveLength(2)
    expect(result[0]).toBe(first)
    expect(result[0].playerName).toBe('Divyansh')
    expect(result[1]).toBe(unique)
  })

  it('preserves order and content of everything else', () => {
    const a = buildClaim('a')
    const b = buildClaim('b')
    const c = buildClaim('c')
    const bDupe = buildClaim('b')

    const result = dedupeClaimsById([a, b, c, bDupe])

    expect(result).toEqual([a, b, c])
    expect(result[0]).toBe(a)
    expect(result[1]).toBe(b)
    expect(result[2]).toBe(c)
  })

  it('is a no-op on an already-duplicate-free list', () => {
    const claims = [buildClaim('x'), buildClaim('y'), buildClaim('z')]

    const result = dedupeClaimsById(claims)

    expect(result).toEqual(claims)
    expect(result).toHaveLength(3)
  })

  it('returns [] for an empty list', () => {
    expect(dedupeClaimsById([])).toEqual([])
  })
})

const prizeIdArb = fc.constantFrom<PrizeId>(
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
)

/** A small closed id pool so duplicates occur naturally across generated arrays. */
const idPoolArb = fc.constantFrom('id-1', 'id-2', 'id-3', 'id-4', 'id-5')

const claimArb = fc.record({
  id: idPoolArb,
  prizeId: prizeIdArb,
  playerName: fc.constantFrom('Divyansh', 'Rohan', 'Kavya'),
})

describe('dedupeClaimsById: Property 4 (PBT)', () => {
  it('output length never exceeds input length, every output id is unique, and relative order of first-occurrences is preserved', () => {
    fc.assert(
      fc.property(fc.array(claimArb, { maxLength: 20 }), (specs) => {
        const claims = specs.map((spec, i) => buildClaim(spec.id, {
          prizeId: spec.prizeId,
          playerName: spec.playerName,
          submittedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        }))

        const result = dedupeClaimsById(claims)

        // Output length never exceeds input length.
        expect(result.length).toBeLessThanOrEqual(claims.length)

        // Every output id is unique.
        const resultIds = result.map((c) => c.id)
        expect(new Set(resultIds).size).toBe(resultIds.length)

        // Relative order of first-occurrences is preserved: the sequence of
        // ids in the output must equal the sequence of first-occurrence ids
        // from the input, in the same relative order.
        const expectedFirstOccurrenceIds: string[] = []
        const seen = new Set<string>()
        for (const claim of claims) {
          if (!seen.has(claim.id)) {
            seen.add(claim.id)
            expectedFirstOccurrenceIds.push(claim.id)
          }
        }
        expect(resultIds).toEqual(expectedFirstOccurrenceIds)

        // Content of each surviving entry matches its first occurrence,
        // not a later duplicate.
        for (const claim of result) {
          const firstMatch = claims.find((c) => c.id === claim.id)
          expect(claim).toBe(firstMatch)
        }
      }),
    )
  })

  it('is a no-op when the generated list already has no duplicate ids', () => {
    fc.assert(
      fc.property(fc.uniqueArray(idPoolArb, { maxLength: 5 }), (ids) => {
        const claims = ids.map((id) => buildClaim(id))
        const result = dedupeClaimsById(claims)
        expect(result).toEqual(claims)
        expect(result).toHaveLength(claims.length)
      }),
    )
  })
})
