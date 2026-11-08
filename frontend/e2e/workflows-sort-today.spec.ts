import { test, expect } from "./fixtures";
import { DateTime } from "luxon";
import { login } from "./support";

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

test("手动排序可拖动并持久化", async ({ page }) => {
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

  const cardA = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: "任务A" }) });
  const cardC = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: "任务C" }) });
  const expected = ["任务B", "任务A", "任务C"];
  await cardA
    .getByLabel("拖动 任务A")
    .dragTo(cardC.getByRole("heading", { name: "任务C" }));
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
  const subtasks = page.locator(".section").filter({ hasText: "子任务" });
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
    page.getByRole("heading", { name: "交高数作业", exact: true }),
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
    page.getByRole("heading", { name: "买牛奶", exact: true }),
  ).toBeVisible();

  await page.getByLabel("修改截止时间：未设置").click();
  await page.getByText("明天", { exact: true }).click();
  await expect(page.getByText("截止时间已更新")).toBeVisible();
  let tasks = await (await page.request.get("/api/v1/tasks")).json();
  let task = tasks.find((item: { title: string }) => item.title === "买牛奶");
  expect(task.deadline_all_day).toBe(true);

  await page.getByLabel("完成 买牛奶").click();
  await expect(page.getByText("已完成“买牛奶”")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "买牛奶", exact: true }),
  ).not.toBeVisible();
  tasks = await (await page.request.get("/api/v1/tasks")).json();
  task = tasks.find((item: { title: string }) => item.title === "买牛奶");
  expect(task.status).toBe("done");
  expect(task.completed_at).not.toBeNull();

  await page.getByRole("button", { name: "撤销" }).click();
  await expect(
    page.getByRole("heading", { name: "买牛奶", exact: true }),
  ).toBeVisible();

  await page.getByRole("heading", { name: "买牛奶", exact: true }).click();
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

test("计划视图按日期分组并跨天拖拽", async ({ page }) => {
  const headers = await login(page);
  const auth = await (await page.request.get("/api/v1/auth/me")).json();
  const zone = auth.user.timezone;
  const today = DateTime.now().setZone(zone).startOf("day");
  const todayKey = today.toISODate()!;
  const tomorrowKey = today.plus({ days: 1 }).toISODate()!;
  const remindAt = today.set({ hour: 9, minute: 0 }).toISO()!;
  const reminder = await page.request.post("/api/v1/tasks", {
    headers,
    data: {
      title: "提醒任务",
      deadline_at: today.endOf("day").toISO(),
      deadline_all_day: true,
      remind_at: remindAt,
    },
  });
  expect(reminder.status()).toBe(201);
  const undated = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "跨天任务" },
  });
  expect(undated.status()).toBe(201);

  await page.goto("/tasks");
  await expect(
    page.locator(`[data-plan-date="${todayKey}"] .plan-day-heading strong`),
  ).toContainText("今天");
  await expect(
    page.locator(`[data-plan-date="${tomorrowKey}"] .plan-day-heading strong`),
  ).toContainText("明天");
  const reminderCard = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: "提醒任务" }) });
  await expect(reminderCard.getByText(/^提醒 /)).toBeVisible();

  const source = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: "跨天任务" }) });
  await source
    .getByLabel("拖动 跨天任务")
    .dragTo(page.locator(`[data-plan-date="${tomorrowKey}"]`));
  await expect
    .poll(
      async () => {
        const tasks = await (await page.request.get("/api/v1/tasks")).json();
        const task = tasks.find(
          (item: { title: string }) => item.title === "跨天任务",
        );
        return task.deadline_at
          ? DateTime.fromISO(task.deadline_at).setZone(zone).toISODate()
          : null;
      },
      { timeout: 10000 },
    )
    .toBe(tomorrowKey);
  await expect(
    page
      .locator(`[data-plan-date="${tomorrowKey}"]`)
      .getByRole("heading", { name: "跨天任务" }),
  ).toBeVisible();
});
