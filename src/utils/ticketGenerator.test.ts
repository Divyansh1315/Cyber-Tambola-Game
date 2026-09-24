import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import type { CyberTerm } from '../types/cyberTerm'
import type { Ticket } from '../types/ticket'
import {
  computeSignature,
  generateTicket,
  getActiveTerms,
  TICKET_COLS,
  TICKET_ROWS,
  TICKET_SIZE,
  type TicketGenOptions,
} from './ticketGenerator'

const RUNS = 100

// A deterministic, seeded RNG in [0,1) built from fast-check's provided seed.
// Mulberry32 — small, fast, good enough for shuffle determinism in tests.
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeTerm(index: number, active: CyberTerm['active'] | undefined): CyberTerm {
  const term: Partial<CyberTerm> = {
    id: `TERM_${String(index).padStart(3, '0')}`,
    term: `Term ${index}`,
    category: 'Threats',
    definition: `clue ${index}`,
    awarenessTip: `msg ${index}`,
    difficulty: 'easy',
  }
  // Only assign active when defined so we also exercise the "absent" case.
  if (active !== undefined) {
    ;(term as CyberTerm).active = active as boolean
  }
  return term as CyberTerm
}

// A term-bank arbitrary mixing active: true / false / undefined / null,
// guaranteeing at least `minActive` strictly-true entries.
function termBankArb(minActive: number, maxExtra = 20) {
  return fc
    .record({
      activeCount: fc.integer({ min: minActive, max: minActive + maxExtra }),
      inactives: fc.array(
        fc.constantFrom<CyberTerm['active'] | undefined | null>(
          false,
          undefined,
          null as unknown as boolean,
        ),
        { minLength: 0, maxLength: 10 },
      ),
    })
    .map(({ activeCount, inactives }) => {
      const terms: CyberTerm[] = []
      let idx = 0
      for (let i = 0; i < activeCount; i++) terms.push(makeTerm(idx++, true))
      for (const a of inactives)
        terms.push(makeTerm(idx++, a as CyberTerm['active'] | undefined))
      // Shuffle deterministically-ish by index parity so actives aren't grouped.
      return terms
    })
}

function baseOptions(rng?: () => number): TicketGenOptions {
  return {
    id: 'ticket-1',
    playerId: 'player-1',
    gameId: 'game-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    ref: 'Ticket #TEST',
    rng,
  }
}

function ticketTermIds(ticket: Ticket): string[] {
  return ticket.rows.flat().map((c) => c.termId)
}

