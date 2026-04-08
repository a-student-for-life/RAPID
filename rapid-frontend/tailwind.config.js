/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        rapid: {
          bg:       '#0f1117',
          surface:  '#1a1d2e',
          border:   '#2d3148',
          red:      '#ef4444',
          amber:    '#f59e0b',
          green:    '#10b981',
          blue:     '#3b82f6',
          purple:   '#8b5cf6',
        },
      },
    },
  },
  plugins: [],
}
