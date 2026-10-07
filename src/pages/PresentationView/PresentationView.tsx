import { useEffect, useState } from 'react'
import { JoinQrCode } from '../../components/common/JoinQrCode'
import { useGameSession } from '../../state/GameSessionContext'
import type { GameSessionState } from '../../state/gameSessionInitialState'
import type { PrizeId, Winner } from '../../types/prize'
import { PRIZES } from '../../utils/prizeEngine'
import './PresentationView.css'

/**
 * Decorative shield-with-check outline glyph for the lobby/join screen
 * (Cyber Awareness Month branding). Purely decorative -- aria-hidden, no
 * interactive affordance, matches the outline style already established by
 * BrandMark's glyph but standalone since this screen's title/subtitle no
 * longer pair with the BrandMark wordmark ("Cyber Tambola V2" / "Cyber Word
 * Tambola" must not appear on this screen per the design brief).
 */
function ShieldCheckIcon() {
  return (
    <svg
      className="projector__shield"
      viewBox="0 0 48 48"
      width="1em"
      height="1em"
      aria-hidden="true"
      role="img"
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
        d="M24 4 8 10v12c0 10 6.8 17 16 22 9.2-5 16-12 16-22V10L24 4Z"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m16.5 24 5 5L32 18"
      />
    </svg>
  )
}

/**
 * Restrained decorative circuit-board traces + connection nodes for the
 * lobby/join screen background (design brief section 3). Pure decoration:
 * aria-hidden, absolutely positioned behind the content stack, and never
 * intercepts pointer events (`pointer-events: none` in CSS) so it cannot
 * affect layout or interaction. Two mirrored corner clusters (left/right)
 * keep the center visually clean, per the brief.
 */
function CircuitBackground() {
  return (
    <svg
      className="projector__circuits"
      viewBox="0 0 1024 576"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g className="projector__circuit-lines" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M0 40 L90 40 L90 90 L170 90 L170 60 L230 60" />
        <path d="M0 140 L60 140 L60 180 L140 180" />
        <path d="M20 260 L100 260 L100 300 L60 300 L60 340" />
        <path d="M0 420 L80 420 L80 470 L150 470" />
        <path d="M1024 40 L934 40 L934 90 L854 90 L854 60 L794 60" />
        <path d="M1024 140 L964 140 L964 180 L884 180" />
        <path d="M1004 260 L924 260 L924 300 L964 300 L964 340" />
        <path d="M1024 420 L944 420 L944 470 L874 470" />
      </g>
      <g className="projector__circuit-nodes" fill="currentColor">
        <circle cx="90" cy="40" r="4" />
        <circle cx="170" cy="90" r="3" />
        <circle cx="230" cy="60" r="4" />
        <circle cx="60" cy="180" r="3" />
        <circle cx="100" cy="300" r="4" />
        <circle cx="60" cy="340" r="3" />
        <circle cx="150" cy="470" r="4" />
        <circle cx="934" cy="40" r="4" />
        <circle cx="854" cy="90" r="3" />
        <circle cx="794" cy="60" r="4" />
        <circle cx="964" cy="180" r="3" />
        <circle cx="924" cy="300" r="4" />
        <circle cx="964" cy="340" r="3" />
        <circle cx="874" cy="470" r="4" />
      </g>
    </svg>
  )
}

/**
 * Announcement view-model: picks exactly the fields the presentation
 * screen may show for a winner — the prize label, the player's display
 * name, and the winning ticket's own reference — and nothing else (never
 * employeeDemoId, internal playerId, ticketId, claimId, gameId, prizeId,
 * or confirmedAt) (Req 14.1, 14.2, 2.9).
 */
export function toAnnouncementViewModel(winner: Winner): {
  prizeLabel: string
  playerName: string
  ticketRef: string
} {
  return { prizeLabel: winner.prizeLabel, playerName: winner.playerName, ticketRef: winner.ticketRef }
}

export type PresenterDisplayMode = 'LOBBY' | 'WORD' | 'WINNER' | 'FINAL_RESULTS'

