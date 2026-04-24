import React, { Suspense, lazy, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import axios from 'axios'
import 'leaflet/dist/leaflet.css'
import './index.css'

// ── Remote API base ───────────────────────────────────────────────────────
// In dev, Vite proxies /api to localhost:8000. In prod (Firebase / Cloud Run
// frontend / wherever we host the static bundle), VITE_API_URL points at the
// Cloud Run backend. We transparently rewrite relative /api/* calls so no
// component needs to know the backend is on a different origin.
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
if (API_BASE) {
  axios.defaults.baseURL = API_BASE

  const _fetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      return _fetch(API_BASE + input, init)
    }
    if (input instanceof Request && input.url.startsWith(`${window.location.origin}/api/`)) {
      const rewritten = new Request(API_BASE + input.url.slice(window.location.origin.length), input)
      return _fetch(rewritten, init)
    }
    return _fetch(input, init)
  }
}

const App = lazy(() => import('./App.jsx'))
const CrewView = lazy(() => import('./components/CrewView.jsx'))
const HospitalKiosk = lazy(() => import('./components/HospitalKiosk.jsx'))
const BystanderReport = lazy(() => import('./components/BystanderReport.jsx'))

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[RAPID] Render error:', error, info?.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          background: '#080a0f', color: '#e2e8f0', height: '100vh',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', fontFamily: 'system-ui', padding: '2rem',
          textAlign: 'center',
        }}>
          <p style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>🚨</p>
          <p style={{ fontSize: '1.1rem', fontWeight: 900, marginBottom: '0.5rem', color: '#f87171' }}>
            RAPID - Unexpected Error
          </p>
          <p style={{
            fontSize: '0.8rem', color: '#94a3b8', maxWidth: '480px',
            marginBottom: '1.5rem', lineHeight: 1.6,
            background: '#1a1d2e', padding: '0.75rem 1rem', borderRadius: '0.5rem',
            border: '1px solid #2d3148', fontFamily: 'monospace', textAlign: 'left',
          }}>
            {this.state.error?.message || String(this.state.error)}
          </p>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload() }}
            style={{
              background: '#3b82f6', color: '#fff', border: 'none',
              padding: '0.6rem 1.8rem', borderRadius: '0.5rem',
              cursor: 'pointer', fontSize: '0.9rem', fontWeight: 700,
            }}
          >
            Reload RAPID
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function getHashRoute(hash) {
  if (hash.startsWith('#report')) return 'report'
  if (hash.startsWith('#hospital')) return 'hospital'
  if (hash.startsWith('#crew')) return 'crew'
  return 'app'
}

function Router() {
  const [route, setRoute] = useState(() => getHashRoute(window.location.hash))

  useEffect(() => {
    function onHash() { setRoute(getHashRoute(window.location.hash)) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (route === 'report') return <BystanderReport />
  if (route === 'hospital') return <HospitalKiosk />
  if (route === 'crew') return <CrewView />
  return <App />
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/rapid-sw.js').catch((error) => {
      console.warn('[RAPID] Service worker registration failed:', error?.message || error)
    })
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Suspense fallback={<div className="min-h-screen grid place-items-center bg-[#080a0f] text-sm text-slate-500">Loading RAPID...</div>}>
        <Router />
      </Suspense>
    </ErrorBoundary>
  </React.StrictMode>,
)
