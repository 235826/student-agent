import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { DateTime } from "luxon";
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("用户名").fill("student");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page
    .getByRole("button", { name: /^(创建账号并进入|登\s*录)$/ })
    .click();
  await expect(page.getByRole("heading", { name: "今天", exact: true })).toBeVisible();
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
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("草稿已保存到收件箱")).toBeVisible();
  await page.getByRole("link", { name: "收件箱", exact: true }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(
    page.getByRole("heading", { name: "未命名草稿", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "编辑任务草稿", exact: true }).click();
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
  await page.getByRole("button", { name: "删除每周课程", exact: true }).click();
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
  const futureStart = DateTime.now()
    .setZone("Asia/Shanghai")
    .plus({ days: 30 })
    .startOf("hour");
  const futureEnd = futureStart.plus({ hours: 1 });
  for (const [title, start_at, end_at] of [
    ["过去事件", "2000-01-01T09:00:00Z", "2000-01-01T10:00:00Z"],
    ["未来事件", futureStart.toISO()!, futureEnd.toISO()!],
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
  await page.getByRole("checkbox", { name: "包含过去事件" }).click();
  await expect(page).toHaveURL(/tab=check/);
  await expect(page).toHaveURL(/past=1/);
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "包含过去事件" }),
  ).toBeChecked();
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
  await expect(page).toHaveURL(/view=(timeGridWeek|listWeek)/);
  const calendarUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(calendarUrl);

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
  await expect(page).toHaveURL(
    /\/calendar\?week=2030-01-07(&view=(timeGridWeek|listWeek))?$/,
  );

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
  await page.getByRole("link", { name: "日历", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "内联课程事件", exact: true }),
  ).toBeVisible();
});

test("清单创建、任务归类、筛选与完成历史", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "任务", exact: true }).click();
  await page.getByRole("button", { name: "管理清单", exact: true }).click();
  await page.getByLabel("新清单名称").fill("课程");
  await page.getByRole("button", { name: "创建清单", exact: true }).click();
  await expect(page.getByText("清单已创建")).toBeVisible();
  await page.locator(".ant-modal-close").click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("任务标题").fill("清单任务");
  await page.getByRole("combobox", { name: "标签", exact: true }).click();
  await page.getByRole("combobox", { name: "标签", exact: true }).fill("数学");
  await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "标签", exact: true }).fill("阅读");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "所属清单" }).click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
    .filter({ hasText: "课程" })
    .click();
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const card = page
    .locator(".ant-card")
    .filter({ has: page.getByRole("heading", { name: "清单任务" }) });
  await expect(card.getByText("课程", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("任务标题").fill("收件箱任务");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "收件箱任务" })).toBeVisible();

  await card.getByText("课程", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "清单任务" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "收件箱任务" }),
  ).not.toBeVisible();
  await card.getByText("课程", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "收件箱任务" })).toBeVisible();

  await expect(card.getByText("数学", { exact: true })).toBeVisible();
  await expect(card.getByText("阅读", { exact: true })).toBeVisible();
  await card.getByText("数学", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "收件箱任务" }),
  ).not.toBeVisible();
  await card.getByText("数学", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "收件箱任务" })).toBeVisible();

  await page.getByLabel("完成 清单任务").click();
  await expect(page.getByText("已完成“清单任务”")).toBeVisible();
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  await expect(page.getByRole("heading", { name: "清单任务" })).toBeVisible();

  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  const task = tasks.find((item: { title: string }) => item.title === "清单任务");
  expect(task.status).toBe("done");
  expect(task.completed_at).not.toBeNull();
  const lists = await (await page.request.get("/api/v1/task-lists")).json();
  expect(task.list_id).toBe(lists[0].id);
});

