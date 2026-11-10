/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        midnight: '#050914',
        panel: '#0A1224',
        raised: '#0F1A33',
        overlay: '#14213F',
        line: 'rgba(138, 166, 232, 0.12)',
        'line-strong': 'rgba(138, 166, 232, 0.24)',
        fg: '#E8EEFC',
        dim: '#93A3C7',
        faint: '#5F7098',
        electric: { DEFAULT: '#3B82F6', soft: '#6EA1FF', deep: '#2158C9' },
        cyan: { DEFAULT: '#22D3EE', soft: '#7CE7F7' },
        positive: '#34D399',
        negative: '#F87171',
        caution: '#FBBF24',
      },
      fontFamily: {
        sans: ['"DM Sans"', 'sans-serif'],
        display: ['"Space Grotesk"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Menlo', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(34,211,238,0.25), 0 8px 32px -8px rgba(34,211,238,0.25)',
        card: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 12px 32px -16px rgba(0,0,0,0.6)',
      },
      keyframes: {
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        rise: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s infinite',
        rise: 'rise 0.5s cubic-bezier(0.2,0.7,0.2,1) both',
      },
    },
  },
  plugins: [],
}
