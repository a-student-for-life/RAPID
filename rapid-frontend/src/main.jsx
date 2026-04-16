import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './index.css'

const App = lazy(() => import('./App.jsx'))
const CrewView = lazy(() => import('./components/CrewView.jsx'))

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

const isCrewView = window.location.hash.startsWith('#crew')

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
        {isCrewView ? <CrewView /> : <App />}
      </Suspense>
    </ErrorBoundary>
  </React.StrictMode>,
)