test("批量选择并完成任务", async ({ page }) => {
  const headers = await login(page);
  for (const title of ["批量任务A", "批量任务B"]) {
    const response = await page.request.post("/api/v1/tasks", {
      headers,
      data: { title },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/tasks");
  await page.getByRole("button", { name: "批量操作", exact: true }).click();
  await page.getByLabel("选择 批量任务A").check();
  await page.getByLabel("选择 批量任务B").check();
  const complete = page.getByRole("button", { name: /^完\s*成$/ });
  await expect(complete).toBeEnabled();
  await complete.click();
  await expect(page.getByText("已处理 2 项")).toBeVisible();

  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  const selected = tasks.filter((task: { title: string }) =>
    ["批量任务A", "批量任务B"].includes(task.title),
  );
  expect(selected).toHaveLength(2);
  expect(selected.every((task: { status: string }) => task.status === "done")).toBe(
    true,
  );

  await page.getByRole("button", { name: /^撤\s*销$/ }).click();
  await expect(page.getByText("已撤销批量操作")).toBeVisible();
  await expect
    .poll(async () => {
      const items = await (await page.request.get("/api/v1/tasks")).json();
      return items
        .filter((task: { title: string }) =>
          ["批量任务A", "批量任务B"].includes(task.title),
        )
        .every((task: { status: string }) => task.status === "todo");
    })
    .toBe(true);
});

test("完成统计展示今日、估时与实耗", async ({ page }) => {
  const headers = await login(page);
  const created = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "统计任务", estimate_minutes: 90 },
  });
  expect(created.status()).toBe(201);
  const task = await created.json();
  expect(
    (
      await page.request.post(`/api/v1/tasks/${task.id}/complete`, {
        headers,
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await page.request.post(`/api/v1/tasks/${task.id}/worklogs`, {
        headers,
        data: { actual_minutes: 45 },
      })
    ).status(),
  ).toBe(201);

  await page.getByRole("link", { name: "统计", exact: true }).click();
  await expect(page).toHaveURL(/\/stats$/);
  await expect(
    page.getByRole("heading", { name: "完成统计" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".ant-statistic")
      .filter({ hasText: "今天完成" })
      .getByText("1", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".ant-statistic")
      .filter({ hasText: "预计用时（分钟）" })
      .getByText("90", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".ant-statistic")
      .filter({ hasText: "实际用时（分钟）" })
      .getByText("45", { exact: true }),
  ).toBeVisible();
});

test("PWA 资源与离线提示", async ({ page }) => {
  await login(page);
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect((await manifest.json()).name).toBe("Student Agent");
  const worker = await page.request.get("/sw.js");
  expect(worker.status()).toBe(200);

  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(
    page.getByText("当前处于离线状态，部分数据可能无法加载。"),
  ).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(
    page.getByText("当前处于离线状态，部分数据可能无法加载。"),
  ).not.toBeVisible();
});

test("任务快速查看抽屉", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "drawer is desktop-only");
  const headers = await login(page);
  const created = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "抽屉任务" },
  });
  expect(created.status()).toBe(201);
  const task = await created.json();
  await page.goto("/tasks");
  await page.getByRole("button", { name: "快速查看", exact: true }).click();

  const drawer = page.locator(".ant-drawer-content");
  await expect(
    drawer.getByRole("heading", { name: "抽屉任务" }),
  ).toBeVisible();
  await expect(
    page.locator(".task-card").filter({ hasText: "抽屉任务" }),
  ).toBeVisible();

  await drawer.getByRole("button", { name: "打开完整详情", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}(\\?|$)`));
  await expect(
    page.locator(".task-card").getByRole("heading", { name: "抽屉任务" }),
  ).toBeVisible();
});

test("任务快速查看关闭后保留筛选 URL", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "drawer is desktop-only");
  const headers = await login(page);
  const created = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "抽屉筛选任务" },
  });
  expect(created.status()).toBe(201);
  await page.goto("/tasks");
  const search = page.getByLabel("搜索任务");
  await search.fill("抽屉筛选");
  await expect(page).toHaveURL(/[?&]q=/);
  await page.getByRole("button", { name: "快速查看", exact: true }).click();
  const drawer = page.locator(".ant-drawer-content");
  await expect(
    drawer.getByRole("heading", { name: "抽屉筛选任务" }),
  ).toBeVisible();
  await page.locator(".ant-drawer-close").click();
  await expect(page).toHaveURL(/[?&]q=/);
  await expect(search).toHaveValue("抽屉筛选");
  await expect(
    page.locator(".task-card").filter({ hasText: "抽屉筛选任务" }),
  ).toBeVisible();
});

test("批量改期、添加标签与撤销", async ({ page }) => {
  const headers = await login(page);
  for (const title of ["批量改期A", "批量改期B"]) {
    const response = await page.request.post("/api/v1/tasks", {
      headers,
      data: { title },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/tasks");
  await page.getByRole("button", { name: "批量操作", exact: true }).click();
  await page.getByLabel("选择 批量改期A").check();
  await page.getByLabel("选择 批量改期B").check();
  const bar = page.locator(".ant-card").filter({ hasText: "已选 2 项" });
  await bar.getByRole("button", { name: /^改\s*期$/ }).click();
  await page
    .locator(".ant-dropdown-menu-item")
    .filter({ hasText: "明天" })
    .click();
  await expect(page.getByText("已处理 2 项")).toBeVisible();
  await expect
    .poll(async () => {
      const tasks = await (await page.request.get("/api/v1/tasks")).json();
      return tasks
        .filter((task: { title: string }) =>
          ["批量改期A", "批量改期B"].includes(task.title),
        )
        .every((task: { deadline_all_day: boolean }) => task.deadline_all_day);
    })
    .toBe(true);

  await page.getByLabel("选择 批量改期A").check();
  await page.getByLabel("选择 批量改期B").check();
  await bar.getByRole("button", { name: /^标\s*签$/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").click();
  await dialog.getByRole("combobox").fill("批量标签");
  await page.keyboard.press("Enter");
  await dialog.getByText("批量标签", { exact: true }).first().click();
  await dialog
    .getByRole("button", { name: "添加标签", exact: true })
    .click();
  await expect(page.getByText("已处理 2 项").last()).toBeVisible();
  await expect
    .poll(async () => {
      const tasks = await (await page.request.get("/api/v1/tasks")).json();
      return tasks
        .filter((task: { title: string }) =>
          ["批量改期A", "批量改期B"].includes(task.title),
        )
        .every((task: { tags: string[] }) => task.tags.includes("批量标签"));
    })
    .toBe(true);

  await page.getByRole("button", { name: /^撤\s*销$/ }).last().click();
  await expect(page.getByText("已撤销批量操作")).toBeVisible();
  await expect
    .poll(async () => {
      const tasks = await (await page.request.get("/api/v1/tasks")).json();
      return tasks
        .filter((task: { title: string }) =>
          ["批量改期A", "批量改期B"].includes(task.title),
        )
        .every((task: { tags: string[] }) => !task.tags.includes("批量标签"));
    })
    .toBe(true);
});

test("垃圾箱永久删除与清空", async ({ page }) => {
  const headers = await login(page);
  const created: { id: string }[] = [];
  for (const title of ["永久删除A", "永久删除B"]) {
    const response = await page.request.post("/api/v1/tasks", {
      headers,
      data: { title },
    });
    expect(response.status()).toBe(201);
    created.push(await response.json());
  }
  for (const task of created) {
    expect(
      (
        await page.request.post(`/api/v1/tasks/${task.id}/trash`, {
          headers,
        })
      ).status(),
    ).toBe(200);
  }
  await page.goto("/tasks");
  await page.getByRole("button", { name: "垃圾箱", exact: true }).click();
  const card = page
    .locator(".task-card")
    .filter({ hasText: "永久删除A" });
  await card.getByRole("button", { name: "永久删除", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "永久删除", exact: true })
    .click();
  await expect(page.getByText("任务已永久删除")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "永久删除A" }),
  ).not.toBeVisible();

  await page.getByRole("button", { name: "清空垃圾箱", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "清空垃圾箱", exact: true })
    .click();
  await expect(page.getByText(/已永久删除 1 项/)).toBeVisible();
  expect(
    await (
      await page.request.get("/api/v1/tasks?trashed=true")
    ).json(),
  ).toEqual([]);
});

test("附件图片预览", async ({ page }) => {
  const headers = await login(page);
  const created = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "预览任务" },
  });
  expect(created.status()).toBe(201);
  const task = await created.json();
  await page.goto(`/tasks/${task.id}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.getByText("pixel.png", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^预\s*览$/ }).click();
  const image = page.locator(".attachment-preview-image");
  await expect(image).toBeVisible();
  expect(await image.getAttribute("src")).toContain("?inline=true");
});

