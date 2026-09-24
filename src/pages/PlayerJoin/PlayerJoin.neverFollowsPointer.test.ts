// Feature: winner-history-and-game-reset — regression guarantee that
// PlayerJoin.tsx never follows the Active_Game_Pointer.
//
// This is a text-pattern check against PlayerJoin.tsx's own source, not a
// runtime import-graph inspection, mirroring the structural lint style
// already established for the SQL migrations (see
// supabase/migrations/schema.structure.test.ts and
// rpcActiveGameAndReset.structure.test.ts). It exists to catch a future
// change that wires PlayerJoin.tsx up to getActiveGame,
// subscribeToActiveGamePointer, or resetGameToNew before any such change
// ships, since Requirement 7 requires Player Join to keep resolving a game
// only via a client-submitted code through the existing join_game RPC path.
//
// Validates: Requirements 7.1, 7.4
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const playerJoinPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'PlayerJoin.tsx')
const source = readFileSync(playerJoinPath, 'utf-8')

/** Names PlayerJoin.tsx must never import from realtimeClient.ts. */
const FORBIDDEN_POINTER_IMPORTS = [
  'getActiveGame',
  'subscribeToActiveGamePointer',
  'resetGameToNew',
]

describe('PlayerJoin.tsx never follows the Active_Game_Pointer (Req 7.1, 7.4)', () => {
  it.each(FORBIDDEN_POINTER_IMPORTS)('never imports "%s"', (name) => {
    // A plain word-boundary check catches both a named import
    // (`import { getActiveGame } from ...`) and any qualified reference
    // (`realtimeClient.getActiveGame(...)`), so this holds regardless of
    // how a future regression might introduce the call.
    const pattern = new RegExp(`\\b${name}\\b`)
    expect(source).not.toMatch(pattern)
  })

  it('still resolves its game only via a client-submitted code through joinGame from context', () => {
    // joinGame (destructured from useGameSession()) is PlayerJoin's sole
    // path to the backend; it forwards the form's own gameCode field to the
    // join_game RPC (see GameSessionContext.tsx), never a pointer-resolved id.
    expect(source).toMatch(/\bjoinGame\b/)
    expect(source).toMatch(/useGameSession\s*\(\s*\)/)
    expect(source).toMatch(/joinGame\s*\(\s*\{[^)]*gameCode/)
  })

  it('does not import getActiveGame, subscribeToActiveGamePointer, or resetGameToNew from realtimeClient.ts', () => {
    // Locate PlayerJoin's own import statement(s) sourcing from
    // realtimeClient.ts, and assert none of the pointer/reset exports
    // appear in their named-import lists.
    const realtimeClientImports = [
      ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*realtimeClient['"]/g),
    ]

    expect(realtimeClientImports.length).toBeGreaterThan(0)

    for (const match of realtimeClientImports) {
      const namedImports = match[1]
      for (const forbidden of FORBIDDEN_POINTER_IMPORTS) {
        expect(namedImports).not.toMatch(new RegExp(`\\b${forbidden}\\b`))
      }
    }
  })
})
