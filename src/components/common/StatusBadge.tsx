import type { GameStatus } from '../../types/game'
import './StatusBadge.css'

interface StatusBadgeProps {
  status: GameStatus
}

/** Human-readable label + dot for each game status. */
const STATUS_META: Record<GameStatus, { label: string; tone: string }> = {
  LOBBY: { label: 'Lobby', tone: 'lobby' },
  WORD_ACTIVE: { label: 'Word Active', tone: 'live' },
  PAUSED: { label: 'Paused', tone: 'paused' },
  COMPLETED: { label: 'Completed', tone: 'ended' },
}

/**
 * Status indicator that pairs a colored dot with a text label,
 * so status is never communicated by color alone.
 */
export function StatusBadge({ status }: StatusBadgeProps) {
  const meta = STATUS_META[status]
  return (
    <span className={`status-badge status-badge--${meta.tone}`}>
      <span className="status-badge__dot" aria-hidden="true" />
      {meta.label}
    </span>
  )
}
