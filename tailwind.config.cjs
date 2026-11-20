/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  corePlugins: {
    // Keep existing plain-CSS base typography/spacing intact until DESIGN.MD phase.
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        "noble-black": {
          100: "#e8e9e9",
          200: "#cdcecf",
          300: "#9b9c9e",
          400: "#686b6e",
          500: "#363a3d",
          600: "#1a1d21",
          700: "#131619",
        },
        "stem-green": {
          300: "#dbf8cd",
          400: "#c8f4b4",
          500: "#b6f09c",
        },
        "day-blue": {
          900: "#263520",
        },
        "green-blue-day-blue": {
          500: "#82dbf7",
        },
        "red-power": {
          600: "#d0302f",
        },
        "happy-orange": {
          600: "#e26f20",
        },
        "electric-green": {
          600: "#4ac97e",
        },
        "glass-fill": "rgba(215, 237, 237, 0.16)",
      },
      fontFamily: {
        "plus-jakarta-sans": ['"Plus Jakarta Sans"', "sans-serif"],
      },
      fontSize: {
        "body-l-semibold": ["16px", { lineHeight: "24px", fontWeight: "600" }],
        "body-m-semibold": ["14px", { lineHeight: "20px", fontWeight: "600" }],
        "body-s-semibold": ["12px", { lineHeight: "18px", fontWeight: "600" }],
      },
      boxShadow: {
        "glass-effects": "inset 0 8px 12px rgba(255, 255, 255, 0.08)",
        "outline-heisenberg-blue": "0 0 0 4px rgba(130, 219, 247, 0.2)",
        "outline-noble-black": "0 0 0 4px rgba(54, 58, 61, 0.35)",
        "outline-red-power": "0 0 0 4px rgba(208, 48, 47, 0.25)",
        "outline-happy-orange": "0 0 0 4px rgba(226, 111, 32, 0.25)",
        "outline-eletric-green": "0 0 0 4px rgba(74, 201, 126, 0.25)",
      },
    },
  },
  plugins: [],
}
