// Feature: module-3-player-joining-tickets — end-to-end integration tests
//
// These tests drive the *real* GameSessionProvider (with its localStorage
// persistence effect and restore-on-mount logic), the real reducer, and the
// real joinService/ticketGenerator. No mocks or fake data are used: players
// and tickets are built through buildJoinOutcome() exactly as the PlayerJoin
// screen does. Covers manual Tests B, D, and F from the design Testing
// Strategy and Requirements 6, 15, 16, 19.
import { describe, it, expect, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from './GameSessionContext'
import { STORAGE_KEY, parseEnvelope } from './persistence'
import { buildJoinOutcome } from './joinService'
import { computeSignature } from '../utils/ticketGenerator'
import { cyberTerms } from '../data/cyberTerms'
import type { JoinFormValues } from '../types/player'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/**
 * A tiny harness that captures the live context value on every render into a
 * ref supplied by the test. This lets a test dispatch actions and read state
 * from outside the React tree while still exercising the real provider,
 * reducer, selectors, and persistence effect.
 */
function Harness({ sink }: { sink: { current: GameSessionContextValue | null } }) {
  const ctx = useGameSession()
  const ref = useRef(sink)
  useEffect(() => {
    ref.current.current = ctx
  })
  // Also assign synchronously so the very first captured value is available.
  sink.current = ctx
  return null
}

function mountProvider() {
  const sink: { current: GameSessionContextValue | null } = { current: null }
  const utils = render(
    <GameSessionProvider>
      <Harness sink={sink} />
    </GameSessionProvider>,
  )
  return { sink, ...utils }
}

/** Build a real new-player join outcome from the current session state. */
function joinNew(
  ctx: GameSessionContextValue,
  form: JoinFormValues,
) {
  const outcome = buildJoinOutcome({
    form,
    game: ctx.state.game,
    players: ctx.state.players,
    tickets: ctx.state.tickets,
    terms: cyberTerms,
  })
  if (outcome.kind !== 'new') {
    throw new Error(`expected a new join outcome, got: ${outcome.kind}`)
  }
  return outcome
}

const VALID_CODE = 'CYBER24'

describe('session integration (module-3-player-joining-tickets)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // -------------------------------------------------------------------------
  // 16.1 — Persistence round-trip through the provider (Test B, Req 16.2)
  // -------------------------------------------------------------------------
  it('persists a joined player/ticket and restores them identically on remount (Test B, Req 16.2)', () => {
    const first = mountProvider()
    const ctx = first.sink.current!

    // Build a real player + ticket and dispatch JOIN_PLAYER through the reducer.
    const outcome = joinNew(ctx, {
      gameCode: VALID_CODE,
      employeeName: 'Asha',
      employeeId: 'EMP-1001',
    })
    act(() => {
      ctx.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
    })

    // The persistence effect should have written a v2 envelope holding the
    // joined player/ticket (SHARED state only — currentPlayerId is
    // client-local and is verified separately below via localStorage's
    // dedicated key + the live context value).
    const rawAfterJoin = localStorage.getItem(STORAGE_KEY)
    expect(rawAfterJoin).toBeTruthy()
    const persisted = parseEnvelope(rawAfterJoin)
    expect(persisted).not.toBeNull()
    expect(persisted!.players).toHaveLength(1)
    expect(persisted!.players[0].id).toBe(outcome.player.id)
    expect(persisted!.tickets).toHaveLength(1)
    expect(persisted!.tickets[0].id).toBe(outcome.ticket.id)
    expect(first.sink.current!.state.currentPlayerId).toBe(outcome.player.id)

    // Also assert the raw envelope carries the version marker (Req 16.3).
    expect(JSON.parse(rawAfterJoin!).version).toBe(4)

    // Snapshot the pre-unmount live state for identity comparison.
    const before = first.sink.current!.state

    // Unmount and remount a fresh provider against the same localStorage.
    first.unmount()

    const second = mountProvider()
    const restored = second.sink.current!.state

    // Players, tickets, and currentPlayerId restored identically.
    expect(restored.players).toEqual(before.players)
    expect(restored.tickets).toEqual(before.tickets)
    expect(restored.currentPlayerId).toBe(before.currentPlayerId)

    // The ticket id was NOT regenerated on restore.
    expect(restored.tickets[0].id).toBe(outcome.ticket.id)
    expect(restored.players[0].ticketId).toBe(outcome.ticket.id)

    // The game is restored identically too.
    expect(restored.game).toEqual(before.game)

    // Derived selectors resolve the restored player + ticket.
    expect(second.sink.current!.currentPlayer?.id).toBe(outcome.player.id)
    expect(second.sink.current!.currentTicket?.id).toBe(outcome.ticket.id)

    second.unmount()
  })

  // -------------------------------------------------------------------------
  // 16.2 — Stale-data fallback (Req 16.4)
  // -------------------------------------------------------------------------
  it('falls back to seed state (without throwing) when localStorage holds an old Module 2 shape with no version (Req 16.4)', () => {
    // Old Module 2 shape: a bare game object with NO `version` marker.
    const oldModule2Game = {
      id: 'GAME_001',
      code: 'CYBER24',
      status: 'CLUE_ACTIVE',
      createdAt: new Date().toISOString(),
      currentRound: 3,
      currentTermId: 'TERM_006',
      revealedTermIds: ['TERM_001', 'TERM_002'],
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(oldModule2Game))

    let mounted!: ReturnType<typeof mountProvider>
    expect(() => {
      mounted = mountProvider()
    }).not.toThrow()

    const s = mounted.sink.current!.state
    expect(s.players).toEqual([])
    expect(s.tickets).toEqual([])
    expect(s.currentPlayerId).toBeUndefined()
    expect(s.game.status).toBe('LOBBY')

    mounted.unmount()
  })

  it('falls back to seed state (without throwing) when localStorage holds an arbitrary garbage string (Req 16.4)', () => {
    localStorage.setItem(STORAGE_KEY, 'this-is-not-json-{{{')

    let mounted!: ReturnType<typeof mountProvider>
    expect(() => {
      mounted = mountProvider()
    }).not.toThrow()

    const s = mounted.sink.current!.state
    expect(s.players).toEqual([])
    expect(s.tickets).toEqual([])
    expect(s.currentPlayerId).toBeUndefined()
    expect(s.game.status).toBe('LOBBY')

    mounted.unmount()
  })

  // -------------------------------------------------------------------------
  // 16.3 — Three distinct players (Test D, Req 6.1, 6.3, 19.4)
  // -------------------------------------------------------------------------
  it('joins three distinct players and assigns each a distinct ticket signature (Test D, Req 6.1, 6.3, 19.4)', () => {
    const mounted = mountProvider()

    const employeeIds = ['EMP-1001', 'EMP-1002', 'EMP-1003']
    const names = ['Asha', 'Bhavin', 'Chetna']

    employeeIds.forEach((employeeId, i) => {
      // Use the CURRENT state each time so existing signatures are compared
      // during generation (uniqueness across the three players).
      const ctx = mounted.sink.current!
      const outcome = joinNew(ctx, {
        gameCode: VALID_CODE,
        employeeName: names[i],
        employeeId,
      })
      act(() => {
        ctx.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
      })
    })

    const s = mounted.sink.current!.state
    // Participant count derives from players.length (Req 6.1, 6.3).
    expect(s.players).toHaveLength(3)
    expect(s.tickets).toHaveLength(3)

    // All three ticket signatures are distinct (Req 19.4).
    const signatures = s.tickets.map((t) =>
      computeSignature(t.rows.flat().map((c) => c.termId)),
    )
    const distinct = new Set(signatures)
    expect(distinct.size).toBe(3)

    // Sanity: every ticket has exactly 15 cells in a 3x5 grid.
    for (const ticket of s.tickets) {
      expect(ticket.rows).toHaveLength(3)
      expect(ticket.rows.flat()).toHaveLength(15)
    }

    mounted.unmount()
  })

  // -------------------------------------------------------------------------
  // 16.4 — Reset (Test F, Req 15.1, 15.2, 16.6)
  // -------------------------------------------------------------------------
  it('RESET_GAME clears the session and overwrites persisted storage with the reset seed (Test F, Req 15.1, 15.2, 16.6)', () => {
    const mounted = mountProvider()

    // Join a player, then progress the game a bit (start + reveal a clue).
    const ctx0 = mounted.sink.current!
    const outcome = joinNew(ctx0, {
      gameCode: VALID_CODE,
      employeeName: 'Asha',
      employeeId: 'EMP-1001',
    })
    act(() => {
      ctx0.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
    })
    act(() => {
      mounted.sink.current!.dispatch({ type: 'START_GAME' })
    })

    // Confirm we actually made progress before the reset. START_GAME already
    // calls (and thus reveals) the first term in one step (Module 5).
    const progressed = mounted.sink.current!.state
    expect(progressed.players).toHaveLength(1)
    expect(progressed.game.status).toBe('WORD_ACTIVE')
    expect(progressed.game.revealedTermIds.length).toBeGreaterThan(0)

    // Reset.
    act(() => {
      mounted.sink.current!.dispatch({ type: 'RESET_GAME' })
    })

    const s = mounted.sink.current!.state
    expect(s.players).toEqual([])
    expect(s.tickets).toEqual([])
    expect(s.currentPlayerId).toBeUndefined()
    expect(s.game.status).toBe('LOBBY')
    expect(s.game.currentRound).toBe(0)
    expect(s.game.currentTermId).toBeUndefined()
    expect(s.game.revealedTermIds).toEqual([])

    // The persistence effect must have overwritten storage with the reset seed
    // envelope (Req 16.6): empty players/tickets, v2 marker. currentPlayerId
    // is client-local and is asserted via `s.currentPlayerId` above.
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!).version).toBe(4)
    const persisted = parseEnvelope(raw)
    expect(persisted).not.toBeNull()
    expect(persisted!.players).toEqual([])
    expect(persisted!.tickets).toEqual([])
    expect(persisted!.game.status).toBe('LOBBY')

    mounted.unmount()
  })
})
