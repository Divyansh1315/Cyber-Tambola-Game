// Feature: module-4-term-marking-prize-engine
//
// Property tests for the MARK_TERM reducer case:
//   Property 2: A valid mark attempt creates exactly one well-formed Mark
//   Property 3: The reducer's MARK_TERM handling is pure
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fc from 'fast-check'
import { gameSessionReducer } from './gameSessionReducer'
import { gameSessionInitialState, type GameSessionState } from './gameSessionInitialState'
import { validateMarkAttempt } from '../utils/prizeEngine'
import type { Game } from '../types/game'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'
import type { Mark } from '../types/mark'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively freeze an object so any mutation attempt throws in strict mode.
 * Used to enforce reducer purity: the reducer must never mutate its input.
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

// --- Fixture builders -------------------------------------------------------

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

function makePlayer(id: string, ticketId: string): Player {
  return {
    id,
    gameId: 'GAME_001',
    displayName: `Player ${id}`,
    employeeDemoId: `EMP-${id}`,
    ticketId,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: `Player ${id}`,
    employeeId: `EMP-${id}`,
    ticketRef: `Ticket #${id}`,
  }
}

/** A 3x5 ticket whose 15 cells have distinct termIds `T0`..`T14`. */
function makeTicket(id: string, playerId: string): Ticket {
  const rows: TicketCell[][] = []
  let n = 0
  for (let row = 0; row < 3; row++) {
    const cells: TicketCell[] = []
    for (let col = 0; col < 5; col++) {
      cells.push({ termId: `T${n}`, term: `Term ${n}`, state: 'LOCKED', row, col })
      n++
    }
    rows.push(cells)
  }
  return {
    id,
    playerId,
    gameId: 'GAME_001',
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: `Ticket #${id}`,
    rows,
  }
}

function allTermIds(ticket: Ticket): string[] {
  return ticket.rows.flat().map((c) => c.termId)
}

/**
 * Builds a valid session state fixture where MARK_TERM for `termId` will be
 * accepted: current player exists, their ticket exists, `termId` is one of
 * the ticket's 15 cells, revealed, game not completed, and not yet marked.
 * `existingMarks` lets a scenario seed prior marks (for other termIds) so the
 * fixture still exercises non-trivial `marks` arrays.
 */
function validFixtureArb(): fc.Arbitrary<{
  state: GameSessionState
  termId: string
}> {
  return fc
    .record({
      playerId: fc.string({ minLength: 1, maxLength: 10 }),
      ticketId: fc.string({ minLength: 1, maxLength: 10 }),
      gameId: fc.string({ minLength: 1, maxLength: 10 }),
      cellIndex: fc.integer({ min: 0, max: 14 }),
      priorMarkCount: fc.integer({ min: 0, max: 5 }),
    })
    .map(({ playerId, ticketId, gameId, cellIndex, priorMarkCount }) => {
      const player = makePlayer(playerId, ticketId)
      const ticket = makeTicket(ticketId, playerId)
      const termIds = allTermIds(ticket)
      const termId = termIds[cellIndex]

      // Reveal the target term plus a few others; never mark the target term
      // itself among the "prior marks" so gate 6 (DUPLICATE_MARK) stays clear.
      const otherTermIds = termIds.filter((id) => id !== termId)
      const priorMarkedTermIds = otherTermIds.slice(0, priorMarkCount)
      const revealedTermIds = [termId, ...priorMarkedTermIds]

      const priorMarks: Mark[] = priorMarkedTermIds.map((tid, i) => ({
        id: `prior-${i}`,
        gameId,
        playerId,
        ticketId,
        termId: tid,
        markedAt: '2026-01-01T00:00:00.000Z',
        valid: true,
      }))

      const game = makeGame({ id: gameId, revealedTermIds })

      const state: GameSessionState = {
        ...gameSessionInitialState,
        game,
        players: [player],
        tickets: [ticket],
        currentPlayerId: playerId,
        marks: priorMarks,
      }

      return { state, termId }
    })
}

// ---------------------------------------------------------------------------
// Property 2 — A valid mark attempt creates exactly one well-formed Mark
// ---------------------------------------------------------------------------

