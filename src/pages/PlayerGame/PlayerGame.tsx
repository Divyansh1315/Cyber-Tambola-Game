import { useMemo, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { Button } from '../../components/common/Button'
import { Card } from '../../components/common/Card'
import { CyberWordCard } from '../../components/common/CyberWordCard'
import { StatusBadge } from '../../components/common/StatusBadge'
import { PrizeProgressList } from '../../components/player/PrizeProgressList'
import { Ticket } from '../../components/player/Ticket'
import { findCyberTerm } from '../../data/cyberTerms'
import { useGameSession } from '../../state/GameSessionContext'
import { shortTicketRef } from '../../state/joinService'
import { deriveCellState } from '../../utils/deriveCellState'
import { canMarkTerm, getMarkedTermIds } from '../../utils/prizeEngine'
import {
  derivePlayerClaimStatus,
  getWinnerForPrize,
  type PlayerClaimStatus,
} from '../../utils/winnerEngine'
import type { Ticket as TicketData } from '../../types/game'
import type { PrizeClaim, PrizeProgress } from '../../types/prize'
import './PlayerGame.css'

/**
 * "current/target" progress text, shared by the NOT_ELIGIBLE message (Req
 * 12.3) and the Req 10.3 INVALID-claim special case.
 */
export function progressMessage(progress: PrizeProgress): string {
  return `${progress.current}/${progress.target}`
}

/**
 * The exact per-status message/button copy driving each prize's block (Req
 * 12.2–12.9). Purely a function of the derived Player_Claim_Status plus the
 * inputs needed to fill in the message — no nested conditionals elsewhere.
 */
export function claimStatusView(input: {
  status: PlayerClaimStatus
  progress: PrizeProgress
  ownLatestClaim?: PrizeClaim
  isOwnClaimInvalid: boolean
}): { message: string; buttonLabel: string; buttonDisabled: boolean } {
  const { status, progress, ownLatestClaim, isOwnClaimInvalid } = input

  // Req 10.3: an own-claim that the system marked INVALID at submission
  // shows the exact progress-based message instead of derivePlayerClaimStatus's
  // plain fallback. A brand-new claim's hostDecision always starts as
  // 'PENDING' regardless of validationStatus (see SUBMIT_PRIZE_CLAIM), so
  // derivePlayerClaimStatus resolves an own INVALID claim to PENDING just
  // like a VALID one — this check overrides that generic "waiting for
  // host" message specifically for the INVALID case, checked ahead of the
  // PENDING/ELIGIBLE/NOT_ELIGIBLE fallbacks derivePlayerClaimStatus would
  // otherwise produce for it.
  if (
    isOwnClaimInvalid &&
    (status === 'ELIGIBLE' || status === 'NOT_ELIGIBLE' || status === 'PENDING')
  ) {
    return {
      message: `Claim could not be validated. Your current progress is ${progressMessage(progress)}.`,
      buttonLabel: `Claim ${progress.label}`,
      buttonDisabled: status !== 'ELIGIBLE',
    }
  }

  switch (status) {
    case 'NOT_ELIGIBLE':
      return {
        message: `Progress: ${progressMessage(progress)}`,
        buttonLabel: `Claim ${progress.label}`,
        buttonDisabled: true,
      }
    case 'ELIGIBLE':
      return {
        message: `🎉 ${progress.label} Ready!`,
        buttonLabel: `Claim ${progress.label}`,
        buttonDisabled: false,
      }
    case 'PENDING':
      return {
        message: 'Claim submitted. Waiting for Host confirmation.',
        buttonLabel: 'Claim Pending',
        buttonDisabled: true,
      }
    case 'CONFIRMED':
      return {
        message: `🏆 ${progress.label.toUpperCase()} WINNER — Your ${progress.label} claim has been confirmed.`,
        buttonLabel: 'Winner Confirmed',
        buttonDisabled: true,
      }
    case 'REJECTED': {
      const reason = ownLatestClaim?.rejectionReason
      return {
        message: reason ? `Claim rejected. ${reason}` : 'Claim rejected.',
        buttonLabel: `Claim ${progress.label}`,
        buttonDisabled: false,
      }
    }
    case 'CLOSED_BY_OTHER_WINNER':
      return {
        message: `${progress.label} has already been awarded to another player. Keep going for the remaining prizes!`,
        buttonLabel: 'Prize Awarded',
        buttonDisabled: true,
      }
  }
}

/**
 * Screen B — Player Game.
 * Primary target: smartphone in portrait. The clue, reveal state, and game
 * status are read from the central session store — the player never controls
 * the reveal.
 *
 * The rendered player and ticket come from the Current_Player resolved via
 * `currentPlayerId` (Req 9). Ticket cell state is a pure derivation from the
 * game's live `revealedTermIds` plus the shared `marks` collection — there is
 * no component-local marked state (Req 1.3, 4, 8, 11, 12). Prize progress and
 * claim gating are driven by the Prize_Engine's real output so they never
 * contradict each other (Req 7, 15, 16).
 */
export function PlayerGame() {
  const {
    state,
    remoteSyncStatus,
    currentTerm,
    currentPlayer,
    currentTicket,
    currentPlayerMarks,
    currentPrizeProgress,
    dispatch,
    isHydrated,
  } = useGameSession()
  const { game } = state
  const location = useLocation()

  const [lockedHint, setLockedHint] = useState<string | null>(null)

  const isPaused = game.status === 'PAUSED'
  const isCompleted = game.status === 'COMPLETED'
  const inLobby = game.status === 'LOBBY'
  // Read-only once the game is over.
  const readOnly = isCompleted

  // A restored duplicate-identity session announces itself (Req 5.5).
  const restored =
    (location.state as { restored?: boolean } | null)?.restored === true

  // The Current_Player's Marked_Term_Ids for the Current_Ticket, derived from
  // the shared `marks` collection (Req 4.4, 7.2, 7.3).
  const markedTermIds = useMemo(
    () => getMarkedTermIds(currentPlayerMarks),
    [currentPlayerMarks],
  )

  // Build the RENDERED ticket by deriving each cell's state from the live
  // reveal history plus the shared marks — the stored ticket is never
  // mutated (Req 4.5, 8.2, 11.1, 11.2, 12.1–12.4). Labels resolve from the
  // term bank.
  const renderedTicket = useMemo<TicketData | undefined>(() => {
    if (!currentTicket) return undefined
    return {
      ...currentTicket,
      rows: currentTicket.rows.map((row) =>
        row.map((cell) => ({
          ...cell,
          term: findCyberTerm(cell.termId)?.term ?? cell.term,
          state: deriveCellState(cell.termId, game.revealedTermIds, markedTermIds),
        })),
      ),
    }
  }, [currentTicket, game.revealedTermIds, markedTermIds])

  // Wait for the initial local restore (shared state + client-local
  // currentPlayerId) before deciding whether to redirect. Without this gate,
  // a render that observes a momentarily-incomplete identity/session pairing
  // could bounce a genuinely-joined player back to the join screen.
  if (!isHydrated) {
    return null
  }

  // No current player/ticket → send the visitor to the join screen (Req 9.4).
  // This is the ONLY redirect trigger: no current player, a current player
  // whose record has vanished, or a current player with no matching ticket.
  // Game status, clue, marks, and participant-count changes never trigger it.
  // Redirects to "/player" (the Player entry point), not "/" (the Host
  // Dashboard) -- PlayerEntry.tsx will then render PlayerJoin since
  // currentPlayer is gone.
  if (!currentPlayer || !currentTicket || !renderedTicket) {
    return <Navigate to="/player" replace />
  }

  /**
   * Tap a cell. LOCKED cells only show a hint (never dispatch). MARKED cells
   * are a permanent no-op (Req 13). AVAILABLE cells dispatch MARK_TERM, which
   * is validated by the same canMarkTerm/validateMarkAttempt pipeline the
   * reducer uses — no gate logic is duplicated here (Req 12, 14).
   */
  function handleTap(termId: string) {
    if (readOnly) return

    const isRevealed = game.revealedTermIds.includes(termId)
    const isMarked = markedTermIds.has(termId)

    if (!isRevealed) {
      const label = findCyberTerm(termId)?.term ?? termId
      setLockedHint(`${label} has not been revealed yet.`)
      return
    }

    if (isMarked) {
      // Already marked — explicit no-op, never dispatch (Req 13.1, 13.2, 14.3).
      return
    }

    setLockedHint(null)
    if (canMarkTerm(state, termId)) {
      dispatch({ type: 'MARK_TERM', termId })
    }
  }

  // Per-prize claim blocks: each Prize_Id gets its own independently derived
  // status, so claiming one prize never reads/affects another's block (Req
  // 2.5, 12.1, 12.2, 13.2). currentPlayer/currentTicket are non-null here —
  // both redirect guards above have already run.
  const prizeBlocks = currentPrizeProgress.map((progress) => {
    // The player's own latest claim for this prize — claims are append-only,
    // so the last matching entry in array order is the most recent one.
    const ownClaimsForPrize = state.claims.filter(
      (c) => c.playerId === currentPlayer.id && c.prizeId === progress.id,
    )
    const ownLatestClaim = ownClaimsForPrize[ownClaimsForPrize.length - 1]

    const winner = getWinnerForPrize(state.winners, state.game.id, progress.id)

    const status = derivePlayerClaimStatus({
      progress,
      ownLatestClaim,
      winner,
      playerId: currentPlayer.id,
    })

    // Req 10.3 special case: the player's own latest claim was rejected by
    // the SYSTEM as INVALID at submission time (an INVALID claim's
    // hostDecision stays PENDING forever, so derivePlayerClaimStatus alone
    // resolves it to ELIGIBLE/NOT_ELIGIBLE — this check layers the special
    // message on top, ahead of that plain fallback text). Not shown once a
    // Winner exists for the prize, since CONFIRMED/CLOSED_BY_OTHER_WINNER
    // should take over instead.
    const isOwnClaimInvalid = !winner && ownLatestClaim?.validationStatus === 'INVALID'

    const view = claimStatusView({
      status,
      progress,
      ownLatestClaim,
      isOwnClaimInvalid,
    })

    return { progress, status, view }
  })

  return (
    <div className="page player">
      <div className="player__inner">
        {/* Header */}
        <header className="player__header">
          <div className="player__header-top">
            <span className="player__game">Cyber Tambola</span>
            <StatusBadge status={game.status} />
          </div>
          <div className="player__header-meta">
            <span className="player__name">{currentPlayer.displayName}</span>
            <span className="player__ticket-ref">
              {shortTicketRef(currentTicket.id)}
            </span>
          </div>
        </header>

        {/* Restored duplicate-identity session notice (Req 5.5) */}
        {restored && (
          <p className="player__restored" role="status">
            Existing game session restored.
          </p>
        )}

        {/* Connection issue: the initial sync against the server failed
            after every retry. Rendering the game screen as-is here could
            show stale, previously-cached state (e.g. a completed game from
            before a reset) as if it were live -- surface this instead of
            failing silently. */}
        {remoteSyncStatus === 'error' && (
          <Card className="player__notice player__notice--error">
            <p className="player__notice-title">
              <span aria-hidden="true">?</span> Connection issue
            </p>
            <p className="player__notice-sub">
              Could not sync with the game server. What you see below may be
              out of date.
            </p>
            <Button
              variant="secondary"
              onClick={() => window.location.reload()}
            >
              Retry
            </Button>
          </Card>
        )}

        {/* Paused / completed banners take over the clue/answer area */}
        {isPaused && (
          <Card className="player__notice">
            <p className="player__notice-title">
              <span aria-hidden="true">⏸</span> Game paused by host.
            </p>
            <p className="player__notice-sub">Your ticket is safe — hang tight.</p>
          </Card>
        )}

        {isCompleted && (
          <Card className="player__notice">
            <p className="player__notice-title">
              <span aria-hidden="true">🏁</span> Game completed.
            </p>
            <p className="player__notice-sub">Thanks for playing Cyber Tambola.</p>
          </Card>
        )}

        {/* Active gameplay: the called Cyber Word comes from shared state */}
        {!isPaused && !isCompleted && (
          <section aria-label="Current Cyber Word">
            {currentTerm ? (
              <CyberWordCard
                term={currentTerm.term}
                definition={currentTerm.definition}
                awarenessTip={currentTerm.awarenessTip}
              />
            ) : (
              <Card className="player__notice">
                <p className="player__notice-title">
                  <span aria-hidden="true">⏳</span> Waiting for the host…
                </p>
                <p className="player__notice-sub">
                  {inLobby
                    ? 'The game has not started yet.'
                    : 'The first Cyber Word is on its way.'}
                </p>
              </Card>
            )}
          </section>
        )}

        {/* Cyber word ticket */}
        <Card title="Your Cyber Word Ticket" className="player__ticket-card">
          <Ticket ticket={renderedTicket} onToggleCell={handleTap} />
          {lockedHint && (
            <p className="player__locked-hint" role="status">
              <span aria-hidden="true">🔒</span> {lockedHint}
            </p>
          )}
          <ul className="player__legend" aria-label="Ticket cell states">
            <li>
              <span aria-hidden="true">🔒</span> Locked
            </li>
            <li>
              <span aria-hidden="true">○</span> Available
            </li>
            <li>
              <span aria-hidden="true">✓</span> Marked
            </li>
          </ul>
        </Card>

        {/* Prize progress */}
        <Card title="Prize Progress">
          <PrizeProgressList items={currentPrizeProgress} />
        </Card>

        {/* Claim prizes — one independent block per Prize_Id (Req 2.5, 12.2, 13.2) */}
        <Card title="Claim Your Prizes">
          <ul className="player__claims" aria-label="Prize claim status">
            {prizeBlocks.map(({ progress, status, view }) => (
              <li
                key={progress.id}
                className={`player__claim-block player__claim-block--${status.toLowerCase()}`}
              >
                <div className="player__claim-block-head">
                  <span className="player__claim-block-label">{progress.label}</span>
                </div>
                <p
                  className={`player__claim-message player__claim-message--${status.toLowerCase()}`}
                  role="status"
                >
                  {view.message}
                </p>
                <Button
                  variant={status === 'CONFIRMED' ? 'success' : 'primary'}
                  size="md"
                  className="player__claim-btn"
                  disabled={view.buttonDisabled || readOnly}
                  onClick={() =>
                    dispatch({
                      type: 'SUBMIT_PRIZE_CLAIM',
                      playerId: currentPlayer.id,
                      ticketId: currentTicket.id,
                      prizeId: progress.id,
                    })
                  }
                  icon="🏆"
                >
                  {view.buttonLabel}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
