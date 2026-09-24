import type { CyberTerm } from '../types/cyberTerm'

/**
 * Pure game-engine logic for the local Cyber Tambola prototype.
 *
 * These helpers contain no React or side effects so they are easy to reason
 * about and (later) test. Selection rules:
 *   - only active terms may be selected
 *   - a term already used this game is never selected again
 *   - selection is randomized among the remaining active, unused terms
 *   - when nothing remains a safe `null` is returned so the UI cannot crash
 */

/** The active terms that have not yet been used in this game. */
export function getAvailableTerms(
  terms: CyberTerm[],
  usedTermIds: string[],
): CyberTerm[] {
  const used = new Set(usedTermIds)
  return terms.filter((t) => t.active && !used.has(t.id))
}

/** True when at least one active, unused term remains. */
export function hasRemainingTerms(
  terms: CyberTerm[],
  usedTermIds: string[],
): boolean {
  return getAvailableTerms(terms, usedTermIds).length > 0
}

/**
 * Pick the next clue term. Returns `null` when the bank is exhausted so callers
 * can safely prevent another round from starting.
 *
 * @param rng Optional deterministic random source in [0, 1); defaults to
 *            `Math.random`. Useful for predictable behaviour in tests.
 */
export function selectNextTerm(
  terms: CyberTerm[],
  usedTermIds: string[],
  rng: () => number = Math.random,
): CyberTerm | null {
  const available = getAvailableTerms(terms, usedTermIds)
  if (available.length === 0) return null
  const index = Math.floor(rng() * available.length)
  // Clamp defensively in case rng() returns exactly 1.
  return available[Math.min(index, available.length - 1)]
}
