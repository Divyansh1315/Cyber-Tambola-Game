// Feature: winner-history-and-game-reset, Property 9: A pointer change always yields exactly one live subscription, scoped to the new game
//
// This property test drives GameSessionContext.tsx's pointer-follow mount
// effect (design.md's "Client: resolving and following the Active_Game"
// section) through arbitrary sequences of pointer-change announcements --
// including repeats of the same game id (no-ops, per the effect's own
// `newActiveGameId === gameIdRef.current` guard) and nulls interspersed
// (announcing "no Active_Game") -- and asserts that, after the full
// sequence has been processed, the mock Supabase client's channel
// bookkeeping shows exactly one non-unsubscribed per-game channel, scoped
// to whichever game id is currently held (the running result of applying
// each announcement's own no-op guard, exactly as the production effect
// computes it), or zero per-game channels if none is currently held. There
// is never a window left with two live per-game channels, nor one left
// dangling for a superseded game id.
//
// Mirrors GameSessionContext.pointerFollow.integration.test.tsx's (task
// 7.3) exact mocking approach: realtimeClient.ts's exported functions
// (getActiveGame, subscribeToGame, subscribeToActiveGamePointer,
// resetGameToNew) each close over that module's OWN private
// getSupabaseClient singleton, so `vi.mock`'s factory replacing the
// exported binding does not change what those already-defined functions
// close over internally -- they are reimplemented below as thin
// pass-throughs against `mockClient`, matching the real implementations'
// request/response shapes exactly (verified against realtimeClient.ts's
// source), rather than rediscovered from scratch here.
//
// Live-channel bookkeeping is observed directly rather than inferred: this
// test wraps the mock client's `.channel()` so every per-game
// (`game:<id>`) channel's `subscribe()`/`unsubscribe()` calls are recorded,
// giving a ground-truth "is this specific channel instance still live"
// answer with no dependency on firing further synthetic events.
//
// Validates: Requirements 6.1, 6.2
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, cleanup, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import fc from 'fast-check'
import {
  createMockSupabaseClient,
  type MockSupabaseClient,
} from './testSupport/mockSupabaseClient'

let mockClient: MockSupabaseClient | null = null