test("任务附件上传、下载链接与删除", async ({ page }) => {
  const headers = await login(page);
  const created = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "附件任务" },
  });
  expect(created.status()).toBe(201);
  const task = await created.json();
  await page.goto(`/tasks/${task.id}`);
  await expect(
    page.getByRole("heading", { name: "附件任务" }),
  ).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect(page.getByText("附件已上传")).toBeVisible();
  await expect(page.getByText("note.txt", { exact: true })).toBeVisible();
  const download = page.getByRole("link", { name: "下载", exact: true }).first();
  expect(await download.getAttribute("href")).toMatch(
    /\/api\/v1\/attachments\//,
  );

  const attachmentCard = page.locator(".ant-card").filter({ hasText: "附件" });
  await attachmentCard
    .getByRole("button", { name: /^删\s*除$/ })
    .click();
  await page
    .locator(".ant-popconfirm")
    .getByRole("button", { name: /^删\s*除$/ })
    .click();
  await expect(page.getByText("附件已删除")).toBeVisible();
  await expect(page.getByText("note.txt", { exact: true })).not.toBeVisible();
  expect(
    await (
      await page.request.get(`/api/v1/tasks/${task.id}/attachments`)
    ).json(),
  ).toEqual([]);
});

test("任务链接保存与展示", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "任务", exact: true }).click();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("任务标题").fill("资料任务");
  await page
    .getByLabel("相关链接")
    .fill("https://example.com/a\nhttps://example.org/b");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  const card = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: "资料任务" }) });
  await expect(card.locator('a[href="https://example.com/a"]')).toBeVisible();
  await expect(card.locator('a[href="https://example.org/b"]')).toBeVisible();

  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  const task = tasks.find(
    (item: { title: string }) => item.title === "资料任务",
  );
  expect(task.links).toEqual([
    "https://example.com/a",
    "https://example.org/b",
  ]);
});

