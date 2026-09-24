import { useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { BrandMark } from '../../components/common/BrandMark'
import { Button } from '../../components/common/Button'
import { cyberTerms } from '../../data/cyberTerms'
import { SEED_GAME_CODE } from '../../state/gameSessionInitialState'
import { useGameSession } from '../../state/GameSessionContext'
import { buildJoinOutcome, MESSAGES } from '../../state/joinService'
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

  // Prefills from the code query param when present -- e.g. a player who
  // scanned the QR shown on the Host/Presentation screen, which always
  // encodes the CURRENT game's code (JoinQrCode.tsx). Game codes rotate on
  // every Reset (winner-history-and-game-reset), so this must never be a
  // fixed constant: a returning/bookmarked player who follows the QR again
  // after a reset needs the field to reflect the NEW code, not a stale one.
  // Falls back to SEED_GAME_CODE only when no code param is present at
  // all (e.g. someone typed the bare site URL directly) -- the field is
  // still always editable either way, and submitting still requires the
  // player's own explicit action (Req 7: never auto-joins from a URL).
  const [gameCode, setGameCode] = useState(() => {
    const fromUrl = new URLSearchParams(location.search).get('code')
    return fromUrl ? fromUrl.toUpperCase() : SEED_GAME_CODE
  })
  const [employeeName, setEmployeeName] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  /** Trim + required-fields check only, for instant client-side feedback. */
  function requiredFieldsError(): string | null {
    if (!gameCode.trim() || !employeeName.trim() || !employeeId.trim()) {
      return MESSAGES.requiredFields
    }
    return null
  }

  /** Local-only fallback path: unchanged behavior when Supabase isn't configured. */
  function joinLocally() {
    let outcome
    try {
      outcome = buildJoinOutcome({
        form: { gameCode, employeeName, employeeId },
        game: state.game,
        players: state.players,
        tickets: state.tickets,
        terms: cyberTerms,
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
        setError(null)
        dispatch({ type: 'JOIN_PLAYER', player: outcome.player, ticket: outcome.ticket })
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
        employeeDemoId: employeeId,
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
          <BrandMark size="hero" withSubtitle />
        </header>

        <p className="join__intro">
          Match cyber clues to the terms on your ticket.
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

          <div className="field">
            <label className="field__label" htmlFor="employeeId">
              Employee ID / Demo ID
            </label>
            <input
              id="employeeId"
              name="employeeId"
              className="field__input"
              autoComplete="off"
              maxLength={64}
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              placeholder="e.g. DEMO-021"
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
