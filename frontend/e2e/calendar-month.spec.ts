import { DateTime } from "luxon";
import { test, expect } from "./fixtures";
import { login } from "./support";

test("月视图同步整月列表、跨年导航和详情返回", async ({ page }) => {
  const headers = await login(page);
  for (const [title, date] of [
    ["上月安排", "2029-12-31"],
    ["月初安排", "2030-01-01"],
    ["月末安排", "2030-01-30"],
    ["下月安排", "2030-02-01"],
  ]) {
    const response = await page.request.post("/api/v1/events", {
      headers,
      data: {
        title,
        start_at: `${date}T09:00:00+08:00`,
        end_at: `${date}T10:00:00+08:00`,
      },
    });
    expect(response.ok()).toBeTruthy();
  }
  await page.goto("/calendar?week=2030-01-15&view=dayGridMonth");
  await expect(page.locator(".fc-toolbar-title")).toHaveText("2030年1月");
  await expect(page).toHaveURL(/week=2030-01-01&view=dayGridMonth$/);
  const rows = page.locator(".event-row");
  await expect(rows).toHaveCount(2);
  await expect(rows).toContainText(["月初安排", "月末安排"]);
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await page
    .locator(".fc-daygrid-event")
    .filter({ hasText: "月末安排" })
    .click();
  await expect(page).toHaveURL(/\/calendar\/events\//);
  await page.getByRole("link", { name: "返回日历", exact: true }).click();
  await expect(page).toHaveURL(url);
  await expect(page.locator(".fc-dayGridMonth-view")).toBeVisible();
  await page.locator(".fc-next-button").click();
  await expect(page).toHaveURL(/week=2030-02-01&view=dayGridMonth$/);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("下月安排");
  await page.locator(".fc-next-button").click();
  await expect(page.getByText("本月没有事件", { exact: true })).toBeVisible();
  await page.locator(".fc-prev-button").click();
  await page.locator(".fc-prev-button").click();
  await page.locator(".fc-prev-button").click();
  await expect(page.locator(".fc-toolbar-title")).toHaveText("2029年12月");
  await expect(page).toHaveURL(/week=2029-12-01&view=dayGridMonth$/);
  await page.getByRole("button", { name: "周", exact: true }).click();
  await expect(page.locator(".fc-timeGridWeek-view")).toBeVisible();
  await page.getByRole("button", { name: "月", exact: true }).click();
  await expect(page.locator(".fc-dayGridMonth-view")).toBeVisible();
});

test("月视图折叠密集安排并按日期新建事件", async ({ page }) => {
  const headers = await login(page);
  for (let index = 0; index < 5; index++) {
    const response = await page.request.post("/api/v1/events", {
      headers,
      data: {
        title: `当天安排${index}：${"完整标题".repeat(6)}`,
        start_at: `2030-01-15T${String(9 + index).padStart(2, "0")}:00:00+08:00`,
        end_at: `2030-01-15T${String(10 + index).padStart(2, "0")}:00:00+08:00`,
        note: "当天安排的详细备注",
      },
    });
    expect(response.ok()).toBeTruthy();
  }
  await page.goto("/calendar?week=2030-01-01&view=dayGridMonth");
  await page.getByText(/还有 \d+ 项/).click();
  await expect(page.locator(".fc-more-popover .fc-event-title")).toHaveCount(5);
  await expect(
    page.locator(".fc-more-popover .fc-event-note").first(),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("month-popover.png"),
    fullPage: true,
  });
  await page.locator(".fc-popover-close").click();
  await page
    .getByRole("button", { name: "在2030-01-20新建事件", exact: true })
    .click();
  await expect(page.getByLabel("开始时间")).toHaveValue("2030-01-20T09:00");
  await expect(page.getByLabel("结束时间")).toHaveValue("2030-01-20T10:00");
  await page.getByLabel("事件标题").fill("从月视图新增");
  await page.getByRole("button", { name: "保存事件", exact: true }).click();
  await expect(
    page.locator(".event-row").filter({ hasText: "从月视图新增" }),
  ).toBeVisible();
  await expect(page.locator(".fc-dayGridMonth-view")).toBeVisible();
});

test("月视图展示已采用的计划块并保留任务返回路径", async ({ page }) => {
  const headers = await login(page);
  const day = DateTime.now()
    .setZone("Asia/Shanghai")
    .plus({ days: 3 })
    .startOf("day");
  await page.request.put("/api/v1/profile", {
    headers,
    data: {
      timezone: "Asia/Shanghai",
      available_windows: [
        { weekday: day.weekday - 1, start: "09:00", end: "12:00" },
      ],
      rest_windows: [],
    },
  });
  const taskResponse = await page.request.post("/api/v1/tasks", {
    headers,
    data: {
      title: "月度计划任务",
      estimate_minutes: 30,
    },
  });
  expect(taskResponse.ok()).toBeTruthy();
  const task = await taskResponse.json();
  const response = await page.request.post("/api/v1/plans", {
    headers,
    data: {
      start_at: day.set({ hour: 9 }).toISO(),
      end_at: day.set({ hour: 12 }).toISO(),
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(response.ok()).toBeTruthy();
  const plan = await response.json();
  expect(plan.blocks).toHaveLength(1);
  const adopted = await page.request.post(`/api/v1/plans/${plan.id}/adopt`, {
    headers,
    data: { confirmed: true },
  });
  expect(adopted.ok()).toBeTruthy();
  await page.goto(
    `/calendar?week=${day.startOf("month").toISODate()}&view=dayGridMonth`,
  );
  const url = page.url();
  await page
    .locator(".fc-daygrid-event")
    .filter({ hasText: "月度计划任务" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}\\?from=`));
  await page.getByRole("link", { name: /返回/ }).first().click();
  await expect(page).toHaveURL(url);
  await expect(page.locator(".fc-dayGridMonth-view")).toBeVisible();
});
