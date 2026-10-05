import { useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { BrandMark } from '../../components/common/BrandMark'
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
      if (err instanceof RpcError) {
        if (err.code === 'GAME_NOT_FOUND') {
          setError(MESSAGES.gameNotFound)
        } else if (err.code === 'GAME_COMPLETED') {
          setError(MESSAGES.gameCompleted)
        } else {
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
      <div className="join__inner">
        <header className="join__brand">
          <BrandMark
            size="hero"
            withSubtitle
            title="Cyber Awareness Month"
            subtitle="Cyber Tambola"
          />
        </header>

        <p className="join__intro">
          Match called cyber words with the terms on your ticket.
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
            icon="→"
            disabled={isSubmitting}
          >
            Join Game
          </Button>
        </form>

        <p className="join__note">
          <span aria-hidden="true">📱</span> No app installation required.
        </p>
      </div>
    </div>
  )
}
