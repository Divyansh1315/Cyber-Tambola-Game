import { Button } from '../../components/common/Button'
import { useEffect, useRef, useState } from 'react'
import { Card } from '../../components/common/Card'
import { ClaimStatusTag } from '../../components/common/ClaimStatusTag'
import { ConnectionStatusBanner } from '../../components/common/ConnectionStatusBanner'
import { CyberWordCard } from '../../components/common/CyberWordCard'
import { JoinQrCode } from '../../components/common/JoinQrCode'
import { StatusBadge } from '../../components/common/StatusBadge'
import { cyberTerms } from '../../data/cyberTerms'
import {
  fetchAllWinnersWithGames,
  getSupabaseClient,
  getSupabaseConfig,
} from '../../state/realtimeClient'
import { mapRowToWinner } from '../../state/remoteRowMappers'
import { useGameSession } from '../../state/GameSessionContext'
import type { HostDecision, ValidationStatus } from '../../types/claim'
import type { PrizeClaim, PrizeId, Winner } from '../../types/prize'
import { PRIZES } from '../../utils/prizeEngine'
import {
  canConfirmClaim,
  getWinnerForPrize,
  groupClaimsForHistory,
  sortClaimsForInbox,
} from '../../utils/winnerEngine'
import {
  toWinnerHistoryViewModel,
  type WinnerHistoryGameSummary,
  type WinnerHistoryGroupViewModel,
} from './hostWinnerHistoryViewModel'
import './HostDashboard.css'

/**
 * The exact set of display fields a Host_Claim_Inbox row needs (Req 7.2,
 * 7.3) — the player's display name, a ticket reference, the prize label,
 * the submission time, the validation result, and the host decision, plus
 * the rejection reason so the Rejected/Invalid subsection can show it
 * (Req 9.3, 10.2). Never the player's employee/demo id or any other
 * claim/technical field (`id`, `gameId`, `playerId`, `ticketId`, `prizeId`).
 */
export interface ClaimInboxRowViewModel {
  playerName: string
  ticketRef: string
  prizeLabel: string
  submittedAt: string
  validationStatus: ValidationStatus
  hostDecision: HostDecision
  rejectionReason?: string
}

/**
 * Builds the Host_Claim_Inbox row view-model from a full `PrizeClaim`,
 * picking exactly the display-safe fields the host needs to see and
 * dropping every identifier/technical field (Req 7.2, 7.3). Does not
 * mutate its input.
 */
export function toClaimInboxRowViewModel(claim: PrizeClaim): ClaimInboxRowViewModel {
  return {
    playerName: claim.playerName,
    ticketRef: claim.ticketRef,
    prizeLabel: claim.prizeLabel,
    submittedAt: claim.submittedAt,
    validationStatus: claim.validationStatus,
    hostDecision: claim.hostDecision,
    rejectionReason: claim.rejectionReason,
  }
}

/** Removes any later duplicate-id entries, keeping each id's first occurrence (Req 2.5). */
export function dedupeClaimsById(claims: readonly PrizeClaim[]): PrizeClaim[] {
  const seen = new Set<string>()
  return claims.filter((c) => {
    if (seen.has(c.id)) return false
    seen.add(c.id)
    return true
  })
}

/** One Winner Panel row: a fixed prize with its winner's name, or none. */
export interface WinnerPanelRowViewModel {
  prizeId: PrizeId
  label: string
  winnerName: string | null
}

/**
 * Builds the Winner Panel view-model: exactly one row per fixed `PRIZES`
 * entry, in `PRIZES` order, each showing that prize's confirmed winner's
 * display name (via `getWinnerForPrize`) or `null` when the prize is not
 * yet awarded (Req 15.1, 15.2, 15.3). Does not mutate its inputs.
 */
export function toWinnerPanelViewModel(
  winners: readonly Winner[],
  gameId: string,
): WinnerPanelRowViewModel[] {
  return PRIZES.map((prize) => {
    const winner = getWinnerForPrize(winners, gameId, prize.id)
    return {
      prizeId: prize.id,
      label: prize.label,
      winnerName: winner ? winner.playerName : null,
    }
  })
}

/** Fixed rejection-reason options offered to the host (Req 9.3). */
const REJECTION_REASON_OPTIONS = [
  'Duplicate / already won',
  'Host verification issue',
  'Invalid event claim',
  'Other',
] as const

