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
