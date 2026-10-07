// Feature: presenter-realtime-winner-sync, Property 1: Presenter display mode follows Req 2.10 priority order at all times
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { derivePresenterMode } from './PresentationView'
import type { GameSessionState } from '../../state/gameSessionInitialState'
import type { GameStatus } from '../../types/game'

/** Builds a minimal-but-valid GameSessionState for a given game-level combination. */
function buildState(overrides: {
  status: GameStatus
  latestWinnerAnnouncementId?: string
  currentTermId?: string
}): GameSessionState {
  return {
    game: {
      id: 'GAME_001',
      code: 'CYBER24',
      status: overrides.status,
      createdAt: '2026-01-01T08:00:00.000Z',
      currentRound: overrides.currentTermId ? 1 : 0,
      revealedTermIds: overrides.currentTermId ? [overrides.currentTermId] : [],
      currentTermId: overrides.currentTermId,
      latestWinnerAnnouncementId: overrides.latestWinnerAnnouncementId,
    },
    players: [],
    tickets: [],
    currentPlayerId: undefined,
    marks: [],
    claims: [],
    winners: [],
    winnerHistory: [],
    prizeProgress: [],
  }
}

const statusArb: fc.Arbitrary<GameStatus> = fc.constantFrom(
  'LOBBY',
  'WORD_ACTIVE',
  'PAUSED',
  'COMPLETED',
)

const maybeIdArb = fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined })

describe('derivePresenterMode', () => {
  describe('every combination of (status, latestWinnerAnnouncementId, currentTermId)', () => {
    const statuses: GameStatus[] = ['LOBBY', 'WORD_ACTIVE', 'PAUSED', 'COMPLETED']
    const announcementStates: Array<string | undefined> = ['WINNER_1', undefined]
    const termStates: Array<string | undefined> = ['TERM_1', undefined]

    for (const status of statuses) {
      for (const latestWinnerAnnouncementId of announcementStates) {
        for (const currentTermId of termStates) {
          it(`status=${status} announcement=${latestWinnerAnnouncementId ?? 'undefined'} currentTermId=${currentTermId ?? 'undefined'}`, () => {
            const state = buildState({ status, latestWinnerAnnouncementId, currentTermId })
            const mode = derivePresenterMode(state)

            if (status === 'COMPLETED') {
              expect(mode).toBe('FINAL_RESULTS')
            } else if (latestWinnerAnnouncementId !== undefined) {
              expect(mode).toBe('WINNER')
            } else if (status === 'WORD_ACTIVE' && currentTermId) {
              expect(mode).toBe('WORD')
            } else {
              expect(mode).toBe('LOBBY')
            }
          })
        }
      }
    }
  })

  it('COMPLETED wins even when latestWinnerAnnouncementId is ALSO defined (priority edge case)', () => {
    const state = buildState({
      status: 'COMPLETED',
      latestWinnerAnnouncementId: 'WINNER_1',
      currentTermId: 'TERM_1',
    })
    expect(derivePresenterMode(state)).toBe('FINAL_RESULTS')
  })

  it('an active announcement wins over WORD_ACTIVE with a current term (priority edge case)', () => {
    const state = buildState({
      status: 'WORD_ACTIVE',
      latestWinnerAnnouncementId: 'WINNER_1',
      currentTermId: 'TERM_1',
    })
    expect(derivePresenterMode(state)).toBe('WINNER')
  })

  // Note: PAUSED is intentionally NOT tested as an expected return value of
  // derivePresenterMode itself -- the function can never return 'PAUSED'; it
  // is a sibling check made independently by PresentationView's component
  // body (see derivePresenterMode's own doc comment in PresentationView.tsx).
  // What IS tested here is that an active announcement still wins over a
  // PAUSED status when derivePresenterMode is evaluated for a paused game,
  // matching the four combinations exercised above for status='PAUSED'.
  it('an active announcement still resolves to WINNER even when status is PAUSED', () => {
    const state = buildState({ status: 'PAUSED', latestWinnerAnnouncementId: 'WINNER_1' })
    expect(derivePresenterMode(state)).toBe('WINNER')
  })

  it('PAUSED with no announcement and no current term falls through to LOBBY (derivePresenterMode has no WORD/PAUSED case to give it)', () => {
    const state = buildState({ status: 'PAUSED' })
    expect(derivePresenterMode(state)).toBe('LOBBY')
  })

  it('property: for any random state combination, the output always satisfies Req 2.10 priority order', () => {
    fc.assert(
      fc.property(
        statusArb,
        maybeIdArb,
        maybeIdArb,
        (status, latestWinnerAnnouncementId, currentTermId) => {
          const state = buildState({ status, latestWinnerAnnouncementId, currentTermId })
          const mode = derivePresenterMode(state)

          if (status === 'COMPLETED') {
            expect(mode).toBe('FINAL_RESULTS')
          } else if (latestWinnerAnnouncementId !== undefined) {
            expect(mode).toBe('WINNER')
          } else if (status === 'WORD_ACTIVE' && currentTermId) {
            expect(mode).toBe('WORD')
          } else {
            expect(mode).toBe('LOBBY')
          }
        },
      ),
      { numRuns: 200 },
    )
  })
})
