import React, { useState, useEffect, useRef } from 'react'

/**
 * Address search using Nominatim (OpenStreetMap geocoding — free, no API key).
 * Debounces input by 400ms, shows a dropdown of results, calls onSelect with {lat, lon, label}.
 */
export default function AddressSearch({ onSelect }) {
  const [query,       setQuery]       = useState('')
  const [results,     setResults]     = useState([])
  const [loading,     setLoading]     = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const debounceRef = useRef(null)
  const wrapperRef  = useRef(null)

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function handleChange(e) {
    const val = e.target.value
    setQuery(val)
    setShowDropdown(true)

    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (val.trim().length < 3) { setResults([]); return }

    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(val)}&format=json&limit=5&addressdetails=1&countrycodes=in`
        const res = await fetch(url, {
          headers: { 'Accept-Language': 'en', 'User-Agent': 'RAPID-Emergency-Dispatcher' },
        })
        const data = await res.json()
        setResults(data)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 400)
  }

  function handleSelect(item) {
    onSelect({
      lat:   parseFloat(item.lat),
      lon:   parseFloat(item.lon),
      label: item.display_name,
    })
    setQuery(item.display_name.split(',').slice(0, 2).join(','))
    setResults([])
    setShowDropdown(false)
  }

  return (
    <div ref={wrapperRef} className="relative">
      <div className="flex items-center gap-1.5">
        <span className="text-slate-500 text-sm">🔍</span>
        <input
          type="text"
          value={query}
          onChange={handleChange}
          onFocus={() => results.length > 0 && setShowDropdown(true)}
          placeholder="Search address or place…"
          className="flex-1 bg-rapid-bg border border-rapid-border rounded px-2 py-1.5 text-sm text-slate-200
                     placeholder-slate-600 focus:outline-none focus:border-blue-500"
        />
        {loading && (
          <svg className="animate-spin w-3.5 h-3.5 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
          </svg>
        )}
      </div>

      {showDropdown && results.length > 0 && (
        <ul className="absolute z-50 left-0 right-0 mt-1 bg-rapid-surface border border-rapid-border
                       rounded shadow-xl max-h-48 overflow-y-auto text-xs">
          {results.map((item, i) => (
            <li
              key={i}
              onClick={() => handleSelect(item)}
              className="px-3 py-2 cursor-pointer hover:bg-blue-900/40 text-slate-300 border-b border-rapid-border last:border-0"
            >
              <span className="font-medium text-slate-200">
                {item.display_name.split(',').slice(0, 2).join(', ')}
              </span>
              <span className="block text-slate-500 truncate">
                {item.display_name.split(',').slice(2, 4).join(', ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
