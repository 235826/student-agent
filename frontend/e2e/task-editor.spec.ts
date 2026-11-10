import { test, expect } from "./fixtures";
import { login } from "./support";

test("任务抽屉支持校验、关闭保护、失败重试与最小创建", async ({
  page,
}, info) => {
  await login(page);
  await page.goto("/tasks");
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "新建任务", exact: true });
  await expect(drawer).toBeVisible();
  await expect(page.getByLabel("任务标题")).toBeFocused();
  await page.screenshot({
    path: `test-results/${info.project.name}-task-editor.png`,
  });
  await expect(page.getByLabel("父任务（可选）")).not.toBeVisible();
  await drawer.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(drawer.getByText("请输入任务标题")).toBeVisible();
  await page.getByLabel("任务标题").fill("抽屉创建任务");
  await drawer.getByRole("button", { name: /^取\s*消$/ }).click();
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page.getByLabel("任务标题")).toHaveValue("抽屉创建任务");
  await page.route("**/api/v1/tasks", async (route) => {
    if (route.request().method() === "POST")
      await route.fulfill({ status: 500, json: { message: "模拟保存失败" } });
    else await route.continue();
  });
  await drawer.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(page.getByText("模拟保存失败")).toBeVisible();
  await expect(page.getByLabel("任务标题")).toHaveValue("抽屉创建任务");
  await page.unroute("**/api/v1/tasks");
  await drawer.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "抽屉创建任务" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test("折叠字段校验、全天日期和关闭时保存草稿", async ({ page }) => {
  await login(page);
  await page.goto("/tasks/new");
  const drawer = page.getByRole("dialog", { name: "新建任务", exact: true });
  await page.getByLabel("任务标题").fill("全天资料任务");
  await page.getByLabel("仅日期（全天）").check();
  await page.getByLabel(/截止日期/).fill("2027-01-05");
  await page.getByLabel(/截止日期/).press("Enter");
  await page.getByRole("button", { name: "分类与资料" }).click();
  await page.getByRole("button", { name: "添加链接" }).click();
  await page
    .getByLabel("相关链接 1", { exact: true })
    .fill("javascript:alert(1)");
  await page.getByRole("button", { name: "分类与资料" }).click();
  await drawer.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(page.getByText("请输入有效的 http 或 https 链接")).toBeVisible();
  await page
    .getByLabel("相关链接 1", { exact: true })
    .fill("https://example.com/notes");
  await drawer.getByRole("button", { name: /^取\s*消$/ }).click();
  await page
    .getByRole("dialog", { name: "保存当前修改？" })
    .getByRole("button", { name: "保存草稿", exact: true })
    .click();
  await expect(drawer).not.toBeVisible();
  const drafts = await (await page.request.get("/api/v1/drafts")).json();
  const draft = drafts.find(
    (item: { payload: { title: string } }) =>
      item.payload.title === "全天资料任务",
  );
  expect(draft.payload.deadline_all_day).toBe(true);
  expect(draft.payload.links).toEqual(["https://example.com/notes"]);
});
