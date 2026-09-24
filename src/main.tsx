import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { GameSessionProvider } from './state/GameSessionContext'
import './styles/global.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <GameSessionProvider>
        <App />
      </GameSessionProvider>
    </BrowserRouter>
  </StrictMode>,
)
