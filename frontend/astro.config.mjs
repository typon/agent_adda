import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

const backendTarget = process.env.AGENT_ADDA_BACKEND_TARGET ?? "http://127.0.0.1:4322";
const allowedHosts = (process.env.AGENT_ADDA_ALLOWED_HOSTS ?? "localhost,127.0.0.1")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  devToolbar: {
    enabled: false,
  },
  integrations: [react()],
  server: {
    allowedHosts,
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      allowedHosts,
      proxy: {
        "/api": backendTarget
      }
    }
  }
});
