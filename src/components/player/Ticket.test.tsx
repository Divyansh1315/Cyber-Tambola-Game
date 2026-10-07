// Feature: ticket-3x4-dimension-refactor — example test for Ticket grid DOM structure
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { Ticket as TicketData, TicketCell as TicketCellData } from '../../types/game'
import { Ticket } from './Ticket'

function buildCell(termId: string, term: string, row: number, col: number): TicketCellData {
  return { termId, term, state: 'LOCKED', row, col }
}

/** A 3x4 fixture ticket: 3 rows of 4 cells each, matching the new ticket shape. */
function build3x4Ticket(): TicketData {
  const rows: TicketCellData[][] = []
  for (let row = 0; row < 3; row++) {
    const cells: TicketCellData[] = []
    for (let col = 0; col < 4; col++) {
      const index = row * 4 + col
      cells.push(buildCell(`term-${index}`, `Term ${index}`, row, col))
    }
    rows.push(cells)
  }
  return {
    id: 'ticket-1',
    playerId: 'player-1',
    gameId: 'game-1',
    createdAt: new Date().toISOString(),
    ref: 'Ticket #001',
    rows,
  }
}

describe('Ticket grid DOM structure', () => {
  it('renders exactly 3 role="row" elements, each containing exactly 4 role="gridcell" elements', () => {
    const ticket = build3x4Ticket()
    const onToggleCell = vi.fn()
    const { container } = render(<Ticket ticket={ticket} onToggleCell={onToggleCell} />)

    const rows = container.querySelectorAll('[role="row"]')
    expect(rows).toHaveLength(3)

    rows.forEach((row) => {
      const gridcells = row.querySelectorAll('[role="gridcell"]')
      expect(gridcells).toHaveLength(4)
    })

    // Sanity check: total gridcells across the whole ticket is 12.
    expect(container.querySelectorAll('[role="gridcell"]')).toHaveLength(12)
  })

  it('wraps the rows in a single role="grid" container', () => {
    const ticket = build3x4Ticket()
    const onToggleCell = vi.fn()
    const { container } = render(<Ticket ticket={ticket} onToggleCell={onToggleCell} />)

    const grids = container.querySelectorAll('[role="grid"]')
    expect(grids).toHaveLength(1)
    expect(grids[0].querySelectorAll('[role="row"]')).toHaveLength(3)
  })
})
