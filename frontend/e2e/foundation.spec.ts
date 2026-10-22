import { test, expect } from "./fixtures";
test("账号、任务、事件、设置和手机布局闭环", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await page.getByLabel("用户名").fill("student");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page
    .getByRole("button", { name: /^(创建账号并进入|登\s*录)$/ })
    .click();
  await expect(page.getByRole("heading", { name: "今日工作台" })).toBeVisible();
  await page.getByRole("link", { name: "任务", exact: true }).click();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const title = `算法作业-${testInfo.project.name}`;
  await page.getByLabel("任务标题").fill(title);
  await page.getByLabel("任务描述").fill("实现、验证并整理算法笔记");
  await page.getByLabel("预计用时").fill("120");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const card = page
    .locator(".ant-card")
    .filter({ has: page.getByRole("heading", { name: title }) });
  await card.getByRole("button", { name: /^编\s*辑$/ }).click();
  await page.getByLabel("任务标题").fill(`${title}-已编辑`);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `${title}-已编辑` }),
  ).toBeVisible();
  await card.getByRole("button", { name: "移入垃圾箱" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: `${title}-已编辑` }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "垃圾箱", exact: true }).click();
  await page.getByRole("button", { name: "恢复任务" }).click();
  await page.getByRole("button", { name: "我的任务" }).click();
  await expect(
    page.getByRole("heading", { name: `${title}-已编辑` }),
  ).toBeVisible();
  await page.getByRole("link", { name: "日历与课程" }).click();
  await page.getByRole("button", { name: "添加事件", exact: true }).click();
  await page.getByLabel("事件标题").fill(`数据库课-${testInfo.project.name}`);
  await page.getByLabel("开始时间").fill("2026-10-21T09:00");
  await page.getByLabel("结束时间").fill("2026-10-21T10:00");
  await page.getByLabel("地点").fill("教学楼 A101");
  await page.getByRole("button", { name: "确 定" }).click();
  await expect(
    page.getByRole("heading", { name: `数据库课-${testInfo.project.name}` }),
  ).toBeVisible();
  await page
    .locator(".ant-card")
    .filter({
      has: page.getByRole("heading", {
        name: `数据库课-${testInfo.project.name}`,
      }),
    })
    .getByRole("button", { name: "编辑事件" })
    .click();
  await page.getByLabel("地点").fill("教学楼 B202");
  await page.getByRole("button", { name: "确 定" }).click();
  await expect(page.getByText("教学楼 B202").first()).toBeVisible();
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByLabel("显示时区").fill("Asia/Shanghai");
  await page.getByRole("button", { name: "添加时段" }).first().click();
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByText("设置已保存", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("显示时区")).toHaveValue("Asia/Shanghai");
  await expect(page.getByLabel("窗口开始").first()).toHaveValue(/09:00/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
  if (testInfo.project.name === "mobile") {
    for (const input of await page
      .locator('.window-row input[type="time"]')
      .all()) {
      await expect(input).toBeVisible();
      expect(
        await input.evaluate(
          (element) => element.getBoundingClientRect().right,
        ),
      ).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
  }
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-settings.png`,
    fullPage: true,
  });
  if (testInfo.project.name === "mobile") {
    for (const position of [0, 0.5, 1]) {
      await page.evaluate((fraction) => {
        window.scrollTo(0, document.documentElement.scrollHeight * fraction);
      }, position);
      await expect
        .poll(() =>
          page.locator("aside nav a").evaluateAll((links) =>
            links.every((link) => {
              const rect = link.getBoundingClientRect();
              const target = document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              );
              return target !== null && link.contains(target);
            }),
          ),
        )
        .toBe(true);
    }
  }
  await page.getByRole("link", { name: "任务", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `${title}-已编辑` }),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-tasks.png`,
    fullPage: true,
  });
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "退出账号", exact: true }).click();
  await expect(page.getByLabel("用户名")).toBeVisible();
  await page.getByLabel("用户名").fill("student");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page.getByRole("button", { name: /^登\s*录$/ }).click();
  await page.getByRole("link", { name: "任务", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `${title}-已编辑` }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});