/**
 * Prompts the host for a rejection reason using the fixed options plus free
 * text (Req 9.3). Returns undefined if the host cancels or leaves it blank.
 */
function promptForRejectionReason(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const optionsList = REJECTION_REASON_OPTIONS.map((o, i) => `${i + 1}. ${o}`).join('\n')
  const input = window.prompt(
    `Reason for rejecting this claim (pick a number or type your own):\n${optionsList}`,
  )
  if (input === null) return undefined
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  const asIndex = Number(trimmed)
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= REJECTION_REASON_OPTIONS.length) {
    return REJECTION_REASON_OPTIONS[asIndex - 1]
  }
  return trimmed
}

/**
 * Screen C — Host Dashboard.
 * Desktop/laptop-first facilitator view. Game state (code, status, round,
 * current Cyber Word, called-word history) is read from the central session
 * store; the controls dispatch lifecycle actions against that shared state.
 * Calling a word displays its word/definition/awareness tip and marks it
 * called in the same action — there is no separate reveal step (Module 5).
 * Claims and winners are read from the shared session state and the Claim
 * Inbox dispatches CONFIRM_CLAIM/REJECT_CLAIM against it (Module 5).
 */
export function HostDashboard() {
  const {
    state,
    dispatch,
    currentTerm,
    revealHistory,
    realtimeConnectionStatus,
    retryRealtimeConnection,
  } = useGameSession()
  const { game } = state
  const totalRounds = cyberTerms.filter((t) => t.active).length

  // Winner_History (Req 2.1-2.4, 2.6, 2.7, 9.2): an independent read path,
  // separate from the per-active-game subscription above -- see design.md's
  // "Host Dashboard: Winner_History" section. Supabase path: fetched once on
  // mount and re-fetched on every unfiltered winners INSERT event. Local
  // Fallback path: derived directly from session state below (no fetch/
  // subscription of its own).
  const [remoteWinnerHistoryData, setRemoteWinnerHistoryData] = useState<{
    winners: Winner[]
    games: WinnerHistoryGameSummary[]
  }>({ winners: [], games: [] })

  // Local Fallback only: a locally-tracked list of past local games'
  // {id, code, createdAt} summaries, captured immediately before each
  // RESET_GAME dispatch (the reducer itself reseeds `game` in place and
  // keeps no record of the outgoing game's own identity) -- see design.md's
  // Local Fallback section and the dualInput test's "pastGameSummaries"
  // convention (Req 9.2).
  const [pastLocalGames, setPastLocalGames] = useState<WinnerHistoryGameSummary[]>([])

  useEffect(() => {
    const supabase = getSupabaseClient()
    if (!supabase) return

    let cancelled = false

    async function refetch() {
      const { winners, games } = await fetchAllWinnersWithGames()
      if (cancelled) return
      setRemoteWinnerHistoryData({
        winners: winners.map(mapRowToWinner),
        games: games.map((row) => ({
          id: row.id as string,
          code: row.code as string,
          createdAt: row.created_at as string,
        })),
      })
    }

    refetch()

    const channel = supabase.channel('winner-history')
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'winners' }, // no filter (Req 2.6)
      () => refetch(),
    )
    channel.subscribe()

    return () => {
      cancelled = true
      channel.unsubscribe()
    }
  }, [])

  const isLocalOnlyMode = getSupabaseConfig() === null

  const winnerHistoryGroups: WinnerHistoryGroupViewModel[] = isLocalOnlyMode
    ? toWinnerHistoryViewModel(
        [...state.winnerHistory, ...state.winners],
        [...pastLocalGames, { id: game.id, code: game.code, createdAt: game.createdAt }],
      )
    : toWinnerHistoryViewModel(remoteWinnerHistoryData.winners, remoteWinnerHistoryData.games)

  const inboxGroups = groupClaimsForHistory(sortClaimsForInbox(dedupeClaimsById(state.claims)))

  // Control enablement derived from the current lifecycle status. There is
  // only one active-round status now — calling a word displays it fully in
  // the same action, so there's no separate "reveal" gate (Module 5).
  // Guards against a double-click/tap firing the same lifecycle dispatch
  // twice before the first RPC round-trip resolves. `canCallNext` etc. below
  // are derived from `game.status`, which this flag backs up: for most
  // lifecycle actions the optimistic local reducer applies the new status
  // synchronously on the FIRST click, so a second click milliseconds later
  // would otherwise still read a "valid" status and fire a second,
  // genuinely-independent RPC call (each one lands its own real row in
  // called_terms server-side, since call_next_word has no way to know two
  // calls came from the same user intent). For START_GAME/CALL_NEXT_WORD
  // specifically, `game.status` does NOT flip optimistically when Supabase
  // is configured (GameSessionContext.tsx's wrappedDispatch intentionally
  // skips the optimistic dispatch for those two, to avoid a client-side
  // random term pick racing the server's own) — so for those two actions
  // this flag is the ONLY thing preventing a double-click from firing a
  // second RPC call during that round trip, not just a backstop.
  //
  // G1: this is now a genuine promise-based in-flight lock, not a fixed
  // 800ms timer. `dispatch` (GameSessionContext.tsx's `wrappedDispatch`)
  // returns a Promise<void> that settles once the matching RPC call itself
  // settles (success or failure) — set `true` immediately before
  // dispatching, cleared in BOTH the `.then` and `.catch` continuations via
  // `.finally()`, so the lock covers exactly the real RPC's duration, never
  // more and never less, and can never get stuck set (a rejected RPC's
  // existing rollback — unchanged, see GameSessionContext.tsx — still
  // fires; `.finally()` only clears this LOCAL lock, independent of that).
  const [lifecycleActionPending, setLifecycleActionPending] = useState(false)
  // Synchronous guard, checked AND set before any state update is even
  // requested. `lifecycleActionPending` (React state) only drives the
  // button's `disabled`/label rendering; it is NOT itself a reliable
  // mutual-exclusion primitive here, because two click handlers invoked
  // synchronously back-to-back in the same tick/batch (e.g. a double-tap
  // registered as two events before React has re-rendered) would both
  // read the SAME stale `lifecycleActionPending` value. A ref's value is
  // visible to every synchronous reader immediately after being set, with
  // no batching/re-render in between.
  const lifecycleActionPendingRef = useRef(false)

  function dispatchLifecycleAction(action: Parameters<typeof dispatch>[0]) {
    if (lifecycleActionPendingRef.current) return
    lifecycleActionPendingRef.current = true
    setLifecycleActionPending(true)
    // dispatch(...) (GameSessionContext.tsx's wrappedDispatch) always
    // RESOLVES once the matching RPC settles, whether it succeeded or
    // failed -- GameSessionContext.tsx's own rollback-on-reject handling
    // (unchanged) is the real error response; this component only needs
    // to know the RPC settled, to release its local button lock below.
    void dispatch(action).finally(() => {
      lifecycleActionPendingRef.current = false
      setLifecycleActionPending(false)
    })
  }

  const canStart = game.status === 'LOBBY' && !lifecycleActionPending
  const canCallNext = game.status === 'WORD_ACTIVE' && !lifecycleActionPending
  const canPause = game.status === 'WORD_ACTIVE' && !lifecycleActionPending
  const canResume = game.status === 'PAUSED' && !lifecycleActionPending
  const canEnd = game.status !== 'COMPLETED' && !lifecycleActionPending

  // G6: per-claim promise-based lock for Confirm/Reject, independent of
  // `lifecycleActionPending` above (a different concern — per-row claim
  // decisions, not whole-game lifecycle actions) and independent PER CLAIM
  // ID, so acting on one claim never blocks any other claim's buttons. Only
  // one of Confirm/Reject can be in flight for a given claim at a time
  // (both read/write the SAME Set entry keyed by claim id), covering the
  // "Confirm and Reject must not run simultaneously for the same claim"
  // requirement directly.
  const [pendingClaimDecisionIds, setPendingClaimDecisionIds] = useState<Set<string>>(new Set())
  // Synchronous guard mirroring lifecycleActionPendingRef's reasoning above
  // -- a Set held in a ref, checked AND mutated synchronously before any
  // state update is requested, so two click handlers invoked back-to-back
  // in the same tick (Confirm then Reject on the same claim, or two rapid
  // Confirm clicks) can never both observe "not yet pending" for the same
  // claim id. `pendingClaimDecisionIds` (React state) only drives rendering.
  const pendingClaimDecisionIdsRef = useRef<Set<string>>(new Set())

  function isClaimDecisionPending(claimId: string): boolean {
    return pendingClaimDecisionIds.has(claimId)
  }

  function dispatchClaimDecision(claimId: string, action: Parameters<typeof dispatch>[0]) {
    if (pendingClaimDecisionIdsRef.current.has(claimId)) return
    pendingClaimDecisionIdsRef.current.add(claimId)
    setPendingClaimDecisionIds((prev) => new Set(prev).add(claimId))
    // See dispatchLifecycleAction's identical comment above: dispatch(...)
    // always resolves once settled; GameSessionContext.tsx's own rollback
    // is the real error response.
    void dispatch(action).finally(() => {
      pendingClaimDecisionIdsRef.current.delete(claimId)
      setPendingClaimDecisionIds((prev) => {
        const next = new Set(prev)
        next.delete(claimId)
        return next
      })
    })
  }

  function handleConfirm(claim: PrizeClaim) {
    dispatchClaimDecision(claim.id, { type: 'CONFIRM_CLAIM', claimId: claim.id })
  }

  function handleReject(claim: PrizeClaim) {
    const rejectionReason = promptForRejectionReason()
    dispatchClaimDecision(claim.id, {
      type: 'REJECT_CLAIM',
      claimId: claim.id,
      rejectionReason,
    })
  }

  function resetGame() {
    // Development/demo reset — returns the shared session to LOBBY.
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Reset the demo game back to the Lobby?')
    ) {
      return
    }
    // Local Fallback only (Supabase-configured resets are followed via the
    // pointer effect instead): record the outgoing game's own identity
    // before the reducer reseeds `game` in place, so Winner_History can
    // still label the group it belongs to after this reset (Req 9.2).
    if (isLocalOnlyMode) {
      setPastLocalGames((prev) => [
        ...prev,
        { id: game.id, code: game.code, createdAt: game.createdAt },
      ])
    }
    dispatch({ type: 'RESET_GAME' })
  }

  return (
    <div className="page host">
      <div className="host__inner">
        {isLocalOnlyMode ? (
          <p className="host__local-only-notice" role="status">
            Running in local-only mode — set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY for
            cross-device sync
          </p>
        ) : null}

        {/* E6: small, non-blocking Realtime connection banner. No-op while
            connected/connecting/not-configured -- the normal Host experience
            below renders completely unchanged in that case. */}
        <ConnectionStatusBanner
          status={realtimeConnectionStatus}
          onRetry={retryRealtimeConnection}
        />

        {/* Session header */}
        <header className="host__header">
          {/*
           * Host-only branding block: a small "Cyber Awareness Month" line
           * above a larger, bold "CYBER TAMBOLA" title, both set beside the
           * shield/check glyph (reused inline so the icon stays visually
           * identical across Host/Presentation/Player Join). Each screen
           * builds this hierarchy with its own small dedicated block rather
           * than through the shared BrandMark component, since every
           * screen's exact layout/sizing needs differ slightly.
           */}
          <div className="host__brand">
            <span className="host__brand-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="1em" height="1em" role="img">
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
            </span>
            <span className="host__brand-text">
              <span className="host__brand-eyebrow">Cyber Awareness Month</span>
              <span className="host__brand-title">Cyber Tambola</span>
            </span>
          </div>
          <div className="host__session-meta">
            <span className="host__stat">
              <span className="host__stat-label">Game Code</span>
              <span className="host__stat-value host__code">{game.code}</span>
            </span>
            <span className="host__stat">
              <span className="host__stat-label">Status</span>
              <StatusBadge status={game.status} />
            </span>
            <span className="host__stat">
              <span className="host__stat-label">Participants</span>
              <span className="host__stat-value">{state.players.length}</span>
            </span>
            <span className="host__stat">
              <span className="host__stat-label">Round</span>
              <span className="host__stat-value">
                {game.currentRound} / {totalRounds}
              </span>
            </span>
          </div>
          {/*
           * Opens the Presentation/Projector view in a separate browser
           * tab so the Host never navigates away from the Dashboard --
           * game controls, participant count, claims, and winner
           * confirmation all stay visible and usable while the
           * Presentation screen runs independently on the projector. The
           * new tab connects to the same active game through the existing
           * Supabase/shared-state architecture (GameSessionProvider
           * resolves the current Active_Game on its own mount); no game
           * session/state is passed or duplicated here.
           */}
          <Button
            variant="secondary"
            onClick={() => window.open('/presentation', '_blank', 'noopener,noreferrer')}
          >
            Open Presentation View
          </Button>
        </header>

        <div className="host__grid">
          {/* Left column: clue, reveal, controls */}
          <div className="host__col host__col--main">
            <Card title="Current Cyber Word" className="host__clue-card">
              {currentTerm ? (
                <CyberWordCard
                  term={currentTerm.term}
                  definition={currentTerm.definition}
                  awarenessTip={currentTerm.awarenessTip}
                  scale="stage"
                />
              ) : (
                <p className="host__empty">
                  {game.status === 'COMPLETED'
                    ? 'Game completed.'
                    : 'No word called yet. Start the game to call the first Cyber Word.'}
                </p>
              )}
            </Card>

            <Card title="Host Controls">
              <div className="host__controls">
                <Button
                  variant="primary"
                  onClick={() => dispatchLifecycleAction({ type: 'START_GAME' })}
                  disabled={!canStart}
                  icon="▶"
                >
                  Start Game
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => dispatchLifecycleAction({ type: 'CALL_NEXT_WORD' })}
                  disabled={!canCallNext}
                  icon="⏭"
                >
                  {lifecycleActionPending ? 'Calling…' : 'Next Cyber Word'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => dispatchLifecycleAction({ type: 'PAUSE_GAME' })}
                  disabled={!canPause}
                  icon="⏸"
                >
                  Pause
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => dispatchLifecycleAction({ type: 'RESUME_GAME' })}
                  disabled={!canResume}
                  icon="⏵"
                >
                  Resume
                </Button>
                <Button
                  variant="danger"
                  onClick={() => dispatchLifecycleAction({ type: 'END_GAME' })}
                  disabled={!canEnd}
                  icon="⏹"
                >
                  End Game
                </Button>
              </div>

              <div className="host__dev-controls">
                <Button variant="ghost" onClick={resetGame} icon="↺">
                  Reset Game
                </Button>
              </div>
            </Card>
          </div>

          {/* Right column: join, history, claims, winners */}
          <div className="host__col host__col--side">
            <Card title="Join the Game" className="host__join-card">
              <p className="host__join-code">{game.code}</p>
              <JoinQrCode gameCode={game.code} size={160} />
              <p className="host__join-text">Scan to join the game</p>
            </Card>

            <Card title="Called Words">
              {revealHistory.length === 0 ? (
                <p className="host__empty">No Cyber Words called yet.</p>
              ) : (
                <ul className="host__history">
                  {revealHistory.map((t) => (
                    <li key={t.id} className="host__history-item">
                      {t.term}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Participants">
              {/* Compact roster — display names only; never the Employee/Demo ID (Req 17.2, 17.4). */}
              {state.players.length === 0 ? (
                <p className="host__empty">No participants have joined yet.</p>
              ) : (
                <ul className="host__participants">
                  {state.players.map((player) => (
                    <li key={player.id} className="host__participant">
                      {player.displayName}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Prize Claims">
              <ClaimInboxSection
                title="Pending Claims"
                claims={inboxGroups.pending}
                winners={state.winners}
                onConfirm={handleConfirm}
                onReject={handleReject}
                isDecisionPending={isClaimDecisionPending}
              />
              <ClaimInboxSection
                title="Confirmed"
                claims={inboxGroups.confirmed}
                winners={state.winners}
                onConfirm={handleConfirm}
                onReject={handleReject}
                isDecisionPending={isClaimDecisionPending}
              />
              <ClaimInboxSection
                title="Rejected/Invalid"
                claims={inboxGroups.rejectedOrInvalid}
                winners={state.winners}
                onConfirm={handleConfirm}
                onReject={handleReject}
                isDecisionPending={isClaimDecisionPending}
              />
            </Card>

            <Card title="Winners">
              {/* Fixed-order render over all five prizes (Req 15.1, 15.2, 15.3) —
                  never a variable-length list of only-awarded prizes. */}
              <ul className="host__winners">
                {toWinnerPanelViewModel(state.winners, game.id).map((row) => (
                  <li
                    key={row.prizeId}
                    className={
                      row.winnerName ? 'host__winner' : 'host__winner host__winner--unawarded'
                    }
                  >
                    <span aria-hidden="true">{row.winnerName ? '🏆' : '—'}</span>
                    <span>
                      <strong>{row.label}</strong> —{' '}
                      {row.winnerName ?? 'Not awarded'}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Winner History">
              <WinnerHistorySection groups={winnerHistoryGroups} />
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

interface WinnerHistorySectionProps {
  groups: WinnerHistoryGroupViewModel[]
}

/**
 * Winner_History (Req 2.1-2.4, 2.6): every confirmed winner across every
 * game, grouped by owning game (newest game first) with that game's own
 * code/creation time as the group header. Rows show only `prizeLabel`/
 * `playerName`/`ticketRef`/`confirmedAt` — never an employee/demo id
 * (Req 2.7); `WinnerHistoryRowViewModel` structurally excludes it.
 */
function WinnerHistorySection({ groups }: WinnerHistorySectionProps) {
  if (groups.length === 0) {
    return <p className="host__empty">No winners have been confirmed yet.</p>
  }
  return (
    <div className="host__winner-history">
      {groups.map((group) => (
        <div key={group.gameId} className="host__winner-history-group">
          <h3 className="host__winner-history-group-title">
            {group.gameCode}
            <span className="host__winner-history-group-time">
              {new Date(group.gameCreatedAt).toLocaleString()}
            </span>
          </h3>
          <ul className="host__winner-history-rows">
            {group.rows.map((row, index) => (
              <li key={`${group.gameId}-${index}`} className="host__winner-history-row">
                <span className="host__winner-history-prize">{row.prizeLabel}</span>
                <span className="host__winner-history-player">{row.playerName}</span>
                <span className="host__winner-history-ticket">{row.ticketRef}</span>
                <span className="host__winner-history-time">
                  {new Date(row.confirmedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

interface ClaimInboxSectionProps {
  title: string
  claims: PrizeClaim[]
  winners: readonly Winner[]
  onConfirm: (claim: PrizeClaim) => void
  onReject: (claim: PrizeClaim) => void
  /** G6: true while a Confirm/Reject RPC is in flight for this claim id. */
  isDecisionPending: (claimId: string) => boolean
}

/**
 * One Host_Claim_Inbox subsection (Pending / Confirmed / Rejected-Invalid)
 * (Req 7.1-7.5, 10.2). Rows show only the player's display name — never the
 * employee/demo id (Req 17.2, 17.4).
 */
function ClaimInboxSection({
  title,
  claims,
  winners,
  onConfirm,
  onReject,
  isDecisionPending,
}: ClaimInboxSectionProps) {
  return (
    <div className="host__claims-section">
      <h3 className="host__claims-section-title">{title}</h3>
      {claims.length === 0 ? (
        <p className="host__empty">No claims in this category.</p>
      ) : (
        <ul className="host__claims">
          {claims.map((claim) => {
            const row = toClaimInboxRowViewModel(claim)
            // G6: while either Confirm or Reject is in flight for THIS
            // claim, both of its own buttons are disabled -- unrelated
            // claim rows are entirely unaffected (isDecisionPending is
            // keyed by claim.id, not a single global flag).
            const decisionPending = isDecisionPending(claim.id)
            return (
              <li key={claim.id} className="host__claim">
                <div className="host__claim-info">
                  <span className="host__claim-prize">{row.prizeLabel}</span>
                  <span className="host__claim-player">{row.playerName}</span>
                  <span className="host__claim-ticket">{row.ticketRef}</span>
                  <span className="host__claim-time">
                    {new Date(row.submittedAt).toLocaleTimeString()}
                  </span>
                  {row.rejectionReason ? (
                    <span className="host__claim-reason">{row.rejectionReason}</span>
                  ) : null}
                </div>
                <div className="host__claim-actions">
                  <ClaimStatusTag
                    validationStatus={row.validationStatus}
                    hostDecision={row.hostDecision}
                  />
                  <div className="host__claim-buttons">
                    <Button
                      variant="success"
                      onClick={() => onConfirm(claim)}
                      disabled={!canConfirmClaim(claim, winners) || decisionPending}
                    >
                      {decisionPending ? 'Processing…' : 'Confirm Winner'}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => onReject(claim)}
                      disabled={claim.hostDecision !== 'PENDING' || decisionPending}
                    >
                      {decisionPending ? 'Processing…' : 'Reject'}
                    </Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
