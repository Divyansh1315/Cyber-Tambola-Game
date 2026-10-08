// Minimal Supabase Realtime (Phoenix channel protocol v1.0.0) client built
// on k6's websockets module, just enough to subscribe to postgres_changes
// on a game's tables the same way src/state/realtimeClient.ts's
// subscribeToGame() does, and measure fan-out latency / delivery.
//
// This intentionally does NOT reimplement the full JS SDK — only phx_join
// (with a postgres_changes config matching realtimeClient.ts's own filters)
// and heartbeats, which is sufficient to observe whether change events
// arrive and how quickly.
import { WebSocket } from 'k6/websockets'
// setInterval/clearInterval are globally available (standard WebAPIs,
// graduated out of k6/experimental/timers as of k6 v0.52+) — no import
// needed.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

function wsUrl() {
  // k6's JS runtime does not provide a global URL constructor — parse the
  // scheme/host with a regex instead of new URL(SUPABASE_URL).
  const match = /^(https?):\/\/([^/]+)/i.exec(SUPABASE_URL)
  const isHttps = match ? match[1].toLowerCase() === 'https' : true
  const host = match ? match[2] : SUPABASE_URL
  const scheme = isHttps ? 'wss' : 'ws'
  return `${scheme}://${host}/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`
}

/**
 * Opens a realtime connection subscribed to game:<gameId>'s postgres_changes
 * for the given tables, same as subscribeToGame(). Calls onEvent(table,
 * eventType, row) for every change received, and onJoined()/onError() for
 * connection lifecycle. Returns the WebSocket instance so the caller can
 * close it (ws.close()) to simulate a disconnect.
 */
export function connectToGameChannel(gameId, tables, callbacks) {
  const { onJoined, onEvent, onError, onClose } = callbacks || {}
  const topic = `realtime:game:${gameId}`
  const ws = new WebSocket(wsUrl())
  let ref = 1
  let heartbeatTimer

  ws.addEventListener('open', () => {
    const postgresChanges = tables.map((table) => ({
      event: '*',
      schema: 'public',
      table,
      filter: table === 'games' ? `id=eq.${gameId}` : `game_id=eq.${gameId}`,
    }))

    ws.send(
      JSON.stringify({
        topic,
        event: 'phx_join',
        payload: { config: { postgres_changes: postgresChanges } },
        ref: String(ref++),
      })
    )

    heartbeatTimer = setInterval(() => {
      ws.send(
        JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(ref++) })
      )
    }, 25000)
  })

  ws.addEventListener('message', (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch (e) {
      return
    }

    if (msg.event === 'phx_reply' && msg.payload && msg.payload.status === 'ok' && msg.topic === topic) {
      if (onJoined) onJoined()
      return
    }
    if (msg.event === 'phx_reply' && msg.payload && msg.payload.status === 'error') {
      if (onError) onError(msg.payload)
      return
    }
    if (msg.event === 'postgres_changes' && msg.payload) {
      const changes = msg.payload.data ? [msg.payload.data] : msg.payload
      const list = Array.isArray(changes) ? changes : [changes]
      for (const change of list) {
        if (onEvent) onEvent(change.table, change.type, change.record || change.old_record)
      }
    }
  })

  ws.addEventListener('error', (e) => {
    if (onError) onError(e)
  })

  ws.addEventListener('close', () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (onClose) onClose()
  })

  return ws
}
