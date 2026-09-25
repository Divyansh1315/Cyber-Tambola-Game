import { QRCodeSVG } from 'qrcode.react'
import './JoinQrCode.css'

interface JoinQrCodeProps {
  /** The game code players type in if they join manually instead of scanning. */
  gameCode: string
  size?: number
}

/**
 * Real, scannable QR code encoding the Player entry URL for this device's
 * current origin (window.location.origin) PLUS the current game's own
 * code as a `game` query param -- e.g.
 * `https://host:port/player?game=AHMA29`. The Player entry point lives at
 * `/player` (the public base URL `/` is the Host Dashboard), so the QR
 * must always target `/player`, never the bare origin.
 *
 * Game codes rotate on every Reset (winner-history-and-game-reset's
 * reset_game_to_new), so encoding only the bare origin/path (no code)
 * would silently point every scan at whatever code happens to be
 * hardcoded/prefilled client-side, rather than the CURRENT game -- exactly
 * the bug this fixes. PlayerJoin.tsx reads this `game` query param on
 * mount to prefill its Game Code field, so scanning always prefills the
 * right code automatically; the player still explicitly submits the join
 * form themselves (Req 7: Player Join never auto-joins from a URL param).
 */
export function JoinQrCode({ gameCode, size = 180 }: JoinQrCodeProps) {
  const joinUrl = `${window.location.origin}/player?game=${encodeURIComponent(gameCode)}`

  return (
    <div className="join-qr" style={{ width: size, height: size }}>
      <QRCodeSVG
        value={joinUrl}
        size={size - 20}
        marginSize={2}
        level="M"
        title={`Scan to join game ${gameCode}`}
      />
    </div>
  )
}