// Feature: module-4-term-marking-prize-engine, updated for
// module-6-realtime-multi-device-sync's removal of the `rev`-gated
// SYNC_STATE mechanism (design.md Decision 6/7).
//
// Property test for SYNC_LOCAL's handling of the `marks` field:
//   Property 10: Cross-tab sync includes, upserts-by-id, and safely defaults
//   marks
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { gameSessionReducer, type SharedStatePayload } from './gameSessionReducer'
import { gameSessionInitialState, type GameSessionState } from './gameSessionInitialState'
import type { Game } from '../types/game'
import type { Player } from '../types/player'
import type { Ticket } from '../types/ticket'
import type { Mark } from '../types/mark'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

function makeGame(over: Partial<Game> = {}): Game {
  return {
    id: 'GAME_001',
    code: 'CYBER24',
    status: 'WORD_ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    currentRound: 1,
    revealedTermIds: [],
    ...over,
  }
}

function makePlayer(id: string): Player {
  return {
    id,
    gameId: 'GAME_001',
    displayName: `Player ${id}`,
    employeeDemoId: `EMP-${id}`,
    ticketId: `TICKET_${id}`,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: `Player ${id}`,
    employeeId: `EMP-${id}`,
    ticketRef: `Ticket #${id}`,
  }
}

function makeTicket(id: string, playerId: string): Ticket {
  return {
    id,
    playerId,
    gameId: 'GAME_001',
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: `Ticket #${id}`,
    rows: [[{ termId: 'TERM_001', term: 'Phishing', state: 'LOCKED', row: 0, col: 0 }]],
  }
}

const markArb: fc.Arbitrary<Mark> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 10 }),
  gameId: fc.string({ minLength: 1, maxLength: 10 }),
  playerId: fc.string({ minLength: 1, maxLength: 10 }),
  ticketId: fc.string({ minLength: 1, maxLength: 10 }),
  termId: fc.string({ minLength: 1, maxLength: 10 }),
  markedAt: fc.constant('2026-01-01T00:00:00.000Z'),
  valid: fc.boolean(),
})

/** A base session state seeded with an arbitrary set of players + tickets. */
const baseStateArb: fc.Arbitrary<GameSessionState> = fc
  .array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 4 })
  .map((ids) => {
    const players = ids.map((id) => makePlayer(id))
    const tickets = ids.map((id) => makeTicket(`TICKET_${id}`, id))
    return {
      ...gameSessionInitialState,
      game: { ...gameSessionInitialState.game },
      players,
      tickets,
      currentPlayerId: undefined,
      marks: [] as Mark[],
    }
  })

/** A valid SharedStatePayload shape whose `marks` is an actual array. */
function validPayloadArb(): fc.Arbitrary<SharedStatePayload> {
  return fc
    .record({
      game: fc.record({
        id: fc.string({ minLength: 1, maxLength: 10 }),
        status: fc.constantFrom<Game['status']>('LOBBY', 'WORD_ACTIVE', 'PAUSED', 'COMPLETED'),
        revealedTermIds: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 5 }),
      }),
      players: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 3 }).map((ids) =>
        ids.map((id) => makePlayer(id)),
      ),
      tickets: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 3 }).map((ids) =>
        ids.map((id) => makeTicket(`T_${id}`, id)),
      ),
      marks: fc.uniqueArray(markArb, { maxLength: 5, selector: (m) => m.id }),
    })
    .map(({ game, players, tickets, marks }) => ({
      game: makeGame(game),
      players,
      tickets,
      marks,
      claims: [],
      winners: [],
    }))
}

// ---------------------------------------------------------------------------
// Property 10 — Cross-tab sync includes, upserts-by-id, and safely defaults
// marks
// ---------------------------------------------------------------------------

// Feature: module-4-term-marking-prize-engine, Property 10: Cross-tab sync includes, upserts-by-id, and safely defaults marks
//
// Validates: Requirements 6.1, 6.2, 6.3
describe('SYNC_LOCAL applies and safely defaults marks (property 10)', () => {
  it('upserts every incoming mark by id, starting from no local marks', () => {
    fc.assert(
      fc.property(baseStateArb, validPayloadArb(), (state, payload) => {
        const frozen = deepFreeze(state)
        const next = gameSessionReducer(frozen, { type: 'SYNC_LOCAL', payload })

        // Starting from no local marks, an upsert-by-id of the incoming
        // marks is equivalent to adopting them directly (order aside).
        expect(next.marks.map((m) => m.id).sort()).toEqual(
          payload.marks.map((m) => m.id).sort(),
        )
        for (const incoming of payload.marks) {
          expect(next.marks.find((m) => m.id === incoming.id)).toEqual(incoming)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('defaults marks to [] when the incoming marks field is missing or not an array', () => {
    // Arbitrary "bad" values for marks: missing (undefined), null, or a
    // non-array primitive/object.
    const badMarksArb = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.string(),
      fc.integer(),
      fc.record({ notAnArray: fc.boolean() }),
    )

    fc.assert(
      fc.property(baseStateArb, validPayloadArb(), badMarksArb, (state, basePayload, badMarks) => {
        const frozen = deepFreeze(state)
        const payload = {
          ...basePayload,
          marks: badMarks,
          // deep-freeze the payload too, to ensure SYNC_LOCAL never mutates it.
        } as unknown as SharedStatePayload
        deepFreeze(payload)

        const next = gameSessionReducer(frozen, { type: 'SYNC_LOCAL', payload })

        expect(next.marks).toEqual([])
        // game from the (otherwise-valid) payload still applies (replaced
        // outright), and every incoming player/ticket is still upserted in —
        // the malformed `marks` field alone does not block the rest of the
        // payload from applying.
        expect(next.game.id).toBe(basePayload.game.id)
        for (const player of basePayload.players) {
          expect(next.players.find((p) => p.id === player.id)).toEqual(player)
        }
        for (const ticket of basePayload.tickets) {
          expect(next.tickets.find((t) => t.id === ticket.id)).toEqual(ticket)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('never drops a local mark not present in the incoming payload', () => {
    fc.assert(
      fc.property(baseStateArb, validPayloadArb(), (state, payload) => {
        const localMarks: Mark[] = [
          {
            id: 'LOCAL_MARK_1',
            gameId: 'GAME_001',
            playerId: 'P1',
            ticketId: 'T1',
            termId: 'TERM_001',
            markedAt: '2026-01-01T00:00:00.000Z',
            valid: true,
          },
        ]
        const withLocalMark = { ...state, marks: localMarks }
        const frozen = deepFreeze(withLocalMark)

        const next = gameSessionReducer(frozen, { type: 'SYNC_LOCAL', payload })

        expect(next.marks.some((m) => m.id === 'LOCAL_MARK_1')).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('never throws for any valid-shape payload regardless of marks content', () => {
    fc.assert(
      fc.property(baseStateArb, validPayloadArb(), (state, payload) => {
        const frozen = deepFreeze(state)
        expect(() =>
          gameSessionReducer(frozen, { type: 'SYNC_LOCAL', payload }),
        ).not.toThrow()
      }),
      { numRuns: 100 },
    )
  })
})
