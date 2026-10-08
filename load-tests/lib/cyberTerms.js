// Mirrors src/data/cyberTerms.ts's id list exactly. All 30 terms are
// `active: true` in the app today, so this is simply TERM_001..TERM_030.
//
// IMPORTANT: assign_ticket requires at least 12 active ids to build a
// 3x4 ticket, and join_game forwards whatever p_active_term_ids the caller
// supplies straight through — these scripts must send the SAME list a real
// client would, or generated tickets/behavior will diverge from production
// usage. If src/data/cyberTerms.ts ever changes which terms are `active`,
// update this list to match.
export const ACTIVE_TERM_IDS = Array.from(
  { length: 30 },
  (_, i) => `TERM_${String(i + 1).padStart(3, '0')}`
)

export const PRIZE_IDS = [
  'CYBER_FIVE',
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
]
