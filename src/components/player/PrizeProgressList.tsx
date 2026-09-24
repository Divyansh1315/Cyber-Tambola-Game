import type { PrizeProgress } from '../../types/prize'
import './PrizeProgressList.css'

interface PrizeProgressListProps {
  items: PrizeProgress[]
}

/** Compact progress cards for each prize category (mock values). */
export function PrizeProgressList({ items }: PrizeProgressListProps) {
  return (
    <ul className="prize-progress">
      {items.map((prize) => {
        const pct = Math.round((prize.current / prize.target) * 100)
        const complete = prize.current >= prize.target
        return (
          <li className="prize-progress__item" key={prize.id}>
            <div className="prize-progress__head">
              <span className="prize-progress__label">{prize.label}</span>
              <span className="prize-progress__count">
                {prize.current}/{prize.target}
                {complete && (
                  <span className="prize-progress__ready" aria-hidden="true">
                    {' '}
                    ✓
                  </span>
                )}
              </span>
            </div>
            <div
              className="prize-progress__bar"
              role="progressbar"
              aria-valuenow={prize.current}
              aria-valuemin={0}
              aria-valuemax={prize.target}
              aria-label={`${prize.label} progress`}
            >
              <span
                className={`prize-progress__fill ${
                  complete ? 'is-complete' : ''
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
