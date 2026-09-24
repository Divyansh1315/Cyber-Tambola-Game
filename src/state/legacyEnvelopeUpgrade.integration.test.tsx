// Feature: module-4-term-marking-prize-engine — legacy envelope rejection
//
// Covers the scenario where a real browser already has an old, pre-Module-5
// v2 envelope persisted (from before the direct-word-call refactor bumped
// `PERSIST_VERSION` to 3). A v2 envelope may even carry a now-invalid status
// string like `CLUE_ACTIVE`, which no longer exists on `GameStatus` at all.
// Loading it must never throw and must never silently "upgrade" it in place
// — `parseEnvelope` rejects any envelope whose `version` isn't exactly the
// current `PERSIST_VERSION`, so the provider falls back to a fresh seed game
// instead. `currentPlayerId` is, separately, client-local identity and is
// never read from this shared envelope at all.
//
// Validates: Requirements 5.4, 16.4
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import {
  GameSessionProvider,
  useGameSession,
  type GameSessionContextValue,
} from './GameSessionContext'
import { STORAGE_KEY, PERSIST_VERSION } from './persistence'
import { buildJoinOutcome } from './joinService'
import { createSeedGame } from './gameSessionInitialState'
import { cyberTerms } from '../data/cyberTerms'

// ---------------------------------------------------------------------------
// Test harness (mirrors session.integration.test.tsx's convention)
// ---------------------------------------------------------------------------

function Harness({ sink }: { sink: { current: GameSessionContextValue | null } }) {
  const ctx = useGameSession()
  const ref = useRef(sink)
  useEffect(() => {
    ref.current.current = ctx
  })
  sink.current = ctx
  return null
}

function mountProvider() {
  const sink: { current: GameSessionContextValue | null } = { current: null }
  const utils = render(
    <GameSessionProvider>
      <Harness sink={sink} />
    </GameSessionProvider>,
  )
  return { sink, ...utils }
}

const VALID_CODE = 'CYBER24'

describe('legacy (version 2, pre-Module-5) envelope is rejected safely (module-4-term-marking-prize-engine)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('discards a version:2 envelope (even with a now-invalid CLUE_ACTIVE status) and falls back to a fresh seed game, without throwing (Req 5.4, 16.4)', () => {
    // Build a real player + ticket via the same join flow the app uses, so
    // the seeded envelope's players/tickets have a realistic, valid shape.
    // The game's status is deliberately the now-removed 'CLUE_ACTIVE' value
    // — exactly what a real pre-Module-5 (version 2) envelope would still
    // contain on disk. This is realistic legacy data, not a malformed one.
    const game = {
      ...createSeedGame(),
      status: 'CLUE_ACTIVE' as never,
      currentRound: 1,
    }
    const outcome = buildJoinOutcome({
      form: { gameCode: VALID_CODE, employeeName: 'Asha', employeeId: 'EMP-1001' },
      game,
      players: [],
      tickets: [],
      terms: cyberTerms,
    })
    if (outcome.kind !== 'new') {
      throw new Error(`expected a new join outcome, got: ${outcome.kind}`)
    }

    // A Module-3-shaped v2 envelope: version 2, game/players/tickets present
    // (plus a legacy `currentPlayerId` field, now simply ignored by
    // parseEnvelope since it's client-local, not shared, state), and no
    // `marks` key at all (predates Module 4 too).
    const legacyEnvelope = {
      version: 2,
      game,
      players: [outcome.player],
      tickets: [outcome.ticket],
      currentPlayerId: outcome.player.id,
      // marks intentionally omitted
    }
    expect('marks' in legacyEnvelope).toBe(false)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(legacyEnvelope))

    let mounted!: ReturnType<typeof mountProvider>
    expect(() => {
      mounted = mountProvider()
    }).not.toThrow()

    const s = mounted.sink.current!.state

    // The whole legacy envelope is rejected on version mismatch — the
    // provider falls back to a fresh seed game rather than adopting any of
    // the stale game/players/tickets/marks from disk.
    expect(s.game.status).toBe('LOBBY')
    expect(s.players).toEqual([])
    expect(s.tickets).toEqual([])
    expect(s.marks).toEqual([])
    expect(s.currentPlayerId).toBeUndefined()

    expect(mounted.sink.current!.currentPlayer).toBeUndefined()
    expect(mounted.sink.current!.currentTicket).toBeUndefined()
    expect(mounted.sink.current!.currentPlayerMarks).toEqual([])

    mounted.unmount()
  })

  it('also falls back to a fresh seed game when a version:2 envelope explicitly sets marks to null or a non-array value (Req 5.4)', () => {
    const game = createSeedGame()
    const outcome = buildJoinOutcome({
      form: { gameCode: VALID_CODE, employeeName: 'Bhavin', employeeId: 'EMP-1002' },
      game,
      players: [],
      tickets: [],
      terms: cyberTerms,
    })
    if (outcome.kind !== 'new') {
      throw new Error(`expected a new join outcome, got: ${outcome.kind}`)
    }

    for (const badMarks of [null, 'not-an-array', 42, { not: 'an array' }]) {
      localStorage.clear()
      const envelope = {
        version: 2,
        game,
        players: [outcome.player],
        tickets: [outcome.ticket],
        currentPlayerId: outcome.player.id,
        marks: badMarks,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))

      let mounted!: ReturnType<typeof mountProvider>
      expect(() => {
        mounted = mountProvider()
      }).not.toThrow()

      const s = mounted.sink.current!.state
      // Version mismatch alone is enough to reject the whole envelope,
      // regardless of what `marks` contains.
      expect(s.players).toEqual([])
      expect(s.tickets).toEqual([])
      expect(s.marks).toEqual([])

      mounted.unmount()
    }
  })
})

