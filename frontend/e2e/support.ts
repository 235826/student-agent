import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

export async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("用户名").fill("student");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page
    .getByRole("button", { name: /^(创建账号并进入|登\s*录)$/ })
    .click();
  await expect(page.getByRole("heading", { name: "今天", exact: true })).toBeVisible();
  const auth = await (await page.request.get("/api/v1/auth/me")).json();
  return { "X-CSRF-Token": auth.csrf_token, Origin: "http://127.0.0.1:5173" };
}

export async function openTaskFilters(page: Page) {
  const trigger = page.getByRole("button", { name: "筛选", exact: true });
  if (await trigger.isVisible()) await trigger.click();
}
