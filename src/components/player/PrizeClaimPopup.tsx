import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import type { PrizeProgress } from '../../types/prize'
import type { PlayerClaimStatus } from '../../utils/winnerEngine'
import './PrizeClaimPopup.css'

interface PrizeClaimPopupProps {
  progress: PrizeProgress
  status: PlayerClaimStatus
  view: { message: string; buttonLabel: string; buttonDisabled: boolean }
  isSubmitting: boolean
  onClaim: () => void
  onDismiss: () => void
  /**
   * Mirrors PlayerGame.tsx's existing `lastSessionGuardFailure`-derived
   * check for this prize block: a claim submission for this specific prize
   * was blocked by the pre-submission session consistency guard. Renders
   * the identical "session out of date" message/button in place of the
   * claim button, rather than inventing a second messaging path (Req 2.4
   * error-handling branch, design.md Error Handling).
   */
  sessionGuardFailed: boolean
}

/**
 * The automatically-surfacing Prize_Claim_Popup (Req 1.1). Built on top of
 * the generic `Modal` primitive. Introduces no new eligibility, validation,
 * or claim-decision logic — title/message/button copy and disabled state
 * are read verbatim from the existing `progress`/`view`/`isSubmitting`
 * inputs already derived by PlayerGame.tsx's `prizeBlocks` (Req 1.4).
 */
export function PrizeClaimPopup({
  progress,
  status,
  view,
  isSubmitting,
  onClaim,
  onDismiss,
  sessionGuardFailed,
}: PrizeClaimPopupProps) {
  // Req 4.4 / 2.5: a player can back out of an eligible-but-not-yet-claimed
  // popup; dismissal is disabled while PENDING/submitting since there is
  // nothing meaningful to dismiss to — the popup instead auto-closes via
  // the queue hook on CONFIRMED/REJECTED/CLOSED_BY_OTHER_WINNER transitions.
  const dismissable = status === 'ELIGIBLE'

  return (
    <Modal
      open
      onDismiss={onDismiss}
      dismissable={dismissable}
      aria-label={`${progress.label} prize claim`}
    >
      <div className="prize-claim-popup">
        <h2 className="prize-claim-popup__title">{progress.label}</h2>
        {sessionGuardFailed ? (
          <>
            <p
              className="prize-claim-popup__message prize-claim-popup__message--session-guard"
              role="status"
            >
              Your session is out of date. Please refresh or rejoin to continue.
            </p>
            <Button
              variant="secondary"
              size="md"
              className="prize-claim-popup__btn"
              onClick={() => window.location.reload()}
            >
              Refresh
            </Button>
          </>
        ) : (
          <>
            <p className="prize-claim-popup__message" role="status">
              {view.message}
            </p>
            <Button
              variant={status === 'CONFIRMED' ? 'success' : 'primary'}
              size="md"
              className="prize-claim-popup__btn"
              disabled={view.buttonDisabled || isSubmitting}
              onClick={onClaim}
              icon="🏆"
            >
              {isSubmitting ? 'Submitting Claim...' : view.buttonLabel}
            </Button>
          </>
        )}
      </div>
    </Modal>
  )
}