vi.mock('./realtimeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./realtimeClient')>()

  function getSupabaseClient() {
    return mockClient
  }

  async function getActiveGame() {
    const supabase = getSupabaseClient()
    if (!supabase) return undefined
    const { data, error } = await supabase.rpc('get_active_game')
    if (error) throw new actual.RpcError(error.code ?? 'UNKNOWN', error.message)
    const rows = data as unknown[] | Record<string, unknown> | null
    const row = Array.isArray(rows) ? rows[0] : rows
    return row ?? undefined
  }

  function subscribeToGame(
    gameId: string,
    onChange: (change: { table: string; eventType: string; row: Record<string, unknown> }) => void,
  ) {
    const supabase = getSupabaseClient()
    if (!supabase) return null
    const channel = supabase.channel(`game:${gameId}`)
    const tables = ['games', 'called_terms', 'players', 'tickets', 'marks', 'claims', 'winners']
    for (const table of tables) {
      const filterColumn = table === 'games' ? 'id' : 'game_id'
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `${filterColumn}=eq.${gameId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as Record<string, unknown>
          const scopeColumn = table === 'games' ? 'id' : 'game_id'
          if (String(row[scopeColumn]) !== gameId) return
          onChange({ table, eventType: payload.eventType, row })
        },
      )
    }
    channel.subscribe()
    return channel
  }

  function subscribeToActiveGamePointer(onChange: (activeGameId: string | null) => void) {
    const supabase = getSupabaseClient()
    if (!supabase) return null
    const channel = supabase.channel('active-game-pointer')
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'active_game_pointer' },
      (payload) => onChange((payload.new as { active_game_id: string | null }).active_game_id),
    )
    channel.subscribe()
    return channel
  }

  async function resetGameToNew(oldGameId: string, hostSecret: string) {
    const supabase = getSupabaseClient()
    if (!supabase) throw new Error('no mock client configured')
    const { data, error } = await supabase.rpc('reset_game_to_new', {
      p_old_game_id: oldGameId,
      p_host_secret: hostSecret,
    })
    if (error) throw new actual.RpcError(error.code ?? 'UNKNOWN', error.message)
    const rows = (data as unknown[] | null) ?? []
    return rows[0]
  }

  return {
    ...actual,
    getSupabaseClient,
    getActiveGame,
    subscribeToGame,
    subscribeToActiveGamePointer,
    resetGameToNew,
  }
})

import { GameSessionProvider, useGameSession } from './GameSessionContext'

// ---------------------------------------------------------------------------
// Test harness (mirrors GameSessionContext.pointerFollow.integration.test.tsx's
// existing convention)
// ---------------------------------------------------------------------------

function Harness() {
  useGameSession()
  return null
}

function mountProvider() {
  return render(createElement(GameSessionProvider, null, createElement(Harness)))
}

/** Builds a `get_active_game`-shaped game row for the given id. */
function buildGameRow(id: string): Record<string, unknown> {
  return {
    id,
    code: `CODE_${id}`,
    host_secret: `secret-${id}`,
    status: 'LOBBY',
    current_round: 0,
    current_term_id: null,
    previous_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: null,
    ended_at: null,
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

/** Fires a pointer-row change through the mock's `active_game_pointer` listener. */
function firePointerChange(client: MockSupabaseClient, activeGameId: string | null) {
  client.fireRemoteChange({
    table: 'active_game_pointer',
    eventType: 'UPDATE',
    row: { id: true, active_game_id: activeGameId, updated_at: new Date().toISOString() },
  })
}

/**
 * Wraps `client.channel()` so every `game:<id>` channel's live/unsubscribed
 * state is directly observable, keyed by the CHANNEL INSTANCE (not just its
 * name) -- `subscribeToGame` opens a brand-new channel object on every
 * call, even when re-subscribing to a previously-seen game id, so tracking
 * by name alone would conflate a fresh channel with a stale, already-
 * unsubscribed one of the same name. Returns a `livePerGameChannelNames()`
 * accessor reflecting exactly the channel names with at least one
 * subscribed-and-not-yet-unsubscribed instance.
 */
function trackPerGameChannelLiveness(client: MockSupabaseClient) {
  const liveInstances = new Set<object>()
  const nameByInstance = new Map<object, string>()
  const originalChannel = client.channel.bind(client)

  client.channel = (name: string) => {
    const channel = originalChannel(name)
    if (name.startsWith('game:')) {
      const originalUnsubscribe = channel.unsubscribe.bind(channel)
      channel.unsubscribe = () => {
        liveInstances.delete(channel)
        originalUnsubscribe()
      }
      liveInstances.add(channel)
      nameByInstance.set(channel, name)
    }
    return channel
  }

  return {
    livePerGameChannelNames(): string[] {
      return [...liveInstances].map((instance) => nameByInstance.get(instance)!)
    },
  }
}

/**
 * A pointer-change announcement fired at the mounted provider: either a
 * game id (a small closed pool, so repeats of the same id are exercised
 * naturally) or `null` ("no Active_Game").
 */
const gameIdPoolArb = fc.constantFrom('GAME_A', 'GAME_B', 'GAME_C')
const announcementArb = fc.option(gameIdPoolArb, { nil: null })
const announcementSequenceArb = fc.array(announcementArb, { minLength: 0, maxLength: 12 })

describe('Property 9: a pointer change always yields exactly one live subscription, scoped to the new game (Req 6.1, 6.2)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('after any sequence of pointer announcements, exactly one non-unsubscribed per-game channel remains, scoped to whichever game id is currently held (or zero if none is held)', async () => {
    await fc.assert(
      fc.asyncProperty(announcementSequenceArb, async (announcements) => {
        mockClient = createMockSupabaseClient()
        const client = mockClient
        const tracker = trackPerGameChannelLiveness(client)

        // Initial mount resolves to no Active_Game -- the property is about
        // the pointer-follow effect's own channel bookkeeping in response to
        // announcements, not the initial resolve, so start from the "no
        // game yet" state for every run.
        client.queueRpcResponse('get_active_game', { data: [] })

        const { unmount } = mountProvider()
        // Flush the initial mount effect's async resolve (get_active_game
        // -> [] -> NO_ACTIVE_GAME, no per-game fetch/channel involved) before
        // the announcement sequence begins.
        await waitFor(() => {
          expect(client.rpcCalls.some((c) => c.name === 'get_active_game')).toBe(true)
        })

        // Track the "currently held" game id exactly as the production
        // effect's own `gameIdRef` would, applying its own no-op guard
        // (`newActiveGameId === gameIdRef.current`): starts `undefined`
        // (no game resolved at mount), and each announcement either is
        // ignored (equal to what's already held) or replaces the held id
        // (a real game id, or `undefined` for a `null` announcement).
        let heldGameId: string | undefined

        for (const announcement of announcements) {
          const isNoOp = announcement === (heldGameId ?? null) && heldGameId !== undefined
          if (announcement !== null && !isNoOp) {
            // Queue the row get_active_game will resolve to if this
            // announcement triggers a re-resolve. A no-op announcement
            // (repeating the currently-held game id) must NOT queue a
            // response here: the production effect's own early-return guard
            // means it never calls get_active_game for a no-op, so queuing
            // one anyway would leave it unconsumed in the mock's FIFO queue
            // and be wrongly consumed by a LATER, genuinely-new announcement.
            client.queueRpcResponse('get_active_game', { data: [buildGameRow(announcement)] })
          }
          const expectedHeldAfterThis = isNoOp ? heldGameId : announcement ?? undefined

          act(() => {
            firePointerChange(client, announcement)
          })

          // Wait for the effect's own async work (re-resolve via
          // get_active_game, fetchFullGameState's parallel SELECTs, then
          // subscribeToGame) to fully settle before firing the next
          // announcement -- a non-no-op announcement involves several more
          // microtask hops than a synchronous re-render, so polling via
          // waitFor (rather than a fixed number of Promise.resolve() flushes)
          // is the only reliable way to reach a stable state here.
          await waitFor(() => {
            const expectedNames = expectedHeldAfterThis ? [`game:${expectedHeldAfterThis}`] : []
            expect(tracker.livePerGameChannelNames().sort()).toEqual(expectedNames)
          })

          heldGameId = expectedHeldAfterThis
        }

        const expectedLiveChannelNames = heldGameId ? [`game:${heldGameId}`] : []
        const actualLiveChannelNames = tracker.livePerGameChannelNames().sort()

        expect(actualLiveChannelNames).toEqual(expectedLiveChannelNames)

        unmount()
        cleanup()
      }),
      { numRuns: 100 },
    )
  }, 60000)
})
