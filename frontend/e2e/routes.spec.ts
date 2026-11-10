import { test, expect } from "./fixtures";

test("导航、旧路径与详情刷新", async ({ page }) => {
  await page.goto("/tasks");
  await page.evaluate(() => localStorage.setItem("onboarding_done", "1"));
  await page.getByLabel("用户名").fill("student");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page
    .getByRole("button", { name: /^(创建账号并进入|登\s*录)$/ })
    .click();
  await expect(page.locator("nav a")).toHaveCount(3);
  await expect(page.locator("nav a").filter({ hasText: "今日" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("任务标题").fill("可刷新的任务");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "可刷新的任务", exact: true }),
  ).toBeVisible();
  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  const url = `/tasks/${tasks[0].id}`;
  await page.goto(url);
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(
    page.getByRole("heading", { name: "可刷新的任务" }),
  ).toBeVisible();
  await page.goto("/compatibility");
  await expect(page).toHaveURL(/\/settings\/rules$/);
  await page.goto("/events");
  await expect(page).toHaveURL(/\/calendar(\?|$)/);
  await page.goto("/imports?job=missing");
  await expect(page).toHaveURL(/\/inbox\/imports\/missing$/);
  await expect(page.getByText("记录不存在")).toBeVisible();
  await page.goto("/not-a-page");
  await expect(page.getByText("页面不存在，请检查地址")).toBeVisible();
});
