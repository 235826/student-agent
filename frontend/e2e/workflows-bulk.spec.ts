import { test, expect } from "./fixtures";
import { login, openTaskActions } from "./support";

test("任务行展开后保留筛选 URL", async ({ page }) => {
  const headers = await login(page);
  const created = await page.request.post("/api/v1/tasks", {
    headers,
    data: { title: "抽屉筛选任务", description: "行内展开内容" },
  });
  expect(created.status()).toBe(201);
  await page.goto("/tasks");
  const search = page.getByLabel("搜索任务");
  await search.fill("抽屉筛选");
  await expect(page).toHaveURL(/[?&]q=/);
  const row = page
    .locator(".task-card")
    .filter({ has: page.getByRole("heading", { name: "抽屉筛选任务" }) });
  await row.getByRole("heading", { name: "抽屉筛选任务" }).click();
  await expect(page.locator(".ant-drawer-content")).toHaveCount(0);
  await expect(row.getByText("行内展开内容", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/[?&]q=/);
  await expect(search).toHaveValue("抽屉筛选");
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
  await openTaskActions(page);
  await page.getByRole("button", { name: "批量操作", exact: true }).click();
  await page.getByLabel("选择 批量改期A").check();
  await page.getByLabel("选择 批量改期B").check();
  const bar = page.locator(".bulk-bar").filter({ hasText: "已选 2 项" });
  await bar.getByRole("button", { name: /^改\s*期$/ }).click();
  await bar.getByRole("button", { name: "明天", exact: true }).click();
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
  const bulkTag = page.locator(".bulk-bar .inline-filter-save");
  await bulkTag.getByRole("combobox").click();
  await bulkTag.getByRole("combobox").fill("批量标签");
  await page.keyboard.press("Enter");
  await bulkTag.getByText("批量标签", { exact: true }).first().click();
  await bulkTag
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
  await card.getByRole("heading", { name: "永久删除A" }).click();
  await card.getByRole("button", { name: "永久删除", exact: true }).click();
  await card
    .getByRole("button", { name: "确认永久删除", exact: true })
    .click();
  await expect(page.getByText("任务已永久删除")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "永久删除A" }),
  ).not.toBeVisible();

  await openTaskActions(page);
  await page.getByRole("button", { name: "清空垃圾箱", exact: true }).click();
  await page
    .getByRole("button", { name: "确认清空垃圾箱", exact: true })
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
  await expect(
    page.getByRole("heading", { name: /^附件 \d+$/ }),
  ).toHaveCount(0);

  await page.locator('input[type="file"]').setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect(page.getByText("附件已上传")).toBeVisible();
  await expect(page.getByRole("heading", { name: /附件 1/ })).toBeVisible();
  await expect(page.getByText("note.txt", { exact: true })).toBeVisible();
  const download = page.getByRole("link", { name: "下载", exact: true }).first();
  expect(await download.getAttribute("href")).toMatch(
    /\/api\/v1\/attachments\//,
  );

  const attachmentCard = page
    .locator(".section")
    .filter({ has: page.getByRole("heading", { name: "附件" }) });
  await attachmentCard
    .getByRole("button", { name: /^删\s*除$/ })
    .click();
  await page.getByRole("button", { name: /^确认删除$/ }).click();
  await expect(page.getByText("附件已删除")).toBeVisible();
  await expect(page.getByText("note.txt", { exact: true })).not.toBeVisible();
  expect(
    await (
      await page.request.get(`/api/v1/tasks/${task.id}/attachments`)
    ).json(),
  ).toEqual([]);
});
