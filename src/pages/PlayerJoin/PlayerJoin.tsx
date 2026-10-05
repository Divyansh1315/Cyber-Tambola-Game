import { useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Button } from '../../components/common/Button'
import { cyberTerms } from '../../data/cyberTerms'
import { SEED_GAME_CODE } from '../../state/gameSessionInitialState'
import { useGameSession } from '../../state/GameSessionContext'
import {
  buildJoinOutcome,
  MESSAGES,
  readOrCreateDeviceJoinToken,
} from '../../state/joinService'
import {
  readDeviceJoinTokensByPlayerId,
  writeDeviceJoinTokensByPlayerId,
} from '../../state/persistence'
import { RpcError } from '../../state/realtimeClient'
import './PlayerJoin.css'

/** Fallback message when the ticket generator throws (developer-facing only). */
const GENERATOR_ERROR = 'Unable to create a ticket right now. Please try again.'

/** Generic fallback for an RPC rejection whose code isn't specifically handled. */
const GENERIC_JOIN_ERROR = 'Unable to join right now. Please try again.'

/** Shown for a browser-level network failure (offline, DNS, CORS, etc). */
const NETWORK_ERROR = 'Unable to connect. Please check your internet connection and try again.'

/**
 * Decorative shield-with-check outline glyph for the join screen's Cyber
 * Awareness Month branding. Purely decorative -- aria-hidden, no
 * interactive affordance. Matches the glyph already used on the
 * Presentation/Host screens so the icon stays visually consistent across
 * every Cyber Awareness Month surface in the app.
 */
function ShieldCheckIcon() {
  return (
    <svg
      className="join__shield"
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      aria-hidden="true"
      role="img"
    >
      <path
        fill="currentColor"
        d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5l-8-3Z"
        opacity="0.18"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5l-8-3Z"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="m8.5 12 2.4 2.4L15.5 9.5"
      />
    </svg>
  )
}

/**
 * Restrained decorative circuit-board traces + connection nodes for the
 * join screen background. Pure decoration: aria-hidden, absolutely
 * positioned behind the content stack, and `pointer-events: none` in CSS
 * so it can never affect layout or interaction. Mirrors the same visual
 * language used on the Presentation screen's lobby background.
 */
function CircuitBackground() {
  return (
    <svg
      className="join__circuits"
      viewBox="0 0 480 640"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g className="join__circuit-lines" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M0 60 L70 60 L70 110 L140 110 L140 80" />
        <path d="M0 180 L50 180 L50 220 L110 220" />
        <path d="M480 60 L410 60 L410 110 L340 110 L340 80" />
        <path d="M480 540 L420 540 L420 500 L360 500" />
        <path d="M0 560 L60 560 L60 600" />
      </g>
      <g className="join__circuit-nodes" fill="currentColor">
        <circle cx="70" cy="60" r="3.5" />
        <circle cx="140" cy="110" r="3" />
        <circle cx="50" cy="220" r="3" />
        <circle cx="410" cy="60" r="3.5" />
        <circle cx="340" cy="110" r="3" />
        <circle cx="420" cy="500" r="3" />
        <circle cx="60" cy="600" r="3" />
      </g>
    </svg>
  )
}

/**
 * True for a `TypeError` thrown by `fetch` itself (not a Supabase/Postgres
 * error response) -- the shape every browser uses for "the request never
 * reached the server at all" (offline, DNS failure, blocked by CORS, etc).
 * Supabase's client surfaces this as a plain TypeError, not an RpcError,
 * since it never got far enough to receive a Postgres response to wrap.
 */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError
}

/**
 * Screen A — Player Join.
 * Mobile-first. On submit the join service validates the form and either
 * reports a validation error, restores an existing player, or creates a brand
 * new player + ticket before navigating to the Player Game screen. All game
 * state lives in the central session (no backend call in this prototype).
 */
