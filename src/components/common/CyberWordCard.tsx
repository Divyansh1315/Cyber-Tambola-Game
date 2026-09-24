import './CyberWordCard.css'

interface CyberWordCardProps {
  term: string
  definition: string
  awarenessTip: string
  /** Visual scale: `player` for phones, `stage` for host/projector. */
  scale?: 'player' | 'stage'
}

/**
 * Shows the officially-called Cyber Word together with its definition and
 * safe-practice tip, all at once. There is no hidden/waiting sub-state — the
 * moment the host calls a word, everything about it is visible everywhere
 * (Host, Player, Presentation). Replaces the old ClueCard + AnswerReveal pair
 * from the clue/reveal model (Module 5).
 */
export function CyberWordCard({
  term,
  definition,
  awarenessTip,
  scale = 'player',
}: CyberWordCardProps) {
  return (
    <div className={`cyber-word-card cyber-word-card--${scale}`}>
      <span className="cyber-word-card__eyebrow">Current Cyber Word</span>
      <p className="cyber-word-card__term">{term}</p>
      <p className="cyber-word-card__definition">{definition}</p>
      <div className="cyber-word-card__tip">
        <span className="cyber-word-card__tip-label">Safe Practice</span>
        <p className="cyber-word-card__tip-text">{awarenessTip}</p>
      </div>
    </div>
  )
}
