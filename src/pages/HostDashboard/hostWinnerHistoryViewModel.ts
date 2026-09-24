import type { Winner } from '../../types/prize'

/** A minimal game summary: just enough to label a Winner_History group (Req 2.4). */
export interface WinnerHistoryGameSummary {
  id: string
  code: string
  createdAt: string
}

/**
 * One Winner_History row. Narrowed to exactly the fields the host needs to
 * see (Req 2.3) — never an `employeeDemoId` or any other identifying/
 * technical field. `Winner` itself carries no `employeeDemoId`, so this
 * narrowing is defense-in-depth consistent with `toClaimInboxRowViewModel`/
 * `toWinnerPanelViewModel`'s existing convention (Req 2.7).
 */
export interface WinnerHistoryRowViewModel {
  prizeLabel: string
  playerName: string
  ticketRef: string
  confirmedAt: string
}

/** One Winner_History group: all winners for a single game, with that game's own label. */
export interface WinnerHistoryGroupViewModel {
  gameId: string
  gameCode: string
  gameCreatedAt: string
  rows: WinnerHistoryRowViewModel[]
}

/**
 * Groups winners by their owning game and orders the groups newest-game-
 * first (Req 2.2, 2.4) — "newest" meaning that game's own `createdAt`, not
 * any winner's `confirmedAt`. Every winner is included exactly once,
 * regardless of which game is currently the Active_Game (Req 2.1, 2.6).
 * Pure and source-agnostic: fed from mapped Supabase rows or from
 * Local_Fallback's `winnerHistory` + current-session `winners` + a
 * locally-tracked list of past games alike (Req 9.2) — this is the one
 * place grouping/ordering/labeling is implemented. Does not mutate its
 * inputs.
 */
export function toWinnerHistoryViewModel(
  winners: readonly Winner[],
  games: readonly WinnerHistoryGameSummary[],
): WinnerHistoryGroupViewModel[] {
  const gameById = new Map(games.map((g) => [g.id, g]))

  const winnersByGame = new Map<string, Winner[]>()
  for (const winner of winners) {
    const rows = winnersByGame.get(winner.gameId) ?? []
    rows.push(winner)
    winnersByGame.set(winner.gameId, rows)
  }

  return [...winnersByGame.entries()]
    .map(([gameId, gameWinners]) => {
      const game = gameById.get(gameId)
      return {
        gameId,
        gameCode: game?.code ?? 'Unknown game',
        gameCreatedAt: game?.createdAt ?? gameWinners[0]?.confirmedAt ?? '',
        rows: gameWinners.map((winner) => ({
          prizeLabel: winner.prizeLabel,
          playerName: winner.playerName,
          ticketRef: winner.ticketRef,
          confirmedAt: winner.confirmedAt,
        })),
      }
    })
    .sort((a, b) => (a.gameCreatedAt < b.gameCreatedAt ? 1 : -1))
}
