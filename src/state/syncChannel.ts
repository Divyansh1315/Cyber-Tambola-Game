import type { SharedStatePayload } from './gameSessionReducer'

/** Channel name for same-browser cross-tab game sync. */
export const SYNC_CHANNEL_NAME = 'cyber-tambola-v2:sync'

/** A message carries the synced slice plus the id of the tab that sent it. */
interface SyncMessage {
  senderId: string
  payload: SharedStatePayload
}

/**
 * Same-browser cross-tab synchronization over BroadcastChannel.
 *
 * Loop safety: every message is stamped with this tab's unique `senderId`.
 * Incoming messages from our own id are ignored, so applying a remote snapshot
 * (which updates state and would otherwise re-broadcast) can never ping-pong
 * between tabs. Applying a remote snapshot must be done WITHOUT calling
 * `post()` again — the provider guards this with an "applying remote" flag.
 *
 * Availability: if BroadcastChannel is missing (older browsers / SSR / test
 * env), every method is a safe no-op and the app still works within one tab,
 * falling back to localStorage persistence for same-tab refresh.
 */
export interface SyncChannel {
  /** This tab's unique id (exposed for testing / diagnostics). */
  readonly senderId: string
  /** Broadcast the local slice to other tabs. No-op if unavailable. */
  post(payload: SharedStatePayload): void
  /** Subscribe to snapshots from OTHER tabs. Returns an unsubscribe fn. */
  subscribe(handler: (payload: SharedStatePayload) => void): () => void
  /** Close the underlying channel. */
  close(): void
}

function makeSenderId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createSyncChannel(): SyncChannel {
  const senderId = makeSenderId()

  const BC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel })
    .BroadcastChannel

  if (typeof BC !== 'function') {
    // Safe no-op channel — sync unavailable, app still works in one tab.
    return {
      senderId,
      post() {},
      subscribe() {
        return () => {}
      },
      close() {},
    }
  }

  let channel: BroadcastChannel | null = new BC(SYNC_CHANNEL_NAME)

  return {
    senderId,

    post(payload) {
      if (!channel) return
      try {
        const message: SyncMessage = { senderId, payload }
        channel.postMessage(message)
      } catch {
        // Best-effort; a serialization/availability failure must not break play.
      }
    },

    subscribe(handler) {
      if (!channel) return () => {}
      const active = channel
      const listener = (event: MessageEvent) => {
        const data = event.data as SyncMessage | null
        if (!data || typeof data !== 'object') return
        // Loop guard: ignore our own echoes.
        if (data.senderId === senderId) return
        if (!data.payload) return
        handler(data.payload)
      }
      active.addEventListener('message', listener)
      return () => active.removeEventListener('message', listener)
    },

    close() {
      try {
        channel?.close()
      } catch {
        // ignore
      }
      channel = null
    },
  }
}
