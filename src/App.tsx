import { Route, Routes } from 'react-router-dom'
import { DevNav } from './components/common/DevNav'
import { HostDashboard } from './pages/HostDashboard/HostDashboard'
import { PlayerEntry } from './pages/PlayerEntry'
import { PresentationView } from './pages/PresentationView/PresentationView'

/**
 * App shell + production routing.
 * Routes:
 *   /              Host Dashboard      (public base URL — the live-event
 *                                        entry point for the Host)
 *   /player        Player entry point  (Join screen, or Game screen once
 *                                        the player has joined — see
 *                                        PlayerEntry)
 *   /host          Host Dashboard      (kept as an alias of "/" for any
 *                                        existing bookmarks/links)
 *   /presentation  Projector View      (audience-facing display)
 * DevNav is a temporary demo aid for moving between screens. It is only
 * rendered outside production builds (import.meta.env.PROD) so a public
 * deployment does not expose an internal screen-switcher to every visitor.
 */
export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<HostDashboard />} />
        <Route path="/host" element={<HostDashboard />} />
        <Route path="/player" element={<PlayerEntry />} />
        <Route path="/presentation" element={<PresentationView />} />
        {/* Fallback to the Host Dashboard for any unknown route, since the
            public base URL is the Host entry point. */}
        <Route path="*" element={<HostDashboard />} />
      </Routes>
      {!import.meta.env.PROD && <DevNav />}
    </>
  )
}