export function PlayerJoin() {
  const navigate = useNavigate()
  const location = useLocation()
  const { state, dispatch, joinGame } = useGameSession()

  // Prefills from the `game` query param when present -- e.g. a player who
  // scanned the QR shown on the Presentation/Host screen, which always
  // encodes the CURRENT game's code (JoinQrCode.tsx) as `?game=<CODE>`.
  // `code` is also accepted for backward compatibility with any
  // already-printed/cached QR codes from before the query param was
  // renamed. Game codes rotate on every Reset (winner-history-and-game-
  // reset), so this must never be a fixed constant: a returning/bookmarked
  // player who follows the QR again after a reset needs the field to
  // reflect the NEW code, not a stale one. Falls back to SEED_GAME_CODE
  // only when neither param is present at all (e.g. someone typed the bare
  // /player URL directly) -- the field is still always editable either
  // way, and submitting still requires the player's own explicit action
  // (Req 7: never auto-joins from a URL).
  const [gameCode, setGameCode] = useState(() => {
    const params = new URLSearchParams(location.search)
    const fromUrl = params.get('game') ?? params.get('code')
    return fromUrl ? fromUrl.toUpperCase() : SEED_GAME_CODE
  })
  const [employeeName, setEmployeeName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  /** Trim + required-fields check only, for instant client-side feedback. */
  function requiredFieldsError(): string | null {
    if (!gameCode.trim() || !employeeName.trim()) {
      return MESSAGES.requiredFields
    }
    return null
  }

  /** Local-only fallback path: unchanged behavior when Supabase isn't configured. */
  function joinLocally() {
    const deviceJoinToken = readOrCreateDeviceJoinToken()
    const deviceJoinTokensByPlayerId = readDeviceJoinTokensByPlayerId()

    let outcome
    try {
      outcome = buildJoinOutcome({
        form: { gameCode, employeeName },
        game: state.game,
        players: state.players,
        tickets: state.tickets,
        terms: cyberTerms,
        deviceJoinTokensByPlayerId,
        deviceJoinToken,
      })
    } catch {
      // The generator only throws for developer-facing failures (insufficient
      // terms / signature-space exhaustion) that cannot occur in the demo.
      setError(GENERATOR_ERROR)
      return
    }

    switch (outcome.kind) {
      case 'error':
        // Validation failure: show the message and stay on the screen.
        setError(outcome.message)
        return
      case 'restore':
        // Existing identity: restore as current and flag the resumed session.
        setError(null)
        dispatch({ type: 'RESTORE_PLAYER', playerId: outcome.playerId })
        navigate('/player', { state: { restored: true } })
        return
      case 'new':
        // Brand-new participant: add the pre-built player + ticket, then go.
        // Remember this device's token against the new player id so a
        // later duplicate join from the same browser (Req 5.2) is
        // recognized without needing an Employee ID or matching by name.
        setError(null)
        dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
        writeDeviceJoinTokensByPlayerId({
          ...deviceJoinTokensByPlayerId,
          [outcome.player.id]: deviceJoinToken,
        })
        navigate('/player')
        return
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (isSubmitting) return

    const fieldError = requiredFieldsError()
    if (fieldError) {
      setError(fieldError)
      return
    }

    setIsSubmitting(true)
    try {
      const result = await joinGame({
        gameCode,
        displayName: employeeName,
        deviceJoinToken: readOrCreateDeviceJoinToken(),
      })

      if (result === undefined) {
        // Supabase not configured: fall back to the local-only join path
        // unchanged (Req 17.2).
        joinLocally()
        return
      }

      // RPC path succeeded (join_game returns no new/restored flag, so we
      // cannot distinguish the two here; the "session restored" notice on
      // PlayerGame.tsx simply won't show for RPC-path restores).
      setError(null)
      navigate('/player')
    } catch (err) {
      if (isNetworkError(err)) {
        // The request never reached Supabase at all (offline/DNS/CORS) --
        // distinct from a backend error response, so tell the player to
        // check their own connection rather than "try again" blindly.
        setError(NETWORK_ERROR)
      } else if (err instanceof RpcError) {
        if (err.code === 'GAME_NOT_FOUND') {
          setError(MESSAGES.gameNotFound)
        } else if (err.code === 'GAME_COMPLETED') {
          setError(MESSAGES.gameCompleted)
        } else {
          // Any other backend/RPC error (including a stale/mismatched RPC
          // signature on the live database) -- never show Supabase's raw
          // technical message to the player, but log it so the issue is
          // diagnosable from the browser console without exposing it in
          // the UI.
          console.error('[PlayerJoin] join_game RPC failed:', err.code, err.message)
          setError(GENERIC_JOIN_ERROR)
        }
      } else {
        setError(GENERIC_JOIN_ERROR)
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="page join">
      <CircuitBackground />
      <div className="join__glow" aria-hidden="true" />
      <div className="join__inner">
        <header className="join__brand">
          <ShieldCheckIcon />
          <span className="join__brand-eyebrow">Cyber Awareness Month</span>
          <span className="join__brand-title">Cyber Tambola</span>
        </header>

        <p className="join__intro">
          Spot the cyber word. Match your ticket. Stay cyber aware.
        </p>

        <form className="join__form" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="gameCode">
              Game Code
            </label>
            <input
              id="gameCode"
              name="gameCode"
              className="field__input"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={64}
              value={gameCode}
              onChange={(e) => setGameCode(e.target.value.toUpperCase())}
              placeholder="e.g. CYBER24"
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="employeeName">
              Employee Name
            </label>
            <input
              id="employeeName"
              name="employeeName"
              className="field__input"
              autoComplete="name"
              maxLength={64}
              value={employeeName}
              onChange={(e) => setEmployeeName(e.target.value)}
              placeholder="Your name"
            />
          </div>

          {/* Validation / error message area */}
          <div className="join__error" role="alert" aria-live="assertive">
            {error}
          </div>

          <Button
            type="submit"
            size="lg"
            className="join__submit"
            icon={isSubmitting ? undefined : '→'}
            disabled={isSubmitting}
            aria-busy={isSubmitting}
          >
            {isSubmitting ? 'Joining…' : 'Join Game'}
          </Button>
        </form>
      </div>
    </div>
  )
}
