// Feature: module-4-term-marking-prize-engine — cross-tab mark sync
// integration test (Task 12.3, Req 6.1, 6.2)
//
// These tests drive TWO independent GameSessionProvider instances (each with
// its own createSyncChannel() call, simulating two separate browser tabs)
// against the real reducer, joinService, and prizeEngine. No mocks or fake
// data are used. The two providers share the same BroadcastChannel name
// (SYNC_CHANNEL_NAME), which — per Module 3's syncChannel.test.ts — already
// delivers messages across independently-constructed channels within the
// same jsdom test process, so no additional test-only bridging is required.
import { describe, it, expect, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from './GameSessionContext'
import { buildJoinOutcome } from './joinService'
import { cyberTerms } from '../data/cyberTerms'
import { deriveCellState } from '../utils/deriveCellState'
import { getMarkedTermIds } from '../utils/prizeEngine'
import type { JoinFormValues } from '../types/player'

// ---------------------------------------------------------------------------
// Test harness (mirrors marks.integration.test.tsx / session.integration.test.tsx)
// ---------------------------------------------------------------------------

/**
 * A tiny harness that captures the live context value on every render into a
 * ref supplied by the test. This lets a test dispatch actions and read state
 * from outside the React tree while still exercising the real provider,
 * reducer, selectors, and sync effect.
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

/**
 * Allow queued BroadcastChannel message events to flush (see
 * syncChannel.test.ts). Wrapped in `act()` because the flushed message
 * triggers a state update in the *other* tab's provider, outside of the
 * dispatch call that originated it.
 */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

const hasBroadcastChannel =
  typeof (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel === 'function'

describe.runIf(hasBroadcastChannel)(
  'cross-tab mark sync integration (module-4-term-marking-prize-engine)',
  () => {
    beforeEach(() => {
      localStorage.clear()
    })

    it("syncs a Mark created in tab 1 to tab 2's state.marks and derived cell state (Req 6.1, 6.2)", async () => {
      // "Tab 1" and "Tab 2" are two independent provider mounts, each with its
      // own createSyncChannel() instance sharing the same BroadcastChannel name.
      const tab1 = mountProvider()
      const tab2 = mountProvider()
      await flush()

      const ctx1 = tab1.sink.current!

      // Join a real player + ticket in tab 1.
      const outcome = joinNew(ctx1, {
        gameCode: VALID_CODE,
        employeeName: 'Asha',
        employeeId: 'EMP-3001',
      })
      act(() => {
        tab1.sink.current!.dispatch({
          type: 'JOIN_PLAYER',
          player: outcome.player,
          ticket: outcome.ticket,
        })
      })
      await flush()

      // Tab 2 receives the synced game/players/tickets via BroadcastChannel.
      expect(tab2.sink.current!.state.players).toHaveLength(1)
      expect(tab2.sink.current!.state.players[0].id).toBe(outcome.player.id)
      expect(tab2.sink.current!.state.tickets).toHaveLength(1)
      expect(tab2.sink.current!.state.tickets[0].id).toBe(outcome.ticket.id)

      // Start the game in tab 1 and reveal clues one at a time until one of
      // the player's own ticket terms has been revealed (selectNextTerm picks
      // randomly from the whole active term bank). cyberTerms is finite, so
      // bound the loop by the active term count to avoid ever hanging.
      act(() => {
        tab1.sink.current!.dispatch({ type: 'START_GAME' })
      })
      await flush()

      const ticketTermIds = outcome.ticket.rows.flat().map((c) => c.termId)
      let termId: string | undefined
      const activeTermCount = cyberTerms.filter((t) => t.active).length
      // Tab 1's START_GAME already called the first term; check it, then call
      // subsequent words until one matches the ticket (Module 5: calling and
      // revealing are the same step).
      const initialRevealed = tab1.sink.current!.state.game.revealedTermIds
      termId = initialRevealed.find((id) => ticketTermIds.includes(id))
      for (let i = 0; i < activeTermCount && !termId; i++) {
        if (tab1.sink.current!.state.game.status === 'COMPLETED') break
        act(() => {
          tab1.sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
        })
        const revealedTermIds = tab1.sink.current!.state.game.revealedTermIds
        termId = revealedTermIds.find((id) => ticketTermIds.includes(id))
      }
      expect(termId).toBeTruthy()
      const revealedTermId: string = termId!
      await flush()

      // Tab 2's game state (including the reveal) is in sync before marking.
      expect(tab2.sink.current!.state.game.revealedTermIds).toContain(revealedTermId)
      expect(tab2.sink.current!.state.marks).toEqual([])

      // Dispatch MARK_TERM in tab 1, exactly as PlayerGame's tap handler would.
      act(() => {
        tab1.sink.current!.dispatch({ type: 'MARK_TERM', termId: revealedTermId })
      })
      await flush()

      const tab1Marks = tab1.sink.current!.state.marks
      expect(tab1Marks).toHaveLength(1)
      const createdMark = tab1Marks[0]
      expect(createdMark.termId).toBe(revealedTermId)
      expect(createdMark.playerId).toBe(outcome.player.id)
      expect(createdMark.ticketId).toBe(outcome.ticket.id)

      // Tab 2's raw marks now include the synced Mark (Req 6.1, 6.2).
      const tab2Marks = tab2.sink.current!.state.marks
      expect(tab2Marks).toHaveLength(1)
      expect(tab2Marks[0]).toEqual(createdMark)

      // Tab 2's downstream derived cell state also resolves to MARKED, proving
      // the sync flows all the way through to the UI-facing derivation.
      const tab2MarkedTermIds = getMarkedTermIds(tab2Marks)
      const tab2CellState = deriveCellState(
        revealedTermId,
        tab2.sink.current!.state.game.revealedTermIds,
        tab2MarkedTermIds,
      )
      expect(tab2CellState).toBe('MARKED')

      tab1.unmount()
      tab2.unmount()
    })

    // -------------------------------------------------------------------------
    // Bugfix regression (Test C) — a stale broadcast must never erase a
    // fresher tab's marks.
    //
    // The real defect required tab A to dispatch an action *while still
    // holding a stale local copy of `marks`* (i.e. before its own
    // BroadcastChannel subscription had delivered tab B's newer marks). That
    // specific race — "dispatch fires in the gap between tab B's postMessage
    // and tab A's message handler running" — is not something this harness
    // can force deterministically: BroadcastChannel delivery in jsdom is
    // real async message-queue delivery, and by the time `flush()` returns
    // both tabs are already caught up, so a genuinely stale in-flight
    // dispatch can't be reproduced without racy, flaky timing assertions.
    //
    // The exact scenario (Host mid-flight on stale state broadcasting over a
    // Player's fresher marks) is instead covered deterministically at the
    // reducer level in staleSyncRejection.test.ts, which constructs the two
    // tabs' states directly and asserts SYNC_LOCAL's upsert-by-id never
    // drops a mark regardless of payload ordering/completeness. What we CAN
    // verify here, at the full integration level, is the
    // complementary real-world guarantee: once tab 2 has received a Mark via
    // sync, nothing tab 1 broadcasts afterwards (including a REVEAL_ANSWER
    // that only touches `game`) ever wipes it back out — i.e. no observable
    // mark loss across a real BroadcastChannel exchange, end to end.
    //
    // Manual multi-tab verification (practical stand-in for true multi-process
    // timing): open two real browser tabs on /player and /host, join a player
    // in tab 1, reveal a term, mark it in tab 1, then rapidly click "Reveal
    // Answer" in tab 2 (host) before tab 2 has visibly updated its player
    // count — the mark must remain MARKED in tab 1 afterwards.
    it("a Mark synced into tab 2 survives tab 1 broadcasting further game-only changes (Req 6.1, 6.2, bugfix regression)", async () => {
      const tab1 = mountProvider()
      const tab2 = mountProvider()
      await flush()

      const ctx1 = tab1.sink.current!
      const outcome = joinNew(ctx1, {
        gameCode: VALID_CODE,
        employeeName: 'Bhavin',
        employeeId: 'EMP-3002',
      })
      act(() => {
        tab1.sink.current!.dispatch({
          type: 'JOIN_PLAYER',
          player: outcome.player,
          ticket: outcome.ticket,
        })
      })
      await flush()

      act(() => {
        tab1.sink.current!.dispatch({ type: 'START_GAME' })
      })
      await flush()

      const ticketTermIds = outcome.ticket.rows.flat().map((c) => c.termId)
      let termId: string | undefined
      const activeTermCount = cyberTerms.filter((t) => t.active).length
      const initialRevealed = tab1.sink.current!.state.game.revealedTermIds
      termId = initialRevealed.find((id) => ticketTermIds.includes(id))
      for (let i = 0; i < activeTermCount && !termId; i++) {
        if (tab1.sink.current!.state.game.status === 'COMPLETED') break
        act(() => {
          tab1.sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
        })
        const revealedTermIds = tab1.sink.current!.state.game.revealedTermIds
        termId = revealedTermIds.find((id) => ticketTermIds.includes(id))
      }
      expect(termId).toBeTruthy()
      const revealedTermId: string = termId!
      await flush()

      act(() => {
        tab1.sink.current!.dispatch({ type: 'MARK_TERM', termId: revealedTermId })
      })
      await flush()

      // Tab 2 has synced the Mark.
      expect(tab2.sink.current!.state.marks).toHaveLength(1)

      // Tab 1 now broadcasts a game-only change (CALL_NEXT_WORD or, if the
      // bank is exhausted, RESUME_GAME) — this must not disturb tab 2's marks.
      act(() => {
        if (tab1.sink.current!.state.game.status !== 'COMPLETED') {
          tab1.sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
        } else {
          tab1.sink.current!.dispatch({ type: 'RESUME_GAME' })
        }
      })
      await flush()

      expect(tab2.sink.current!.state.marks).toHaveLength(1)
      expect(tab2.sink.current!.state.marks[0].termId).toBe(revealedTermId)

      tab1.unmount()
      tab2.unmount()
    })
  },
)