test("重复任务支持间隔与工作日选项", async ({ page }) => {
  await login(page);
  const auth = await (await page.request.get("/api/v1/auth/me")).json();
  const zone = auth.user.timezone;
  const deadline = DateTime.now()
    .setZone(zone)
    .plus({ days: 2 })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toFormat("yyyy-MM-dd'T'HH:mm");

  await page.getByRole("link", { name: "任务", exact: true }).click();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("任务标题").fill("双周任务");
  await page.getByLabel(/截止时间/).fill(deadline);
  const recurrence = page
    .locator(".ant-select")
    .filter({ has: page.getByRole("combobox", { name: "重复", exact: true }) });
  await recurrence.click();
  await page.getByTitle("每周").click();
  await page.getByLabel(/重复间隔/).fill("2");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  const card = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: "双周任务" }) });
  await expect(card.getByText(/重复：每 2 周/)).toBeVisible();
  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  const task = tasks.find(
    (item: { title: string }) => item.title === "双周任务",
  );
  expect(task.recurrence).toBe("weekly");
  expect(task.recurrence_interval).toBe(2);
});

test("重复任务完成后生成下一次并可撤销", async ({ page }) => {
  const headers = await login(page);
  const auth = await (await page.request.get("/api/v1/auth/me")).json();
  const zone = auth.user.timezone;
  const due = DateTime.now()
    .setZone(zone)
    .plus({ days: 2 })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toISO();
  const response = await page.request.post("/api/v1/tasks", {
    headers,
    data: {
      title: "每日任务",
      recurrence: "daily",
      deadline_at: due,
      tags: ["习惯"],
    },
  });
  expect(response.status()).toBe(201);
  await page.goto("/tasks");
  await expect(
    page.getByRole("heading", { name: "每日任务" }),
  ).toBeVisible();
  await page.getByLabel("完成 每日任务").click();
  await expect(page.getByText(/下一次已生成/)).toBeVisible();

  await expect
    .poll(
      async () => {
        const tasks = await (await page.request.get("/api/v1/tasks")).json();
        return tasks.filter(
          (task: { title: string }) => task.title === "每日任务",
        ).length;
      },
      { timeout: 10000 },
    )
    .toBe(2);
  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  const nextTask = tasks.find(
    (task: { title: string; status: string }) =>
      task.title === "每日任务" && task.status === "todo",
  );
  expect(nextTask.recurrence).toBe("daily");
  expect(nextTask.tags).toEqual(["习惯"]);
  expect(
    DateTime.fromISO(nextTask.deadline_at)
      .setZone(zone)
      .toFormat("yyyy-MM-dd HH:mm"),
  ).toBe(
    DateTime.fromISO(due!).plus({ days: 1 }).toFormat("yyyy-MM-dd HH:mm"),
  );

  await page.getByLabel("恢复 每日任务").click();
  await expect
    .poll(
      async () => {
        const items = await (
          await page.request.get("/api/v1/tasks")
        ).json();
        return items.filter(
          (task: { title: string }) => task.title === "每日任务",
        ).length;
      },
      { timeout: 10000 },
    )
    .toBe(1);
});

