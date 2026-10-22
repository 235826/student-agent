import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
const database = path.resolve("../data/e2e.db");
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chromium",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        viewport: { width: 375, height: 812 },
        defaultBrowserType: "chromium",
      },
    },
  ],
  webServer: [
    {
      command: "../backend/.venv/bin/python ../backend/scripts/e2e_server.py",
      url: "http://127.0.0.1:8000/health/ready",
      reuseExistingServer: false,
      env: { SA_DATABASE_URL: `sqlite:///${database}` },
    },
    {
      command: "npm run dev -- --port 5173 --strictPort",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
    },
  ],
});
