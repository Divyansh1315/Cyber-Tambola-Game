// Feature: module-5-prize-claim-processing-winner-management — claims/winners
// persistence-across-refresh integration test (task 15.2).
//
// Drives the *real* GameSessionProvider (with its localStorage persistence
// effect and restore-on-mount logic), the real reducer, and the real
// joinService/prizeEngine/claimEngine/winnerEngine. A player submits a
// CYBER_FIVE claim, the host confirms it, the whole component tree is
// unmounted (simulating a page refresh/close), `localStorage` is inspected
// directly to prove the claim/winner were actually written to disk, and then
// a brand new GameSessionProvider instance is mounted and asserted to
// restore the exact same claim and winner.
//
// Validates: Requirements 16.3, 20.3
import { describe, it, expect, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from './GameSessionContext'
import { buildJoinOutcome } from './joinService'
import { STORAGE_KEY, parseEnvelope } from './persistence'
import { cyberTerms } from '../data/cyberTerms'
import type { JoinFormValues } from '../types/player'

// ---------------------------------------------------------------------------
// Test harness (mirrors lineProgress.integration.test.tsx's convention)
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

describe('claims/winners persist across a simulated page refresh (module-5-prize-claim-processing-winner-management)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('restores the same confirmed claim and winner from localStorage after unmount + remount (Req 16.3, 20.3)', () => {
    // --- Phase 1: join, mark 5 terms (Cyber Five target), submit + confirm ---
    const before = mountProvider()
    const ctx0 = before.sink.current!

    const outcome = joinNew(ctx0, {
      gameCode: VALID_CODE,
      employeeName: 'Refresh Tester',
      employeeId: 'EMP-REFRESH-1',
    })
    act(() => {
      ctx0.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
    })

    act(() => {
      before.sink.current!.dispatch({ type: 'START_GAME' })
    })

    // Reveal + mark terms until Cyber Five (any 5 marked cells) is at 5/5.
    const activeTermCount = cyberTerms.filter((t) => t.active).length
    const ticketTermIds = new Set(
      outcome.ticket.rows.flatMap((row) => row.map((cell) => cell.termId)),
    )
    const markedTermIds = new Set<string>()

    for (let i = 0; i < activeTermCount && markedTermIds.size < 5; i++) {
      if (before.sink.current!.state.game.status === 'COMPLETED') break
      act(() => {
        before.sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
      })
      const currentTermId = before.sink.current!.state.game.currentTermId
      if (
        currentTermId &&
        ticketTermIds.has(currentTermId) &&
        !markedTermIds.has(currentTermId)
      ) {
        act(() => {
          before.sink.current!.dispatch({ type: 'MARK_TERM', termId: currentTermId })
        })
        markedTermIds.add(currentTermId)
      }
    }

    expect(markedTermIds.size).toBe(5)
    const cyberFiveProgress = before.sink.current!.currentPrizeProgress.find(
      (p) => p.id === 'CYBER_FIVE',
    )
    expect(cyberFiveProgress).toEqual({ id: 'CYBER_FIVE', label: 'Cyber Five', current: 5, target: 5 })

    // Submit the claim exactly as PlayerGame's claim button would.
    act(() => {
      before.sink.current!.dispatch({
        type: 'SUBMIT_PRIZE_CLAIM',
        playerId: outcome.player.id,
        ticketId: outcome.ticket.id,
        prizeId: 'CYBER_FIVE',
      })
    })

    const submittedClaim = before.sink.current!.state.claims.find(
      (c) => c.playerId === outcome.player.id && c.prizeId === 'CYBER_FIVE',
    )
    expect(submittedClaim).toBeDefined()
    expect(submittedClaim!.validationStatus).toBe('VALID')
    expect(submittedClaim!.hostDecision).toBe('PENDING')

    // Confirm the claim exactly as the Host Dashboard's Confirm button would.
    act(() => {
      before.sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: submittedClaim!.id })
    })

    const confirmedClaim = before.sink.current!.state.claims.find(
      (c) => c.id === submittedClaim!.id,
    )
    const winner = before.sink.current!.state.winners.find(
      (w) => w.claimId === submittedClaim!.id,
    )
    expect(confirmedClaim!.hostDecision).toBe('CONFIRMED')
    expect(winner).toBeDefined()

    // --- Phase 2: simulate a page refresh/close ---
    before.unmount()

    // --- Phase 3: inspect localStorage directly, before remounting anything ---
    const raw = window.localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()

    const persisted = parseEnvelope(raw)
    expect(persisted).not.toBeNull()

    const persistedClaim = persisted!.claims.find((c) => c.id === submittedClaim!.id)
    const persistedWinner = persisted!.winners.find((w) => w.id === winner!.id)
    expect(persistedClaim).toBeDefined()
    expect(persistedClaim!.hostDecision).toBe('CONFIRMED')
    expect(persistedClaim!.validationStatus).toBe('VALID')
    expect(persistedWinner).toBeDefined()
    expect(persistedWinner!.claimId).toBe(submittedClaim!.id)
    expect(persistedWinner!.playerId).toBe(outcome.player.id)
    expect(persistedWinner!.prizeId).toBe('CYBER_FIVE')

    // --- Phase 4: mount a fresh provider instance ("after refresh") ---
    const after = mountProvider()
    const restoredState = after.sink.current!.state

    const restoredClaim = restoredState.claims.find((c) => c.id === submittedClaim!.id)
    const restoredWinner = restoredState.winners.find((w) => w.id === winner!.id)

    expect(restoredClaim).toEqual(confirmedClaim)
    expect(restoredWinner).toEqual(winner)

    // Sanity: the restored player/ticket that back the claim/winner are also
    // still present (Req 20.3 — "restore the same player, ticket, marks,
    // claims, and winners without loss").
    expect(restoredState.players.some((p) => p.id === outcome.player.id)).toBe(true)
    expect(restoredState.tickets.some((t) => t.id === outcome.ticket.id)).toBe(true)
    expect(restoredState.marks.length).toBeGreaterThanOrEqual(5)

    after.unmount()
  })
})
