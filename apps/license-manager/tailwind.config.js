/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          orange: "#FE9300",
          orangeHover: "#FFAA33",
          orangeMuted: "#C47200",
        },
        surface: {
          950: "#090B0E",
          900: "#0E1116",
          850: "#13171F",
          800: "#181D27",
          700: "#222938",
          600: "#2F374A",
        },
      },
      fontFamily: {
        display: ["'Space Grotesk'", "'Chakra Petch'", "'Segoe UI'", "sans-serif"],
        sans: ["'Inter'", "'Segoe UI'", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "'Cascadia Code'", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