// ---------------------------------------------------------------------------
// module-5-prize-claim-processing-winner-management — pre-Module-5 (v3)
// envelope, now also rejected wholesale
// ---------------------------------------------------------------------------
//
// A version:3 envelope (Module 4's direct-word-call refactor, carrying a
// `rev` field and no `claims`/`winners`) predates module-6-realtime-multi-
// device-sync's removal of `rev` (design.md Decision 6/7), which bumped
// `PERSIST_VERSION` to 4. Like the version-2 scenario above, this is now a
// strict version mismatch against the CURRENT `PERSIST_VERSION` and is
// rejected wholesale — the provider falls back to a fresh seed game rather
// than adopting any of the stale game/players/tickets/marks from disk.
describe('legacy (version 3, pre-Module-6) envelope is rejected safely (module-6-realtime-multi-device-sync)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('discards a version:3 envelope (which still carries a `rev` field) and falls back to a fresh seed game, without throwing (Req 16.4)', () => {
    const game = {
      ...createSeedGame(),
      status: 'WORD_ACTIVE' as never,
      currentRound: 1,
    }
    const outcome = buildJoinOutcome({
      form: { gameCode: VALID_CODE, employeeName: 'Chetan', employeeId: 'EMP-1003' },
      game,
      players: [],
      tickets: [],
      terms: cyberTerms,
    })
    if (outcome.kind !== 'new') {
      throw new Error(`expected a new join outcome, got: ${outcome.kind}`)
    }

    const mark = {
      id: 'mark-1',
      playerId: outcome.player.id,
      ticketId: outcome.ticket.id,
      termId: cyberTerms[0].id,
      markedAt: Date.now(),
    }

    // A pre-Module-6 (version 3) envelope: still carries `rev`, no
    // `claims`/`winners` — exactly what a real envelope persisted between
    // Module 4 and Module 5 would look like on disk.
    const rawEnvelope = {
      version: 3,
      game,
      rev: 3,
      players: [outcome.player],
      tickets: [outcome.ticket],
      marks: [mark],
    }
    expect(rawEnvelope.version).not.toBe(PERSIST_VERSION)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rawEnvelope))

    let mounted!: ReturnType<typeof mountProvider>
    expect(() => {
      mounted = mountProvider()
    }).not.toThrow()

    const s = mounted.sink.current!.state

    // The whole legacy envelope is rejected on version mismatch — the
    // provider falls back to a fresh seed game.
    expect(s.game.status).toBe('LOBBY')
    expect(s.players).toEqual([])
    expect(s.tickets).toEqual([])
    expect(s.marks).toEqual([])
    expect(s.claims).toEqual([])
    expect(s.winners).toEqual([])

    mounted.unmount()
  })
})

