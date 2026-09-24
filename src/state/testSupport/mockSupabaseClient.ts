/**
 * Test-only fake of the subset of the `supabase-js` client that
 * `realtimeClient.ts` actually calls:
 *   - `.channel(name).on('postgres_changes', filter, cb).subscribe()`
 *   - `.rpc(name, args)`
 *   - `.from(table).select(...)...`
 *
 * This lets reducer-level and component-level tests exercise the full
 * fetch/subscribe/RPC-call code paths in `realtimeClient.ts` and
 * `GameSessionContext.tsx` without a network call or a real Supabase
 * project — matching this codebase's existing convention of a small,
 * hand-written fake for an external dependency (see `syncChannel.ts`'s
 * `BroadcastChannel` no-op fallback and `persistence.ts`'s
 * `window.localStorage` usage, both exercised in tests via lightweight
 * stand-ins rather than a full reimplementation of the browser API).
 *
 * Nothing in this file imports `@supabase/supabase-js` — the shape below is
 * a structural subset, not the real `SupabaseClient` type, so tests can
 * construct one without any real credentials or network access.
 */

/**
 * A single row change as `realtimeClient.ts`'s `RemoteChange` describes it.
 * `active_game_pointer` is included alongside the six per-game tables so
 * tests can also fire a simulated pointer-row change through the same
 * `fireRemoteChange` mechanism (winner-history-and-game-reset's
 * `subscribeToActiveGamePointer`, which registers its `postgres_changes`
 * listener on this table with no filter).
 */
export interface MockRemoteChange {
  table:
    | 'games'
    | 'called_terms'
    | 'tickets'
    | 'marks'
    | 'claims'
    | 'winners'
    | 'active_game_pointer'
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  row: Record<string, unknown>
}

/** The raw postgres_changes-shaped payload handed to a registered `.on()` callback. */
interface MockPostgresChangesPayload {
  eventType: MockRemoteChange['eventType']
  new: Record<string, unknown> | null
  old: Record<string, unknown> | null
}

interface PostgresChangesFilter {
  event: string
  schema: string
  table: string
  filter?: string
}

type PostgresChangesCallback = (payload: MockPostgresChangesPayload) => void

interface RegisteredListener {
  channelName: string
  filter: PostgresChangesFilter
  callback: PostgresChangesCallback
}

/** One recorded `.rpc(name, args)` invocation, in call order. */
export interface RecordedRpcCall {
  name: string
  args: Record<string, unknown> | undefined
}

/** The result a queued RPC response resolves or rejects with. */
export interface RpcOutcome<T = unknown> {
  data?: T | null
  error?: { message: string; code?: string } | null
}

/** Minimal fake of supabase-js's `RealtimeChannel`. */
export interface MockRealtimeChannel {
  on(
    type: 'postgres_changes',
    filter: PostgresChangesFilter,
    callback: PostgresChangesCallback,
  ): MockRealtimeChannel
  subscribe(): MockRealtimeChannel
  unsubscribe(): void
}

