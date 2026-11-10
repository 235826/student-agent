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
  await page
    .locator(".calendar-filters")
    .getByText("仅课程", { exact: true })
    .click();
  await expect(page.locator(".fc-daygrid-event")).toHaveCount(0);
  await page
    .locator(".calendar-filters")
    .getByText("隐藏课程", { exact: true })
    .click();
  await expect(page.locator(".fc-daygrid-event")).toHaveCount(1);
  const url = page.url();
  await page
    .locator(".fc-daygrid-event")
    .filter({ hasText: "月度计划任务" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}\\?from=`));
  await page.getByRole("link", { name: /返回/ }).first().click();
  await expect(page).toHaveURL(url);
  await expect(page.locator(".fc-dayGridMonth-view")).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "隐藏课程", exact: true }),
  ).toBeChecked();
});

test("日历统一时间格式并同步课程筛选与返回状态", async ({ page }) => {
  const headers = await login(page);
  const courseResponse = await page.request.post("/api/v1/courses", {
    headers,
    data: { name: "筛选测试课程" },
  });
  expect(courseResponse.ok()).toBeTruthy();
  const course = await courseResponse.json();
  const seriesResponse = await page.request.post("/api/v1/event-series", {
    headers,
    data: {
      course_id: course.id,
      start_date: "2030-01-07",
      end_date: "2030-01-07",
      weekdays: [0],
      start_time: "08:00",
      end_time: "09:00",
      timezone: "Asia/Shanghai",
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(seriesResponse.ok()).toBeTruthy();
  for (const event of [
    {
      title: "独立课程",
      kind: "course",
      course_id: course.id,
      time: "14:00",
      end: "15:00",
    },
    {
      title: "个人复习",
      kind: "other",
      course_id: null,
      time: "18:30",
      end: "19:30",
    },
  ]) {
    const { time, end, ...data } = event;
    const response = await page.request.post("/api/v1/events", {
      headers,
      data: {
        ...data,
        start_at: `2030-01-07T${time}:00+08:00`,
        end_at: `2030-01-07T${end}:00+08:00`,
      },
    });
    expect(response.ok()).toBeTruthy();
  }
  await page.goto("/calendar?week=2030-01-01&view=dayGridMonth");
  await expect(page.locator(".fc-daygrid-event .fc-event-time")).toHaveText([
    "08:00",
    "14:00",
    "18:30",
  ]);
  await expect(page.locator(".event-row")).toHaveCount(3);
  await page
    .locator(".calendar-filters")
    .getByText("仅课程", { exact: true })
    .click();
  await expect(page).toHaveURL(/content=courses/);
  await expect(page.locator(".fc-daygrid-event")).toHaveCount(2);
  await expect(page.locator(".event-row")).toHaveCount(2);
  await page.getByRole("button", { name: "周", exact: true }).click();
  await page.locator(".fc-next-button").click();
  await expect(
    page.locator(".fc-timegrid-event .fc-event-time").first(),
  ).toContainText("08:00");
  await expect(
    page
      .locator(".fc-timegrid-slot-label-cushion")
      .filter({ hasText: /^08:00$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "列表", exact: true }).click();
  await expect(page.locator(".fc-list-event")).toHaveCount(2);
  await expect(page.locator(".fc-list-event-time").first()).toContainText(
    "08:00",
  );
  await page
    .locator(".calendar-filters")
    .getByText("隐藏课程", { exact: true })
    .click();
  await expect(page.locator(".fc-list-event")).toHaveCount(1);
  await expect(page.locator(".fc-list-event-time")).toContainText("18:30");
  await expect(page.locator(".event-row")).toHaveCount(1);
  await page.getByRole("button", { name: "月", exact: true }).click();
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(
    page.getByRole("radio", { name: "隐藏课程", exact: true }),
  ).toBeChecked();
  await expect(page.locator(".fc-daygrid-event")).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("calendar-filter.png"),
    fullPage: true,
  });
  await page.locator(".fc-daygrid-event").click();
  await page.getByRole("link", { name: "返回日历", exact: true }).click();
  await expect(page).toHaveURL(url);
  await expect(
    page.getByRole("radio", { name: "隐藏课程", exact: true }),
  ).toBeChecked();
  await page.locator(".fc-next-button").click();
  await expect(
    page.getByText("当前筛选下暂无安排", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".calendar-filters")
    .getByText("全部", { exact: true })
    .click();
  await expect(page).not.toHaveURL(/content=/);
  await page.locator(".fc-prev-button").click();
  await expect(page.locator(".fc-daygrid-event")).toHaveCount(3);
});
