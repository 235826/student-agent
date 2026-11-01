import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/@fullcalendar/")) return "fullcalendar";
          if (id.includes("/node_modules/luxon/")) return "luxon";
          if (id.includes("/node_modules/@tanstack/")) return "query";
          if (
            id.includes("/node_modules/react") ||
            id.includes("/node_modules/scheduler/")
          )
            return "react";
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/health": "http://127.0.0.1:8000",
    },
  },
  test: { environment: "jsdom", include: ["src/**/*.test.ts?(x)"] },
});
