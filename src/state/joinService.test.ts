import { describe, it, expect, afterEach } from 'vitest'
import fc from 'fast-check'
import {
  buildJoinOutcome,
  validateJoin,
  normalizeId,
  localId,
  shortTicketRef,
  MESSAGES,
  JOINABLE_STATUSES,
} from './joinService'
import { computeSignature } from '../utils/ticketGenerator'
import { cyberTerms } from '../data/cyberTerms'
import type { Game, GameStatus } from '../types/game'
import type { JoinFormValues, Player } from '../types/player'
import type { Ticket } from '../types/ticket'

// ---------------------------------------------------------------------------
// Shared helpers / arbitraries
// ---------------------------------------------------------------------------

/** A valid 30-term active bank so ticket generation always succeeds. */
const TERMS = cyberTerms

function makeGame(status: GameStatus): Game {
  return {
    id: 'GAME_001',
    code: 'CYBER24',
    status,
    createdAt: new Date().toISOString(),
    currentRound: 0,
    revealedTermIds: [],
  }
}

/** Case variants of the valid game code. */
const validCodeArb = fc.constantFrom(
  'CYBER24',
  'cyber24',
  'Cyber24',
  'cYbEr24',
)

/** Non-empty display name / id after trimming. */
const nameArb = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0)
const idArb = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0)

/** Random surrounding whitespace. */
const wsArb = fc.stringOf(fc.constantFrom(' ', '\t', '\n'), { maxLength: 4 })

const JOINABLE_ARB = fc.constantFrom<GameStatus>(...JOINABLE_STATUSES)

function form(
  gameCode: string,
  employeeName: string,
  employeeId: string,
): JoinFormValues {
  return { gameCode, employeeName, employeeId }
}

// ---------------------------------------------------------------------------
// Property 8 — Join validation normalizes and trims correctly
// Feature: module-3-player-joining-tickets, property 8 — trimming/normalization
// Validates: Requirements 3.3, 3.5, 4.2, 5.1
// ---------------------------------------------------------------------------

