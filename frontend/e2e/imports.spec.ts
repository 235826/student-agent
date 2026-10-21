import { type Page } from "@playwright/test";
import { test, expect } from "./fixtures";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("用户名").fill("student");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page
    .getByRole("button", { name: /^(创建账号并进入|登\s*录)$/ })
    .click();
  await page.getByRole("link", { name: "导入整理" }).click();
}
async function reviewAndPublish(page: Page, count: number) {
  const checks = page.getByRole("checkbox", {
    name: "已核对该条目的标题、日期、时间及关联关系",
  });
  await expect(checks).toHaveCount(count);
  for (let i = 0; i < count; i++) await checks.nth(i).check();
  await page.getByRole("button", { name: "保存校对", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "确认入库", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "确认入库", exact: true }).click();
  await page
    .locator(".ant-popconfirm")
    .getByRole("button", { name: /确\s*定/ })
    .click();
  await expect(
    page.getByText(`已入库 ${count} 项；重复确认不会再次创建。`),
  ).toBeVisible();
}

test("文本解析、校对、确认、来源与重复导入", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  const title = `导入报告-${info.project.name}`;
  await page.getByLabel("导入原文").fill(title);
  await page.getByRole("checkbox", { name: /我同意/ }).check();
  await page.getByRole("button", { name: "保存并解析" }).click();
  await expect(page.getByLabel("条目 1 标题")).toHaveValue(title);
  const tasksBefore = await (await page.request.get("/api/v1/tasks")).json();
  expect(tasksBefore.some((t: { title: string }) => t.title === title)).toBe(
    false,
  );
  await page.getByLabel("条目 1 标题").fill(title + "-校对");
  await reviewAndPublish(page, 1);
  await page.getByRole("button", { name: "保存并解析" }).click();
  await expect(
    page.getByText("已入库 1 项；重复确认不会再次创建。"),
  ).toBeVisible();
  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  expect(
    tasks.filter((t: { title: string }) => t.title === title + "-校对"),
  ).toHaveLength(1);
  await page.getByRole("link", { name: "任务", exact: true }).click();
  const card = page
    .locator(".ant-card")
    .filter({ has: page.getByRole("heading", { name: title + "-校对" }) });
  await card.getByRole("button", { name: "查看来源" }).click();
  await expect(
    page.getByRole("dialog").getByText(title, { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("课表图片三条课程、确认与移动端布局", async ({ page }, info) => {
  await login(page);
  // A synthetic screenshot exercises multipart upload; the local HTTP fixture supplies draft data.
  const image = await page
    .getByRole("heading", { name: "先整理，再确认" })
    .screenshot();
  const prefix = `图片导入-${info.project.name}`;
  await page.getByLabel("课表图片", { exact: true }).setInputFiles({
    name: "timetable.png",
    mimeType: "image/png",
    buffer: image,
  });
  await page.getByLabel("补充说明", { exact: true }).fill(prefix);
  await page.getByRole("checkbox", { name: /我同意/ }).check();
  await page.getByRole("button", { name: "保存并解析" }).click();
  await expect(page.getByLabel("条目 3 标题")).toHaveValue(prefix + "-课程2");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/${info.project.name}-import-preview.png`,
    fullPage: true,
  });
  await reviewAndPublish(page, 3);
  const events = await (await page.request.get("/api/v1/events")).json();
  expect(
    events.filter((e: { title: string }) => e.title.startsWith(prefix)),
  ).toHaveLength(3);
});

test("模型失败后可手动补全草稿", async ({ page }, info) => {
  await login(page);
  await page.getByLabel("导入原文").fill(`E2E_FAIL-${info.project.name}`);
  await page.getByRole("checkbox", { name: /我同意/ }).check();
  await page.getByRole("button", { name: "保存并解析" }).click();
  await expect(page.getByText("模型接口返回 HTTP 400")).toBeVisible();
  await page.getByRole("button", { name: "添加条目" }).click();
  await page.getByLabel("条目 1 标题").fill(`手动补全-${info.project.name}`);
  await reviewAndPublish(page, 1);
});
