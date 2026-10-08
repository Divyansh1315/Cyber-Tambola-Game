import { useEffect } from 'react'
import './CelebrationOverlay.css'

/** How long the celebration overlay stays visible before auto-dismissing. */
export const CELEBRATION_DURATION_MS = 3000

/** Fixed number of CSS-only confetti pieces rendered in the animated branch. */
const CONFETTI_COUNT = 56

interface CelebrationOverlayProps {
  prizeLabel: string
  onDismiss: () => void
  /** Overridable for tests; defaults to reading `matchMedia('(prefers-reduced-motion: reduce)')`. */
  reducedMotion?: boolean
}

function readPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Transient celebration shown when a prize claim is confirmed. Auto-dismisses
 * itself after CELEBRATION_DURATION_MS. Honors prefers-reduced-motion by
 * rendering the same confirmed-win message without animated confetti.
 */
export function CelebrationOverlay({
  prizeLabel,
  onDismiss,
  reducedMotion,
}: CelebrationOverlayProps) {
  const effectiveReducedMotion = reducedMotion ?? readPrefersReducedMotion()

  useEffect(() => {
    const timer = setTimeout(onDismiss, CELEBRATION_DURATION_MS)
    return () => clearTimeout(timer)
  }, [onDismiss])

  return (
    <div className="celebration-overlay" role="status" aria-live="polite">
      {!effectiveReducedMotion && (
        <div className="celebration-overlay__confetti" aria-hidden="true">
          {Array.from({ length: CONFETTI_COUNT }, (_, index) => (
            <span
              key={index}
              className="celebration-overlay__piece"
              style={{
                left: `${(index * (100 / CONFETTI_COUNT)) % 100}%`,
                animationDelay: `${(index % 8) * 0.15}s`,
              }}
            />
          ))}
        </div>
      )}
      <p className="celebration-overlay__message">🏆 {prizeLabel} confirmed!</p>
    </div>
  )
}
