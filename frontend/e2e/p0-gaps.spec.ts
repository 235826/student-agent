import { DateTime } from "luxon";
import { test, expect } from "./fixtures";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("onboarding_done", "1"));
  await page.getByLabel("用户名").fill("student");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page
    .getByRole("button", { name: /^(创建账号并进入|登\s*录)$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "今天", exact: true }),
  ).toBeVisible();
  const auth = await (await page.request.get("/api/v1/auth/me")).json();
  return {
    "X-CSRF-Token": auth.csrf_token,
    Origin: "http://127.0.0.1:5173",
  };
}

test("执行记录、活动反馈与任务归档", async ({ page }) => {
  const headers = await login(page);
  const created = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "P0 执行记录任务", estimate_minutes: 60 },
  });
  expect(created.ok()).toBeTruthy();
  const task = await created.json();
  const eventStart = DateTime.now().plus({ days: 2 }).startOf("hour");
  const eventResponse = await page.request.post("/api/v1/events", {
    headers,
    data: {
      title: "P0 数据库课",
      start_at: eventStart.toISO(),
      end_at: eventStart.plus({ hours: 1 }).toISO(),
      timezone: "Asia/Shanghai",
    },
  });
  expect(eventResponse.ok()).toBeTruthy();
  const event = await eventResponse.json();

  await page.goto("/tasks");
  const card = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: "P0 执行记录任务" }) });
  await card.getByRole("heading", { name: "P0 执行记录任务" }).click();
  await card.getByRole("button", { name: "记录一次", exact: true }).click();
  await card.getByLabel("实际用时（分钟）").fill("30");
  await card.getByLabel("完成后的感受").fill("第一次记录感受");
  await card.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(card.getByText("第一次记录感受")).toBeVisible();

  await card.getByRole("button", { name: "修改", exact: true }).click();
  await page.getByLabel("完成后的感受").fill("修改后的感受");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(card.getByText("修改后的感受")).toBeVisible();

  await page.goto(`/calendar/events/${event.id}`);
  await page.locator(".ant-rate-star").nth(3).click();
  await page.getByLabel("自由文本").fill("课程反馈：节奏合适");
  await page.getByRole("button", { name: "保存反馈", exact: true }).click();
  await expect(page.getByText("课程反馈：节奏合适")).toBeVisible();

  await page.goto("/tasks");
  const archiveCard = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: task.title }) });
  await archiveCard.getByRole("heading", { name: task.title }).click();
  await archiveCard.getByRole("button", { name: "归档", exact: true }).click();
  await page.getByRole("button", { name: "已归档", exact: true }).click();
  await expect(page.getByRole("heading", { name: task.title })).toBeVisible();
  const archivedCard = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: task.title }) });
  await archivedCard.getByRole("heading", { name: task.title }).click();
  await archivedCard
    .getByRole("button", { name: "恢复归档", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: task.title })).not.toBeVisible();
});

test("Markdown 作业文件可仅保存并保留来源", async ({ page }) => {
  await login(page);
  await page.goto("/inbox/imports");
  await page.getByLabel("导入文件", { exact: true }).setInputFiles({
    name: "作业说明.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 作业说明\n\n下周五前提交实验报告。"),
  });
  await page.getByRole("button", { name: "仅保存材料", exact: true }).click();
  await expect(
    page.getByText("下周五前提交实验报告。", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("下载原始文件")).toBeVisible();
});

test("计划依据、数据导出校验与新手引导入口", async ({ page }) => {
  const headers = await login(page);
  const target = DateTime.now().plus({ days: 2 }).startOf("day");
  await page.request.put("/api/v1/profile", {
    headers,
    data: {
      timezone: "Asia/Shanghai",
      available_windows: [
        {
          weekday: target.weekday - 1,
          start: "09:00",
          end: "12:00",
        },
      ],
      rest_windows: [],
    },
  });
  await page.request.post("/api/v1/tasks", {
    headers,
    data: {
      title: "P0 计划依据任务",
      estimate_minutes: 30,
      deadline_at: target.plus({ hours: 12 }).toISO(),
    },
  });
  const planResponse = await page.request.post("/api/v1/plans", {
    headers,
    data: {
      start_at: target.toISO(),
      end_at: target.plus({ days: 1 }).toISO(),
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(planResponse.ok()).toBeTruthy();
  const plan = await planResponse.json();
  expect(plan.blocks[0].basis.summary).toBeTruthy();

  await page.goto(`/plans/${plan.id}`);
  await page.getByText("查看每个计划块的安排依据", { exact: true }).click();
  await expect(page.getByText("安排理由", { exact: true })).toBeVisible();

  const exported = await page.request.get("/api/v1/data/export");
  expect(exported.ok()).toBeTruthy();
  const preview = await page.request.post("/api/v1/data/import/validate", {
    headers,
    data: await exported.json(),
  });
  expect(preview.ok()).toBeTruthy();
  expect((await preview.json()).counts.tasks).toBeGreaterThan(0);

  await page.goto("/settings");
  await page.getByRole("button", { name: "重新查看新手引导" }).click();
  await expect(
    page.getByRole("dialog", { name: "开始使用 Student Agent" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "跳过", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "开始使用 Student Agent" }),
  ).not.toBeVisible();
});
