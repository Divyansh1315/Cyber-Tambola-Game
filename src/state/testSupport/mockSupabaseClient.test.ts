// Feature: module-6-realtime-multi-device-sync (Req 18.1)
// Unit tests for the mock Supabase client fixture itself — not for
// realtimeClient.ts. These assert the fixture's own contract: FIFO queued
// RPC responses/errors resolve in call order per RPC name, a manually-fired
// realtime change delivers the exact shape passed to it, and recorded
// `.rpc`/`.from` calls capture name/args exactly as invoked.
import { describe, expect, it } from 'vitest'
import { createMockSupabaseClient, type MockRemoteChange } from './mockSupabaseClient'

describe('createMockSupabaseClient — queued RPC responses/errors', () => {
  it('resolves queued RPC responses in FIFO call order per RPC name (Req 18.1)', async () => {
    const client = createMockSupabaseClient()
    client.queueRpcResponse('call_next_word', { data: { termId: 'first' }, error: null })
    client.queueRpcResponse('call_next_word', { data: { termId: 'second' }, error: null })

    const first = await client.rpc('call_next_word', { p_game_id: 'g1' })
    const second = await client.rpc('call_next_word', { p_game_id: 'g1' })

    expect(first).toEqual({ data: { termId: 'first' }, error: null })
    expect(second).toEqual({ data: { termId: 'second' }, error: null })
  })

  it('resolves (never rejects) with the queued error envelope on queueRpcError (Req 18.1)', async () => {
    const client = createMockSupabaseClient()
    client.queueRpcError('submit_mark', 'Term not revealed', 'TERM_NOT_REVEALED')

    const result = await client.rpc('submit_mark', { p_term_id: 't1' })

    expect(result.data).toBeNull()
    expect(result.error).toEqual({ message: 'Term not revealed', code: 'TERM_NOT_REVEALED' })
  })

  it('keeps separate FIFO queues per RPC name (Req 18.1)', async () => {
    const client = createMockSupabaseClient()
    client.queueRpcResponse('join_game', { data: { ok: 1 }, error: null })
    client.queueRpcError('call_next_word', 'nope', 'NOT_AUTHORIZED')

    const joinResult = await client.rpc('join_game', {})
    const callResult = await client.rpc('call_next_word', {})

    expect(joinResult.error).toBeNull()
    expect(callResult.error).toEqual({ message: 'nope', code: 'NOT_AUTHORIZED' })
  })

  it('resolves with a default null/no-error envelope when nothing is queued (Req 18.1)', async () => {
    const client = createMockSupabaseClient()

    const result = await client.rpc('pause_game', {})

    expect(result).toEqual({ data: null, error: null })
  })
})

describe('createMockSupabaseClient — fireRemoteChange', () => {
  it('delivers the exact RemoteChange row/eventType shape to a matching listener (Req 18.1)', () => {
    const client = createMockSupabaseClient()
    let received: { eventType: string; new: unknown; old: unknown } | undefined

    client
      .channel('games-channel')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'games', filter: 'id=eq.g1' },
        (payload) => {
          received = payload
        },
      )
      .subscribe()

    const change: MockRemoteChange = {
      table: 'games',
      eventType: 'UPDATE',
      row: { id: 'g1', status: 'WORD_ACTIVE' },
    }
    client.fireRemoteChange(change)

    expect(received).toEqual({
      eventType: 'UPDATE',
      new: { id: 'g1', status: 'WORD_ACTIVE' },
      old: null,
    })
  })

  it('uses the row as `old` (and `new: null`) for a DELETE event (Req 18.1)', () => {
    const client = createMockSupabaseClient()
    let received: { eventType: string; new: unknown; old: unknown } | undefined

    client
      .channel('marks-channel')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'marks', filter: 'game_id=eq.g1' },
        (payload) => {
          received = payload
        },
      )
      .subscribe()

    client.fireRemoteChange({ table: 'marks', eventType: 'DELETE', row: { id: 'm1' } })

    expect(received).toEqual({ eventType: 'DELETE', new: null, old: { id: 'm1' } })
  })

  it('only invokes listeners registered for the matching table (Req 18.1)', () => {
    const client = createMockSupabaseClient()
    const gamesCalls: unknown[] = []
    const ticketsCalls: unknown[] = []

    client
      .channel('c1')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games' }, (p) =>
        gamesCalls.push(p),
      )
      .subscribe()
    client
      .channel('c2')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, (p) =>
        ticketsCalls.push(p),
      )
      .subscribe()

    client.fireRemoteChange({ table: 'games', eventType: 'INSERT', row: { id: 'g1' } })

    expect(gamesCalls).toHaveLength(1)
    expect(ticketsCalls).toHaveLength(0)
  })

  it('invokes every listener registered for the matching table, in registration order (Req 18.1)', () => {
    const client = createMockSupabaseClient()
    const order: string[] = []

    client
      .channel('c1')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'claims' }, () =>
        order.push('first'),
      )
      .subscribe()
    client
      .channel('c2')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'claims' }, () =>
        order.push('second'),
      )
      .subscribe()

    client.fireRemoteChange({ table: 'claims', eventType: 'INSERT', row: { id: 'c1' } })

    expect(order).toEqual(['first', 'second'])
  })

  it('does not invoke a listener removed via unsubscribe (Req 18.1)', () => {
    const client = createMockSupabaseClient()
    let calls = 0
    const channel = client
      .channel('winners-channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'winners' }, () => {
        calls += 1
      })
      .subscribe()

    channel.unsubscribe()
    client.fireRemoteChange({ table: 'winners', eventType: 'INSERT', row: { id: 'w1' } })

    expect(calls).toBe(0)
  })
})

describe('createMockSupabaseClient — rpcCalls/fromCalls recording', () => {
  it('records .rpc calls with the exact name and args, in call order (Req 18.1)', async () => {
    const client = createMockSupabaseClient()

    await client.rpc('join_game', { p_game_code: 'ABC123', p_display_name: 'Alice' })
    await client.rpc('submit_mark', { p_player_id: 'p1', p_term_id: 't1' })

    expect(client.rpcCalls).toEqual([
      { name: 'join_game', args: { p_game_code: 'ABC123', p_display_name: 'Alice' } },
      { name: 'submit_mark', args: { p_player_id: 'p1', p_term_id: 't1' } },
    ])
  })

  it('records .rpc calls made with no args as undefined args (Req 18.1)', async () => {
    const client = createMockSupabaseClient()

    await client.rpc('end_game')

    expect(client.rpcCalls).toEqual([{ name: 'end_game', args: undefined }])
  })

  it('records .from(table) calls by table name, in call order (Req 18.1)', () => {
    const client = createMockSupabaseClient()

    client.from('players')
    client.from('tickets')

    expect(client.fromCalls).toEqual(['players', 'tickets'])
  })
})
