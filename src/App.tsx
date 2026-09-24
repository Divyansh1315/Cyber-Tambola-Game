import { Route, Routes } from 'react-router-dom'
import { DevNav } from './components/common/DevNav'
import { HostDashboard } from './pages/HostDashboard/HostDashboard'
import { PlayerGame } from './pages/PlayerGame/PlayerGame'
import { PlayerJoin } from './pages/PlayerJoin/PlayerJoin'
import { PresentationView } from './pages/PresentationView/PresentationView'

/**
 * App shell + prototype routing.
 * Routes:
 *   /              Player Join   (Screen A)
 *   /player        Player Game   (Screen B)
 *   /host          Host Dashboard(Screen C)
 *   /presentation  Projector View(Screen D)
 * DevNav is a temporary demo aid for moving between screens.
 */
export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<PlayerJoin />} />
        <Route path="/player" element={<PlayerGame />} />
        <Route path="/host" element={<HostDashboard />} />
        <Route path="/presentation" element={<PresentationView />} />
        {/* Fallback to the join screen for any unknown route */}
        <Route path="*" element={<PlayerJoin />} />
      </Routes>
      <DevNav />
    </>
  )
}
