// Feature: module-4-term-marking-prize-engine — locked-tap and duplicate-tap
// rejection integration tests (Task 12.7)
//
// These tests drive the *real* GameSessionProvider (with its localStorage
// persistence effect and restore-on-mount logic) and the real reducer, using
// the same Harness/mountProvider convention established in
// marks.integration.test.tsx. Unlike PlayerGame.test.tsx's task 10.2
// component tests — which simulate a UI tap through a disabled button and so
// can never actually dispatch for a LOCKED cell — these tests dispatch
// MARK_TERM directly against the reducer/context, bypassing the UI's own
// tap-guard entirely. This proves validateMarkAttempt itself rejects the
// attempt (not just that the UI declines to call dispatch).
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
import { getMarkedTermIds, validateMarkAttempt } from '../utils/prizeEngine'
import type { JoinFormValues } from '../types/player'

// ---------------------------------------------------------------------------
// Test harness (mirrors marks.integration.test.tsx's convention)
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

describe('mark rejection integration (module-4-term-marking-prize-engine)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // -------------------------------------------------------------------------
  // Task 12.7 — LOCKED-cell rejection (Test F, Req 14.1, 14.2, 18.6)
  // -------------------------------------------------------------------------
  it('dispatching MARK_TERM for an unrevealed term is rejected: no Mark created, prize progress unchanged (Test F, Req 14.1, 14.2, 18.6)', () => {
    const { sink, unmount } = mountProvider()
    const ctx0 = sink.current!

    // Join a real player + ticket. Nothing is revealed yet (game stays in
    // LOBBY), so every one of this ticket's 15 terms is LOCKED.
    const outcome = joinNew(ctx0, {
      gameCode: VALID_CODE,
      employeeName: 'Meera',
      employeeId: 'EMP-4001',
    })
    act(() => {
      ctx0.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
    })

    const lockedTermId = outcome.ticket.rows[0][0].termId
    expect(sink.current!.state.game.revealedTermIds).not.toContain(lockedTermId)

    // Causal check backing PlayerGame's "not revealed yet" UI message: the
    // validation pipeline itself rejects this term for exactly this reason.
    // PlayerGame's tap handler reads this same reason to render the
    // "{term} has not been revealed yet." hint (see design.md, Error
    // Handling table, Req 14.1).
    const validation = validateMarkAttempt(sink.current!.state, lockedTermId)
    expect(validation).toEqual({ valid: false, reason: 'TERM_NOT_REVEALED' })

    const progressBefore = sink.current!.currentPrizeProgress
    const marksBefore = sink.current!.state.marks

    // Dispatch MARK_TERM directly, bypassing any UI tap-guard, to prove the
    // reducer itself (via validateMarkAttempt) rejects an unrevealed term.
    act(() => {
      sink.current!.dispatch({ type: 'MARK_TERM', termId: lockedTermId })
    })

    // No Mark was created.
    expect(sink.current!.state.marks).toEqual(marksBefore)
    expect(sink.current!.state.marks).toHaveLength(0)

    // Every Prize_Progress value is completely unchanged.
    expect(sink.current!.currentPrizeProgress).toEqual(progressBefore)

    // The cell still derives as LOCKED.
    const markedTermIds = getMarkedTermIds(sink.current!.currentPlayerMarks)
    const cellState = deriveCellState(
      lockedTermId,
      sink.current!.state.game.revealedTermIds,
      markedTermIds,
    )
    expect(cellState).toBe('LOCKED')

    unmount()
  })

  // -------------------------------------------------------------------------
  // Task 12.7 — duplicate-tap rejection on an already-MARKED cell
  // (Test G, Req 14.3, 18.7)
  // -------------------------------------------------------------------------
  it('dispatching MARK_TERM a second time for an already-marked term is rejected: no duplicate Mark, prize progress unchanged, cell stays MARKED (Test G, Req 14.3, 18.7)', () => {
    const { sink, unmount } = mountProvider()
    const ctx0 = sink.current!

    const outcome = joinNew(ctx0, {
      gameCode: VALID_CODE,
      employeeName: 'Karan',
      employeeId: 'EMP-4002',
    })
    act(() => {
      ctx0.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
    })

    // Reveal one of this ticket's own terms directly (no need to drive the
    // full clue engine — CALL_NEXT_WORD's target is randomized, so setting up
    // the revealed set via the real START_GAME/CALL_NEXT_WORD cycle, as
    // marks.integration.test.tsx does, is unnecessary here since this test
    // only needs *a* revealed, markable term to set up the already-MARKED
    // precondition).
    act(() => {
      sink.current!.dispatch({ type: 'START_GAME' })
    })
    const ticketTermIds = outcome.ticket.rows.flat().map((c) => c.termId)
    let termId: string | undefined = sink.current!.state.game.revealedTermIds.find((id) =>
      ticketTermIds.includes(id),
    )
    const activeTermCount = cyberTerms.filter((t) => t.active).length
    for (let i = 0; i < activeTermCount && !termId; i++) {
      if (sink.current!.state.game.status === 'COMPLETED') break
      act(() => {
        sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
      })
      const revealedTermIds = sink.current!.state.game.revealedTermIds
      termId = revealedTermIds.find((id) => ticketTermIds.includes(id))
    }
    expect(termId).toBeTruthy()
    const revealedTermId: string = termId!

    // Mark it once successfully.
    act(() => {
      sink.current!.dispatch({ type: 'MARK_TERM', termId: revealedTermId })
    })
    expect(sink.current!.state.marks).toHaveLength(1)

    // Causal check: validateMarkAttempt itself already flags a second
    // attempt as a duplicate before we even dispatch again.
    const validation = validateMarkAttempt(sink.current!.state, revealedTermId)
    expect(validation).toEqual({ valid: false, reason: 'DUPLICATE_MARK' })

    const marksBefore = sink.current!.state.marks
    const progressBefore = sink.current!.currentPrizeProgress

    // Dispatch MARK_TERM again for the same term.
    act(() => {
      sink.current!.dispatch({ type: 'MARK_TERM', termId: revealedTermId })
    })

    // No duplicate Mark was created.
    expect(sink.current!.state.marks).toHaveLength(1)
    expect(sink.current!.state.marks).toEqual(marksBefore)

    // Every Prize_Progress value is completely unchanged.
    expect(sink.current!.currentPrizeProgress).toEqual(progressBefore)

    // The cell's derived state is still MARKED.
    const markedTermIds = getMarkedTermIds(sink.current!.currentPlayerMarks)
    const cellState = deriveCellState(
      revealedTermId,
      sink.current!.state.game.revealedTermIds,
      markedTermIds,
    )
    expect(cellState).toBe('MARKED')

    unmount()
  })
})
