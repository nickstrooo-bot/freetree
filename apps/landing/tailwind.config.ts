import { tailwindPreset } from "@kytelink/config/tailwind";
import type { Config } from "tailwindcss";

const config: Config = {
  presets: [tailwindPreset],
  theme: {
    extend: {
      colors: {
        freetree: {
          DEFAULT: "#1B4332",
          light: "#2D6A4F",
          bright: "#40916C",
          dark: "#10281D",
          cream: "#FDF8F0",
          sand: "#F5EDDF",
        },
      },
    },
  },
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "./consts/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
};

export default config;
