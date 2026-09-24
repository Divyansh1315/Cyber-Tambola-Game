// Feature: module-2.5-cross-tab-sync — SYNC_LOCAL reducer behavior
//
// SYNC_LOCAL applies a shared-state payload broadcast from another tab of
// THIS browser (design.md Decision 7 — same-tab, zero-authority convenience,
// superseding the old rev-gated SYNC_STATE/SyncPayload mechanism, Module 6).
// These tests verify it: applies valid payloads via an id-keyed upsert per
// collection, ignores malformed ones (fail-safe), NEVER touches
// `currentPlayerId` (client-local identity — see the
// gameSessionReducer.playerIdentity.test.ts regression suite for the bugfix
// this protects), and never touches host-only demo data.
import { describe, it, expect } from 'vitest'
import {
  gameSessionReducer,
  isValidSharedStatePayload,
  type SharedStatePayload,
} from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import type { Game } from '../types/game'
import type { Player } from '../types/player'
import type { Ticket } from '../types/ticket'

function makeGame(over: Partial<Game> = {}): Game {
  return {
    id: 'GAME_001',
    code: 'CYBER24',
    status: 'WORD_ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    currentRound: 1,
    currentTermId: 'TERM_001',
    revealedTermIds: [],
    ...over,
  }
}

function makePlayer(id: string): Player {
  return {
    id,
    gameId: 'GAME_001',
    displayName: `Player ${id}`,
    employeeDemoId: `EMP-${id}`,
    ticketId: `TICKET_${id}`,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: `Player ${id}`,
    employeeId: `EMP-${id}`,
    ticketRef: `Ticket #${id}`,
  }
}

function makeTicket(id: string, playerId: string): Ticket {
  return {
    id,
    playerId,
    gameId: 'GAME_001',
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: `Ticket #${id}`,
    rows: [
      [{ termId: 'TERM_001', term: 'Phishing', state: 'LOCKED', row: 0, col: 0 }],
    ],
  }
}

describe('isValidSharedStatePayload', () => {
  it('accepts a well-formed payload', () => {
    const payload: SharedStatePayload = {
      game: makeGame(),
      players: [],
      tickets: [],
      marks: [],
      claims: [],
      winners: [],
    }
    expect(isValidSharedStatePayload(payload)).toBe(true)
  })

  it('rejects malformed values', () => {
    expect(isValidSharedStatePayload(null)).toBe(false)
    expect(isValidSharedStatePayload(undefined)).toBe(false)
    expect(isValidSharedStatePayload('nope')).toBe(false)
    expect(isValidSharedStatePayload({})).toBe(false)
    expect(isValidSharedStatePayload({ game: {}, players: [], tickets: [] })).toBe(false)
    expect(
      isValidSharedStatePayload({ game: makeGame(), players: 'x', tickets: [] }),
    ).toBe(false)
  })
})

describe('gameSessionReducer SYNC_LOCAL', () => {
  it('applies a valid payload (game replaced, players/tickets upserted by id)', () => {
    const player = makePlayer('A')
    const ticket = makeTicket('TICKET_A', 'A')
    const payload: SharedStatePayload = {
      game: makeGame({ status: 'WORD_ACTIVE', revealedTermIds: ['TERM_001'] }),
      players: [player],
      tickets: [ticket],
      marks: [],
      claims: [],
      winners: [],
    }

    const next = gameSessionReducer(gameSessionInitialState, {
      type: 'SYNC_LOCAL',
      payload,
    })

    expect(next.game.status).toBe('WORD_ACTIVE')
    expect(next.game.revealedTermIds).toEqual(['TERM_001'])
    expect(next.players).toEqual([player])
    expect(next.tickets).toEqual([ticket])
  })

  it('ignores a malformed payload and returns the same state (fail-safe)', () => {
    const bad = {
      game: { nope: true },
      players: [],
      tickets: [],
    } as unknown as SharedStatePayload
    const next = gameSessionReducer(gameSessionInitialState, {
      type: 'SYNC_LOCAL',
      payload: bad,
    })
    expect(next).toBe(gameSessionInitialState)
  })

  it('upserts an existing player/ticket by id rather than duplicating it', () => {
    const player = makePlayer('A')
    const ticket = makeTicket('TICKET_A', 'A')
    const withPlayer = {
      ...gameSessionInitialState,
      players: [player],
      tickets: [ticket],
    }
    const updatedPlayer = { ...player, displayName: 'Renamed' }
    const payload: SharedStatePayload = {
      game: makeGame(),
      players: [updatedPlayer],
      tickets: [ticket],
      marks: [],
      claims: [],
      winners: [],
    }

    const next = gameSessionReducer(withPlayer, { type: 'SYNC_LOCAL', payload })
    expect(next.players).toHaveLength(1)
    expect(next.players[0].displayName).toBe('Renamed')
  })

  it("never touches this tab's currentPlayerId, even when the payload's players array has no matching player (client-local identity fix)", () => {
    const local = { ...gameSessionInitialState, currentPlayerId: 'A' }
    // Simulates a Host tab broadcasting its own (empty) players array.
    const payload: SharedStatePayload = {
      game: makeGame(),
      players: [],
      tickets: [],
      marks: [],
      claims: [],
      winners: [],
    }

    const next = gameSessionReducer(local, { type: 'SYNC_LOCAL', payload })
    expect(next.currentPlayerId).toBe('A')
  })

  it('never adopts a currentPlayerId from the payload (SharedStatePayload has no such field)', () => {
    const local = { ...gameSessionInitialState, currentPlayerId: undefined }
    const payload: SharedStatePayload = {
      game: makeGame(),
      players: [makePlayer('A')],
      tickets: [makeTicket('TICKET_A', 'A')],
      marks: [],
      claims: [],
      winners: [],
    }

    const next = gameSessionReducer(local, { type: 'SYNC_LOCAL', payload })
    // Local had no currentPlayerId and SYNC_LOCAL must never set one.
    expect(next.currentPlayerId).toBeUndefined()
  })

  it('leaves a dangling currentPlayerId completely untouched (no reconciliation happens in SYNC_LOCAL)', () => {
    const local = { ...gameSessionInitialState, currentPlayerId: 'GHOST' }
    const payload: SharedStatePayload = {
      game: makeGame(),
      players: [makePlayer('A')],
      tickets: [makeTicket('TICKET_A', 'A')],
      marks: [],
      claims: [],
      winners: [],
    }

    const next = gameSessionReducer(local, { type: 'SYNC_LOCAL', payload })
    // SYNC_LOCAL is not responsible for dangling-id reconciliation anymore —
    // that only happens locally, on hydration (GameSessionContext.initState).
    expect(next.currentPlayerId).toBe('GHOST')
  })

  it('upserts claims/winners by id, leaving prizeProgress untouched by reference', () => {
    const payload: SharedStatePayload = {
      game: makeGame(),
      players: [],
      tickets: [],
      marks: [],
      claims: [],
      winners: [],
    }
    const next = gameSessionReducer(gameSessionInitialState, {
      type: 'SYNC_LOCAL',
      payload,
    })
    expect(next.claims).toEqual(gameSessionInitialState.claims)
    expect(next.winners).toEqual(gameSessionInitialState.winners)
    // prizeProgress has no merge logic in SYNC_LOCAL at all, so it is the
    // one field that remains genuinely untouched (same reference).
    expect(next.prizeProgress).toBe(gameSessionInitialState.prizeProgress)
  })
})
