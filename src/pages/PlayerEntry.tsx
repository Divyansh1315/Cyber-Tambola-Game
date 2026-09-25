import { useGameSession } from '../state/GameSessionContext'
import { PlayerGame } from './PlayerGame/PlayerGame'
import { PlayerJoin } from './PlayerJoin/PlayerJoin'

/**
 * The single Player entry point at "/player".
 *
 * Renders the Join screen when there is no current player yet (fresh
 * visitor, or a returning visitor whose local identity has been cleared),
 * and the Game screen once a current player is resolved (fresh join,
 * restored identity, or a page refresh with a persisted session). This
 * keeps both the Join and Game experiences under the one public URL the
 * QR code and Presentation screen point to ("/player?game=<CODE>"),
 * matching the production routing requirement: "/player" is the Player
 * entry point, full stop — it is never routed to the Host.
 *
 * PlayerGame.tsx still redirects back to "/player" (not "/") if its own
 * current-player/ticket check ever fails after this wrapper has already
 * chosen to render it (e.g. the player's record vanishes mid-session) —
 * that redirect lands back here and this wrapper then renders PlayerJoin
 * again, since `currentPlayer` is gone. No separate route/component needed
 * for that case.
 */
export function PlayerEntry() {
  const { currentPlayer, isHydrated } = useGameSession()

  // Wait for the initial local restore before deciding which screen to show
  // (mirrors PlayerGame's own hydration gate) -- avoids a flash of the Join
  // screen for an already-joined returning player.
  if (!isHydrated) {
    return null
  }

  return currentPlayer ? <PlayerGame /> : <PlayerJoin />
}
