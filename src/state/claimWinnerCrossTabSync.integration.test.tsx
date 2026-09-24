// Feature: module-5-prize-claim-processing-winner-management — cross-tab
// claim/winner sync integration test (Task 15.4)
//
// Simulates two browser tabs sharing a real BroadcastChannel: a "Player tab"
// and a "Host tab", each with its OWN GameSessionProvider instance (mirroring
// PlayerGame.test.tsx's "PlayerGame survives Host lifecycle dispatches"
// convention). Both tabs restore the same base session from a shared
// localStorage envelope on mount. A claim submitted from the Player tab must
// appear in the Host tab's `state.claims` after the BroadcastChannel
// round-trip; a confirm dispatched from the Host tab must appear in the
// Player tab's `state.winners` (and drive its derived claim status) the same
// way — all without either tab calling SYNC_STATE manually.
//
// Validates: Requirements 17.2, 17.3
import { describe, it, expect, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from './GameSessionContext'
import { STORAGE_KEY, CURRENT_PLAYER_STORAGE_KEY, toEnvelope } from './persistence'
import { createSeedGame } from './gameSessionInitialState'
import { buildJoinOutcome } from './joinService'
import { cyberTerms } from '../data/cyberTerms'
import { getWinnerForPrize, derivePlayerClaimStatus } from '../utils/winnerEngine'
import { getAllPrizeProgress } from '../utils/prizeEngine'
import type { Mark } from '../types/mark'

const hasBroadcastChannel =
  typeof (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel === 'function'

/** A bridge component exposing dispatch/state for programmatic access, one per tab. */
function Bridge({ sink }: { sink: { current: GameSessionContextValue | null } }) {
  const ctx = useGameSession()
  sink.current = ctx
  return null
}

function mountTab() {
  const sink: { current: GameSessionContextValue | null } = { current: null }
  const utils = render(
    <GameSessionProvider>
      <Bridge sink={sink} />
    </GameSessionProvider>,
  )
  return { sink, ...utils }
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

describe('cross-tab claim/winner sync (module-5-prize-claim-processing-winner-management)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it.runIf(hasBroadcastChannel)(
    'propagates a submitted claim to the Host tab, and a confirmed winner back to the Player tab, via BroadcastChannel (Req 17.2, 17.3)',
    async () => {
      // Seed a shared session: one game, one player joined and assigned a
      // ticket, with that player's ticket fully marked for CYBER_FIVE so the
      // claim submitted below validates as VALID/PENDING.
      const game = createSeedGame()
      const outcome = buildJoinOutcome({
        form: { gameCode: 'CYBER24', employeeName: 'Priya Singh', employeeId: 'EMP-2001' },
        game,
        players: [],
        tickets: [],
        terms: cyberTerms,
      })
      if (outcome.kind !== 'new') {
        throw new Error(`expected a new join outcome, got ${outcome.kind}`)
      }
      const { player, ticket } = outcome

      // Reveal the first 5 of the ticket's own terms and mark them as this
      // player, so Cyber Five's progress reaches its target of 5.
      const ticketTermIds = [...new Set(ticket.rows.flat().map((c) => c.termId))]
      const termsToMark = ticketTermIds.slice(0, 5)
      const seededGame = { ...game, revealedTermIds: termsToMark }
      const marks: Mark[] = termsToMark.map((termId, i) => ({
        id: `mark-${i}`,
        gameId: player.gameId,
        playerId: player.id,
        ticketId: ticket.id,
        termId,
        markedAt: new Date().toISOString(),
        valid: true,
      }))

      // Sanity-check the seed actually makes Cyber Five eligible before
      // relying on it inside the two tabs.
      const progress = getAllPrizeProgress(ticket, marks)
      const cyberFive = progress.find((p) => p.id === 'CYBER_FIVE')!
      expect(cyberFive.current).toBeGreaterThanOrEqual(cyberFive.target)

      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(
          toEnvelope({
            game: seededGame,
            players: [player],
            tickets: [ticket],
            marks,
            claims: [],
            winners: [],
          }),
        ),
      )
      window.localStorage.setItem(CURRENT_PLAYER_STORAGE_KEY, player.id)

      // Mount the Player tab and the Host tab as two separate provider
      // instances, each restoring the same seeded envelope on mount.
      const playerTab = mountTab()
      const hostTab = mountTab()

      // Let both tabs' BroadcastChannel subscriptions + any initial sync
      // settle before driving any dispatches.
      await settle()

      expect(playerTab.sink.current!.state.claims).toEqual([])
      expect(hostTab.sink.current!.state.claims).toEqual([])

      // --- Player tab submits a claim -----------------------------------
      act(() => {
        playerTab.sink.current!.dispatch({
          type: 'SUBMIT_PRIZE_CLAIM',
          playerId: player.id,
          ticketId: ticket.id,
          prizeId: 'CYBER_FIVE',
        })
      })
      await settle()

      // The Player tab's own claim is VALID/PENDING.
      const playerSideClaim = playerTab.sink.current!.state.claims.find(
        (c) => c.playerId === player.id && c.prizeId === 'CYBER_FIVE',
      )
      expect(playerSideClaim).toBeDefined()
      expect(playerSideClaim!.validationStatus).toBe('VALID')
      expect(playerSideClaim!.hostDecision).toBe('PENDING')

      // The Host tab received it via the BroadcastChannel round-trip, with
      // no manual SYNC_STATE dispatch and no refresh.
      const hostSideClaim = hostTab.sink.current!.state.claims.find(
        (c) => c.id === playerSideClaim!.id,
      )
      expect(hostSideClaim).toBeDefined()
      expect(hostSideClaim).toEqual(playerSideClaim)

      // --- Host tab confirms the claim -----------------------------------
      act(() => {
        hostTab.sink.current!.dispatch({
          type: 'CONFIRM_CLAIM',
          claimId: hostSideClaim!.id,
        })
      })
      await settle()

      // The Host tab now has a Winner for CYBER_FIVE.
      const hostSideWinner = getWinnerForPrize(
        hostTab.sink.current!.state.winners,
        game.id,
        'CYBER_FIVE',
      )
      expect(hostSideWinner).toBeDefined()
      expect(hostSideWinner!.playerId).toBe(player.id)
      expect(hostSideWinner!.claimId).toBe(hostSideClaim!.id)

      // The Player tab receives the confirmed Winner via the same
      // BroadcastChannel round-trip.
      const playerSideWinner = getWinnerForPrize(
        playerTab.sink.current!.state.winners,
        game.id,
        'CYBER_FIVE',
      )
      expect(playerSideWinner).toBeDefined()
      expect(playerSideWinner).toEqual(hostSideWinner)

      // The Player tab's own claim record is updated to CONFIRMED too (not
      // just the winners array).
      const playerSideClaimAfterConfirm = playerTab.sink.current!.state.claims.find(
        (c) => c.id === playerSideClaim!.id,
      )
      expect(playerSideClaimAfterConfirm?.hostDecision).toBe('CONFIRMED')

      // And the derived Player_Claim_Status for CYBER_FIVE on the Player tab
      // now reads CONFIRMED, matching what PlayerGame would render.
      const status = derivePlayerClaimStatus({
        progress: cyberFive,
        ownLatestClaim: playerSideClaimAfterConfirm,
        winner: playerSideWinner,
        playerId: player.id,
      })
      expect(status).toBe('CONFIRMED')

      // currentPlayerId must never be disturbed by any claims/winners sync
      // payload on either tab (Req 17.6, referenced by design but re-checked
      // here for the two actions this test actually exercises).
      expect(playerTab.sink.current!.state.currentPlayerId).toBe(player.id)

      playerTab.unmount()
      hostTab.unmount()
    },
  )
})