/**
 * Implements Req 2.10's exact priority order, reading only shared,
 * authoritative state (never Presenter-local state):
 *   1. game.status === 'COMPLETED'              -> FINAL_RESULTS
 *   2. game.latestWinnerAnnouncementId is set    -> WINNER
 *   3. game.status === 'WORD_ACTIVE' && currentTermId -> WORD
 *   4. otherwise                                  -> LOBBY
 * PAUSED is intentionally folded into the existing separate
 * `game.status === 'PAUSED'` render branch, which this function's
 * callers check independently (see component body) -- PAUSED has no
 * priority conflict with WINNER/FINAL_RESULTS/WORD since a paused game
 * cannot simultaneously be WORD_ACTIVE, and an active announcement
 * during a pause still correctly takes priority per step 2 (a Winner
 * confirmed just before a pause stays visible through the pause,
 * exactly as Req 2.1's "no timer" and Req 3.4's "PAUSED unchanged for
 * transitions unrelated to Winner announcement" both require).
 */
export function derivePresenterMode(state: GameSessionState): PresenterDisplayMode {
  if (state.game.status === 'COMPLETED') return 'FINAL_RESULTS'
  if (state.game.latestWinnerAnnouncementId !== undefined) return 'WINNER'
  if (state.game.status === 'WORD_ACTIVE' && state.game.currentTermId) return 'WORD'
  return 'LOBBY'
}

export interface FinalWinnerSummaryEntry {
  prizeId: PrizeId
  prizeLabel: string
  winnerName?: string
  ticketRef?: string
}

/**
 * Derives the five-category Final Winner Summary live from
 * `state.winners`, filtered to the active game and already
 * confirmed-only by construction (CONFIRM_CLAIM's existing invariant —
 * Req 2.5, 3.3). Never reads state.claims. Category order and labels
 * come from PRIZES (prizeEngine.ts) — the single existing source of
 * truth for prize ids/labels/order — not re-declared here, so this
 * function and prizeEngine.ts can never silently drift out of sync.
 */
export function buildFinalWinnerSummary(
  winners: readonly Winner[],
  activeGameId: string,
): FinalWinnerSummaryEntry[] {
  const gameWinners = winners.filter((w) => w.gameId === activeGameId)
  return PRIZES.map((prize) => {
    const winner = gameWinners.find((w) => w.prizeId === prize.id)
    return {
      prizeId: prize.id,
      prizeLabel: prize.label,
      winnerName: winner?.playerName,
      ticketRef: winner?.ticketRef,
    }
  })
}

/**
 * The QR must render at its real pixel size to stay sharp/undistorted (an
 * SVG-based QR code scaled purely via CSS on the wrapper would clip or
 * blur its modules), so the lobby screen tracks viewport height directly
 * and picks a concrete `size` for JoinQrCode rather than trying to make it
 * fluid through CSS alone (design brief section 4: ~360-420px at 1920x1080,
 * must still fit without scrolling at 1366x768, and shrink gracefully on
 * shorter/mobile viewports).
 */
