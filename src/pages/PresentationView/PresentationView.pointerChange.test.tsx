// Feature: winner-history-and-game-reset — task 12.3
//
// Component test that PresentationView.tsx's rendered QR/join-code display
// (JoinQrCode + the "Game Code: ..." text near "Scan to Join") updates live
// on an Active_Game_Pointer change, without a remount.
//
// Mocks `../../state/realtimeClient` module-wide, same convention as
// `GameSessionContext.pointerFollow.integration.test.tsx` (task 7.3):
// PresentationView.tsx resolves its game exclusively through
// `useGameSession()`, so this test drives the change entirely through
// GameSessionProvider's own pointer-follow mount effect. `realtimeClient.ts`'s
// exported functions (getActiveGame, subscribeToGame,
// subscribeToActiveGamePointer) each close over that module's OWN private
// `getSupabaseClient` singleton — Vitest's `vi.mock` factory replacing the
// exported binding does not change what an already-defined function in that
// same module closes over internally, so those are reimplemented below as
// thin pass-throughs against the mock Supabase client, matching the real
// implementations' request/response shapes exactly (verified against
// realtimeClient.ts's source).
//
// Validates: Requirements 8.1, 8.2
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
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
          // Reproduce real Postgres Changes' per-game-id filter scoping at
          // the listener level, since the mock fixture's fireRemoteChange
          // matches listeners by TABLE only (see mockSupabaseClient.ts's own
          // documented contract).
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

  return {
    ...actual,
    getSupabaseClient,
    getActiveGame,
    subscribeToGame,
    subscribeToActiveGamePointer,
  }
})

import { PresentationView } from './PresentationView'
import { GameSessionProvider } from '../../state/GameSessionContext'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Builds a `get_active_game`-shaped game row, in LOBBY status (Scan to Join screen). */
function buildGameRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'GAME_A',
    code: 'CYBER24',
    host_secret: 'secret-a',
    status: 'LOBBY',
    current_round: 0,
    current_term_id: null,
    previous_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: null,
    ended_at: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
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

function renderView() {
  return render(
    <MemoryRouter>
      <GameSessionProvider>
        <PresentationView />
      </GameSessionProvider>
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------

describe('PresentationView QR/join-code display updates live on a pointer change (Task 12.3, Req 8.1, 8.2)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mockClient = createMockSupabaseClient()
  })

  it('updates the rendered game code to the new Active_Game once a pointer change is announced, without a remount', async () => {
    const client = mockClient!
    client.queueRpcResponse('get_active_game', { data: [buildGameRow({ id: 'GAME_A', code: 'CYBER24' })] })

    const { container } = renderView()

    await waitFor(() => {
      expect(screen.getByText('Scan to Join')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByText('CYBER24')).toBeInTheDocument()
    })

    // Grab the actual DOM node hosting the projector lobby markup so we can
    // assert it is the SAME node after the pointer change (no remount).
    const lobbyNodeBefore = container.querySelector('.projector__lobby')
    expect(lobbyNodeBefore).not.toBeNull()

    // Queue the row get_active_game resolves to once the pointer-change
    // handler re-resolves after the announcement.
    client.queueRpcResponse('get_active_game', {
      data: [buildGameRow({ id: 'GAME_B', code: 'NEWG01', host_secret: 'secret-b' })],
    })

    await act(async () => {
      firePointerChange(client, 'GAME_B')
    })

    await waitFor(() => {
      expect(screen.getByText('NEWG01')).toBeInTheDocument()
    })
    expect(screen.queryByText('CYBER24')).not.toBeInTheDocument()

    // Still on the "Scan to Join" lobby screen, and the same DOM node was
    // reused rather than a fresh subtree being mounted.
    expect(screen.getByText('Scan to Join')).toBeInTheDocument()
    const lobbyNodeAfter = container.querySelector('.projector__lobby')
    expect(lobbyNodeAfter).toBe(lobbyNodeBefore)
  })
})
