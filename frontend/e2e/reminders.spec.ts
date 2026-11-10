import { DateTime } from "luxon";
import { test, expect } from "./fixtures";
import { login } from "./support";

const today = () => DateTime.now().setZone("Asia/Shanghai").startOf("day");

test("日期分组连续录入、原地改名与撤销", async ({ page }) => {
  const headers = await login(page);
  const list = await (
    await page.request.post("/api/v1/task-lists", {
      headers,
      data: { name: "学习" },
    })
  ).json();
  await page.goto(`/tasks?list=${list.id}`);
  const label = `添加任务：${today().toISODate()}`;
  await page.getByRole("button", { name: label, exact: true }).click();
  const input = page.getByRole("textbox", { name: label, exact: true });
  await input.fill("第一项");
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { name: "第一项", exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  await input.fill("第二项");
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { name: "第二项", exact: true }),
  ).toBeVisible();
  await input.press("Enter");
  await input.fill("不要保存");
  await input.press("Escape");
  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  expect(tasks).toHaveLength(2);
  expect(
    tasks.every(
      (task: {
        list_id: string;
        deadline_all_day: boolean;
        remind_at: unknown;
      }) =>
        task.list_id === list.id &&
        task.deadline_all_day &&
        task.remind_at === null,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "第一项", exact: true }).click();
  const title = page.getByRole("textbox", {
    name: "任务标题：第一项",
    exact: true,
  });
  await title.fill("改名完成");
  await title.press("Enter");
  await expect(
    page.getByRole("heading", { name: "改名完成", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "撤销：修改标题", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "第一项", exact: true }),
  ).toBeVisible();
  await page.locator(`[data-task-id="${tasks[0].id}"]`).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(
    page.getByRole("heading", { name: "第二项", exact: true }),
  ).toHaveCount(0);
  await page.route("**/api/v1/tasks", async (route) => {
    if (route.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  await page.getByRole("button", { name: label, exact: true }).click();
  await input.fill("保存后不抢焦点");
  await input.press("Enter");
  const search = page.getByLabel("搜索任务", { exact: true });
  await search.fill("第一项");
  await expect.poll(async () => (await (await page.request.get("/api/v1/tasks")).json()).some((task: { title: string }) => task.title === "保存后不抢焦点")).toBe(true);
  await expect(search).toBeFocused();
});

test("行多选、右键批量标记与键盘导航完成", async ({ page }) => {
  const headers = await login(page);
  for (const title of ["任务甲", "任务乙", "任务丙"]) {
    await page.request.post("/api/v1/tasks", { headers, data: { title } });
  }
  await page.goto("/tasks");
  await page
    .getByRole("button", { name: "任务甲", exact: true })
    .click({ modifiers: ["ControlOrMeta"] });
  await page
    .getByRole("button", { name: "任务乙", exact: true })
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(page.getByText("已选 2 项", { exact: true })).toBeVisible();
  const first = page.locator(".task-card").filter({
    has: page.getByRole("heading", { name: "任务甲", exact: true }),
  });
  await first.click({ button: "right" });
  await page.getByRole("menuitem", { name: "标记", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/v1/tasks")).json()).filter(
          (task: { flagged: boolean }) => task.flagged,
        ).length,
    )
    .toBe(2);
  await page
    .getByRole("button", { name: "撤销：修改标记", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/v1/tasks")).json()).filter(
          (task: { flagged: boolean }) => task.flagged,
        ).length,
    )
    .toBe(0);
  await first.focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ArrowDown");
  const focused = page.locator(".task-card:focus");
  await expect(focused).toHaveAttribute("aria-current", "true");
  const id = await focused.getAttribute("data-task-id");
  await page.keyboard.press("Space");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/tasks/${id}`)).json()).status,
    )
    .toBe("done");
  await page
    .getByRole("button", { name: "撤销：完成任务", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/tasks/${id}`)).json()).status,
    )
    .toBe("todo");
});

test("主列表展开子任务并直接连续添加", async ({ page }) => {
  const headers = await login(page);
  const parent = await (
    await page.request.post("/api/v1/tasks", {
      headers,
      data: {
        title: "项目任务",
        deadline_at: today().endOf("day").toISO(),
        deadline_all_day: true,
      },
    })
  ).json();
  await page.goto("/tasks");
  await page
    .getByRole("button", { name: "更多操作：项目任务", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "添加子任务", exact: true }).click();
  const label = "添加子任务：项目任务";
  await page.getByRole("button", { name: label, exact: true }).click();
  const input = page.getByRole("textbox", { name: label, exact: true });
  await input.fill("收集资料");
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { name: "收集资料", exact: true }),
  ).toBeVisible();
  await input.press("Escape");
  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  const child = tasks.find(
    (task: { title: string }) => task.title === "收集资料",
  );
  expect(child.parent_id).toBe(parent.id);
  expect(child.deadline_all_day).toBe(true);
  await expect(page.locator(`[data-task-id="${child.id}"]`)).toHaveCount(1);
  await page
    .getByRole("button", { name: "展开子任务：项目任务", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "收集资料", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "展开子任务：项目任务", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "收集资料", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("reminders-list.png"),
    fullPage: true,
  });
});

