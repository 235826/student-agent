import { test, expect } from "./fixtures";

test("排程预览、确认、版本保留及失效提示", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("用户名").fill("student");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page
    .getByRole("button", { name: /^(创建账号并进入|登\s*录)$/ })
    .click();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "添加时段" }).first().click();
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "任务", exact: true }).click();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const title = `排程作业-${info.project.name}`;
  await page.getByLabel("任务标题").fill(title);
  await page.getByLabel("预计用时").fill("60");
  await page.getByRole("button", { name: /^确\s*定$/ }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("link", { name: "学习计划", exact: true }).click();
  await page.getByLabel("排程开始").fill("2030-01-07T00:00");
  await page.getByLabel("排程结束").fill("2030-01-08T00:00");
  await page.getByRole("button", { name: "生成草稿" }).click();
  await expect(page.getByText("待确认草稿", { exact: true })).toBeVisible();
  await page.getByText("查看工作块变更明细", { exact: true }).click();
  await expect(page.locator(".ant-collapse-content-active")).toContainText(
    title,
  );
  const report = page
    .locator(".ant-card")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(report.getByText("已排 60 分钟 · 未排 0 分钟")).toBeVisible();
  await page.getByRole("button", { name: "确认采用" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(page.getByText("已采用计划", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("当前计划", { exact: true })).toBeVisible();
  await page.getByLabel("排程开始").fill("2030-01-07T00:00");
  await page.getByLabel("排程结束").fill("2030-01-08T00:00");
  await page.getByRole("button", { name: "生成草稿" }).click();
  await expect(page.getByText("待确认草稿", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "任务", exact: true }).click();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("任务标题").fill(`${title}-新增`);
  await page.getByRole("button", { name: /^确\s*定$/ }).click();
  await expect(
    page.getByRole("heading", { name: `${title}-新增` }),
  ).toBeVisible();
  await page.getByRole("link", { name: "学习计划", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认采用" })).toBeDisabled();
  await expect(
    page.getByText(/任务、课表、规则或当前计划已变化/),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(page.locator(".ant-message-notice")).toHaveCount(0);
  await page.screenshot({
    path: `test-results/${info.project.name}-schedule.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
