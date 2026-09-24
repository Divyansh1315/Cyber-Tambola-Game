/** The six cyber-awareness categories used by the prototype term bank. */
export type CyberCategory =
  | 'Email Security'
  | 'Identity & Access'
  | 'Threats'
  | 'Device / Physical Security'
  | 'Data Protection'
  | 'Network Security'

/** Relative difficulty of a term, used for future weighting/ordering. */
export type CyberDifficulty = 'easy' | 'medium' | 'hard'

/**
 * A single cyber-awareness term used across the game. The word, its
 * definition, and its awareness tip are all shown together the moment the
 * host officially calls the term — there is no separate hidden-answer phase
 * (Module 5).
 */
export interface CyberTerm {
  /** Stable identifier, e.g. "TERM_001". */
  id: string
  /** Display name, e.g. "Phishing". */
  term: string
  /** Grouping category, e.g. "Email Security". */
  category: CyberCategory
  /** Short factual description of the term, shown together with `term`. */
  definition: string
  /** Short safe-practice guidance, shown together with `term`/`definition`. */
  awarenessTip: string
  /** Relative difficulty of the term. */
  difficulty: CyberDifficulty
  /** Whether this term is eligible to be selected during a game. */
  active: boolean
}
