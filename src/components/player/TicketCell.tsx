import type { TicketCell as TicketCellData } from '../../types/game'

interface TicketCellProps {
  cell: TicketCellData
  onToggle: (termId: string) => void
}

/** Icon + label describing each state (never color alone). */
const STATE_META = {
  LOCKED: { icon: '🔒', hint: 'Not revealed yet' },
  AVAILABLE: { icon: '○', hint: 'Available — tap to mark' },
  MARKED: { icon: '✓', hint: 'Marked' },
} as const

/**
 * A single cyber-word ticket cell.
 * - LOCKED cells are disabled and announce "Not revealed yet".
 * - AVAILABLE cells can be tapped to become MARKED.
 * - MARKED cells show a checkmark and can be un-marked.
 * State is conveyed with an icon and text in addition to color for accessibility.
 */
export function TicketCell({ cell, onToggle }: TicketCellProps) {
  const meta = STATE_META[cell.state]
  const isLocked = cell.state === 'LOCKED'
  const isMarked = cell.state === 'MARKED'

  return (
    <button
      type="button"
      className={`ticket-cell ticket-cell--${cell.state.toLowerCase()}`}
      onClick={() => onToggle(cell.termId)}
      disabled={isLocked}
      aria-pressed={isMarked}
      aria-label={`${cell.term}. ${meta.hint}`}
    >
      <span className="ticket-cell__icon" aria-hidden="true">
        {meta.icon}
      </span>
      <span className="ticket-cell__term">{cell.term}</span>
      <span className="ticket-cell__state" aria-hidden="true">
        {cell.state === 'LOCKED'
          ? 'Locked'
          : cell.state === 'MARKED'
            ? 'Marked'
            : 'Available'}
      </span>
    </button>
  )
}
