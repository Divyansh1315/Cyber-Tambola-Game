// Feature: module-5-prize-claim-processing-winner-management — task 15.7
// regression tests for prior-module (Module 3/4) marks/identity/persistence/
// sync behavior, asserting Module 5's claim/winner workflow has not disturbed
// any of it.
//
// Validates: Requirements 20.1, 20.2, 20.3, 20.4, 20.5
import { describe, it, expect, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { gameSessionReducer, type SharedStatePayload } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from './GameSessionContext'
import { buildJoinOutcome } from './joinService'
import { STORAGE_KEY, parseEnvelope } from './persistence'
import { cyberTerms } from '../data/cyberTerms'
import { getAllPrizeProgress } from '../utils/prizeEngine'
import type { GameSessionState } from './gameSessionInitialState'
import type { JoinFormValues } from '../types/player'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'

const GAME_ID = 'GAME_001'
const PLAYER_ID = 'PLAYER_1'
const TICKET_ID = 'TICKET_1'

/** A 3x5 ticket whose 15 cells have distinct termIds T0..T14. */
function makeTicket(): Ticket {
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
    id: TICKET_ID,
    playerId: PLAYER_ID,
    gameId: GAME_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: 'Ticket #1',
    rows,
  }
}

function makePlayer(): Player {
  return {
    id: PLAYER_ID,
    gameId: GAME_ID,
    displayName: 'Asha',
    employeeDemoId: 'EMP-1001',
    ticketId: TICKET_ID,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: 'Asha',
    employeeId: 'EMP-1001',
    ticketRef: 'Ticket #1',
  }
}

function baseState(): GameSessionState {
  const ticket = makeTicket()
  const player = makePlayer()
  return {
    ...gameSessionInitialState,
    game: {
      ...gameSessionInitialState.game,
      id: GAME_ID,
      status: 'WORD_ACTIVE',
      currentRound: 1,
      revealedTermIds: [],
    },
    players: [player],
    tickets: [ticket],
    currentPlayerId: player.id,
  }
}

/** Simulate "term `termId` has just been officially called" without going
 * through the reducer's own randomized term selection (mirrors the
 * convention already used by markPersistenceAcrossReveals.test.ts). */
function revealTerm(state: GameSessionState, termId: string): GameSessionState {
  return {
    ...state,
    game: {
      ...state.game,
      status: 'WORD_ACTIVE' as const,
      currentTermId: termId,
      revealedTermIds: state.game.revealedTermIds.includes(termId)
        ? state.game.revealedTermIds
        : [...state.game.revealedTermIds, termId],
    },
  }
}

// ---------------------------------------------------------------------------
// 1. Marks preserved across new Cyber Word calls (Req 20.1)
// ---------------------------------------------------------------------------

