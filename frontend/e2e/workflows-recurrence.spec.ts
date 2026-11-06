import { test, expect } from "./fixtures";
import { DateTime } from "luxon";
import { login } from "./support";

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
  await card.getByRole("heading", { name: "资料任务" }).click();
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
  await card.getByRole("heading", { name: "双周任务" }).click();
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
