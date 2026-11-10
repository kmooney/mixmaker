import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser only talks to this origin; the mix-maker API holds the //SCHEMA key.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      "/api": "http://127.0.0.1:8090",
      "/files": "http://127.0.0.1:8090",
    },
  },
});