test("任务分页加载更多", async ({ page }) => {
  const headers = await login(page);
  for (let index = 1; index <= 51; index++) {
    const response = await page.request.post("/api/v1/tasks", {
      headers,
      data: { title: `分页任务${String(index).padStart(2, "0")}` },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/tasks");
  await expect(page.locator(".task-card")).toHaveCount(50);
  await page.getByRole("button", { name: "加载更多" }).click();
  await expect(page.locator(".task-card")).toHaveCount(51);
  await expect(
    page.getByRole("button", { name: "加载更多" }),
  ).not.toBeVisible();
});

test("服务端搜索与侧栏角标", async ({ page }) => {
  const headers = await login(page);
  const auth = await (await page.request.get("/api/v1/auth/me")).json();
  const zone = auth.user.timezone;
  for (const data of [
    {
      title: "逾期任务",
      deadline_at: DateTime.now()
        .setZone(zone)
        .minus({ days: 1 })
        .toISO(),
    },
    { title: "进行中任务", status: "in_progress" },
    { title: "微积分作业" },
    { title: "英语阅读" },
  ]) {
    const response = await page.request.post("/api/v1/tasks", {
      headers,
      data,
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/tasks");
  const todayLink = page.locator("aside nav a").filter({ hasText: "今日" });
  await expect(todayLink).toContainText("2");
  const tasksLink = page.locator("aside nav a").filter({ hasText: "任务" });
  await expect(tasksLink).toContainText("1");

  const search = page.getByLabel("搜索任务");
  await search.fill("微积分");
  await expect(
    page.getByRole("heading", { name: "微积分作业" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "英语阅读" }),
  ).not.toBeVisible();
  await search.fill("");
  await expect(
    page.getByRole("heading", { name: "英语阅读" }),
  ).toBeVisible();
});

test("清单文件夹与保存筛选", async ({ page }) => {
  const headers = await login(page);
  const created = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "数学作业" },
  });
  expect(created.status()).toBe(201);

  await page.getByRole("link", { name: "任务", exact: true }).click();
  await page.getByRole("button", { name: "管理清单", exact: true }).click();
  await page.getByLabel("新文件夹名称").fill("学习");
  await page.getByRole("button", { name: "创建文件夹", exact: true }).click();
  await expect(page.getByText("文件夹已创建")).toBeVisible();
  await page.getByLabel("新清单名称").fill("数学");
  await page.getByRole("button", { name: "创建清单", exact: true }).click();
  await expect(page.getByText("清单已创建")).toBeVisible();

  const listRow = page
    .locator(".ant-list-item")
    .filter({ has: page.getByLabel("数学 名称") });
  const groupSelect = page
    .locator(".ant-select")
    .filter({ has: page.getByRole("combobox", { name: "数学 文件夹" }) });
  await groupSelect.click();
  await page.getByTitle("学习").click();
  await listRow.getByRole("button", { name: /^保\s*存$/ }).click();
  await expect(page.getByText("清单已更新")).toBeVisible();
  await page.locator(".ant-modal-close").click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  const groups = await (
    await page.request.get("/api/v1/task-list-groups")
  ).json();
  const lists = await (await page.request.get("/api/v1/task-lists")).json();
  expect(lists.find((item: { name: string }) => item.name === "数学").group_id).toBe(
    groups[0].id,
  );

  const search = page.getByLabel("搜索任务");
  await search.fill("数学");
  await page.getByRole("button", { name: "保存筛选", exact: true }).click();
  await page.getByLabel("筛选名称").fill("数学筛选");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^保\s*存$/ })
    .click();
  await expect(page.getByText("筛选已保存")).toBeVisible();

  await search.fill("");
  const savedSelect = page
    .locator(".ant-select")
    .filter({ has: page.getByRole("combobox", { name: "已保存筛选" }) });
  await savedSelect.hover();
  await savedSelect.locator(".ant-select-clear").click();
  await savedSelect.click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
    .filter({ hasText: "数学筛选" })
    .click();
  await expect(search).toHaveValue("数学");
  await expect(
    page.getByRole("heading", { name: "数学作业" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "删除筛选", exact: true }).click();
  await expect(page.getByText("筛选已删除")).toBeVisible();
});

test("任务筛选写入 URL，刷新与详情返回后保持", async ({ page }) => {
  const headers = await login(page);
  for (const title of ["URL筛选-数学", "URL筛选-英语"]) {
    const response = await page.request.post("/api/v1/tasks", {
      headers,
      data: { title },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/tasks");
  const search = page.getByLabel("搜索任务");
  await search.fill("数学");
  await expect(page).toHaveURL(/[?&]q=/);
  await expect(
    page.getByRole("heading", { name: "URL筛选-数学", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "URL筛选-英语", exact: true }),
  ).not.toBeVisible();

  const filteredUrl = page.url();
  await page.reload();
  await expect(page).toHaveURL(filteredUrl);
  await expect(search).toHaveValue("数学");
  await expect(
    page.getByRole("heading", { name: "URL筛选-数学", exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "URL筛选-数学", exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/[^/]+\?.*from=/);
  await page.getByRole("link", { name: "返回任务列表" }).click();
  await expect(page).toHaveURL(filteredUrl);
  await expect(search).toHaveValue("数学");
});

test("标签管理重命名、使用次数与删除", async ({ page }) => {
  const headers = await login(page);
  for (const [title, tags] of [
    ["任务A", ["数学"]],
    ["任务B", ["数学", "阅读"]],
  ] as const) {
    const response = await page.request.post("/api/v1/tasks", {
      headers,
      data: { title, tags },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/tasks");
  await page.getByRole("button", { name: "管理标签", exact: true }).click();
  await expect(page.getByText("使用 2 次")).toBeVisible();
  const mathRow = page
    .locator(".ant-list-item")
    .filter({ has: page.getByLabel("数学 名称") });
  await mathRow.getByLabel("数学 名称").fill("高数");
  await mathRow.getByRole("button", { name: /^保\s*存$/ }).click();
  await expect(page.getByText("标签已更新")).toBeVisible();
  await expect(page.getByLabel("高数 名称")).toBeVisible();
  await page.locator(".ant-modal-close").click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  await page.getByRole("button", { name: "管理标签", exact: true }).click();
  const highRow = page
    .locator(".ant-list-item")
    .filter({ has: page.getByLabel("高数 名称") });
  await highRow.getByRole("button", { name: /^删\s*除$/ }).click();
  await page
    .locator(".ant-popconfirm")
    .getByRole("button", { name: /^删\s*除$/ })
    .click();
  await expect(page.getByText("标签已删除")).toBeVisible();
  await page.locator(".ant-modal-close").click();
  await expect(page.getByRole("dialog")).not.toBeVisible();

  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  expect(
    tasks.flatMap((task: { tags: string[] }) => task.tags),
  ).not.toContain("高数");
});

test("清单排序按钮持久化顺序", async ({ page }) => {
  const headers = await login(page);
  for (const name of ["清单A", "清单B", "清单C"]) {
    const response = await page.request.post("/api/v1/task-lists", {
      headers,
      data: { name },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/tasks");
  await page.getByRole("button", { name: "管理清单", exact: true }).click();
  await expect(page.getByLabel("清单A 名称")).toBeVisible();
  const listC = page
    .locator(".ant-list-item")
    .filter({ has: page.getByLabel("清单C 名称") });
  await listC.getByLabel("上移清单 清单C").click();
  await expect
    .poll(
      async () => {
        const lists = await (
          await page.request.get("/api/v1/task-lists")
        ).json();
        return lists.map((list: { name: string }) => list.name);
      },
      { timeout: 10000 },
    )
    .toEqual(["清单A", "清单C", "清单B"]);
});

test("无日期视图只显示没有截止时间的任务", async ({ page }) => {
  const headers = await login(page);
  const auth = await (await page.request.get("/api/v1/auth/me")).json();
  const tomorrow = DateTime.now()
    .setZone(auth.user.timezone)
    .plus({ days: 1 })
    .toISO();
  for (const [title, deadline_at] of [
    ["有截止任务", tomorrow],
    ["无截止任务", null],
  ] as const) {
    const response = await page.request.post("/api/v1/tasks", {
      headers,
      data: { title, deadline_at },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/tasks");
  await expect(
    page.getByRole("heading", { name: "有截止任务" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "无日期", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "无截止任务" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "有截止任务" }),
  ).not.toBeVisible();
});

test("旗标标记、已标记视图与取消标记", async ({ page }) => {
  const headers = await login(page);
  const response = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "重点任务" },
  });
  expect(response.status()).toBe(201);
  const task = await response.json();
  await page.goto("/tasks");
  await expect(
    page.getByRole("heading", { name: "重点任务" }),
  ).toBeVisible();

  await page.getByLabel("标记 重点任务").click();
  await expect(page.getByLabel("取消标记 重点任务")).toBeVisible();
  await page.getByRole("button", { name: "已标记", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "重点任务" }),
  ).toBeVisible();

  await page.getByLabel("取消标记 重点任务").click();
  await expect(
    page.getByRole("heading", { name: "重点任务" }),
  ).not.toBeVisible();
  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  expect(
    tasks.find((item: { id: string }) => item.id === task.id).flagged,
  ).toBe(false);
});

test("手动排序可拖动并持久化", async ({ page }, testInfo) => {
  const headers = await login(page);
  const records = [];
  for (const title of ["任务A", "任务B", "任务C"]) {
    const response = await page.request.post("/api/v1/tasks", {
      headers,
      data: { title },
    });
    expect(response.status()).toBe(201);
    records.push(await response.json());
  }
  await page.request.post("/api/v1/tasks/reorder", {
    headers,
    data: { task_ids: records.map((record) => record.id) },
  });
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "任务A" })).toBeVisible();
  await page
    .locator(".ant-select")
    .filter({ has: page.getByRole("combobox", { name: "任务排序" }) })
    .click();
  await page.getByTitle("手动排序").click();
  await expect(
    page.locator(".ant-select-selection-item").filter({ hasText: "手动排序" }),
  ).toBeVisible();

  const cardA = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: "任务A" }) });
  const cardC = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: "任务C" }) });
  const expected =
    testInfo.project.name === "mobile"
      ? ["任务B", "任务A", "任务C"]
      : ["任务B", "任务C", "任务A"];
  if (testInfo.project.name === "mobile") {
    await cardA.getByLabel("下移 任务A").click();
  } else {
    await cardA.getByLabel("拖动 任务A").dragTo(cardC.locator(".description"));
  }
  await expect
    .poll(
      async () => {
        const tasks = await (await page.request.get("/api/v1/tasks")).json();
        return tasks
          .filter((task: { title: string }) =>
            ["任务A", "任务B", "任务C"].includes(task.title),
          )
          .map((task: { title: string }) => task.title);
      },
      { timeout: 10000 },
    )
    .toEqual(expected);
});

test("嵌套子任务排序与批量完成", async ({ page }) => {
  const headers = await login(page);
  const parent = await (
    await page.request.post("/api/v1/tasks", {
      headers,
      data: { title: "嵌套项目" },
    })
  ).json();
  const first = await (
    await page.request.post("/api/v1/tasks", {
      headers,
      data: { title: "阶段一", parent_id: parent.id },
    })
  ).json();
  const second = await (
    await page.request.post("/api/v1/tasks", {
      headers,
      data: { title: "阶段二", parent_id: parent.id },
    })
  ).json();
  const leaf = await (
    await page.request.post("/api/v1/tasks", {
      headers,
      data: { title: "步骤一", parent_id: first.id },
    })
  ).json();

  await page.goto(`/tasks/${parent.id}`);
  await expect(page.getByRole("link", { name: "阶段一" })).toBeVisible();
  await expect(page.getByRole("link", { name: "阶段二" })).toBeVisible();
  await expect(page.getByRole("link", { name: "步骤一" })).toBeVisible();
  const subtasks = page.locator(".ant-card").filter({ hasText: "子任务" });
  await subtasks.getByLabel("下移子任务 阶段一").click();
  await expect
    .poll(async () => {
      const tasks = await (await page.request.get("/api/v1/tasks")).json();
      const byId = Object.fromEntries(tasks.map((task: { id: string }) => [task.id, task]));
      return [byId[first.id].subtask_order, byId[second.id].subtask_order];
    })
    .toEqual([2, 1]);

  await subtasks.getByRole("button", { name: "全部完成", exact: true }).click();
  await expect(page.getByText("已完成 3 个子任务")).toBeVisible();
  await expect(
    subtasks.getByText("子任务 3/3"),
  ).toBeVisible();
  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  const byId = Object.fromEntries(tasks.map((task: { id: string }) => [task.id, task]));
  expect(byId[first.id].status).toBe("done");
  expect(byId[second.id].status).toBe("done");
  expect(byId[leaf.id].status).toBe("done");
});

test("详情页内联子任务、完成进度与恢复", async ({ page }) => {
  const headers = await login(page);
  const response = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "课程项目" },
  });
  expect(response.status()).toBe(201);
  const parent = await response.json();
  await page.goto(`/tasks/${parent.id}`);

  await page.getByLabel("添加子任务").fill("收集资料");
  await page.getByLabel("添加子任务").press("Enter");
  await expect(
    page.locator(".subtask-row").filter({ hasText: "收集资料" }),
  ).toBeVisible();
  await page.getByLabel("添加子任务").fill("写初稿");
  await page.getByLabel("添加子任务").press("Enter");
  await expect(page.getByText("子任务 0/2")).toBeVisible();

  await page.getByLabel("完成 收集资料").click();
  await expect(page.getByText("子任务 1/2")).toBeVisible();
  await expect(page.getByText("子任务已完成")).toBeVisible();
  await expect(page.getByLabel("恢复 收集资料")).toBeVisible();

  await page.getByLabel("恢复 收集资料").click();
  await expect(page.getByText("子任务 0/2")).toBeVisible();
  await expect(page.getByLabel("完成 收集资料")).toBeVisible();
});

