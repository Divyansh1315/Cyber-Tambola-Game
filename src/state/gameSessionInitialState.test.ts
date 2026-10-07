// Feature: module-3-player-joining-tickets — zeroed initial prize progress (Req 18.2)
// Feature: module-4-term-marking-prize-engine — seeded empty marks (Req 1.4, 7.4)
import { describe, expect, it } from 'vitest'
import { gameSessionInitialState } from './gameSessionInitialState'
import { PRIZES } from '../utils/prizeEngine'
import type { PrizeId } from '../types/prize'

describe('gameSessionInitialState seed', () => {
  it('seeds prize progress zeroed with correct targets (Req 18.2)', () => {
    const { prizeProgress } = gameSessionInitialState

    const expected: { id: PrizeId; label: string; target: number }[] = PRIZES.map(
      (prize) => ({ id: prize.id, label: prize.label, target: prize.target }),
    )

    expect(prizeProgress).toHaveLength(expected.length)

    for (const want of expected) {
      const entry = prizeProgress.find((p) => p.id === want.id)
      expect(entry, `missing prize ${want.id}`).toBeDefined()
      expect(entry?.label).toBe(want.label)
      expect(entry?.current).toBe(0)
      expect(entry?.target).toBe(want.target)
    }
  })

  it('seeds empty players and tickets and undefined currentPlayerId (Req 14.1)', () => {
    expect(gameSessionInitialState.players).toEqual([])
    expect(gameSessionInitialState.tickets).toEqual([])
    expect(gameSessionInitialState.currentPlayerId).toBeUndefined()
  })

  it('seeds marks empty (Req 1.4)', () => {
    expect(gameSessionInitialState.marks).toEqual([])
  })
})

describe('PRIZES', () => {
  it('contains exactly the 5 expected prizes in the documented order (Req 7.4)', () => {
    expect(PRIZES.map((p) => p.id)).toEqual([
      'CYBER_FIVE',
      'FIREWALL_LINE',
      'SECURITY_LINE',
      'DATA_DEFENDER_LINE',
      'CYBER_FULL_HOUSE',
    ])
    expect(PRIZES.find((p) => p.id === 'CYBER_FIVE')?.target).toBe(5)
  })
})
