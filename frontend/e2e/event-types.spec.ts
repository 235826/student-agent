import { test, expect } from "./fixtures";

test("自定义事件类型可创建并用于事件", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("用户名").fill("student");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page
    .getByRole("button", { name: /^(创建账号并进入|登\s*录)$/ })
    .click();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("link", { name: "事件类型", exact: true }).click();
  await page.getByRole("button", { name: "新建事件类型" }).click();
  await page.getByLabel("类型名称").fill("社团活动");
  await page.getByLabel("颜色").fill("#9254de");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "社团活动", exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "日历", exact: true }).click();
  await page.getByRole("button", { name: "添加事件", exact: true }).click();
  await page
    .locator(".ant-select")
    .filter({ has: page.getByRole("combobox", { name: "事件类型" }) })
    .click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: "社团活动" })
    .click();
  await page.getByLabel("事件标题").fill("社团迎新");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(
    page.getByText("社团活动", { exact: true }).first(),
  ).toBeVisible();
});
