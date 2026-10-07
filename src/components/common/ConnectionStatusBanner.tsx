import { Button } from './Button'
import { Card } from './Card'
import type { RealtimeConnectionStatus } from '../../state/GameSessionContext'
import './ConnectionStatusBanner.css'

interface ConnectionStatusBannerProps {
  status: RealtimeConnectionStatus
  onRetry: () => void
}

/**
 * Small, non-blocking banner surfacing E6's `realtimeConnectionStatus` (see
 * `GameSessionContext.tsx`'s doc comment on that type). Renders nothing for
 * `'not-configured'` (Local Fallback — nothing to report) and `'connecting'`/
 * `'connected'` (the normal, connected experience stays visually unchanged,
 * per the task's requirement) — only `'reconnecting'`, `'offline'`, and
 * `'failed'` render anything. Never blocks the rest of the page: callers
 * render this alongside existing content, not in place of it.
 */
export function ConnectionStatusBanner({ status, onRetry }: ConnectionStatusBannerProps) {
  if (status === 'reconnecting' || status === 'offline') {
    return (
      <Card
        className="connection-banner connection-banner--reconnecting"
        role="status"
        aria-live="polite"
      >
        <p className="connection-banner__text">
          <span aria-hidden="true">⟳</span> Connection lost. Reconnecting…
        </p>
      </Card>
    )
  }

  if (status === 'failed') {
    return (
      <Card
        className="connection-banner connection-banner--failed"
        role="alert"
        aria-live="assertive"
      >
        <p className="connection-banner__text">
          <span aria-hidden="true">⚠</span> Unable to reconnect to the game server.
        </p>
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      </Card>
    )
  }

  return null
}
