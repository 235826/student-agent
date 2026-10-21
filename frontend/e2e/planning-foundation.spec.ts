import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";

async function choose(page: Page, label: string, option: string) {
  await page
    .locator(".ant-select")
    .filter({ has: page.getByRole("combobox", { name: label }) })
    .click();
  await page
    .locator(".ant-select-dropdown:visible .ant-select-item-option")
    .filter({ hasText: option })
    .first()
    .click();
}

test("草稿发布、重复课程单次变更与规则检查", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const title = `阅读计划-${info.project.name}`;
  const course = `阅读课程-${info.project.name}`;
  await page.goto("/");
  await page.getByLabel("用户名").fill("student");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page
    .getByRole("button", { name: /^(创建账号并进入|登\s*录)$/ })
    .click();
  await page.getByRole("link", { name: "任务", exact: true }).click();
  await page.getByRole("button", { name: "新建草稿", exact: true }).click();
  await page.getByLabel("任务标题").fill(title);
  await page
    .getByLabel("任务类型（可选）", { exact: true })
    .fill(`reading-${info.project.name}`);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await page.getByRole("button", { name: /^草\s*稿$/ }).click();
  const draft = page
    .locator(".ant-card")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await draft.getByRole("button", { name: "发布任务" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await page.getByRole("button", { name: "我的任务" }).click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "课表 / 事件" }).click();
  await page.getByRole("button", { name: "添加课程", exact: true }).click();
  await page.getByLabel("课程名称").fill(course);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(page.getByText(course, { exact: true })).toBeVisible();
  await choose(page, `${course}默认并行设置`, "接受已允许的组合");
  await page.getByRole("button", { name: "建立重复课表" }).click();
  await choose(page, "选择课程", course);
  await page.getByLabel("起始日期").fill("2026-11-02");
  await page.getByLabel("结束日期").fill("2026-11-09");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  const events = page
    .locator(".ant-card")
    .filter({ has: page.getByRole("heading", { name: course, exact: true }) });
  await expect(events).toHaveCount(2);
  await events.first().getByRole("button", { name: "本次不参加" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(
    events.first().getByRole("button", { name: "恢复参加" }),
  ).toBeVisible();
  await expect(
    events.last().getByRole("button", { name: "本次不参加" }),
  ).toBeVisible();
  await events.first().getByRole("button", { name: "恢复参加" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(
    events.first().getByRole("button", { name: "本次不参加" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "并行规则", exact: true }).click();
  await page.getByLabel("任务类型").fill(`reading-${info.project.name}`);
  await choose(page, "类型默认设置", "接受已允许的组合");
  await page.getByRole("button", { name: "保存类型设置" }).click();
  await expect(
    page.getByRole("button", {
      name: `reading-${info.project.name}：接受选定组合`,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "添加组合规则" }).click();
  await choose(page, "活动一对象", course);
  await page.getByLabel("活动二对象").fill(`reading-${info.project.name}`);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(
    page.getByRole("heading", {
      name: `${course} ＋ 类型：reading-${info.project.name}`,
    }),
  ).toBeVisible();
  await choose(page, "选择待检查活动", `任务：${title}`);
  await page.keyboard.press("Escape");
  await choose(page, "选择待检查活动", `事件：${course}`);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "检查兼容性" }).click();
  await expect(page.getByText("所有两两组合均通过")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/${info.project.name}-rules.png`,
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: `${course} ＋ 类型：reading-${info.project.name}`,
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
