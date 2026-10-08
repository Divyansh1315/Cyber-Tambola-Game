import type { TicketCell as TicketCellData } from '../../types/game'

interface TicketCellProps {
  cell: TicketCellData
  onToggle: (termId: string) => void
  isAwarded?: boolean
}

/** Icon + label describing each state (never color alone). */
const STATE_META = {
  LOCKED: { hint: 'Tap to mark when called' },
  AVAILABLE: { hint: 'Tap to mark when called' },
  MARKED: { icon: '✓', hint: 'Marked' },
} as const

/**
 * A single cyber-word ticket cell.
 * - Unmarked cells (internally LOCKED or AVAILABLE) share one neutral
 *   presentation and remain tappable, so tap-ability never reveals which
 *   term is currently callable.
 * - MARKED cells show a checkmark and take visual priority.
 * State is conveyed with an icon and `aria-label`/`aria-pressed` in addition
 * to color for accessibility.
 */
export function TicketCell({ cell, onToggle, isAwarded = false }: TicketCellProps) {
  const meta = STATE_META[cell.state]
  const isMarked = cell.state === 'MARKED'

  return (
    <button
      type="button"
      className={`ticket-cell ${isMarked ? 'ticket-cell--marked' : 'ticket-cell--unmarked'} ${isAwarded ? 'ticket-cell--awarded' : ''}`}
      onClick={() => onToggle(cell.termId)}
      aria-pressed={isMarked}
      aria-label={`${cell.term}. ${meta.hint}`}
    >
      {cell.state === 'MARKED' && (
        <span className="ticket-cell__icon" aria-hidden="true">
          {STATE_META.MARKED.icon}
        </span>
      )}
      <span className="ticket-cell__term">{cell.term}</span>
    </button>
  )
}
