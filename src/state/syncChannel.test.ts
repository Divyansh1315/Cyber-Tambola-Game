// Feature: module-2.5-cross-tab-sync — SyncChannel BroadcastChannel wrapper
//
// Verifies the loop guard (a channel never delivers its own messages to
// itself), cross-channel delivery on the same channel name, and the safe no-op
// fallback when BroadcastChannel is unavailable.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSyncChannel } from './syncChannel'
import type { SharedStatePayload } from './gameSessionReducer'

function makePayload(status: SharedStatePayload['game']['status']): SharedStatePayload {
  return {
    game: {
      id: 'GAME_001',
      code: 'CYBER24',
      status,
      createdAt: '2026-01-01T00:00:00.000Z',
      currentRound: 1,
      revealedTermIds: [],
    },
    players: [],
    tickets: [],
    marks: [],
    claims: [],
    winners: [],
  }
}

const hasBroadcastChannel =
  typeof (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel === 'function'

describe('createSyncChannel (loop guard + delivery)', () => {
  it('has a unique senderId per channel', () => {
    const a = createSyncChannel()
    const b = createSyncChannel()
    expect(a.senderId).not.toBe(b.senderId)
    a.close()
    b.close()
  })

  it('does not deliver a channel its own broadcast (loop guard)', async () => {
    const a = createSyncChannel()
    const received = vi.fn()
    a.subscribe(received)
    a.post(makePayload('WORD_ACTIVE'))
    // Allow the event loop to flush any queued messages.
    await new Promise((r) => setTimeout(r, 20))
    expect(received).not.toHaveBeenCalled()
    a.close()
  })

  it.runIf(hasBroadcastChannel)(
    'delivers a broadcast from one channel to another on the same name',
    async () => {
      const sender = createSyncChannel()
      const receiver = createSyncChannel()
      const received = vi.fn()
      receiver.subscribe(received)

      sender.post(makePayload('WORD_ACTIVE'))
      await new Promise((r) => setTimeout(r, 20))

      expect(received).toHaveBeenCalledTimes(1)
      const payload = received.mock.calls[0][0] as SharedStatePayload
      expect(payload.game.status).toBe('WORD_ACTIVE')

      sender.close()
      receiver.close()
    },
  )
})

describe('createSyncChannel (no BroadcastChannel available)', () => {
  const original = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel

  beforeEach(() => {
    // Simulate an environment without BroadcastChannel.
    // @ts-expect-error deliberately removing for the test
    delete globalThis.BroadcastChannel
  })

  afterEach(() => {
    ;(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = original
  })

  it('returns a safe no-op channel that never throws', async () => {
    const channel = createSyncChannel()
    const received = vi.fn()
    const unsubscribe = channel.subscribe(received)

    expect(() => channel.post(makePayload('LOBBY'))).not.toThrow()
    await new Promise((r) => setTimeout(r, 10))
    expect(received).not.toHaveBeenCalled()

    expect(() => unsubscribe()).not.toThrow()
    expect(() => channel.close()).not.toThrow()
    expect(typeof channel.senderId).toBe('string')
  })
})