describe('ticketGenerator', () => {
  // Feature: module-3-player-joining-tickets, property 1 — Ticket has 15 distinct active terms in a 3x5 grid
  it('property 1: 15 distinct active terms arranged in a 3x5 grid', () => {
    fc.assert(
      fc.property(termBankArb(15), fc.integer(), (terms, seed) => {
        const activeIds = new Set(getActiveTerms(terms).map((t) => t.id))
        const ticket = generateTicket(terms, [], baseOptions(makeRng(seed)))
        const ids = ticketTermIds(ticket)

        expect(ids).toHaveLength(TICKET_SIZE)
        expect(new Set(ids).size).toBe(TICKET_SIZE) // all distinct
        for (const id of ids) expect(activeIds.has(id)).toBe(true) // all strictly-active
        expect(ticket.rows).toHaveLength(TICKET_ROWS)
        for (const row of ticket.rows) expect(row).toHaveLength(TICKET_COLS)
      }),
      { numRuns: RUNS },
    )
  })

  // Feature: module-3-player-joining-tickets, property 2 — Cell row/column indices match grid position
  it('property 2: cell row/col match grid position with no extra term fields', () => {
    fc.assert(
      fc.property(termBankArb(15), fc.integer(), (terms, seed) => {
        const ticket = generateTicket(terms, [], baseOptions(makeRng(seed)))
        for (let r = 0; r < ticket.rows.length; r++) {
          for (let c = 0; c < ticket.rows[r].length; c++) {
            const cell = ticket.rows[r][c]
            expect(cell.row).toBe(r)
            expect(cell.col).toBe(c)
            expect(cell.row).toBeGreaterThanOrEqual(0)
            expect(cell.row).toBeLessThanOrEqual(2)
            expect(cell.col).toBeGreaterThanOrEqual(0)
            expect(cell.col).toBeLessThanOrEqual(4)
            // No CyberTerm-only fields leaked onto the cell.
            expect(Object.keys(cell).sort()).toEqual(
              ['col', 'row', 'state', 'term', 'termId'].sort(),
            )
          }
        }
      }),
      { numRuns: RUNS },
    )
  })

  // Feature: module-3-player-joining-tickets, property 3 — Signature is deterministic and order-independent
  it('property 3: signature is deterministic, order-independent, canonical', () => {
    fc.assert(
      fc.property(
        // Real termIds never contain the '|' separator; constrain the input
        // space to ids drawn from a separator-free alphabet.
        fc.uniqueArray(
          fc
            .array(
              fc.constantFrom(
                ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'.split(
                  '',
                ),
              ),
              { minLength: 1, maxLength: 8 },
            )
            .map((chars) => chars.join('')),
          { minLength: 15, maxLength: 15 },
        ),
        (termIds) => {
          const sig = computeSignature(termIds)
          const shuffled = [...termIds].reverse()
          expect(computeSignature(shuffled)).toBe(sig)

          const expected = [...termIds].sort().join('|')
          expect(sig).toBe(expected)

          // No leading/trailing/repeated separators.
          expect(sig.startsWith('|')).toBe(false)
          expect(sig.endsWith('|')).toBe(false)
          expect(sig.includes('||')).toBe(false)
          expect(sig.split('|')).toHaveLength(termIds.length)
        },
      ),
      { numRuns: RUNS },
    )
  })

  // Feature: module-3-player-joining-tickets, property 4 — Generated signature is absent from the existing set
  it('property 4: generated signature is not in the (non-saturating) existing set', () => {
    fc.assert(
      fc.property(
        termBankArb(16),
        fc.array(fc.string(), { minLength: 0, maxLength: 5 }),
        fc.integer(),
        (terms, existing, seed) => {
          const ticket = generateTicket(terms, existing, baseOptions(makeRng(seed)))
          const sig = computeSignature(ticketTermIds(ticket))
          expect(existing).not.toContain(sig)
        },
      ),
      { numRuns: RUNS },
    )
  })

  // Feature: module-3-player-joining-tickets, property 5 — Generator does not mutate its inputs
  it('property 5: inputs are unchanged on success and on throw', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 25 }), // active count (may be < 15 to force throw)
        fc.integer(),
        (activeCount, seed) => {
          const terms: CyberTerm[] = []
          for (let i = 0; i < activeCount; i++) terms.push(makeTerm(i, true))
          // Deep-freeze inputs so any mutation attempt would throw loudly.
          terms.forEach((t) => Object.freeze(t))
          Object.freeze(terms)
          const existing = Object.freeze(['some|other|signature'])

          const snapshot = JSON.stringify(terms)

          try {
            generateTicket(
              terms as CyberTerm[],
              existing as readonly string[],
              baseOptions(makeRng(seed)),
            )
          } catch {
            // throw path is acceptable (e.g. < 15 active); inputs must still be intact
          }

          expect(JSON.stringify(terms)).toBe(snapshot)
          expect(existing).toEqual(['some|other|signature'])
        },
      ),
      { numRuns: RUNS },
    )
  })

  // Feature: module-3-player-joining-tickets, property 6 — Error conditions throw without producing a ticket
  it('property 6: throws on <15 active terms and on a saturated signature space', () => {
    // <15 active terms → throw
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 14 }), fc.integer(), (n, seed) => {
        const terms: CyberTerm[] = []
        for (let i = 0; i < n; i++) terms.push(makeTerm(i, true))
        // add some non-active noise
        terms.push(makeTerm(1000, false))
        terms.push(makeTerm(1001, undefined))
        expect(() => generateTicket(terms, [], baseOptions(makeRng(seed)))).toThrow()
      }),
      { numRuns: RUNS },
    )

    // exactly 15 active terms → only one possible signature; if it already
    // exists, every attempt collides and the generator must throw (no dup).
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const terms: CyberTerm[] = []
        for (let i = 0; i < 15; i++) terms.push(makeTerm(i, true))
        const onlySignature = computeSignature(terms.map((t) => t.id))
        expect(() =>
          generateTicket(terms, [onlySignature], baseOptions(makeRng(seed))),
        ).toThrow()
      }),
      { numRuns: RUNS },
    )
  })

  // Feature: module-3-player-joining-tickets, property 7 — Randomized selection produces variety
  it('property 7: >=2 distinct signatures across 100 default-RNG calls (bank >= 16)', () => {
    const terms: CyberTerm[] = []
    for (let i = 0; i < 20; i++) terms.push(makeTerm(i, true))

    const signatures = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const ticket = generateTicket(terms, [], baseOptions()) // default Math.random
      signatures.add(computeSignature(ticketTermIds(ticket)))
    }
    expect(signatures.size).toBeGreaterThanOrEqual(2)
  })
})
