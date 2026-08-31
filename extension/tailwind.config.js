/** @type {import('tailwindcss').Config} */
export default {
  content: ['./*.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: {
          950: '#0A0B0D',
          900: '#101216',
          800: '#181B20',
          700: '#22262D',
          600: '#2E333B',
        },
        signal: {
          DEFAULT: '#00D9A3',
          dim: '#0A6B54',
          glow: '#4FF5C9',
        },
        alert: {
          DEFAULT: '#FF5C5C',
          dim: '#7A2626',
        },
        amber: {
          DEFAULT: '#F5B942',
        },
        ink: {
          50: '#F4F6F7',
          200: '#C7CDD3',
          400: '#8993A0',
          600: '#5B6470',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(0,217,163,0.25), 0 0 24px rgba(0,217,163,0.12)',
      },
      keyframes: {
        'redact-fill': {
          '0%': { boxShadow: '0 0 0 0 rgba(0,217,163,0.55)', opacity: '0.15' },
          '40%': { boxShadow: '0 0 0 3px rgba(0,217,163,0.35)', opacity: '0.55' },
          '100%': { boxShadow: '0 0 0 0 rgba(0,217,163,0)', opacity: '1' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        'redact-fill': 'redact-fill 480ms ease-out',
        'pulse-dot': 'pulse-dot 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