test("自然语言快速添加解析日期、标签和优先级", async ({ page }) => {
  await login(page);
  const input = page.getByLabel("快速添加任务");
  await input.fill("明天下午3点交高数作业 #数学 !高 预计30分钟");
  await expect(page.getByText("将创建：交高数作业")).toBeVisible();
  await expect(page.getByText("#数学", { exact: true })).toBeVisible();
  await expect(page.getByText("优先级 高", { exact: true })).toBeVisible();
  await expect(
    page.getByText("预计 30 分钟", { exact: true }),
  ).toBeVisible();
  await input.press("Enter");
  await expect(
    page.getByRole("link", { name: "交高数作业", exact: true }),
  ).toBeVisible();

  const auth = await (await page.request.get("/api/v1/auth/me")).json();
  const zone = auth.user.timezone;
  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  const task = tasks.find(
    (item: { title: string }) => item.title === "交高数作业",
  );
  expect(task.priority).toBe(3);
  expect(task.tags).toEqual(["数学"]);
  expect(task.estimate_minutes).toBe(30);
  expect(task.deadline_all_day).toBe(false);
  const expected = DateTime.now()
    .setZone(zone)
    .plus({ days: 1 })
    .set({ hour: 15, minute: 0, second: 0, millisecond: 0 });
  expect(
    DateTime.fromISO(task.deadline_at).setZone(zone).toFormat("yyyy-MM-dd HH:mm"),
  ).toBe(expected.toFormat("yyyy-MM-dd HH:mm"));
});

