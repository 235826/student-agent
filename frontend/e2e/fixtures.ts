import { test as base, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";

// Tests run serially; reset domain data so imports cannot consume another scenario's schedule.
export const test = base.extend<{ isolatedDatabase: void }>({
  isolatedDatabase: [
    // Playwright requires an object pattern to declare fixture dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      execFileSync("../backend/.venv/bin/python", [
        "../backend/scripts/reset_e2e.py",
        path.resolve("../data/e2e.db"),
      ]);
      await use();
    },
    { auto: true },
  ],
});
export { expect };