test("多选拖动改期和清单移动可撤销", async ({ page }, info) => {
  const headers = await login(page);
  const tasks: Array<{ id: string }> = [];
  for (const title of ["拖动甲", "拖动乙"]) {
    tasks.push(
      await (
        await page.request.post("/api/v1/tasks", {
          headers,
          data: {
            title,
            deadline_at: today().endOf("day").toISO(),
            deadline_all_day: true,
          },
        })
      ).json(),
    );
  }
  const list = await (
    await page.request.post("/api/v1/task-lists", {
      headers,
      data: { name: "拖入清单" },
    })
  ).json();
  await page.goto("/tasks");
  for (const title of ["拖动甲", "拖动乙"])
    await page
      .getByRole("button", { name: title, exact: true })
      .click({ modifiers: ["ControlOrMeta"] });
  await page
    .locator(`[data-plan-date="${today().plus({ days: 1 }).toISODate()}"]`)
    .evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page
    .locator(`[data-task-id="${tasks[0].id}"]`)
    .dragTo(
      page.locator(
        `[data-plan-date="${today().plus({ days: 1 }).toISODate()}"]`,
      ),
    );
  await expect
    .poll(async () =>
      (await (await page.request.get("/api/v1/tasks")).json()).every(
        (task: { deadline_at: string }) =>
          DateTime.fromISO(task.deadline_at)
            .setZone("Asia/Shanghai")
            .toISODate() === today().plus({ days: 1 }).toISODate(),
      ),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "撤销：移动 2 项任务", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await (await page.request.get("/api/v1/tasks")).json()).every(
        (task: { deadline_at: string }) =>
          DateTime.fromISO(task.deadline_at)
            .setZone("Asia/Shanghai")
            .toISODate() === today().toISODate(),
      ),
    )
    .toBe(true);
  if (info.project.name === "desktop") {
    await page
      .locator(`[data-task-id="${tasks[0].id}"]`)
      .dragTo(page.locator(`[data-task-list-drop="${list.id}"]`));
    await expect
      .poll(async () =>
        (await (await page.request.get("/api/v1/tasks")).json()).every(
          (task: { list_id: string }) => task.list_id === list.id,
        ),
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "撤销：移动清单", exact: true })
      .click();
    await expect
      .poll(async () =>
        (await (await page.request.get("/api/v1/tasks")).json()).every(
          (task: { list_id: unknown }) => task.list_id === null,
        ),
      )
      .toBe(true);
  }
  const first = page.locator(`[data-task-id="${tasks[0].id}"]`);
  await first.focus();
  await page.keyboard.press("Escape");
  await page.keyboard.down("Alt");
  try {
    await first.dragTo(page.locator(`[data-task-id="${tasks[1].id}"]`));
  } finally {
    await page.keyboard.up("Alt");
  }
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/tasks/${tasks[0].id}`)).json())
          .parent_id,
    )
    .toBe(tasks[1].id);
  await page
    .getByRole("button", { name: "撤销：创建子任务关系", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/tasks/${tasks[0].id}`)).json())
          .parent_id,
    )
    .toBeNull();
});

test("多项修改部分失败时仍可撤销成功部分", async ({ page }) => {
  const headers = await login(page);
  const tasks: Array<{ id: string }> = [];
  for (const title of ["成功部分", "失败部分"])
    tasks.push(
      await (
        await page.request.post("/api/v1/tasks", { headers, data: { title } })
      ).json(),
    );
  await page.goto("/tasks");
  for (const title of ["成功部分", "失败部分"])
    await page
      .getByRole("button", { name: title, exact: true })
      .click({ modifiers: ["ControlOrMeta"] });
  await page.route(`**/api/v1/tasks/${tasks[1].id}/flag`, (route) =>
    route.fulfill({ status: 500, json: { message: "模拟第二项失败" } }),
  );
  await page
    .getByRole("button", { name: "更多操作：成功部分", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "标记", exact: true }).click();
  await expect(page.getByText("模拟第二项失败", { exact: true })).toBeVisible();
  expect(
    (await (await page.request.get(`/api/v1/tasks/${tasks[0].id}`)).json())
      .flagged,
  ).toBe(true);
  expect(
    (await (await page.request.get(`/api/v1/tasks/${tasks[1].id}`)).json())
      .flagged,
  ).toBe(false);
  await page
    .getByRole("button", { name: "撤销：修改标记", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/v1/tasks/${tasks[0].id}`)).json())
          .flagged,
    )
    .toBe(false);
});

test("保存失败保留标题，编辑不清除提醒，撤销拒绝覆盖后续修改", async ({
  page,
}) => {
  const headers = await login(page);
  const task = await (
    await page.request.post("/api/v1/tasks", {
      headers,
      data: { title: "保留输入", remind_at: "2030-01-10T09:00:00+08:00" },
    })
  ).json();
  await page.goto("/tasks");
  await page.getByRole("button", { name: "保留输入", exact: true }).click();
  const input = page.getByRole("textbox", {
    name: "任务标题：保留输入",
    exact: true,
  });
  await page.route(`**/api/v1/tasks/${task.id}`, async (route) => {
    if (route.request().method() === "PUT")
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "模拟保存失败" }),
      });
    else await route.continue();
  });
  await input.fill("输入不会丢失");
  await input.press("Enter");
  await expect(input).toHaveValue("输入不会丢失");
  await expect(page.locator(".inline-task-title [role=alert]")).toBeVisible();
  await page.unroute(`**/api/v1/tasks/${task.id}`);
  await input.press("Enter");
  await expect(
    page.getByRole("heading", { name: "输入不会丢失", exact: true }),
  ).toBeVisible();
  expect(
    (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json())
      .remind_at,
  ).toBe(task.remind_at);
  await page.request.put(`/api/v1/tasks/${task.id}`, {
    headers,
    data: { title: "其他窗口的新标题", remind_at: task.remind_at },
  });
  await page
    .getByRole("button", { name: "撤销：修改标题", exact: true })
    .click();
  await expect(page.getByText(/已被再次修改/)).toBeVisible();
  expect(
    (await (await page.request.get(`/api/v1/tasks/${task.id}`)).json()).title,
  ).toBe("其他窗口的新标题");
});
