import { useState } from 'react'
import { BrandMark } from '../../components/common/BrandMark'
import { Button } from '../../components/common/Button'
import { JoinQrCode } from '../../components/common/JoinQrCode'
import { useGameSession } from '../../state/GameSessionContext'
import type { Winner } from '../../types/prize'
import './PresentationView.css'

/**
 * Finds the most recently-added Winner not yet dismissed by the host.
 * Winners are append-only, so the last entry in the array is the most
 * recent; returns undefined once every Winner has been dismissed
 * (Req 14.3, 14.4).
 */
export function findLatestUndismissedWinner(
  winners: Winner[],
  dismissedWinnerIds: Set<string>,
): Winner | undefined {
  return [...winners].reverse().find((w) => !dismissedWinnerIds.has(w.id))
}

/**
 * Announcement view-model: picks exactly the two fields the presentation
 * screen may show for a winner — the prize label and the player's display
 * name — and nothing else (never employeeDemoId, ticketId, claimId, gameId,
 * prizeId, playerId, or confirmedAt) (Req 14.1, 14.2).
 */
export function toAnnouncementViewModel(winner: Winner): {
  prizeLabel: string
  playerName: string
} {
  return { prizeLabel: winner.prizeLabel, playerName: winner.playerName }
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
  const [dismissedWinnerIds, setDismissedWinnerIds] = useState<Set<string>>(new Set())

  const latestWinner = findLatestUndismissedWinner(state.winners, dismissedWinnerIds)
  const announcement = latestWinner ? toAnnouncementViewModel(latestWinner) : undefined

  return (
    <div className="page page--dark projector">
      <div className="projector__stage">
        {latestWinner && announcement ? (
          <div className="projector__announcement">
            <span className="projector__trophy" aria-hidden="true">
              🏆
            </span>
            <p className="projector__winner-title">{announcement.prizeLabel} Winner</p>
            <p className="projector__winner-name">{announcement.playerName}</p>
            <Button
              variant="secondary"
              onClick={() =>
                setDismissedWinnerIds((prev) => new Set(prev).add(latestWinner.id))
              }
            >
              Dismiss Winner Announcement
            </Button>
          </div>
        ) : (
          <>
            {game.status === 'LOBBY' && (
              <div className="projector__lobby">
                <BrandMark size="hero" withSubtitle onDark />
                <p className="projector__scan">Scan to Join</p>
                <JoinQrCode gameCode={game.code} size={260} />
                <p className="projector__code">
                  Game Code: <strong>{game.code}</strong>
                </p>
              </div>
            )}

            {game.status === 'WORD_ACTIVE' && currentTerm && (
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
            )}

            {game.status === 'PAUSED' && (
              <div className="projector__message">
                <span className="projector__message-icon" aria-hidden="true">
                  ⏸
                </span>
                <p className="projector__message-title">Game Paused</p>
              </div>
            )}

            {game.status === 'COMPLETED' && (
              <div className="projector__message">
                <span className="projector__message-icon" aria-hidden="true">
                  🏁
                </span>
                <p className="projector__message-title">Game Completed</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
