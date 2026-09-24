import type { Ticket as TicketData } from '../../types/game'
import { TicketCell } from './TicketCell'
import './Ticket.css'

interface TicketProps {
  ticket: TicketData
  onToggleCell: (termId: string) => void
}

/**
 * The 3 x 5 cyber-word ticket.
 * Renders a responsive grid of cells; long terms wrap gracefully and the grid
 * never causes horizontal page scroll on narrow mobile widths.
 */
export function Ticket({ ticket, onToggleCell }: TicketProps) {
  return (
    <div
      className="ticket-grid"
      role="grid"
      aria-label={`Cyber word ticket ${ticket.ref}`}
    >
      {ticket.rows.map((row, rowIndex) => (
        <div className="ticket-grid__row" role="row" key={rowIndex}>
          {row.map((cell) => (
            <div role="gridcell" key={cell.termId}>
              <TicketCell cell={cell} onToggle={onToggleCell} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