// Feature: module-4-term-marking-prize-engine, Property 2: A valid mark attempt creates exactly one well-formed Mark
//
// Validates: Requirements 2.8, 3.3
describe('MARK_TERM valid branch creates exactly one well-formed Mark (property 2)', () => {
  beforeAll(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'))
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  it('appends exactly one well-formed Mark and leaves players/tickets/game unchanged', () => {
    fc.assert(
      fc.property(validFixtureArb(), ({ state, termId }) => {
        // Sanity: this fixture is indeed a valid mark attempt.
        expect(validateMarkAttempt(state, termId).valid).toBe(true)

        const frozen = deepFreeze(state)
        const before = frozen.marks.length

        const next = gameSessionReducer(frozen, { type: 'MARK_TERM', termId })

        expect(next.marks.length).toBe(before + 1)
        const created = next.marks[next.marks.length - 1]

        expect(created.valid).toBe(true)
        expect(created.gameId).toBe(frozen.game.id)
        expect(created.playerId).toBe(frozen.currentPlayerId)
        const player = frozen.players.find((p) => p.id === frozen.currentPlayerId)!
        expect(created.ticketId).toBe(player.ticketId)
        expect(created.termId).toBe(termId)
        expect(typeof created.markedAt).toBe('string')
        expect(new Date(created.markedAt).toISOString()).toBe(created.markedAt)
        expect(Number.isNaN(new Date(created.markedAt).getTime())).toBe(false)

        // Every prior mark is preserved unchanged.
        expect(next.marks.slice(0, before)).toEqual(frozen.marks)

        // players/tickets/game untouched.
        expect(next.players).toEqual(frozen.players)
        expect(next.tickets).toEqual(frozen.tickets)
        expect(next.game).toEqual(frozen.game)
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 3 — The reducer's MARK_TERM handling is pure
// ---------------------------------------------------------------------------

// Feature: module-4-term-marking-prize-engine, Property 3: The reducer's MARK_TERM handling is pure
//
// Validates: Requirements 3.2
describe("MARK_TERM handling is pure (property 3)", () => {
  it('never mutates the frozen input state and is deterministic for the same input', () => {
    // A mix of valid and arbitrary (possibly invalid) termIds/state so both
    // the accepted and rejected branches are exercised for purity.
    const anyStateAndTermArb = fc.oneof(
      validFixtureArb(),
      validFixtureArb().map(({ state }) => ({
        state,
        // An arbitrary termId not guaranteed to be valid (e.g. off-ticket,
        // unrevealed, or a duplicate) to exercise the rejection branch too.
        termId: 'NOT-ON-TICKET',
      })),
    )

    fc.assert(
      fc.property(anyStateAndTermArb, ({ state, termId }) => {
        const frozen = deepFreeze(state)
        const snapshotMarks = frozen.marks.length
        const snapshotPlayers = frozen.players.length
        const snapshotTickets = frozen.tickets.length

        // Freeze the system clock so markedAt (when created) is deterministic
        // across the two dispatches below.
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'))

        const out1 = gameSessionReducer(frozen, { type: 'MARK_TERM', termId })
        const out2 = gameSessionReducer(frozen, { type: 'MARK_TERM', termId })

        vi.useRealTimers()

        // Determinism: same frozen input + same action → structurally equal
        // output, modulo the new Mark's `id` — MARK_TERM's *only* source of
        // non-determinism is localId()'s crypto.randomUUID() call (the same
        // convention already used by JOIN_PLAYER's player/ticket ids, which
        // is why the Module 3 purity property above excludes JOIN_PLAYER from
        // its determinism check too). Everything else must match exactly.
        expect(out2.players).toEqual(out1.players)
        expect(out2.tickets).toEqual(out1.tickets)
        expect(out2.game).toEqual(out1.game)
        expect(out2.marks.length).toBe(out1.marks.length)
        out2.marks.forEach((mark, i) => {
          const other = out1.marks[i]
          expect({ ...mark, id: undefined }).toEqual({ ...other, id: undefined })
        })

        // Input was never mutated by the dispatch (mutation would throw on a
        // frozen object anyway, but also assert nothing observably changed).
        expect(frozen.marks.length).toBe(snapshotMarks)
        expect(frozen.players.length).toBe(snapshotPlayers)
        expect(frozen.tickets.length).toBe(snapshotTickets)
      }),
      { numRuns: 200 },
    )
  })

  it('performs no localStorage or BroadcastChannel access while handling MARK_TERM', () => {
    const storageSetSpy = vi.spyOn(Storage.prototype, 'setItem')
    const originalBC = globalThis.BroadcastChannel
    let bcConstructed = false
    // Guard against BroadcastChannel not existing in this environment.
    if (typeof originalBC === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(globalThis as any).BroadcastChannel = class extends originalBC {
        constructor(name: string) {
          bcConstructed = true
          super(name)
        }
      }
    }

    fc.assert(
      fc.property(validFixtureArb(), ({ state, termId }) => {
        const frozen = deepFreeze(state)
        gameSessionReducer(frozen, { type: 'MARK_TERM', termId })
      }),
      { numRuns: 100 },
    )

    expect(storageSetSpy).not.toHaveBeenCalled()
    expect(bcConstructed).toBe(false)

    storageSetSpy.mockRestore()
    if (typeof originalBC === 'function') {
      globalThis.BroadcastChannel = originalBC
    }
  })
})