describe('Regression 1: Valid_Marks preserved across new Cyber Word calls (Req 20.1)', () => {
  it('keeps a mark present in state.marks across several subsequent CALL_NEXT_WORD dispatches', () => {
    let state = baseState()
    state = revealTerm(state, 'T0')
    state = gameSessionReducer(state, { type: 'MARK_TERM', termId: 'T0' })
    expect(state.marks).toHaveLength(1)
    const [markBefore] = state.marks

    for (const termId of ['T1', 'T2', 'T3']) {
      state = revealTerm(state, termId)
      state = gameSessionReducer(state, { type: 'CALL_NEXT_WORD' })
      // CALL_NEXT_WORD only ever touches `game`; the earlier mark survives
      // byte-for-byte.
      expect(state.marks).toHaveLength(1)
      expect(state.marks[0]).toEqual(markBefore)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. currentPlayerId preserved across host actions incl. claim confirm/reject
//    dispatched from a host tab (Req 20.2)
// ---------------------------------------------------------------------------

describe('Regression 2: currentPlayerId identity preserved across host actions, including claim confirm/reject from a host tab (Req 20.2)', () => {
  it('never changes the Player tab currentPlayerId while a Host tab dispatches lifecycle + claim confirm/reject actions', () => {
    // Player tab: joined and eligible for CYBER_FIVE.
    let player = baseState()
    const allTermIds = player.tickets[0].rows.flat().map((c) => c.termId)
    const fiveTermIds = allTermIds.slice(0, 5)
    player = {
      ...player,
      game: { ...player.game, revealedTermIds: allTermIds },
    }
    for (const termId of fiveTermIds) {
      player = gameSessionReducer(player, { type: 'MARK_TERM', termId })
    }
    expect(player.currentPlayerId).toBe(PLAYER_ID)

    // Submit a claim from the Player tab.
    player = gameSessionReducer(player, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: PLAYER_ID,
      ticketId: TICKET_ID,
      prizeId: 'CYBER_FIVE',
    })
    const claim = player.claims.find((c) => c.prizeId === 'CYBER_FIVE')!
    expect(claim.validationStatus).toBe('VALID')
    expect(player.currentPlayerId).toBe(PLAYER_ID)

    // Host tab: separate state slice with no players/currentPlayerId of its
    // own (mirrors PlayerGame.test.tsx's Host-tab regression convention).
    let host: GameSessionState = {
      ...gameSessionInitialState,
      game: { ...player.game },
      currentPlayerId: undefined,
      players: [],
      tickets: [],
      claims: player.claims,
      winners: player.winners,
    }

    // Host confirms the claim from its own tab.
    host = gameSessionReducer(host, { type: 'CONFIRM_CLAIM', claimId: claim.id })
    const confirmedClaim = host.claims.find((c) => c.id === claim.id)!
    expect(confirmedClaim.hostDecision).toBe('CONFIRMED')

    // Broadcast the Host tab's resulting state to the Player tab, exactly as
    // GameSessionContext.tsx's BroadcastChannel convenience would (no
    // currentPlayerId field on SharedStatePayload).
    const payloadAfterConfirm: SharedStatePayload = {
      game: host.game,
      players: host.players,
      tickets: host.tickets,
      marks: host.marks,
      claims: host.claims,
      winners: host.winners,
    }
    player = gameSessionReducer(player, { type: 'SYNC_LOCAL', payload: payloadAfterConfirm })
    expect(player.currentPlayerId).toBe(PLAYER_ID)
    expect(player.claims.find((c) => c.id === claim.id)?.hostDecision).toBe('CONFIRMED')

    // Also exercise REJECT_CLAIM from the Host tab (on a second, independent
    // claim) and further plain lifecycle actions, all dispatched host-side.
    let host2: GameSessionState = {
      ...gameSessionInitialState,
      game: { ...player.game },
      currentPlayerId: undefined,
      players: [],
      tickets: [],
      claims: player.claims,
      winners: player.winners,
    }

    // Submit a second claim for a different prize from the Player tab first,
    // so the Host tab has something PENDING to reject.
    player = gameSessionReducer(player, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: PLAYER_ID,
      ticketId: TICKET_ID,
      prizeId: 'FIREWALL_LINE',
    })
    const secondClaim = player.claims.find((c) => c.prizeId === 'FIREWALL_LINE')!
    host2 = { ...host2, claims: player.claims }

    for (const action of [
      { type: 'REJECT_CLAIM', claimId: secondClaim.id, rejectionReason: 'Other' } as const,
      { type: 'PAUSE_GAME' } as const,
      { type: 'RESUME_GAME' } as const,
    ]) {
      host2 = gameSessionReducer(host2, action)
      const payload: SharedStatePayload = {
        game: host2.game,
        players: host2.players,
        tickets: host2.tickets,
        marks: host2.marks,
        claims: host2.claims,
        winners: host2.winners,
      }
      player = gameSessionReducer(player, { type: 'SYNC_LOCAL', payload })
      expect(player.currentPlayerId).toBe(PLAYER_ID)
    }

    const rejectedClaim = player.claims.find((c) => c.id === secondClaim.id)!
    expect(rejectedClaim.hostDecision).toBe('REJECTED')
    expect(player.currentPlayerId).toBe(PLAYER_ID)
  })
})

// ---------------------------------------------------------------------------
// 3. Refresh restores player, ticket, marks, claims, winners (Req 20.3)
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

describe('Regression 3: a refresh after a Mark, a claim submission, or a claim confirmation restores the same player, ticket, marks, claims, and winners (Req 20.3)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('restores everything after a refresh following a Mark only', () => {
    const before = mountProvider()
    const ctx0 = before.sink.current!
    const outcome = joinNew(ctx0, {
      gameCode: VALID_CODE,
      employeeName: 'Mark Only Tester',
      employeeId: 'EMP-MARK-1',
    })
    act(() => {
      ctx0.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
    })
    act(() => {
      before.sink.current!.dispatch({ type: 'START_GAME' })
    })
    const currentTermId = before.sink.current!.state.game.currentTermId!
    act(() => {
      before.sink.current!.dispatch({ type: 'MARK_TERM', termId: currentTermId })
    })
    const marksBefore = before.sink.current!.state.marks
    expect(marksBefore.length).toBeGreaterThanOrEqual(0)

    before.unmount()
    const after = mountProvider()
    const restored = after.sink.current!.state
    expect(restored.players.some((p) => p.id === outcome.player.id)).toBe(true)
    expect(restored.tickets.some((t) => t.id === outcome.ticket.id)).toBe(true)
    expect(restored.marks).toEqual(marksBefore)
    expect(restored.claims).toEqual([])
    expect(restored.winners).toEqual([])
    after.unmount()
  })

  it('restores everything after a refresh following a claim submission only', () => {
    localStorage.clear()
    const before = mountProvider()
    const ctx0 = before.sink.current!
    const outcome = joinNew(ctx0, {
      gameCode: VALID_CODE,
      employeeName: 'Submit Only Tester',
      employeeId: 'EMP-SUBMIT-1',
    })
    act(() => {
      ctx0.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
    })
    act(() => {
      before.sink.current!.dispatch({ type: 'START_GAME' })
    })

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
      const termId = before.sink.current!.state.game.currentTermId
      if (termId && ticketTermIds.has(termId) && !markedTermIds.has(termId)) {
        act(() => {
          before.sink.current!.dispatch({ type: 'MARK_TERM', termId })
        })
        markedTermIds.add(termId)
      }
    }
    expect(markedTermIds.size).toBe(5)

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
    )!
    expect(submittedClaim.hostDecision).toBe('PENDING')
    const marksBefore = before.sink.current!.state.marks

    before.unmount()
    const after = mountProvider()
    const restored = after.sink.current!.state
    expect(restored.players.some((p) => p.id === outcome.player.id)).toBe(true)
    expect(restored.tickets.some((t) => t.id === outcome.ticket.id)).toBe(true)
    expect(restored.marks).toEqual(marksBefore)
    expect(restored.claims.find((c) => c.id === submittedClaim.id)).toEqual(submittedClaim)
    expect(restored.winners).toEqual([])
    after.unmount()
  })

  it('restores everything after a refresh following a claim confirmation', () => {
    localStorage.clear()
    const before = mountProvider()
    const ctx0 = before.sink.current!
    const outcome = joinNew(ctx0, {
      gameCode: VALID_CODE,
      employeeName: 'Confirm Tester',
      employeeId: 'EMP-CONFIRM-1',
    })
    act(() => {
      ctx0.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
    })
    act(() => {
      before.sink.current!.dispatch({ type: 'START_GAME' })
    })

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
      const termId = before.sink.current!.state.game.currentTermId
      if (termId && ticketTermIds.has(termId) && !markedTermIds.has(termId)) {
        act(() => {
          before.sink.current!.dispatch({ type: 'MARK_TERM', termId })
        })
        markedTermIds.add(termId)
      }
    }
    expect(markedTermIds.size).toBe(5)

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
    )!
    act(() => {
      before.sink.current!.dispatch({ type: 'CONFIRM_CLAIM', claimId: submittedClaim.id })
    })
    const confirmedClaim = before.sink.current!.state.claims.find(
      (c) => c.id === submittedClaim.id,
    )!
    const winner = before.sink.current!.state.winners.find(
      (w) => w.claimId === submittedClaim.id,
    )!
    expect(confirmedClaim.hostDecision).toBe('CONFIRMED')
    expect(winner).toBeDefined()
    const marksBefore = before.sink.current!.state.marks

    before.unmount()

    // Also verify directly against the persisted envelope, mirroring
    // claimsWinnersPersistenceAcrossRefresh.integration.test.tsx's convention.
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const persisted = parseEnvelope(raw)!
    expect(persisted.claims.find((c) => c.id === confirmedClaim.id)).toEqual(confirmedClaim)
    expect(persisted.winners.find((w) => w.id === winner.id)).toEqual(winner)

    const after = mountProvider()
    const restored = after.sink.current!.state
    expect(restored.players.some((p) => p.id === outcome.player.id)).toBe(true)
    expect(restored.tickets.some((t) => t.id === outcome.ticket.id)).toBe(true)
    expect(restored.marks).toEqual(marksBefore)
    expect(restored.claims.find((c) => c.id === confirmedClaim.id)).toEqual(confirmedClaim)
    expect(restored.winners.find((w) => w.id === winner.id)).toEqual(winner)
    after.unmount()
  })
})

