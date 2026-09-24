import type { HostDecision, ValidationStatus } from '../../types/prize'
import './ClaimStatusTag.css'

interface ClaimStatusTagProps {
  validationStatus: ValidationStatus
  hostDecision: HostDecision
}

const VALIDATION_META: Record<ValidationStatus, { label: string; tone: string; icon: string }> = {
  VALID: { label: 'Valid', tone: 'valid', icon: '✓' },
  INVALID: { label: 'Invalid', tone: 'invalid', icon: '✕' },
  // Reserved for shape parity; submission validation always resolves
  // synchronously to VALID/INVALID, so this case is not expected in practice.
  PENDING: { label: 'Pending', tone: 'pending', icon: '…' },
}

const HOST_DECISION_META: Record<HostDecision, { label: string; tone: string; icon: string }> = {
  PENDING: { label: 'Pending', tone: 'pending', icon: '…' },
  CONFIRMED: { label: 'Confirmed', tone: 'confirmed', icon: '★' },
  REJECTED: { label: 'Rejected', tone: 'rejected', icon: '✕' },
}

/**
 * Renders a claim's two independent statuses (Req 1.5) as two small tags:
 * the system's automated validationStatus and the host's manual
 * hostDecision. Each tag pairs an icon with text (not color alone).
 */
export function ClaimStatusTag({ validationStatus, hostDecision }: ClaimStatusTagProps) {
  const validationMeta = VALIDATION_META[validationStatus]
  const hostDecisionMeta = HOST_DECISION_META[hostDecision]
  return (
    <span className="claim-tag-group">
      <span className={`claim-tag claim-tag--${validationMeta.tone}`}>
        <span aria-hidden="true">{validationMeta.icon}</span>
        {validationMeta.label}
      </span>
      <span className={`claim-tag claim-tag--${hostDecisionMeta.tone}`}>
        <span aria-hidden="true">{hostDecisionMeta.icon}</span>
        {hostDecisionMeta.label}
      </span>
    </span>
  )
}