// ---------------------------------------------------------------------------
// module-6-realtime-multi-device-sync — current-version envelope missing
// claims/winners still defaults them to []
// ---------------------------------------------------------------------------
//
// Covers the scenario where a current (PERSIST_VERSION 4) envelope is
// missing `claims`/`winners` keys or carries a malformed value for either —
// `parseEnvelope` defaults them to `[]` while restoring the rest of the
// envelope intact (Req 16.4), the same fail-safe convention as `marks`.
describe('current-version envelope defaults claims/winners to [] (module-6-realtime-multi-device-sync)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('restores game/players/tickets/marks intact and defaults claims/winners to [] without throwing (Req 16.4)', () => {
    const game = {
      ...createSeedGame(),
      status: 'WORD_ACTIVE' as never,
      currentRound: 1,
    }
    const outcome = buildJoinOutcome({
      form: { gameCode: VALID_CODE, employeeName: 'Chetan', employeeId: 'EMP-1003' },
      game,
      players: [],
      tickets: [],
      terms: cyberTerms,
    })
    if (outcome.kind !== 'new') {
      throw new Error(`expected a new join outcome, got: ${outcome.kind}`)
    }

    const mark = {
      id: 'mark-1',
      playerId: outcome.player.id,
      ticketId: outcome.ticket.id,
      termId: cyberTerms[0].id,
      markedAt: Date.now(),
    }

    // A current-version envelope with valid game/players/tickets/marks, but
    // `claims`/`winners` keys deliberately omitted entirely.
    const rawEnvelope = {
      version: PERSIST_VERSION,
      game,
      players: [outcome.player],
      tickets: [outcome.ticket],
      marks: [mark],
      // claims intentionally omitted
      // winners intentionally omitted
    }
    expect('claims' in rawEnvelope).toBe(false)
    expect('winners' in rawEnvelope).toBe(false)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rawEnvelope))

    let mounted!: ReturnType<typeof mountProvider>
    expect(() => {
      mounted = mountProvider()
    }).not.toThrow()

    const s = mounted.sink.current!.state

    // claims/winners default to [] rather than the whole envelope being
    // rejected.
    expect(s.claims).toEqual([])
    expect(s.winners).toEqual([])

    // The rest of the restored state is intact and matches what was seeded.
    expect(s.game.status).toBe('WORD_ACTIVE')
    expect(s.game.id).toBe(game.id)
    expect(s.players).toEqual([outcome.player])
    expect(s.tickets).toEqual([outcome.ticket])
    expect(s.marks).toEqual([mark])

    mounted.unmount()
  })

  it('also defaults claims/winners to [] when explicitly null or a non-array value (Req 16.4)', () => {
    const game = createSeedGame()
    const outcome = buildJoinOutcome({
      form: { gameCode: VALID_CODE, employeeName: 'Divya', employeeId: 'EMP-1004' },
      game,
      players: [],
      tickets: [],
      terms: cyberTerms,
    })
    if (outcome.kind !== 'new') {
      throw new Error(`expected a new join outcome, got: ${outcome.kind}`)
    }

    for (const badValue of [null, 'not-an-array', 42, { not: 'an array' }]) {
      localStorage.clear()
      const rawEnvelope = {
        version: PERSIST_VERSION,
        game,
        players: [outcome.player],
        tickets: [outcome.ticket],
        marks: [],
        claims: badValue,
        winners: badValue,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rawEnvelope))

      let mounted!: ReturnType<typeof mountProvider>
      expect(() => {
        mounted = mountProvider()
      }).not.toThrow()

      const s = mounted.sink.current!.state
      expect(s.claims).toEqual([])
      expect(s.winners).toEqual([])
      // The rest of the envelope still restores successfully.
      expect(s.players).toEqual([outcome.player])
      expect(s.tickets).toEqual([outcome.ticket])

      mounted.unmount()
    }
  })
})
