// Feature: module-4-term-marking-prize-engine — full-row Line prize
// eligibility integration test (task 12.5, Test D).
//
// These tests drive the *real* GameSessionProvider (with its localStorage
// persistence effect and restore-on-mount logic), the real reducer, and the
// real joinService/prizeEngine. No mocks or fake data are used: a player and
// ticket are built through buildJoinOutcome() exactly as the PlayerJoin
// screen does, terms are revealed through the real START_GAME/REVEAL_ANSWER/
// LOAD_NEXT_CLUE actions, and MARK_TERM is dispatched exactly as PlayerGame
// would.
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
import type { JoinFormValues } from '../types/player'
import type { PrizeId } from '../types/prize'

// ---------------------------------------------------------------------------
// Test harness (mirrors marks.integration.test.tsx's convention)
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

/** Row index -> the Line_Prize id/label it backs (design.md LINE_PRIZE_ROWS). */
const ROW_PRIZES: { row: number; prizeId: PrizeId }[] = [
  { row: 0, prizeId: 'FIREWALL_LINE' },
  { row: 1, prizeId: 'SECURITY_LINE' },
  { row: 2, prizeId: 'DATA_DEFENDER_LINE' },
]

const ALL_LINE_PRIZE_IDS: PrizeId[] = [
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
]

describe('full-row Line prize eligibility integration (module-4-term-marking-prize-engine, Test D)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it.each(ROW_PRIZES)(
    'marking all 5 cells in row $row makes $prizeId eligible at 5/5 while the other Line prizes stay unchanged',
    ({ row, prizeId }) => {
      const harness = mountProvider()
      const ctx0 = harness.sink.current!

      // Join a real player + ticket.
      const outcome = joinNew(ctx0, {
        gameCode: VALID_CODE,
        employeeName: `Player-row-${row}`,
        employeeId: `EMP-ROW-${row}`,
      })
      act(() => {
        ctx0.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
      })

      act(() => {
        harness.sink.current!.dispatch({ type: 'START_GAME' })
      })

      // The other two Line prizes' progress before any marking, to assert
      // against later (should remain at these same values since no marks
      // will land on their rows).
      const priorOtherProgress = new Map<PrizeId, { current: number; target: number }>()
      for (const otherId of ALL_LINE_PRIZE_IDS) {
        if (otherId === prizeId) continue
        const p = harness.sink.current!.currentPrizeProgress.find((pr) => pr.id === otherId)
        priorOtherProgress.set(otherId, { current: p?.current ?? 0, target: p?.target ?? 5 })
      }

      // Reveal terms (via CALL_NEXT_WORD, bounded-loop pattern since
      // selectNextTerm is random) until all 5 of this row's termIds have
      // been revealed. cyberTerms is finite, so bound the loop by the active
      // term count to avoid ever hanging.
      const rowTermIds = outcome.ticket.rows[row].map((cell) => cell.termId)
      const revealedRowTermIds = new Set<string>()
      const activeTermCount = cyberTerms.filter((t) => t.active).length

      for (const id of rowTermIds) {
        if (harness.sink.current!.state.game.revealedTermIds.includes(id)) {
          revealedRowTermIds.add(id)
        }
      }

      for (
        let i = 0;
        i < activeTermCount && revealedRowTermIds.size < rowTermIds.length;
        i++
      ) {
        if (harness.sink.current!.state.game.status === 'COMPLETED') break
        act(() => {
          harness.sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
        })
        const revealedTermIds = harness.sink.current!.state.game.revealedTermIds
        for (const id of rowTermIds) {
          if (revealedTermIds.includes(id)) revealedRowTermIds.add(id)
        }
      }

      expect(revealedRowTermIds.size).toBe(rowTermIds.length)

      // Mark all 5 of the row's terms exactly as PlayerGame's tap handler
      // would.
      for (const termId of rowTermIds) {
        act(() => {
          harness.sink.current!.dispatch({ type: 'MARK_TERM', termId })
        })
      }

      const finalProgress = harness.sink.current!.currentPrizeProgress
      const linePrizeProgress = finalProgress.find((p) => p.id === prizeId)
      expect(linePrizeProgress).toEqual({
        id: prizeId,
        label: expect.any(String),
        current: 5,
        target: 5,
      })

      // The other two Line prizes remain at their prior values (no marks
      // landed on their rows).
      for (const otherId of ALL_LINE_PRIZE_IDS) {
        if (otherId === prizeId) continue
        const otherProgress = finalProgress.find((p) => p.id === otherId)
        const prior = priorOtherProgress.get(otherId)!
        expect(otherProgress?.current).toBe(prior.current)
        expect(otherProgress?.target).toBe(prior.target)
      }

      harness.unmount()
    },
  )
})
