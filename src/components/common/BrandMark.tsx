import './BrandMark.css'

interface BrandMarkProps {
  /** Layout size. `hero` is used on the join screen and projector view. */
  size?: 'sm' | 'md' | 'hero'
  /** Show the "Cyber Word Tambola" subtitle beneath the title. */
  withSubtitle?: boolean
  /** Render title/subtitle in light colors for dark backgrounds. */
  onDark?: boolean
}

/**
 * Cyber Tambola V2 brand lockup: shield glyph + wordmark.
 * Keeps the visual language professional and cyber-security themed.
 */
export function BrandMark({
  size = 'md',
  withSubtitle = false,
  onDark = false,
}: BrandMarkProps) {
  return (
    <div className={`brand brand--${size} ${onDark ? 'brand--on-dark' : ''}`}>
      <span className="brand__glyph" aria-hidden="true">
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
      <span className="brand__text">
        <span className="brand__title">
          Cyber Tambola <span className="brand__v2">V2</span>
        </span>
        {withSubtitle && (
          <span className="brand__subtitle">Cyber Word Tambola</span>
        )}
      </span>
    </div>
  )
}
