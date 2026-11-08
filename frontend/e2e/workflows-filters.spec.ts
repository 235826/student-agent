import { test, expect } from "./fixtures";
import { DateTime } from "luxon";
import { login, openTaskActions, openTaskFilters } from "./support";

test("清单文件夹与保存筛选", async ({ page }) => {
  const headers = await login(page);
  const created = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "数学作业" },
  });
  expect(created.status()).toBe(201);

  await page.getByRole("link", { name: "任务", exact: true }).click();
  await openTaskActions(page);
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
  await page.getByRole("button", { name: "收起" }).click();
  await expect(
    page.getByRole("heading", { name: "管理清单", exact: true }),
  ).not.toBeVisible();

  const groups = await (
    await page.request.get("/api/v1/task-list-groups")
  ).json();
  const lists = await (await page.request.get("/api/v1/task-lists")).json();
  expect(lists.find((item: { name: string }) => item.name === "数学").group_id).toBe(
    groups[0].id,
  );

  const search = page.getByLabel("搜索任务");
  await search.fill("数学");
  await openTaskActions(page);
  await page.getByRole("button", { name: "保存筛选", exact: true }).click();
  await page.getByLabel("筛选名称").fill("数学筛选");
  await page
    .locator(".inline-filter-save")
    .getByRole("button", { name: /^保\s*存$/ })
    .click();
  await expect(page.getByText("筛选已保存")).toBeVisible();

  await search.fill("");
  await expect(page).toHaveURL(/[?&]saved=/);
  await openTaskFilters(page);
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

  await openTaskActions(page);
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

  const row = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: "URL筛选-数学" }) });
  await row.getByRole("heading", { name: "URL筛选-数学" }).click();
  await expect(page).toHaveURL(filteredUrl);
  await expect(row.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
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
  await openTaskActions(page);
  await page.getByRole("button", { name: "管理标签", exact: true }).click();
  await expect(page.getByText("使用 2 次")).toBeVisible();
  const mathRow = page
    .locator(".ant-list-item")
    .filter({ has: page.getByLabel("数学 名称") });
  await mathRow.getByLabel("数学 名称").fill("高数");
  await mathRow.getByRole("button", { name: /^保\s*存$/ }).click();
  await expect(page.getByText("标签已更新")).toBeVisible();
  await expect(page.getByLabel("高数 名称")).toBeVisible();
  await page.getByRole("button", { name: "收起" }).click();
  await expect(
    page.getByRole("heading", { name: "管理标签", exact: true }),
  ).not.toBeVisible();

  await openTaskActions(page);
  await page.getByRole("button", { name: "管理标签", exact: true }).click();
  const highRow = page
    .locator(".ant-list-item")
    .filter({ has: page.getByLabel("高数 名称") });
  await highRow.getByRole("button", { name: /^删\s*除$/ }).click();
  await highRow
    .getByRole("button", { name: "确认删除", exact: true })
    .click();
  await expect(page.getByText("标签已删除")).toBeVisible();
  await page.getByRole("button", { name: "收起" }).click();
  await expect(
    page.getByRole("heading", { name: "管理标签", exact: true }),
  ).not.toBeVisible();

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
  await openTaskActions(page);
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

test("当前筛选汇总支持一键清除", async ({ page }) => {
  const headers = await login(page);
  const created = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "筛选汇总任务" },
  });
  expect(created.status()).toBe(201);

  await page.goto("/tasks");
  const search = page.getByLabel("搜索任务");
  await search.fill("汇总");
  const summary = page.getByRole("group", { name: "当前筛选" });
  await expect(summary).toContainText("搜索：汇总");

  await summary.getByRole("button", { name: "清除全部" }).click();
  await expect(search).toHaveValue("");
  await expect(summary).not.toBeVisible();
});