function useProjectorQrSize(): number {
  const [size, setSize] = useState(() =>
    typeof window === 'undefined' ? 360 : computeQrSize(window.innerHeight),
  )

  useEffect(() => {
    function handleResize() {
      setSize(computeQrSize(window.innerHeight))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return size
}

/** Maps viewport height to a concrete QR pixel size (includes JoinQrCode's own padding). */
function computeQrSize(viewportHeight: number): number {
  if (viewportHeight >= 900) return 400 // e.g. 1920x1080
  if (viewportHeight >= 700) return 340 // e.g. 1366x768
  if (viewportHeight >= 500) return 260
  return 200 // short/mobile viewports
}

/**
 * Screen D — Presentation / Projector View.
 * Simplified, read-only, high-contrast, very large type for projection.
 * Fully driven by the central session store (host-controlled). Never displays
 * Employee IDs or other sensitive information.
 */
export function PresentationView() {
  const { state, currentTerm } = useGameSession()
  const { game } = state
  const qrSize = useProjectorQrSize()

  // PAUSED is a sibling check, not one of derivePresenterMode's 4 modes
  // (see that function's doc comment): a paused game cannot simultaneously
  // be WORD_ACTIVE, and an active announcement during a pause must still
  // take priority over the "Game Paused" message, exactly as the WINNER
  // mode already does per Req 2.1/3.4. Checking it first, and only
  // rendering it when there is no active WINNER/FINAL_RESULTS mode to show
  // instead, preserves that precedence without needing PAUSED to be a case
  // inside the switch itself.
  const mode = derivePresenterMode(state)
  const showPaused = game.status === 'PAUSED' && mode !== 'WINNER' && mode !== 'FINAL_RESULTS'

  function renderStage() {
    if (showPaused) {
      return (
        <div className="projector__message">
          <span className="projector__message-icon" aria-hidden="true">
            ⏸
          </span>
          <p className="projector__message-title">Game Paused</p>
        </div>
      )
    }

    switch (mode) {
      case 'FINAL_RESULTS': {
        const summary = buildFinalWinnerSummary(state.winners, game.id)
        return (
          <div className="projector__final-results">
            <span className="projector__message-icon" aria-hidden="true">
              🏁
            </span>
            <p className="projector__message-title">Game Completed</p>
            <ul className="projector__final-list">
              {summary.map((entry) => (
                <li key={entry.prizeId} className="projector__final-item">
                  <span className="projector__final-prize">{entry.prizeLabel}</span>
                  {entry.winnerName ? (
                    <span className="projector__final-winner">
                      {entry.winnerName}
                      {entry.ticketRef && (
                        <span className="projector__final-ticket"> Ticket #{entry.ticketRef}</span>
                      )}
                    </span>
                  ) : (
                    <span className="projector__final-winner projector__final-winner--none">
                      No Winner
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      }

      case 'WINNER': {
        const winner = state.winners.find((w) => w.id === game.latestWinnerAnnouncementId)
        if (!winner) break
        const announcement = toAnnouncementViewModel(winner)
        return (
          <div className="projector__announcement">
            <span className="projector__trophy" aria-hidden="true">
              🏆
            </span>
            <p className="projector__winner-title">{announcement.prizeLabel} Winner</p>
            <p className="projector__winner-name">{announcement.playerName}</p>
            {announcement.ticketRef && (
              <p className="projector__winner-ticket">Ticket #{announcement.ticketRef}</p>
            )}
            <p className="projector__winner-congrats">Congratulations!</p>
          </div>
        )
      }

      case 'WORD':
        if (!currentTerm) break
        return (
          <div className="projector__word-call">
            <span className="projector__eyebrow">Cyber Word</span>
            <p className="projector__term">{currentTerm.term}</p>
            <span className="projector__eyebrow projector__eyebrow--secondary">
              What It Means
            </span>
            <p className="projector__definition">{currentTerm.definition}</p>
            <span className="projector__eyebrow projector__eyebrow--secondary">
              Safe Practice
            </span>
            <p className="projector__tip">{currentTerm.awarenessTip}</p>
          </div>
        )

      case 'LOBBY':
      default:
        break
    }

    // Fallback (LOBBY, or a defensive fall-through from an unresolved
    // WINNER/WORD case): render the Lobby/"Scan to Join" screen.
    return (
      <div className="projector__lobby">
        <CircuitBackground />
        <div className="projector__lobby-glow" aria-hidden="true" />
        <div className="projector__lobby-content">
          <ShieldCheckIcon />
          <h1 className="projector__lobby-title">Cyber Awareness Month</h1>
          <p className="projector__lobby-subtitle">Cyber Tambola</p>
          <p className="projector__scan">Scan to Join</p>
          <JoinQrCode gameCode={game.code} size={qrSize} className="join-qr--projector" />
          <p className="projector__code-label">Game Code</p>
          <p className="projector__code">{game.code}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page page--dark projector">
      <div className="projector__stage">{renderStage()}</div>
    </div>
  )
}
