// Feature: module-4-term-marking-prize-engine — bugfix regression, updated
// for module-6-realtime-multi-device-sync's removal of the `rev` cross-tab
// staleness counter (design.md Decision 6/7).
//
// The original defect this suite protects against: a "Host" tab broadcasting
// its own (older/incomplete) view of `marks` over BroadcastChannel must never
// erase a "Player" tab's fresher marks. Under the old `rev`-gated SYNC_STATE
// mechanism this was enforced by rejecting any payload whose `rev` was not
// strictly greater than the receiving tab's own `rev`, plus a union-by-id
// merge as a second line of defense. Under the current SYNC_LOCAL mechanism
// there is no `rev` at all — same-tab BroadcastChannel sync is a zero-
// authority convenience (design.md Decision 7), so the invariant is instead
// enforced directly by upsert-by-id: applying ANY payload, in ANY order,
// never removes a Mark (or any other record) the receiving tab already has;
// it can only add new ones or replace an existing id's fields.
//
// True multi-process/multi-tab BroadcastChannel timing is not deterministic
// in this test environment, so the two tabs are modeled as two independent
// GameSessionState objects and the "broadcast" is simulated by building a
// SharedStatePayload from one and dispatching SYNC_LOCAL against the other —
// exactly what GameSessionContext.tsx's channel.post()/subscribe() plumbing
// does.
import { describe, it, expect } from 'vitest'
import { gameSessionReducer, type SharedStatePayload } from './gameSessionReducer'
import { gameSessionInitialState } from './gameSessionInitialState'
import type { GameSessionState } from './gameSessionInitialState'
import type { Player } from '../types/player'
import type { Ticket, TicketCell } from '../types/ticket'

const PLAYER_ID = 'PLAYER_1'
const TICKET_ID = 'TICKET_1'

function makeTicket(): Ticket {
  const rows: TicketCell[][] = []
  let n = 0
  for (let row = 0; row < 3; row++) {
    const cells: TicketCell[] = []
    for (let col = 0; col < 5; col++) {
      cells.push({ termId: `T${n}`, term: `Term ${n}`, state: 'LOCKED', row, col })
      n++
    }
    rows.push(cells)
  }
  return {
    id: TICKET_ID,
    playerId: PLAYER_ID,
    gameId: 'GAME_001',
    createdAt: '2026-01-01T00:00:00.000Z',
    ref: 'Ticket #1',
    rows,
  }
}

function makePlayer(): Player {
  return {
    id: PLAYER_ID,
    gameId: 'GAME_001',
    displayName: 'Asha',
    employeeDemoId: 'EMP-1001',
    ticketId: TICKET_ID,
    joinedAt: '2026-01-01T00:00:00.000Z',
    name: 'Asha',
    employeeId: 'EMP-1001',
    ticketRef: 'Ticket #1',
  }
}

/**
 * Build a payload from a GameSessionState, as the context does.
 * `currentPlayerId` is intentionally excluded — it is client-local identity,
 * never part of a broadcast SharedStatePayload.
 */
function toPayload(state: GameSessionState): SharedStatePayload {
  return {
    game: state.game,
    players: state.players,
    tickets: state.tickets,
    marks: state.marks,
    claims: [],
    winners: [],
  }
}

/** Build the "Player tab": joins, reveals 3 terms, marks all 3. */
function buildPlayerTabWithThreeMarks(): GameSessionState {
  const ticket = makeTicket()
  const player = makePlayer()

  let state: GameSessionState = gameSessionReducer(gameSessionInitialState, {
    type: 'JOIN_PLAYER',
    player,
    ticket,
  })
  // Simulate each term being officially called (Module 5: calling and
  // revealing are the same step now) by directly setting it into
  // revealedTermIds/currentTermId/WORD_ACTIVE, then mark it.
  for (const termId of ['T0', 'T1', 'T2']) {
    state = {
      ...state,
      game: {
        ...state.game,
        status: 'WORD_ACTIVE',
        currentTermId: termId,
        revealedTermIds: [...state.game.revealedTermIds, termId],
      },
    }
    state = gameSessionReducer(state, { type: 'MARK_TERM', termId })
  }
  return state
}

