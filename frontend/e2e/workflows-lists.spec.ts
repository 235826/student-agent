import { test, expect } from "./fixtures";
import { login } from "./support";

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
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: "清单任务" }) });
  await expect(card.getByText("课程", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("任务标题").fill("收件箱任务");
  await page.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "收件箱任务" })).toBeVisible();

  await card.getByRole("heading", { name: "清单任务" }).click();
  await expect(card.getByText("数学", { exact: true })).toBeVisible();
  await expect(card.getByText("阅读", { exact: true })).toBeVisible();

  const listFilter = page.locator(".ant-select").filter({
    has: page.getByRole("combobox", { name: "筛选清单" }),
  });
  await listFilter.click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
    .filter({ hasText: "课程" })
    .click();
  await expect(page.getByRole("heading", { name: "清单任务" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "收件箱任务" }),
  ).not.toBeVisible();
  await listFilter.click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
    .filter({ hasText: "全部清单" })
    .click();
  await expect(page.getByRole("heading", { name: "收件箱任务" })).toBeVisible();

  const tagFilter = page.locator(".ant-select").filter({
    has: page.getByRole("combobox", { name: "筛选标签" }),
  });
  await tagFilter.click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
    .filter({ hasText: "数学" })
    .click();
  await expect(
    page.getByRole("heading", { name: "收件箱任务" }),
  ).not.toBeVisible();
  await tagFilter.click();
  await page
    .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
    .filter({ hasText: "全部标签" })
    .click();
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

test("任务行列内联展开详情", async ({ page }) => {
  const headers = await login(page);
  const created = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "抽屉任务", description: "行内展开的描述" },
  });
  expect(created.status()).toBe(201);
  await page.goto("/tasks");
  const row = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: "抽屉任务" }) });
  await row.getByRole("heading", { name: "抽屉任务" }).click();

  await expect(page.locator(".ant-drawer-content")).toHaveCount(0);
  await expect(row.getByText("行内展开的描述", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/tasks$/);
});
