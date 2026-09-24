// Feature: module-4-term-marking-prize-engine — end-to-end integration tests
//
// These tests drive the *real* GameSessionProvider (with its localStorage
// persistence effect and restore-on-mount logic), the real reducer, and the
// real joinService/prizeEngine. No mocks or fake data are used: a player and
// ticket are built through buildJoinOutcome() exactly as the PlayerJoin
// screen does, a term is revealed through the real START_GAME/REVEAL_ANSWER
// actions, and MARK_TERM is dispatched exactly as PlayerGame would.
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
import { cyberTerms } from '../data/cyberTerms'
import { deriveCellState } from '../utils/deriveCellState'
import { getMarkedTermIds, isPrizeEligible } from '../utils/prizeEngine'
import type { JoinFormValues } from '../types/player'

// ---------------------------------------------------------------------------
// Test harness (mirrors session.integration.test.tsx's convention)
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

describe('marks persistence integration (module-4-term-marking-prize-engine)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // -------------------------------------------------------------------------
  // Task 12.1 — Mark persists across a simulated refresh (Test B, Req 5.3, 18.2)
  // -------------------------------------------------------------------------
  it('restores a created Mark after an unmount/remount, with the same MARKED cell and matching prize progress (Test B, Req 5.3, 18.2)', () => {
    const first = mountProvider()
    const ctx0 = first.sink.current!

    // Join a real player + ticket.
    const outcome = joinNew(ctx0, {
      gameCode: VALID_CODE,
      employeeName: 'Asha',
      employeeId: 'EMP-2001',
    })
    act(() => {
      ctx0.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
    })

    // Start the game, then reveal clues one at a time until one of the
    // player's own ticket terms has been revealed. The game engine picks the
    // next clue randomly from the whole active term bank (not just this
    // ticket's 15 terms), so it may take a few rounds before a ticket term
    // comes up. cyberTerms is finite, so bound the loop by the active term
    // count to avoid ever hanging.
    act(() => {
      first.sink.current!.dispatch({ type: 'START_GAME' })
    })

    const ticketTermIds = outcome.ticket.rows.flat().map((c) => c.termId)
    let termId: string | undefined = first.sink.current!.state.game.revealedTermIds.find((id) =>
      ticketTermIds.includes(id),
    )
    const activeTermCount = cyberTerms.filter((t) => t.active).length
    for (let i = 0; i < activeTermCount && !termId; i++) {
      if (first.sink.current!.state.game.status === 'COMPLETED') break
      act(() => {
        first.sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
      })
      const revealedTermIds = first.sink.current!.state.game.revealedTermIds
      termId = revealedTermIds.find((id) => ticketTermIds.includes(id))
    }
    expect(termId).toBeTruthy()
    const revealedTermId: string = termId!

    // Mark that revealed term exactly as PlayerGame's tap handler would.
    act(() => {
      first.sink.current!.dispatch({ type: 'MARK_TERM', termId: revealedTermId })
    })

    const beforeState = first.sink.current!.state
    const beforeMarks = beforeState.marks
    expect(beforeMarks).toHaveLength(1)
    const createdMark = beforeMarks[0]
    expect(createdMark.playerId).toBe(outcome.player.id)
    expect(createdMark.ticketId).toBe(outcome.ticket.id)
    expect(createdMark.termId).toBe(revealedTermId)
    expect(createdMark.valid).toBe(true)

    const beforeProgress = first.sink.current!.currentPrizeProgress
    const beforeMarkedTermIds = getMarkedTermIds(first.sink.current!.currentPlayerMarks)
    const beforeCellState = deriveCellState(
      revealedTermId,
      beforeState.game.revealedTermIds,
      beforeMarkedTermIds,
    )
    expect(beforeCellState).toBe('MARKED')

    // Read the raw persisted envelope directly and assert it contains the
    // new Mark (Req 5.1, 5.2).
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!).version).toBe(4)
    const persisted = parseEnvelope(raw)
    expect(persisted).not.toBeNull()
    expect(persisted!.marks).toHaveLength(1)
    expect(persisted!.marks[0]).toEqual(createdMark)

    // Simulate a page refresh: unmount and mount a fresh provider against
    // the same localStorage.
    first.unmount()
    const second = mountProvider()
    const ctx1 = second.sink.current!

    // The same Mark is restored (Req 5.3).
    expect(ctx1.state.marks).toHaveLength(1)
    expect(ctx1.state.marks[0]).toEqual(createdMark)

    // The player/ticket/game are restored identically too.
    expect(ctx1.currentPlayer?.id).toBe(outcome.player.id)
    expect(ctx1.currentTicket?.id).toBe(outcome.ticket.id)
    expect(ctx1.state.game).toEqual(beforeState.game)

    // The corresponding cell still derives as MARKED after restore.
    const afterMarkedTermIds = getMarkedTermIds(ctx1.currentPlayerMarks)
    const afterCellState = deriveCellState(
      revealedTermId,
      ctx1.state.game.revealedTermIds,
      afterMarkedTermIds,
    )
    expect(afterCellState).toBe('MARKED')

    // Prize progress values match their pre-refresh values exactly.
    expect(ctx1.currentPrizeProgress).toEqual(beforeProgress)

    second.unmount()
  })

  // -------------------------------------------------------------------------
  // Task 12.4 — Five distinct marked terms make Cyber Five eligible (Test C, Req 8.3, 18.3)
  // -------------------------------------------------------------------------
  it('marking 5 distinct revealed terms via real dispatches makes Cyber Five 5/5 and eligible (Test C, Req 8.3, 18.3)', () => {
    const { sink, unmount } = mountProvider()
    const ctx0 = sink.current!

    // Join a real player + ticket.
    const outcome = joinNew(ctx0, {
      gameCode: VALID_CODE,
      employeeName: 'Rohit',
      employeeId: 'EMP-3001',
    })
    act(() => {
      ctx0.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
    })

    act(() => {
      sink.current!.dispatch({ type: 'START_GAME' })
    })

    // Reveal clues one at a time (real CALL_NEXT_WORD cycle) until at least 5
    // of this ticket's own 15 termIds have been revealed. The engine picks
    // the next word randomly from the whole active term bank, so this is
    // bounded by the active term count exactly like the Task 12.1 test
    // above, to guarantee it can never hang.
    const ticketTermIds = outcome.ticket.rows.flat().map((c) => c.termId)
    const activeTermCount = cyberTerms.filter((t) => t.active).length
    let revealedOnTicket: string[] = sink.current!.state.game.revealedTermIds.filter((id) =>
      ticketTermIds.includes(id),
    )
    for (let i = 0; i < activeTermCount && revealedOnTicket.length < 5; i++) {
      if (sink.current!.state.game.status === 'COMPLETED') break
      act(() => {
        sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
      })
      const revealedTermIds = sink.current!.state.game.revealedTermIds
      revealedOnTicket = revealedTermIds.filter((id) => ticketTermIds.includes(id))
    }
    expect(revealedOnTicket.length).toBeGreaterThanOrEqual(5)

    // Mark exactly 5 distinct revealed termIds that are on the ticket, via
    // real MARK_TERM dispatches (not pre-seeded marks).
    const fiveTermIds = revealedOnTicket.slice(0, 5)
    for (const termId of fiveTermIds) {
      act(() => {
        sink.current!.dispatch({ type: 'MARK_TERM', termId })
      })
    }

    expect(sink.current!.state.marks).toHaveLength(5)

    const cyberFive = sink.current!.currentPrizeProgress.find(
      (p) => p.id === 'CYBER_FIVE',
    )
    expect(cyberFive).toBeDefined()
    expect(cyberFive).toMatchObject({ current: 5, target: 5 })
    expect(isPrizeEligible(cyberFive!)).toBe(true)

    unmount()
  })

  // -------------------------------------------------------------------------
  // Task 12.6 — Full-ticket Cyber Full House eligibility (Test E, Req 10.3, 18.5)
  // -------------------------------------------------------------------------
  it('marks all 15 ticket terms and reaches Cyber Full House 15/15 eligible, while Cyber Five caps at 5/5 (Test E, Req 10.3, 18.5)', () => {
    const harness = mountProvider()
    const ctx0 = harness.sink.current!

    const outcome = joinNew(ctx0, {
      gameCode: VALID_CODE,
      employeeName: 'Ravi',
      employeeId: 'EMP-4001',
    })
    act(() => {
      ctx0.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
    })

    act(() => {
      harness.sink.current!.dispatch({ type: 'START_GAME' })
    })

    const ticketTermIds = outcome.ticket.rows.flat().map((c) => c.termId)
    const remaining = new Set(ticketTermIds)
    const activeTermCount = cyberTerms.filter((t) => t.active).length

    // The first term is already revealed by START_GAME (Module 5); mark it
    // immediately if it belongs to this ticket before entering the loop.
    for (const termId of [...remaining]) {
      if (harness.sink.current!.state.game.revealedTermIds.includes(termId)) {
        act(() => {
          harness.sink.current!.dispatch({ type: 'MARK_TERM', termId })
        })
        remaining.delete(termId)
      }
    }

    // Call the next word one at a time from the whole active term bank;
    // whenever a newly-called term belongs to this ticket, mark it
    // immediately (interleaved call + mark), exactly like the refresh test
    // above. Bound the loop by the active term count so it always
    // terminates even if this ticket's 15 terms are spread thinly across
    // many rounds.
    for (let i = 0; i < activeTermCount && remaining.size > 0; i++) {
      const statusBeforeCall: string = harness.sink.current!.state.game.status
      if (statusBeforeCall === 'COMPLETED') break

      act(() => {
        harness.sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
      })

      const revealedTermIds = harness.sink.current!.state.game.revealedTermIds
      for (const termId of [...remaining]) {
        if (revealedTermIds.includes(termId)) {
          act(() => {
            harness.sink.current!.dispatch({ type: 'MARK_TERM', termId })
          })
          remaining.delete(termId)
        }
      }
    }

    expect(remaining.size).toBe(0)
    expect(harness.sink.current!.currentPlayerMarks).toHaveLength(15)

    const progress = harness.sink.current!.currentPrizeProgress
    const fullHouse = progress.find((p) => p.id === 'CYBER_FULL_HOUSE')
    expect(fullHouse).toEqual({
      id: 'CYBER_FULL_HOUSE',
      label: 'Cyber Full House',
      current: 15,
      target: 15,
    })
    expect(isPrizeEligible(fullHouse!)).toBe(true)

    // Sanity check: Cyber Five caps at 5/5 even though all 15 terms are
    // marked, and is itself eligible.
    const cyberFive = progress.find((p) => p.id === 'CYBER_FIVE')
    expect(cyberFive).toEqual({
      id: 'CYBER_FIVE',
      label: 'Cyber Five',
      current: 5,
      target: 5,
    })
    expect(isPrizeEligible(cyberFive!)).toBe(true)

    harness.unmount()
  })
})