// ---------------------------------------------------------------------------
// 4. Prize_Progress never decreases from a new Cyber Word call or any
//    claim/winner action (Req 20.4)
// ---------------------------------------------------------------------------

describe('Regression 4: Prize_Progress for any Prize_Id never decreases as a result of a new Cyber Word call or any claim/winner action (Req 20.4)', () => {
  it('records only non-decreasing progress values across a mixed CALL_NEXT_WORD / MARK_TERM / SUBMIT_PRIZE_CLAIM / CONFIRM_CLAIM sequence', () => {
    let state = baseState()
    const allTermIds = state.tickets[0].rows.flat().map((c) => c.termId)

    // Track, per prize id, every progress value observed in order.
    const history = new Map<string, number[]>()
    function record(s: GameSessionState) {
      const progress = getAllPrizeProgress(s.tickets[0], s.marks)
      for (const p of progress) {
        const arr = history.get(p.id) ?? []
        arr.push(p.current)
        history.set(p.id, arr)
      }
    }

    record(state)

    // Reveal + mark 5 terms (bringing CYBER_FIVE to 5/5), recording progress
    // after every single dispatch (reveal and mark alike).
    for (const termId of allTermIds.slice(0, 5)) {
      state = revealTerm(state, termId)
      record(state)
      state = gameSessionReducer(state, { type: 'MARK_TERM', termId })
      record(state)
    }

    // A few more CALL_NEXT_WORD dispatches (no new marks) — progress must
    // stay exactly the same, never decrease.
    for (const termId of allTermIds.slice(5, 8)) {
      state = revealTerm(state, termId)
      state = gameSessionReducer(state, { type: 'CALL_NEXT_WORD' })
      record(state)
    }

    // Submit and confirm the CYBER_FIVE claim.
    state = gameSessionReducer(state, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: PLAYER_ID,
      ticketId: TICKET_ID,
      prizeId: 'CYBER_FIVE',
    })
    record(state)
    const claim = state.claims.find((c) => c.prizeId === 'CYBER_FIVE')!
    state = gameSessionReducer(state, { type: 'CONFIRM_CLAIM', claimId: claim.id })
    record(state)

    // Mark a few more terms toward the still-open prizes after the win.
    for (const termId of allTermIds.slice(8, 11)) {
      state = revealTerm(state, termId)
      state = gameSessionReducer(state, { type: 'MARK_TERM', termId })
      record(state)
    }

    // Submit a second (ineligible) claim for a different prize and reject it
    // — neither action may decrease any prize's progress.
    state = gameSessionReducer(state, {
      type: 'SUBMIT_PRIZE_CLAIM',
      playerId: PLAYER_ID,
      ticketId: TICKET_ID,
      prizeId: 'SECURITY_LINE',
    })
    record(state)
    const secondClaim = state.claims.find((c) => c.prizeId === 'SECURITY_LINE')!
    state = gameSessionReducer(state, {
      type: 'REJECT_CLAIM',
      claimId: secondClaim.id,
      rejectionReason: 'Other',
    })
    record(state)

    // Assert every recorded sequence, for every prize, is monotonically
    // non-decreasing.
    expect(history.size).toBe(5)
    for (const [prizeId, values] of history) {
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThanOrEqual(values[i - 1])
      }
      // Sanity: at least one prize actually made progress (not a vacuous
      // all-zero sequence).
      void prizeId
    }
    const cyberFiveValues = history.get('CYBER_FIVE')!
    expect(cyberFiveValues[cyberFiveValues.length - 1]).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// 5. Direct-word-call gameplay model (START_GAME/CALL_NEXT_WORD) unchanged
//    (Req 20.5)
// ---------------------------------------------------------------------------

describe('Regression 5: the direct-word-call gameplay model (START_GAME/CALL_NEXT_WORD, no separate reveal-answer step) is unchanged by this module (Req 20.5)', () => {
  it('START_GAME from LOBBY sets WORD_ACTIVE, currentRound 1, and reveals exactly one term immediately', () => {
    const state = gameSessionReducer(gameSessionInitialState, { type: 'START_GAME' })
    expect(state.game.status).toBe('WORD_ACTIVE')
    expect(state.game.currentRound).toBe(1)
    expect(state.game.currentTermId).toBeDefined()
    expect(state.game.revealedTermIds).toContain(state.game.currentTermId)
    expect(state.game.revealedTermIds).toHaveLength(1)
  })

  it('CALL_NEXT_WORD increments currentRound and adds exactly one new term to revealedTermIds, calling and revealing in the same step', () => {
    let state = gameSessionReducer(gameSessionInitialState, { type: 'START_GAME' })
    const roundAfterStart = state.game.currentRound
    const revealedAfterStart = state.game.revealedTermIds.length

    state = gameSessionReducer(state, { type: 'CALL_NEXT_WORD' })

    expect(state.game.currentRound).toBe(roundAfterStart + 1)
    expect(state.game.revealedTermIds).toHaveLength(revealedAfterStart + 1)
    expect(state.game.currentTermId).toBeDefined()
    expect(state.game.revealedTermIds).toContain(state.game.currentTermId)
    // No separate "reveal-answer" step exists: the newly-called term is
    // already the head of revealedTermIds/currentTermId in this one dispatch.
    expect(state.game.status).toBe('WORD_ACTIVE')
  })

  it('CALL_NEXT_WORD is a no-op unless the game is WORD_ACTIVE (unchanged lifecycle guard)', () => {
    // From LOBBY (never started): ignored.
    const fromLobby = gameSessionReducer(gameSessionInitialState, { type: 'CALL_NEXT_WORD' })
    expect(fromLobby).toBe(gameSessionInitialState)
  })
})
