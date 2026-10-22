import { test, expect } from "./fixtures";

test("可创建第二个账号且数据互相隔离", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("用户名").fill("student");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page
    .getByRole("button", { name: /^(创建账号并进入|登\s*录)$/ })
    .click();
  await page.getByRole("link", { name: "任务", exact: true }).click();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("任务标题").fill("第一个账号的任务");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "第一个账号的任务", exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "退出账号", exact: true }).click();
  await page.getByRole("button", { name: "创建新账号", exact: true }).click();
  await page.getByLabel("用户名").fill("second");
  await page.getByLabel("密码", { exact: true }).fill("second-password-123");
  await page
    .getByRole("button", { name: "创建账号并进入", exact: true })
    .click();
  await page.getByRole("link", { name: "任务", exact: true }).click();
  await expect(
    page.getByText("还没有任务，先添加一件想完成的事"),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("任务标题").fill("第二个账号的任务");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "第二个账号的任务", exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "退出账号", exact: true }).click();
  await page.getByLabel("用户名").fill("student");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page.getByRole("button", { name: /^登\s*录$/ }).click();
  await page.getByRole("link", { name: "任务", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "第一个账号的任务", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "第二个账号的任务", exact: true }),
  ).not.toBeVisible();
});
