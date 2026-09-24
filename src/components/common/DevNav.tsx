import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import './DevNav.css'

const LINKS = [
  { to: '/', label: 'Join', end: true },
  { to: '/player', label: 'Player' },
  { to: '/host', label: 'Host' },
  { to: '/presentation', label: 'Projector' },
]

/**
 * Temporary development-only navigation for moving between prototype screens.
 * Intentionally subtle (collapsible pill, bottom-right) so it does not dominate
 * the final screen design. Removed when real routing/entry flows are built.
 */
export function DevNav() {
  const [open, setOpen] = useState(true)

  return (
    <nav className={`dev-nav ${open ? 'is-open' : 'is-collapsed'}`} aria-label="Prototype navigation">
      <button
        type="button"
        className="dev-nav__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? '×' : '☰'}</span>
        <span className="sr-only">{open ? 'Hide' : 'Show'} prototype navigation</span>
      </button>
      {open && (
        <div className="dev-nav__links">
          <span className="dev-nav__label">Demo</span>
          {LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                `dev-nav__link ${isActive ? 'is-active' : ''}`
              }
            >
              {link.label}
            </NavLink>
          ))}
        </div>
      )}
    </nav>
  )
}