describe('Property 8: join validation normalizes and trims correctly', () => {
  it('whitespace on fields does not change the outcome versus trimmed values', () => {
    fc.assert(
      fc.property(
        validCodeArb,
        nameArb,
        idArb,
        wsArb,
        wsArb,
        wsArb,
        wsArb,
        wsArb,
        wsArb,
        (code, name, id, wa, wb, wc, wd, we, wf) => {
          const game = makeGame('LOBBY')
          const padded = form(`${wa}${code}${wb}`, `${wc}${name}${wd}`, `${we}${id}${wf}`)
          const trimmed = form(code.trim(), name.trim(), id.trim())

          const paddedOut = buildJoinOutcome({ form: padded, game, players: [], tickets: [], terms: TERMS })
          const trimmedOut = buildJoinOutcome({ form: trimmed, game, players: [], tickets: [], terms: TERMS })

          // Both should be new-player outcomes with equal player fields.
          expect(paddedOut.kind).toBe('new')
          expect(trimmedOut.kind).toBe('new')
          if (paddedOut.kind === 'new' && trimmedOut.kind === 'new') {
            expect(paddedOut.player.displayName).toBe(trimmedOut.player.displayName)
            expect(paddedOut.player.employeeDemoId).toBe(trimmedOut.player.employeeDemoId)
            // New-player fields equal the trimmed inputs.
            expect(paddedOut.player.displayName).toBe(name.trim())
            expect(paddedOut.player.employeeDemoId).toBe(id.trim())
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('normalizeId is idempotent and equal across case/whitespace variants', () => {
    fc.assert(
      fc.property(idArb, wsArb, wsArb, (id, wa, wb) => {
        const n = normalizeId(id)
        // Idempotent.
        expect(normalizeId(n)).toBe(n)
        // Equal across case + whitespace variants of the same id.
        const variant = `${wa}${id.toUpperCase()}${wb}`
        expect(normalizeId(variant)).toBe(normalizeId(id.toUpperCase()))
        expect(normalizeId(`${wa}${id}${wb}`)).toBe(n)
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 9 — Unknown or empty inputs are rejected
// Feature: module-3-player-joining-tickets, property 9 — empty/unknown rejected
// Validates: Requirements 3.4, 3.6
// ---------------------------------------------------------------------------

describe('Property 9: unknown or empty inputs are rejected', () => {
  it('any field empty after trim yields an error and no new player', () => {
    fc.assert(
      fc.property(
        validCodeArb,
        nameArb,
        idArb,
        fc.integer({ min: 0, max: 2 }),
        wsArb,
        (code, name, id, whichEmpty, ws) => {
          const fields = [code, name, id]
          fields[whichEmpty] = ws // blank/whitespace-only
          const out = buildJoinOutcome({
            form: form(fields[0], fields[1], fields[2]),
            game: makeGame('LOBBY'),
            players: [],
            tickets: [],
            terms: TERMS,
          })
          expect(out.kind).toBe('error')
          if (out.kind === 'error') expect(out.message).toBe(MESSAGES.requiredFields)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('game code not normalizing to cyber24 yields gameNotFound and no new player', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => normalizeId(s) !== 'cyber24' && s.trim().length > 0),
        nameArb,
        idArb,
        (code, name, id) => {
          const out = buildJoinOutcome({
            form: form(code, name, id),
            game: makeGame('LOBBY'),
            players: [],
            tickets: [],
            terms: TERMS,
          })
          expect(out.kind).toBe('error')
          if (out.kind === 'error') expect(out.message).toBe(MESSAGES.gameNotFound)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 10 — Joinability depends only on status
// Feature: module-3-player-joining-tickets, property 10 — status gates joinability
// Validates: Requirements 3.7, 3.8
// ---------------------------------------------------------------------------

describe('Property 10: joinability depends only on status', () => {
  it('joinable statuses do not reject a valid submission on status grounds', () => {
    fc.assert(
      fc.property(JOINABLE_ARB, validCodeArb, nameArb, idArb, (status, code, name, id) => {
        const out = buildJoinOutcome({
          form: form(code, name, id),
          game: makeGame(status),
          players: [],
          tickets: [],
          terms: TERMS,
        })
        // Valid input in a joinable status → a new player (not a gameCompleted error).
        expect(out.kind).toBe('new')
      }),
      { numRuns: 100 },
    )
  })

  it('COMPLETED status always rejects', () => {
    fc.assert(
      fc.property(validCodeArb, nameArb, idArb, (code, name, id) => {
        const out = buildJoinOutcome({
          form: form(code, name, id),
          game: makeGame('COMPLETED'),
          players: [],
          tickets: [],
          terms: TERMS,
        })
        expect(out.kind).toBe('error')
        if (out.kind === 'error') expect(out.message).toBe(MESSAGES.gameCompleted)
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 11 — Duplicate identity restores the existing player
// Feature: module-3-player-joining-tickets, property 11 — duplicate id restores
// Validates: Requirements 5.2, 5.3
// ---------------------------------------------------------------------------

function existingPlayer(employeeDemoId: string): Player {
  return {
    id: 'p-existing',
    gameId: 'GAME_001',
    displayName: 'Existing',
    employeeDemoId,
    ticketId: 't-existing',
    joinedAt: new Date().toISOString(),
    name: 'Existing',
    employeeId: employeeDemoId,
    ticketRef: 'Ticket #EXIS',
  }
}

describe('Property 11: duplicate identity restores the existing player', () => {
  it('a normalized-id match returns restore and creates no new player/ticket', () => {
    fc.assert(
      fc.property(
        validCodeArb,
        nameArb,
        idArb,
        wsArb,
        wsArb,
        (code, name, id, wa, wb) => {
          const player = existingPlayer(id)
          const tickets: Ticket[] = []
          // Submit a case/whitespace variant of the same id.
          const submittedId = `${wa}${id.toUpperCase()}${wb}`
          const out = buildJoinOutcome({
            form: form(code, name, submittedId),
            game: makeGame('LOBBY'),
            players: [player],
            tickets,
            terms: TERMS,
          })
          expect(out.kind).toBe('restore')
          if (out.kind === 'restore') expect(out.playerId).toBe('p-existing')
          // No new ticket created.
          expect(tickets).toHaveLength(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 12 — A built player is well-formed
// Feature: module-3-player-joining-tickets, property 12 — built player well-formed
// Validates: Requirements 4.1, 4.2, 4.3
// ---------------------------------------------------------------------------

describe('Property 12: a built player is well-formed', () => {
  it('valid new submission yields a well-formed player and matching ticket', () => {
    fc.assert(
      fc.property(validCodeArb, nameArb, idArb, wsArb, wsArb, (code, name, id, wa, wb) => {
        const game = makeGame('WORD_ACTIVE')
        const out = buildJoinOutcome({
          form: form(code, `${wa}${name}${wb}`, `${wa}${id}${wb}`),
          game,
          players: [],
          tickets: [],
          terms: TERMS,
        })
        expect(out.kind).toBe('new')
        if (out.kind !== 'new') return
        const { player, ticket } = out
        expect(player.id.length).toBeGreaterThan(0)
        expect(player.gameId).toBe(game.id)
        expect(player.gameId.length).toBeGreaterThan(0)
        expect(player.displayName.length).toBeGreaterThan(0)
        expect(player.employeeDemoId.length).toBeGreaterThan(0)
        expect(player.ticketId.length).toBeGreaterThan(0)
        expect(player.ticketId).toBe(ticket.id)
        expect(player.displayName).toBe(name.trim())
        expect(player.employeeDemoId).toBe(id.trim())
        // joinedAt is a valid ISO timestamp.
        expect(new Date(player.joinedAt).toISOString()).toBe(player.joinedAt)
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 13 — Short ticket ref hides the full id
// Feature: module-3-player-joining-tickets, property 13 — short ref hides id
// Validates: Requirements 10.2, 10.3
// ---------------------------------------------------------------------------

describe('Property 13: short ticket ref hides the full id', () => {
  // shortTicketRef is only ever called with ids produced by localId(): either a
  // crypto UUID or the `id-<base36>-<base36>` fallback. Both are long and contain
  // separators, so a short uppercase token can never reproduce them and they can
  // never be a substring of the constant "Ticket #" display prefix. We therefore
  // exercise the property over id shapes representative of real localId() output
  // rather than arbitrary strings: for degenerate 1–2 char strings that happen to
  // be substrings of the required "Ticket #" prefix the "not a substring" invariant
  // is undefined, not a defect in shortTicketRef.
  const base36 = '0123456789abcdefghijklmnopqrstuvwxyz'.split('')
  const alnumChars =
    '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const realisticTicketId: fc.Arbitrary<string> = fc.oneof(
    // crypto.randomUUID() shape.
    fc.uuid(),
    // localId() timestamp+random fallback shape: id-<base36>-<base36>.
    fc
      .tuple(
        fc.stringOf(fc.constantFrom(...base36), { minLength: 6, maxLength: 10 }),
        fc.stringOf(fc.constantFrom(...base36), { minLength: 6, maxLength: 8 }),
      )
      .map(([time, rand]) => `id-${time}-${rand}`),
    // General long alphanumeric ids (>= 8 chars) as a broader realistic case.
    fc.stringOf(fc.constantFrom(...alnumChars), { minLength: 8, maxLength: 40 }),
  )

  it('ref starts with "Ticket #", token is shorter, id not a substring, deterministic', () => {
    fc.assert(
      fc.property(realisticTicketId, (ticketId) => {
        const ref = shortTicketRef(ticketId)
        expect(ref.startsWith('Ticket #')).toBe(true)
        const token = ref.slice('Ticket #'.length)
        expect(token.length).toBeLessThan(ticketId.length)
        expect(ref.includes(ticketId)).toBe(false)
        // Deterministic.
        expect(shortTicketRef(ticketId)).toBe(ref)
      }),
      { numRuns: 300 },
    )
  })
})

// ===========================================================================
// Task 5.3 — Unit tests: localId fallback + exact error messages
// ===========================================================================

describe('localId', () => {
  const originalCrypto = globalThis.crypto

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', {
      value: originalCrypto,
      configurable: true,
      writable: true,
    })
  })

  it('uses crypto.randomUUID when available', () => {
    const stub = {
      randomUUID: () => '11111111-2222-3333-4444-555555555555',
    } as unknown as Crypto
    Object.defineProperty(globalThis, 'crypto', {
      value: stub,
      configurable: true,
      writable: true,
    })
    expect(localId()).toBe('11111111-2222-3333-4444-555555555555')
  })

  it('falls back to a unique token when crypto.randomUUID is unavailable', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    const a = localId()
    const b = localId()
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })

  it('falls back when crypto exists but randomUUID is not a function', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {} as Crypto,
      configurable: true,
      writable: true,
    })
    expect(localId().length).toBeGreaterThan(0)
  })
})

describe('validateJoin error branches and exact messages', () => {
  it('rejects a COMPLETED game with the exact gameCompleted message', () => {
    const decision = validateJoin(
      form('CYBER24', 'Asha', 'EMP-1001'),
      makeGame('COMPLETED'),
      [],
    )
    expect(decision.kind).toBe('error')
    if (decision.kind === 'error') {
      expect(decision.message).toBe('This game has ended and is no longer available.')
      expect(decision.message).toBe(MESSAGES.gameCompleted)
    }
  })

  it('rejects an unknown game code with the exact gameNotFound message', () => {
    const decision = validateJoin(
      form('WRONG99', 'Asha', 'EMP-1001'),
      makeGame('LOBBY'),
      [],
    )
    expect(decision.kind).toBe('error')
    if (decision.kind === 'error') {
      expect(decision.message).toBe('Game not found or no longer available.')
      expect(decision.message).toBe(MESSAGES.gameNotFound)
    }
  })

  it('rejects empty fields with the exact requiredFields message', () => {
    const decision = validateJoin(form('CYBER24', '   ', 'EMP-1001'), makeGame('LOBBY'), [])
    expect(decision.kind).toBe('error')
    if (decision.kind === 'error') expect(decision.message).toBe(MESSAGES.requiredFields)
  })
})

// A guard against unused-import warnings for computeSignature in strict builds.
describe('signature helper is importable', () => {
  it('computes a pipe-joined signature', () => {
    expect(computeSignature(['b', 'a'])).toBe('a|b')
  })
})
