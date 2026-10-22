import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("用户名").fill("student");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page
    .getByRole("button", { name: /^(创建账号并进入|登\s*录)$/ })
    .click();
  await expect(page.getByRole("heading", { name: "今日工作台" })).toBeVisible();
  const auth = await (await page.request.get("/api/v1/auth/me")).json();
  return { "X-CSRF-Token": auth.csrf_token, Origin: "http://127.0.0.1:5173" };
}

test("空标题草稿、正式任务校验与关系跳转", async ({ page }) => {
  const headers = await login(page);
  await page.getByRole("link", { name: "新建任务", exact: true }).click();
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(
    page.getByText("创建任务必须填写标题", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await (await page.request.get("/api/v1/tasks")).json()).toEqual([]);
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(
    page.getByRole("heading", { name: "未命名草稿", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "编辑草稿", exact: true }).click();
  await page.getByLabel("任务标题").fill("父任务");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.getByRole("button", { name: "发布任务", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "父任务", exact: true }),
  ).not.toBeVisible();
  const [parent] = await (await page.request.get("/api/v1/tasks")).json();
  const childTitle = "子任务" + "很长的任务名称".repeat(20);
  const response = await page.request.post("/api/v1/tasks", {
    headers,
    data: {
      title: childTitle,
      parent_id: parent.id,
      predecessor_ids: [parent.id],
    },
  });
  expect(response.status()).toBe(201);
  const child = await response.json();
  await page.goto(`/tasks/${child.id}`);
  await expect(
    page
      .locator(".ant-alert")
      .getByRole("link", { name: "父任务", exact: true }),
  ).toBeVisible();
  await page
    .locator(".ant-alert")
    .getByRole("link", { name: "父任务", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${parent.id}(\\?|$)`));
  await page.reload();
  await page.getByRole("link", { name: childTitle, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${child.id}(\\?|$)`));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("系列批量修改、事件删除与空课程清理", async ({ page }) => {
  const headers = await login(page);
  const course = await (
    await page.request.post("/api/v1/courses", {
      headers,
      data: { name: "可清理课程" },
    })
  ).json();
  const response = await page.request.post("/api/v1/event-series", {
    headers,
    data: {
      course_id: course.id,
      start_date: "2030-01-07",
      end_date: "2030-01-14",
      weekdays: [0],
      start_time: "09:00",
      end_time: "10:00",
      timezone: "Asia/Shanghai",
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const series = await response.json();
  await page.goto(`/calendar/courses/${course.id}`);
  await expect(
    page.getByText("删除课程前需要先清理", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "删除课程", exact: true }),
  ).toBeDisabled();
  await page.goto(`/series/${series.id}`);
  await page.getByLabel("上课地点").fill("新教室");
  await page.getByRole("button", { name: "批量保存", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const events = await (await page.request.get("/api/v1/events")).json();
  expect(
    events.every((event: { location: string }) => event.location === "新教室"),
  ).toBe(true);
  await page.locator(".instance-list a").first().click();
  await page.getByRole("button", { name: "删除事件", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(page).toHaveURL(/\/calendar\/series\//);
  await page.getByRole("link", { name: "所属课程", exact: true }).click();
  await page.getByRole("link", { name: /起 · 1 次课程/ }).click();
  await page.getByRole("button", { name: "删除系列", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(page).toHaveURL(/\/calendar\/courses\//);
  await page.getByRole("button", { name: "删除课程", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(page).toHaveURL(/\/calendar$/);
  expect(await (await page.request.get("/api/v1/courses")).json()).toEqual([]);
  expect(await (await page.request.get("/api/v1/events")).json()).toEqual([]);
});

test("兼容性检查默认隐藏过去事件", async ({ page }) => {
  const headers = await login(page);
  for (const [title, start_at, end_at] of [
    ["过去事件", "2000-01-01T09:00:00Z", "2000-01-01T10:00:00Z"],
    ["未来事件", "2030-01-01T09:00:00Z", "2030-01-01T10:00:00Z"],
  ]) {
    const response = await page.request.post("/api/v1/events", {
      headers,
      data: { title, start_at, end_at, timezone: "Asia/Shanghai" },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/settings/rules?tab=check");
  await page.getByRole("combobox", { name: "选择待检查活动" }).click();
  await expect(
    page.locator(".ant-select-item-option").filter({ hasText: "未来事件" }),
  ).toBeVisible();
  await expect(
    page.locator(".ant-select-item-option").filter({ hasText: "过去事件" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("checkbox", { name: "包含过去事件" }).check();
  await page.getByRole("combobox", { name: "选择待检查活动" }).click();
  await expect(
    page.locator(".ant-select-item-option").filter({ hasText: "过去事件" }),
  ).toBeVisible();
});

test("事件备注范围、课程重命名与周次 URL", async ({ page }) => {
  const headers = await login(page);
  const course = await (
    await page.request.post("/api/v1/courses", {
      headers,
      data: { name: "备注课程" },
    })
  ).json();
  const response = await page.request.post("/api/v1/event-series", {
    headers,
    data: {
      course_id: course.id,
      start_date: "2030-01-07",
      end_date: "2030-01-14",
      weekdays: [0],
      start_time: "09:00",
      end_time: "10:00",
      timezone: "Asia/Shanghai",
      note: "系列备注",
      details: "系列详情",
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const series = await response.json();
  const first = series.event_ids[0];

  await page.goto(`/calendar?week=2030-01-07`);
  await expect(page.getByText("系列备注").first()).toBeVisible();

  await page.goto(`/events/${first}?week=2030-01-07`);
  await expect(page.getByText("系列备注").first()).toBeVisible();
  await expect(page.getByText("系列详情").first()).toBeVisible();
  await page.getByRole("button", { name: "编辑事件", exact: true }).click();
  const noteScope = page
    .locator(".ant-form-item")
    .filter({ hasText: "备注应用范围" });
  await noteScope.getByText("仅本次").click();
  await page.getByLabel("备注（短，显示在卡片和日历）").fill("单次备注");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(page.getByText("系列备注；单次备注").first()).toBeVisible();
  await page.getByRole("link", { name: "返回日历", exact: true }).click();
  await expect(page).toHaveURL(/\/calendar\?week=2030-01-07$/);

  await page.request.put(`/api/v1/courses/${course.id}`, {
    headers,
    data: { name: "改名课程" },
  });
  await page.goto(`/events/${first}?week=2030-01-07`);
  await expect(page.getByText("改名课程").first()).toBeVisible();
  await expect(page.getByText("系列备注；单次备注").first()).toBeVisible();
});


test("今日新建事件继承日期并在表单内联新建课程", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "新建事件", exact: true }).click();
  await expect(page).toHaveURL(/\/calendar\/events\/new\?date=/);
  const start = page.getByLabel("开始时间");
  await expect(start).not.toHaveValue("");
  await expect(page.getByLabel("结束时间")).not.toHaveValue("");
  await page.getByRole("button", { name: "新建课程", exact: true }).click();
  await page.getByLabel("课程名称").fill("内联课程");
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(page.getByLabel("事件标题")).toBeVisible();
  await expect(
    page.getByText("内联课程", { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("事件标题").fill("内联课程事件");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^确\s*定$/ })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("link", { name: "日历与课程" }).click();
  await expect(
    page.getByRole("heading", { name: "内联课程事件", exact: true }),
  ).toBeVisible();
});
