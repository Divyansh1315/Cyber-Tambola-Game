import type { ReactNode } from 'react'
import { useEffect } from 'react'
import './Modal.css'

interface ModalProps {
  /** Controls mount/unmount. Modal renders nothing when false. */
  open: boolean
  /** Called when the user dismisses via backdrop tap or Esc (only when `dismissable`). */
  onDismiss?: () => void
  /** If false, no close affordance is rendered and onDismiss is never wired to backdrop/Esc. */
  dismissable?: boolean
  'aria-label': string
  children: ReactNode
}

/**
 * Generic, reusable bottom-sheet-style modal primitive.
 * Renders a fixed backdrop plus a panel pinned to the bottom of the viewport,
 * capped at the same mobile-first width as `.player__inner` (460px).
 */
export function Modal({ open, onDismiss, dismissable = true, children, 'aria-label': ariaLabel }: ModalProps) {
  useEffect(() => {
    if (!open || !dismissable) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismiss?.()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, dismissable, onDismiss])

  if (!open) return null

  const handleBackdropClick = () => {
    if (dismissable) {
      onDismiss?.()
    }
  }

  return (
    <div className="modal__backdrop" onClick={handleBackdropClick}>
      <div
        className="modal__panel"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
