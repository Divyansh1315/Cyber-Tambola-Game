import type { Game } from '../types/game'
import type { Mark } from '../types/mark'
import type { Player } from '../types/player'
import type { PrizeClaim } from '../types/claim'
import type { PrizeProgress, Winner } from '../types/prize'
import type { Ticket } from '../types/ticket'

/** The single prototype game code used across all screens. */
export const SEED_GAME_CODE = 'CYBER24'

/** Build a fresh seed game in the LOBBY so the host can run the full flow. */
export function createSeedGame(code: string = SEED_GAME_CODE): Game {
  return {
    id: 'GAME_001',
    code,
    status: 'LOBBY',
    createdAt: new Date().toISOString(),
    currentRound: 0,
    revealedTermIds: [],
  }
}

/**
 * Generates a client-local New_Game_Code in the same `4 uppercase letters +
 * 2 digits` format as the SQL `generate_new_game_code()` function (e.g.
 * "QXKD47"). Local Fallback has no shared backend to check for collisions
 * against, so — unlike the SQL version — this is pure random generation
 * with no retry loop (Req 9.3).
 */
export function generateLocalGameCode(): string {
  const letters = Array.from({ length: 4 }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26)),
  ).join('')
  const digits = String(Math.floor(Math.random() * 100)).padStart(2, '0')
  return `${letters}${digits}`
}

/**
 * The complete central session state. The `game` is the source of truth for
 * lifecycle/clue/reveal data. `players`, `tickets`, `currentPlayerId`,
 * `marks`, `claims`, and `winners` are live session state populated as
 * players join, mark terms, submit prize claims, and have those claims
 * confirmed by the host (Req 19.1, 19.3). `prizeProgress` is seeded to
 * zeroed values so it never contradicts a freshly generated ticket
 * (Req 18.2) — real Prize_Progress is computed by the Prize_Engine once a
 * player has joined. `winnerHistory` (winner-history-and-game-reset Req 9.1)
 * is the Local Fallback counterpart of the server's permanent `winners`
 * table: it accumulates every winner folded in from a past session's
 * `winners` on each RESET_GAME and is never cleared, while `winners` itself
 * keeps meaning "this session's winners" everywhere it's already read
 * (Winner Panel, PresentationView announcement) — see design.md Decision 7.
 */
export interface GameSessionState {
  game: Game
  players: Player[]
  tickets: Ticket[]
  currentPlayerId?: string
  marks: Mark[]
  claims: PrizeClaim[]
  winners: Winner[]
  winnerHistory: Winner[]
  prizeProgress: PrizeProgress[]
}

/**
 * Zeroed prize progress used for live state (Req 18.2). Defined locally so live
 * state has no dependency on any dev-only mock fixture (Req 13).
 */
const seedPrizeProgress: PrizeProgress[] = [
  { id: 'CYBER_FIVE', label: 'Cyber Five', current: 0, target: 5 },
  { id: 'FIREWALL_LINE', label: 'Firewall Line', current: 0, target: 5 },
  { id: 'SECURITY_LINE', label: 'Security Line', current: 0, target: 5 },
  { id: 'DATA_DEFENDER_LINE', label: 'Data Defender Line', current: 0, target: 5 },
  { id: 'CYBER_FULL_HOUSE', label: 'Cyber Full House', current: 0, target: 15 },
]

/** The seed session state used on first load and after a reset. */
export const gameSessionInitialState: GameSessionState = {
  game: createSeedGame(),
  players: [],
  tickets: [],
  currentPlayerId: undefined,
  marks: [],
  // Real, empty seed (Req 19.1, 19.3) — claims/winners are populated only via
  // SUBMIT_PRIZE_CLAIM/CONFIRM_CLAIM as the game is actually played.
  claims: [],
  winners: [],
  // Empty on first load — nothing has been reset yet (Req 9.1).
  winnerHistory: [],
  prizeProgress: seedPrizeProgress,
}
