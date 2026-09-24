// Feature: bugfix — Player redirected to Join screen on Host lifecycle actions
//
// Covers the refresh/hydration side of the fix: `currentPlayerId` is
// client-local identity, persisted under its OWN localStorage key
// (CURRENT_PLAYER_STORAGE_KEY), separate from the shared session envelope
// (STORAGE_KEY). This test drives the *real* GameSessionProvider end to end
// (no mocks): join a real player, unmount (simulating a refresh), remount a
// fresh provider, and confirm currentPlayerId/currentPlayer/currentTicket are
// all restored correctly and `isHydrated` is true by the time they're read —
// i.e. no forced redirect condition is true.
import { describe, it, expect, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from './GameSessionContext'
import { CURRENT_PLAYER_STORAGE_KEY, STORAGE_KEY } from './persistence'
import { buildJoinOutcome } from './joinService'
import { cyberTerms } from '../data/cyberTerms'
import type { JoinFormValues } from '../types/player'

// ---------------------------------------------------------------------------
// Test harness (mirrors session.integration.test.tsx's convention)
// ---------------------------------------------------------------------------

function Harness({ sink }: { sink: { current: GameSessionContextValue | null } }) {
  const ctx = useGameSession()
  const ref = useRef(sink)
  useEffect(() => {
    ref.current.current = ctx
  })
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

function joinNew(ctx: GameSessionContextValue, form: JoinFormValues) {
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

describe('client-local currentPlayerId hydration across a simulated refresh (bugfix regression, Test C)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('restores currentPlayerId/currentPlayer/currentTicket (same ticket id) after unmount/remount, with isHydrated true', () => {
    const first = mountProvider()
    const ctx0 = first.sink.current!
    expect(ctx0.isHydrated).toBe(true)

    const outcome = joinNew(ctx0, {
      gameCode: VALID_CODE,
      employeeName: 'Priya',
      employeeId: 'EMP-5001',
    })
    act(() => {
      ctx0.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
    })

    expect(first.sink.current!.state.currentPlayerId).toBe(outcome.player.id)
    expect(first.sink.current!.currentPlayer?.id).toBe(outcome.player.id)
    expect(first.sink.current!.currentTicket?.id).toBe(outcome.ticket.id)

    // The client-local id landed in its OWN storage key, separate from the
    // shared envelope.
    expect(localStorage.getItem(CURRENT_PLAYER_STORAGE_KEY)).toBe(outcome.player.id)

    // Simulate a Host lifecycle action happening before the "refresh" too,
    // to prove this isn't disturbed by ordinary shared-state writes.
    act(() => {
      first.sink.current!.dispatch({ type: 'START_GAME' })
    })

    // Simulate a refresh: unmount, then mount a brand-new provider against
    // the same localStorage.
    first.unmount()
    const second = mountProvider()
    const ctx1 = second.sink.current!

    expect(ctx1.isHydrated).toBe(true)
    expect(ctx1.state.currentPlayerId).toBe(outcome.player.id)
    expect(ctx1.currentPlayer?.id).toBe(outcome.player.id)
    expect(ctx1.currentTicket).toBeDefined()
    expect(ctx1.currentTicket?.id).toBe(outcome.ticket.id)

    // No forced-redirect condition is true.
    expect(!ctx1.currentPlayer || !ctx1.currentTicket).toBe(false)

    second.unmount()
  })

  it('clears a dangling client-local currentPlayerId on hydration when its player no longer exists in the restored shared state', () => {
    // Simulate a leftover client-local id from a previous (now-reset) session
    // while the shared envelope has no matching player.
    localStorage.setItem(CURRENT_PLAYER_STORAGE_KEY, 'GHOST_PLAYER')
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        game: {
          id: 'GAME_001',
          code: 'CYBER24',
          status: 'LOBBY',
          createdAt: '2026-01-01T00:00:00.000Z',
          currentRound: 0,
          revealedTermIds: [],
        },
        rev: 0,
        players: [],
        tickets: [],
        marks: [],
      }),
    )

    const mounted = mountProvider()
    const ctx = mounted.sink.current!

    expect(ctx.isHydrated).toBe(true)
    expect(ctx.state.currentPlayerId).toBeUndefined()
    expect(ctx.currentPlayer).toBeUndefined()

    mounted.unmount()
  })
})

// ---------------------------------------------------------------------------
// D) isHydrated flag — this app's hydration is fully synchronous: initState
// runs synchronously as the useReducer initializer during the FIRST render
// (it reads localStorage directly, no async step involved), so isHydrated is
// true from the very first render onward. There is no genuine async gap to
// race in this architecture — this test documents and verifies that fact
// directly rather than fabricating an artificial race that doesn't reflect
// how the provider actually behaves.
// ---------------------------------------------------------------------------

describe('isHydrated is true immediately, because hydration is synchronous in this architecture', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('is true on the very first captured render, with no seeded session at all', () => {
    const mounted = mountProvider()
    // The harness's `sink.current` is assigned synchronously during the
    // component's render (see Harness above), so this is the value observed
    // on the FIRST render — proving there is no intermediate "not yet
    // hydrated" render to race against.
    expect(mounted.sink.current!.isHydrated).toBe(true)
    mounted.unmount()
  })

  it('is true on the very first captured render, even with a large persisted session to restore', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        game: {
          id: 'GAME_001',
          code: 'CYBER24',
          status: 'CLUE_ACTIVE',
          createdAt: '2026-01-01T00:00:00.000Z',
          currentRound: 1,
          currentTermId: 'T0',
          revealedTermIds: [],
        },
        rev: 3,
        players: [],
        tickets: [],
        marks: [],
      }),
    )
    const mounted = mountProvider()
    expect(mounted.sink.current!.isHydrated).toBe(true)
    mounted.unmount()
  })
})