describe('SYNC_LOCAL upserts by id and never drops a record the receiving tab already has (bugfix regression, updated for Module 6)', () => {
  it("an older/incomplete Host broadcast (marks: []) never erases the Player tab's marks", () => {
    // Player tab: has marked T0, T1, T2.
    const playerTab = buildPlayerTabWithThreeMarks()
    expect(playerTab.marks.map((m) => m.termId)).toEqual(['T0', 'T1', 'T2'])

    // Host tab: an OLDER snapshot captured before the Player's marks existed
    // (e.g. right after JOIN_PLAYER), with empty marks.
    const staleHostBase: GameSessionState = {
      ...gameSessionInitialState,
      game: { ...gameSessionInitialState.game, status: 'WORD_ACTIVE', currentTermId: 'T0' },
      players: playerTab.players,
      tickets: playerTab.tickets,
      marks: [],
    }

    // Host calls the next word against its own stale state — marks stays [].
    const hostAfterReveal = gameSessionReducer(staleHostBase, { type: 'CALL_NEXT_WORD' })
    expect(hostAfterReveal.marks).toEqual([])

    // Simulate the broadcast: apply the Host's older snapshot against the
    // Player tab. Under SYNC_LOCAL's upsert-by-id, this can only ADD rows
    // (there are none to add here) — it can never remove the Player's own
    // marks, unlike a blind whole-collection replace would.
    const payload = toPayload(hostAfterReveal)
    const playerAfterSync = gameSessionReducer(playerTab, {
      type: 'SYNC_LOCAL',
      payload,
    })

    expect(playerAfterSync.marks.map((m) => m.termId)).toEqual(['T0', 'T1', 'T2'])
    // The Host's game update (a game-only field) is still adopted.
    expect(playerAfterSync.game.currentTermId).toBe(hostAfterReveal.game.currentTermId)
  })

  it('applies a payload carrying a genuinely new mark on top of the existing ones', () => {
    const playerTab = buildPlayerTabWithThreeMarks()

    // A newer snapshot: call a brand-new term (T3, not among T0-T2 already
    // marked) and mark it.
    const revealed = {
      ...playerTab,
      game: {
        ...playerTab.game,
        status: 'WORD_ACTIVE' as const,
        currentTermId: 'T3',
        revealedTermIds: [...playerTab.game.revealedTermIds, 'T3'],
      },
    }
    const newerState = gameSessionReducer(revealed, { type: 'MARK_TERM', termId: 'T3' })
    expect(newerState.marks).toHaveLength(4)

    // Roll the Player tab BACK to before that 4th mark (simulating it hasn't
    // seen this update yet), then apply the newer payload via SYNC_LOCAL.
    const payload = toPayload(newerState)
    const applied = gameSessionReducer(playerTab, { type: 'SYNC_LOCAL', payload })

    expect(applied.marks.map((m) => m.termId).sort()).toEqual(['T0', 'T1', 'T2', 'T3'])
  })

  it('a payload identical to the current state is a safe, lossless no-op', () => {
    const playerTab = buildPlayerTabWithThreeMarks()
    const payload = toPayload(playerTab)

    const next = gameSessionReducer(playerTab, { type: 'SYNC_LOCAL', payload })
    expect(next.marks.map((m) => m.termId)).toEqual(['T0', 'T1', 'T2'])
  })

  // ---------------------------------------------------------------------
  // Bugfix regression: a payload whose own `marks` array doesn't include a
  // mark the receiving tab already has must still never drop it, even when
  // that payload also carries other, unrelated game-state progress (e.g. the
  // Host independently calling several more words on its own local state
  // before ever seeing the Player's broadcast). Upsert-by-id guarantees this
  // unconditionally — there is no ordering/"newness" comparison at all
  // anymore for SYNC_LOCAL to get wrong.
  // ---------------------------------------------------------------------
  it("merges (never drops) marks when a payload's own marks array is missing a mark the receiving tab already has", () => {
    const playerTab = buildPlayerTabWithThreeMarks()
    expect(playerTab.marks.map((m) => m.termId)).toEqual(['T0', 'T1', 'T2'])

    // Host tab: started independently, never saw Player's marks, and has
    // dispatched several of its own actions locally.
    let hostState: GameSessionState = {
      ...gameSessionInitialState,
      game: { ...gameSessionInitialState.game, status: 'WORD_ACTIVE', currentTermId: 'T5' },
      players: playerTab.players,
      tickets: playerTab.tickets,
      marks: [], // Host has never seen any of Player's marks
    }
    hostState = {
      ...hostState,
      game: {
        ...hostState.game,
        revealedTermIds: [...hostState.game.revealedTermIds, 'T5'],
      },
    }

    const payload = toPayload(hostState)
    const playerAfterSync = gameSessionReducer(playerTab, { type: 'SYNC_LOCAL', payload })

    // The Host's game-only update is adopted...
    expect(playerAfterSync.game.currentTermId).toBe('T5')
    // ...but every one of the Player's own marks survives, even though
    // Host's payload.marks was empty.
    expect(playerAfterSync.marks.map((m) => m.termId).sort()).toEqual(['T0', 'T1', 'T2'])
  })
})
