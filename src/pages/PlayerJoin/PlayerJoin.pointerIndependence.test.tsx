// Feature: winner-history-and-game-reset, Property 12: Player Join's code field is never altered by a pointer change
//
// PlayerJoin.tsx never imports getActiveGame/subscribeToActiveGamePointer/
// resetGameToNew (see design.md's "Player Join is untouched" section and
// task 12.5's dedicated static-import regression test) -- its Game Code
// field is driven exclusively by the user's own onChange handler
// (`setGameCode`). This property test drives that guarantee end to end:
// it renders PlayerJoin inside the real GameSessionProvider (whose mount
// effect DOES resolve/follow the Active_Game pointer, per task 7.1), types
// an arbitrary value into the Game Code field, then fires an arbitrary
// sequence of pointer-change events on `active_game_pointer` through the
// mock Supabase client's `fireRemoteChange` while PlayerJoin stays
// mounted, and asserts the field's value never changes out from under the
// user for any of those events -- it always still reads back exactly what
// was typed.
//
// Mocking approach mirrors GameSessionContext.pointerFollow.integration.test.tsx
// (task 7.3) and GameSessionContext.pointerSwap.test.ts (task 9) exactly:
// realtimeClient.ts's exported functions each close over that module's OWN
// private getSupabaseClient singleton, so vi.mock's factory replacing the
// exported binding does not change what those already-defined functions
// close over internally -- getActiveGame, subscribeToGame,
// subscribeToActiveGamePointer, and resetGameToNew are reimplemented below
// as thin pass-throughs against `mockClient`, matching the real
// implementations' request/response shapes exactly (verified against
// realtimeClient.ts's source), rather than rediscovered from scratch here.
//
// Validates: Requirements 7.2, 7.3
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import fc from 'fast-check'
import {
  createMockSupabaseClient,
  type MockSupabaseClient,
} from '../../state/testSupport/mockSupabaseClient'

let mockClient: MockSupabaseClient | null = null

vi.mock('../../state/realtimeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/realtimeClient')>()

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

import { GameSessionProvider } from '../../state/GameSessionContext'
import { PlayerJoin } from './PlayerJoin'

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

/** A typed Game Code value: printable, non-empty, no leading/trailing whitespace
 * quirks required since PlayerJoin's own onChange handler already upper-cases it. */
const typedCodeArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => s.trim().length > 0)

/** A pointer-change announcement: either a game id from a small closed pool
 * (so repeats/no-ops are exercised naturally) or `null` ("no Active_Game"). */
const gameIdPoolArb = fc.constantFrom('GAME_A', 'GAME_B', 'GAME_C')
const announcementArb = fc.option(gameIdPoolArb, { nil: null })
const announcementSequenceArb = fc.array(announcementArb, { minLength: 0, maxLength: 8 })

describe("Property 12: Player Join's code field is never altered by a pointer change (Req 7.2, 7.3)", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('after typing an arbitrary code and firing any sequence of pointer-change events, the Game Code field still reads back exactly what was typed', async () => {
    await fc.assert(
      fc.asyncProperty(typedCodeArb, announcementSequenceArb, async (typedCode, announcements) => {
        mockClient = createMockSupabaseClient()
        const client = mockClient

        // Initial mount resolves to no Active_Game -- this property is about
        // the Game Code field's independence from pointer churn, not the
        // initial resolve, so every run starts from "no game yet".
        client.queueRpcResponse('get_active_game', { data: [] })

        render(
          <GameSessionProvider>
            <MemoryRouter initialEntries={['/']}>
              <PlayerJoin />
            </MemoryRouter>
          </GameSessionProvider>,
        )

        await waitFor(() => {
          expect(client.rpcCalls.some((c) => c.name === 'get_active_game')).toBe(true)
        })

        const gameCodeField = screen.getByLabelText('Game Code')

        // fireEvent.change (rather than user.type) exercises PlayerJoin's own
        // onChange handler directly with the exact arbitrary string, without
        // routing it through userEvent's keyboard-descriptor parser (which
        // interprets characters like "{" and "[" as special key syntax and
        // would reject otherwise-valid arbitrary printable strings).
        act(() => {
          fireEvent.change(gameCodeField, { target: { value: typedCode } })
        })

        const expectedValue = typedCode.toUpperCase()
        expect(gameCodeField).toHaveValue(expectedValue)

        let heldGameId: string | undefined
        for (const announcement of announcements) {
          const isNoOp = announcement === (heldGameId ?? null) && heldGameId !== undefined
          if (announcement !== null && !isNoOp) {
            client.queueRpcResponse('get_active_game', { data: [buildGameRow(announcement)] })
          }
          const expectedHeldAfterThis = isNoOp ? heldGameId : announcement ?? undefined

          act(() => {
            firePointerChange(client, announcement)
          })

          // Whether or not this announcement triggers a re-resolve, the
          // field's value must never change -- assert immediately and
          // again once any async hydration work has settled.
          expect(gameCodeField).toHaveValue(expectedValue)

          if (!isNoOp && announcement !== null) {
            await waitFor(() => {
              expect(client.rpcCalls.filter((c) => c.name === 'get_active_game').length).toBeGreaterThan(0)
            })
          }

          expect(gameCodeField).toHaveValue(expectedValue)
          heldGameId = expectedHeldAfterThis
        }

        expect(gameCodeField).toHaveValue(expectedValue)

        cleanup()
      }),
      { numRuns: 100 },
    )
  }, 60000)
})