/** Minimal fake of the `.from(table).select()...` query-builder chain. */
export interface MockQueryBuilder {
  select(columns?: string): MockQueryBuilder
  eq(column: string, value: unknown): MockQueryBuilder
  order(column: string, opts?: { ascending?: boolean }): MockQueryBuilder
  single(): Promise<RpcOutcome>
  maybeSingle(): Promise<RpcOutcome>
  then<TResult1 = RpcOutcome, TResult2 = never>(
    onfulfilled?: ((value: RpcOutcome) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>
}

/** The structural subset of `SupabaseClient` that `realtimeClient.ts` calls. */
export interface MockSupabaseClient {
  channel(name: string): MockRealtimeChannel
  rpc(name: string, args?: Record<string, unknown>): Promise<RpcOutcome>
  from(table: string): MockQueryBuilder

  // --- test-only control surface, not part of the real SupabaseClient API ---

  /** Every `.rpc()` call made so far, in call order. */
  readonly rpcCalls: RecordedRpcCall[]
  /** Every `.from(table)` call made so far, in call order (table names only). */
  readonly fromCalls: string[]

  /**
   * Queue the outcome of the NEXT `.rpc()` call matching `name` (FIFO per
   * name). If no outcome is queued for a given call, it resolves with
   * `{ data: null, error: null }`.
   */
  queueRpcResponse(name: string, outcome: RpcOutcome): void
  /** Convenience for `queueRpcResponse(name, { error: { message, code } })`. */
  queueRpcError(name: string, message: string, code?: string): void

  /**
   * Queue the outcome of the NEXT `.select()`-chain resolution for `table`
   * (FIFO per table).
   */
  queueFromResponse(table: string, outcome: RpcOutcome): void

  /**
   * Manually fire a realtime event as if Postgres had just sent it: invokes
   * every registered `postgres_changes` listener whose subscribed `table`
   * matches, passing through the given `change`'s `eventType` and using
   * `change.row` as both `new` and `old` for INSERT/UPDATE, or only `old`
   * for DELETE — mirroring `subscribeToGame`'s `payload.new ?? payload.old`
   * read in `realtimeClient.ts`. Matches by TABLE ONLY, exactly like every
   * existing caller of this method already assumes (see this file's own
   * `mockSupabaseClient.test.ts`) — a registered `filter` string is not
   * evaluated. A channel that has been `.unsubscribe()`d no longer has any
   * registered listener at all, so it stops receiving events regardless of
   * table.
   */
  fireRemoteChange(change: MockRemoteChange): void

  /** All channels created so far via `.channel()`, in creation order. */
  readonly channels: { name: string; channel: MockRealtimeChannel }[]
}

/**
 * Create a fresh fake Supabase client for a single test. Every test should
 * get its own instance — state (queued responses, recorded calls,
 * registered listeners) is not reset automatically between tests.
 */
export function createMockSupabaseClient(): MockSupabaseClient {
  const rpcCalls: RecordedRpcCall[] = []
  const fromCalls: string[] = []
  const listeners: RegisteredListener[] = []
  const channels: { name: string; channel: MockRealtimeChannel }[] = []

  const rpcQueues = new Map<string, RpcOutcome[]>()
  const fromQueues = new Map<string, RpcOutcome[]>()

  function dequeue(queues: Map<string, RpcOutcome[]>, key: string): RpcOutcome {
    const queue = queues.get(key)
    if (!queue || queue.length === 0) return { data: null, error: null }
    return queue.shift()!
  }

  function toResult<T>(outcome: RpcOutcome<T>): RpcOutcome<T> {
    // Mirrors supabase-js: rpc()/select() resolve (never reject) with a
    // `{ data, error }` envelope — callers check `error`, not a thrown
    // exception, exactly as `realtimeClient.ts`'s RPC wrappers are specified
    // to do (throw a typed error themselves only after inspecting `error`).
    return { data: outcome.data ?? null, error: outcome.error ?? null }
  }

  function makeQueryBuilder(table: string): MockQueryBuilder {
    const resolve = () => Promise.resolve(toResult(dequeue(fromQueues, table)))
    const builder: MockQueryBuilder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      single: resolve,
      maybeSingle: resolve,
      then: (onfulfilled, onrejected) => resolve().then(onfulfilled, onrejected),
    }
    return builder
  }

  function makeChannel(name: string): MockRealtimeChannel {
    const channel: MockRealtimeChannel = {
      on(type, filter, callback) {
        if (type === 'postgres_changes') {
          listeners.push({ channelName: name, filter, callback })
        }
        return channel
      },
      subscribe() {
        return channel
      },
      unsubscribe() {
        for (let i = listeners.length - 1; i >= 0; i -= 1) {
          if (listeners[i].channelName === name) listeners.splice(i, 1)
        }
      },
    }
    return channel
  }

  const client: MockSupabaseClient = {
    channel(name) {
      const channel = makeChannel(name)
      channels.push({ name, channel })
      return channel
    },

    rpc(name, args) {
      rpcCalls.push({ name, args })
      return Promise.resolve(toResult(dequeue(rpcQueues, name)))
    },

    from(table) {
      fromCalls.push(table)
      return makeQueryBuilder(table)
    },

    rpcCalls,
    fromCalls,
    channels,

    queueRpcResponse(name, outcome) {
      const queue = rpcQueues.get(name) ?? []
      queue.push(outcome)
      rpcQueues.set(name, queue)
    },

    queueRpcError(name, message, code) {
      client.queueRpcResponse(name, { data: null, error: { message, code } })
    },

    queueFromResponse(table, outcome) {
      const queue = fromQueues.get(table) ?? []
      queue.push(outcome)
      fromQueues.set(table, queue)
    },

    fireRemoteChange(change) {
      const payload: MockPostgresChangesPayload =
        change.eventType === 'DELETE'
          ? { eventType: change.eventType, new: null, old: change.row }
          : { eventType: change.eventType, new: change.row, old: null }

      for (const listener of listeners) {
        if (listener.filter.table === change.table) {
          listener.callback(payload)
        }
      }
    },
  }

  return client
}

/**
 * Substitute for `realtimeClient.ts`'s `getSupabaseClient` export in tests.
 *
 * Usage (this project's existing mocking convention — module-level
 * `vi.mock` with a factory, as used for other external dependencies):
 *
 * ```ts
 * import { vi } from 'vitest'
 * import { createMockSupabaseClient, mockGetSupabaseClient } from './testSupport/mockSupabaseClient'
 *
 * const mockClient = createMockSupabaseClient()
 * vi.mock('./realtimeClient', async (importOriginal) => {
 *   const actual = await importOriginal<typeof import('./realtimeClient')>()
 *   return { ...actual, getSupabaseClient: mockGetSupabaseClient(mockClient) }
 * })
 * ```
 *
 * `mockGetSupabaseClient` returns a zero-arg function matching
 * `getSupabaseClient`'s signature (`() => SupabaseClient | null`) so it can
 * be swapped in directly wherever `realtimeClient.ts` is mocked.
 */
export function mockGetSupabaseClient(
  client: MockSupabaseClient | null,
): () => MockSupabaseClient | null {
  return () => client
}
