// Feature: module-5-prize-claim-processing-winner-management — unit tests for ClaimStatusTag
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { HostDecision, ValidationStatus } from '../../types/prize'
import { ClaimStatusTag } from './ClaimStatusTag'

// Mirrors the component's internal META tables (Req 1.5): every combination
// of validationStatus/hostDecision must render its own icon+text pair.
const VALIDATION_META: Record<ValidationStatus, { label: string; icon: string }> = {
  VALID: { label: 'Valid', icon: '✓' },
  INVALID: { label: 'Invalid', icon: '✕' },
  PENDING: { label: 'Pending', icon: '…' },
}

const HOST_DECISION_META: Record<HostDecision, { label: string; icon: string }> = {
  PENDING: { label: 'Pending', icon: '…' },
  CONFIRMED: { label: 'Confirmed', icon: '★' },
  REJECTED: { label: 'Rejected', icon: '✕' },
}

const VALIDATION_STATUSES: ValidationStatus[] = ['VALID', 'INVALID', 'PENDING']
const HOST_DECISIONS: HostDecision[] = ['PENDING', 'CONFIRMED', 'REJECTED']

describe('ClaimStatusTag', () => {
  for (const validationStatus of VALIDATION_STATUSES) {
    for (const hostDecision of HOST_DECISIONS) {
      it(`renders the correct icon+text pair for validationStatus=${validationStatus}, hostDecision=${hostDecision}`, () => {
        const { container } = render(
          <ClaimStatusTag validationStatus={validationStatus} hostDecision={hostDecision} />,
        )

        const validationMeta = VALIDATION_META[validationStatus]
        const hostDecisionMeta = HOST_DECISION_META[hostDecision]

        // Query by position (first/second tag) rather than by text, since the
        // two tags can legitimately share identical text (e.g. both PENDING).
        const tags = container.querySelectorAll('.claim-tag')
        expect(tags).toHaveLength(2)

        expect(tags[0]).toHaveTextContent(`${validationMeta.icon}${validationMeta.label}`)
        expect(tags[1]).toHaveTextContent(`${hostDecisionMeta.icon}${hostDecisionMeta.label}`)
      })
    }
  }

  it('renders both tags as siblings within a single tag group, even when labels collide (INVALID vs REJECTED both show "✕")', () => {
    render(<ClaimStatusTag validationStatus="INVALID" hostDecision="REJECTED" />)

    expect(screen.getByText('Invalid').closest('span')).toHaveClass('claim-tag--invalid')
    expect(screen.getByText('Rejected').closest('span')).toHaveClass('claim-tag--rejected')
  })
})
