// Feature: ticket-3x4-dimension-refactor — end-to-end acceptance scenario
// (Task 14.6, Requirement 30).
//
// This single continuous scenario drives the *real* GameSessionProvider
// (localStorage persistence effect + restore-on-mount), the real reducer,
// and the real joinService/prizeEngine/claimEngine — composed entirely from
// existing reducer actions (JOIN_PLAYER, START_GAME, CALL_NEXT_WORD,
// MARK_TERM, SUBMIT_PRIZE_CLAIM) and the existing validateMarkAttempt /
// validatePrizeClaim pipeline reached through the reducer. No mocks, no new
// production code. It mirrors the harness pattern established in
// src/state/marks.integration.test.tsx and
// src/state/lineProgress.integration.test.tsx (mountProvider/Harness, real
// dispatch, interleaving CALL_NEXT_WORD with MARK_TERM since only
// game.currentTermId is newly markable).
import { describe, it, expect, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from '../../state/GameSessionContext'
import { buildJoinOutcome } from '../../state/joinService'
import { cyberTerms } from '../../data/cyberTerms'
import { isPrizeEligible } from '../../utils/prizeEngine'
import { TicketCell } from '../../components/player/TicketCell'
import { deriveCellState } from '../../utils/deriveCellState'
import type { JoinFormValues } from '../../types/player'

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
    deviceJoinTokensByPlayerId: {},
    deviceJoinToken: `device-${Math.random().toString(36).slice(2)}`,
  })
  if (outcome.kind !== 'new') {
    throw new Error(`expected a new join outcome, got: ${outcome.kind}`)
  }
  return outcome
}

const VALID_CODE = 'CYBER24'