test("今日快速添加、改期、一键完成与撤销", async ({ page }) => {
  await login(page);
  await page.getByLabel("快速添加任务").fill("买牛奶");
  await page.getByLabel("快速添加任务").press("Enter");
  await expect(
    page.getByRole("link", { name: "买牛奶", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "改期", exact: true }).click();
  await page.getByText("明天", { exact: true }).click();
  await expect(page.getByText("截止时间已更新")).toBeVisible();
  let tasks = await (await page.request.get("/api/v1/tasks")).json();
  let task = tasks.find((item: { title: string }) => item.title === "买牛奶");
  expect(task.deadline_all_day).toBe(true);

  await page.getByLabel("完成 买牛奶").click();
  await expect(page.getByText("已完成“买牛奶”")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "买牛奶", exact: true }),
  ).not.toBeVisible();
  tasks = await (await page.request.get("/api/v1/tasks")).json();
  task = tasks.find((item: { title: string }) => item.title === "买牛奶");
  expect(task.status).toBe("done");
  expect(task.completed_at).not.toBeNull();

  await page.getByRole("button", { name: "撤销" }).click();
  await expect(
    page.getByRole("link", { name: "买牛奶", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "记录用时" }).click();
  await page.getByLabel("实际用了多少分钟").fill("15");
  await page.getByRole("button", { name: "完成并记录" }).click();
  await expect(page.getByText("任务已完成，实际耗时已记录")).toBeVisible();
  tasks = await (await page.request.get("/api/v1/tasks")).json();
  task = tasks.find((item: { title: string }) => item.title === "买牛奶");
  expect(task.status).toBe("done");
  expect(task.completed_at).not.toBeNull();
  const logs = await (
    await page.request.get(`/api/v1/tasks/${task.id}/worklogs`)
  ).json();
  expect(logs).toHaveLength(1);
  expect(logs[0].actual_minutes).toBe(15);
});