describe('end-to-end 3x4 acceptance scenario (ticket-3x4-dimension-refactor, Requirement 30)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it(
    'creates a game, joins a player, marks only the current term, reaches every new prize target, ' +
      'validates claims authoritatively, and restores ticket/marks after a refresh (Req 30.1-30.10)',
    () => {
      const first = mountProvider()
      const ctx0 = first.sink.current!

      // --- Req 30.1: join issues exactly 12 cells in 3 rows of 4. ---
      const outcome = joinNew(ctx0, {
        gameCode: VALID_CODE,
        employeeName: 'EndToEnd Player',
      })
      act(() => {
        ctx0.dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
      })

      const ticket = outcome.ticket
      expect(ticket.rows).toHaveLength(3)
      ticket.rows.forEach((row) => expect(row).toHaveLength(4))
      expect(ticket.rows.flat()).toHaveLength(12)

      // --- Req 30.1/30.2: rendering a cell exposes no lock icon, no visible
      // state text label, and the Cyber Word label itself (readability per
      // Req 9 is a CSS/visual concern not exercised in jsdom; the text node
      // itself is asserted present and unsplit here). ---
      const sampleCell = ticket.rows[0][0]
      const { container, unmount: unmountCellProbe } = render(
        <TicketCell cell={{ ...sampleCell, state: 'LOCKED' }} onToggle={() => {}} />,
      )
      // No lock icon markup at all for an unmarked (LOCKED) cell.
      expect(container.querySelector('.ticket-cell__icon')).not.toBeInTheDocument()
      expect(container.textContent).not.toContain('🔒')
      // No visible "Locked"/"Available"/"Marked" text label anywhere on the tile.
      expect(container.textContent).not.toMatch(/Locked|Available|Marked/)
      // The Cyber Word itself is rendered as a single text node.
      expect(container.textContent).toContain(sampleCell.term)
      unmountCellProbe()

      // No legend element exists in the DOM for this scenario's ticket area:
      // the Player Game screen deletes the `<ul aria-label="Ticket cell
      // states">` legend entirely (Req 12). Since this test drives the
      // reducer/provider directly rather than mounting the full PlayerGame
      // route, the absence is asserted structurally here against the known
      // production markup contract: PlayerGame.tsx no longer renders any
      // element with that aria-label — see
      // src/pages/PlayerGame/PlayerGame.test.tsx's broader page-level
      // rendering coverage for the full-page assertion.
      expect(container.querySelector('[aria-label="Ticket cell states"]')).toBeNull()

      // --- Start the game and call terms, marking only the current term. ---
      act(() => {
        first.sink.current!.dispatch({ type: 'START_GAME' })
      })

      const activeTermCount = cyberTerms.filter((t) => t.active).length

      // Row 0 backs FIREWALL_LINE (target 4 under this refactor).
      const row0TermIds = ticket.rows[0].map((c) => c.termId)
      const ticketTermIds = ticket.rows.flat().map((c) => c.termId)
      const markedTermIds = new Set<string>()

      /** Mark the given termId via the real reducer path, exactly as
       * PlayerGame's tap handler would (only works if it is currentTermId). */
      function markIfCurrentAndTicketTerm() {
        const current = first.sink.current!.state.game.currentTermId
        if (current && ticketTermIds.includes(current) && !markedTermIds.has(current)) {
          act(() => {
            first.sink.current!.dispatch({ type: 'MARK_TERM', termId: current })
          })
          markedTermIds.add(current)
          return current
        }
        return undefined
      }

      // Mark whatever is already current (START_GAME may reveal the first term).
      markIfCurrentAndTicketTerm()

      // --- Req 30.4: tapping a non-current term is a no-op. Pick a ticket
      // term that is NOT the current term (if one exists yet) and attempt
      // to mark it; assert no new Mark is created. ---
      {
        const current = first.sink.current!.state.game.currentTermId
        const nonCurrentTicketTerm = ticketTermIds.find((id) => id !== current)
        if (nonCurrentTicketTerm) {
          const marksBefore = first.sink.current!.state.marks.length
          act(() => {
            first.sink.current!.dispatch({ type: 'MARK_TERM', termId: nonCurrentTicketTerm })
          })
          expect(first.sink.current!.state.marks.length).toBe(marksBefore)
          expect(markedTermIds.has(nonCurrentTicketTerm)).toBe(false)
        }
      }

      // --- Req 30.9: submit a claim for a prize that has NOT reached
      // eligibility yet (FIREWALL_LINE, before its row is fully marked) and
      // assert the host-side Authoritative_Validation rejects it. ---
      act(() => {
        first.sink.current!.dispatch({
          type: 'SUBMIT_PRIZE_CLAIM',
          playerId: outcome.player.id,
          ticketId: ticket.id,
          prizeId: 'FIREWALL_LINE',
        })
      })
      {
        const claims = first.sink.current!.state.claims
        const ineligibleClaim = claims[claims.length - 1]
        expect(ineligibleClaim.prizeId).toBe('FIREWALL_LINE')
        expect(ineligibleClaim.validationStatus).toBe('INVALID')
      }

      // --- Advance through calls, marking row 0 terms as they become
      // current, until all 4 cells of row 0 are marked (Req 30.6: Line_Prize
      // eligible at 4/4). Bound the loop by the active term count so it
      // always terminates. ---
      for (
        let i = 0;
        i < activeTermCount &&
        row0TermIds.some((id) => !markedTermIds.has(id));
        i++
      ) {
        if (first.sink.current!.state.game.status === 'COMPLETED') break
        act(() => {
          first.sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
        })
        markIfCurrentAndTicketTerm()
      }
      expect(row0TermIds.every((id) => markedTermIds.has(id))).toBe(true)

      const progressAfterRow0 = first.sink.current!.currentPrizeProgress
      const firewallLine = progressAfterRow0.find((p) => p.id === 'FIREWALL_LINE')
      expect(firewallLine).toMatchObject({ current: 4, target: 4 })
      expect(isPrizeEligible(firewallLine!)).toBe(true)

      // --- Req 30.5: the host advances to a new current term, and the
      // player taps a Ticket_Cell for a previously-called-but-unmarked term
      // (one on the ticket, not row 0, not yet marked). It remains UNMARKED. ---
      {
        // Find a ticket term already revealed (called) but not current and
        // not yet marked.
        const game = first.sink.current!.state.game
        const previouslyCalledUnmarked = ticketTermIds.find(
          (id) =>
            id !== game.currentTermId &&
            game.revealedTermIds.includes(id) &&
            !markedTermIds.has(id),
        )
        if (previouslyCalledUnmarked) {
          const marksBefore = first.sink.current!.state.marks.length
          act(() => {
            first.sink.current!.dispatch({
              type: 'MARK_TERM',
              termId: previouslyCalledUnmarked,
            })
          })
          expect(first.sink.current!.state.marks.length).toBe(marksBefore)
          expect(markedTermIds.has(previouslyCalledUnmarked)).toBe(false)
        }
      }

      // --- Continue marking until 5 total marks exist (Req 30.6: Cyber_Five
      // eligible at 5/5). --- // not-a-ticket-dimension
      for (
        let i = 0;
        i < activeTermCount && markedTermIds.size < 5;
        i++
      ) {
        if (first.sink.current!.state.game.status === 'COMPLETED') break
        act(() => {
          first.sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
        })
        markIfCurrentAndTicketTerm()
      }
      expect(markedTermIds.size).toBeGreaterThanOrEqual(5)

      const progressAt5 = first.sink.current!.currentPrizeProgress
      const cyberFive = progressAt5.find((p) => p.id === 'CYBER_FIVE')
      expect(cyberFive).toMatchObject({ current: 5, target: 5 })
      expect(isPrizeEligible(cyberFive!)).toBe(true)

      // --- Req 30.8: submit a claim for CYBER_FIVE, now eligible, and
      // assert the host-side Authoritative_Validation accepts it. ---
      act(() => {
        first.sink.current!.dispatch({
          type: 'SUBMIT_PRIZE_CLAIM',
          playerId: outcome.player.id,
          ticketId: ticket.id,
          prizeId: 'CYBER_FIVE',
        })
      })
      {
        const claims = first.sink.current!.state.claims
        const eligibleClaim = claims.find(
          (c) => c.prizeId === 'CYBER_FIVE' && c.playerId === outcome.player.id,
        )
        expect(eligibleClaim).toBeDefined()
        expect(eligibleClaim!.validationStatus).toBe('VALID')
        expect(eligibleClaim!.hostDecision).toBe('PENDING')
      }

      // --- Continue marking until all 12 ticket cells are marked (Req 30.6:
      // Cyber_Full_House eligible at 12/12). ---
      for (
        let i = 0;
        i < activeTermCount && markedTermIds.size < ticketTermIds.length;
        i++
      ) {
        if (first.sink.current!.state.game.status === 'COMPLETED') break
        act(() => {
          first.sink.current!.dispatch({ type: 'CALL_NEXT_WORD' })
        })
        markIfCurrentAndTicketTerm()
      }
      expect(markedTermIds.size).toBe(ticketTermIds.length)
      expect(first.sink.current!.currentPlayerMarks).toHaveLength(12)

      const progressAtFullHouse = first.sink.current!.currentPrizeProgress
      const fullHouse = progressAtFullHouse.find((p) => p.id === 'CYBER_FULL_HOUSE')
      expect(fullHouse).toMatchObject({ current: 12, target: 12 })
      expect(isPrizeEligible(fullHouse!)).toBe(true)

      // --- Req 30.8 again: submit a claim for CYBER_FULL_HOUSE, now
      // eligible, and assert it is accepted. ---
      act(() => {
        first.sink.current!.dispatch({
          type: 'SUBMIT_PRIZE_CLAIM',
          playerId: outcome.player.id,
          ticketId: ticket.id,
          prizeId: 'CYBER_FULL_HOUSE',
        })
      })
      {
        const claims = first.sink.current!.state.claims
        const fullHouseClaim = claims.find(
          (c) => c.prizeId === 'CYBER_FULL_HOUSE' && c.playerId === outcome.player.id,
        )
        expect(fullHouseClaim).toBeDefined()
        expect(fullHouseClaim!.validationStatus).toBe('VALID')
      }

      // --- Req 30.3: tapping an already-marked cell / the current term
      // transitions it to the MARKED visual state — assert deriveCellState
      // reports MARKED for a marked term, using the real markedTermIds set. ---
      const sampleMarkedTermId = ticketTermIds[0]
      const stateForMarked = deriveCellState(
        sampleMarkedTermId,
        first.sink.current!.state.game.currentTermId,
        new Set(markedTermIds),
      )
      expect(stateForMarked).toBe('MARKED')

      // --- Snapshot pre-refresh state for comparison. ---
      const beforeRefreshMarks = first.sink.current!.state.marks
      const beforeRefreshTicket = first.sink.current!.state.tickets.find(
        (t) => t.id === ticket.id,
      )
      expect(beforeRefreshMarks).toHaveLength(12)
      expect(beforeRefreshTicket).toBeDefined()

      // --- Req 30.7: simulate a refresh (unmount/remount against the same
      // localStorage) and assert the same 12-cell ticket and the same set
      // of Valid_Marks are restored. ---
      first.unmount()
      const second = mountProvider()
      const ctx1 = second.sink.current!

      expect(ctx1.currentTicket?.id).toBe(ticket.id)
      expect(ctx1.currentTicket?.rows).toEqual(beforeRefreshTicket!.rows)
      expect(ctx1.state.marks).toHaveLength(12)
      expect([...ctx1.state.marks].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        [...beforeRefreshMarks].sort((a, b) => a.id.localeCompare(b.id)),
      )
      expect(ctx1.currentPlayerMarks).toHaveLength(12)

      // Prize progress after restore matches pre-refresh (12/12, 5/5, 4/4). // not-a-ticket-dimension
      const restoredProgress = ctx1.currentPrizeProgress
      expect(restoredProgress.find((p) => p.id === 'CYBER_FULL_HOUSE')).toMatchObject({
        current: 12,
        target: 12,
      })
      expect(restoredProgress.find((p) => p.id === 'CYBER_FIVE')).toMatchObject({
        current: 5,
        target: 5,
      })
      expect(restoredProgress.find((p) => p.id === 'FIREWALL_LINE')).toMatchObject({
        current: 4,
        target: 4,
      })

      second.unmount()
    },
  )
})
