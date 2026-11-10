import { test, expect } from "./fixtures";
import { login } from "./support";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

test("Agent 默认创建任务并支持修改和撤销", async ({ page }) => {
  await login(page);
  await page.goto("/agent");
  await page.getByRole("button", { name: "新对话" }).waitFor();
  const consent = page.getByRole("button", { name: "同意并开始" });
  await consent
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => undefined);
  if (await consent.isVisible()) await consent.click();
  const input = page.getByPlaceholder(/例如/);
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.fill("帮我建一个任务：复习线性代数");
  await page.getByRole("button", { name: /发\s*送/ }).click();
  await expect(page.getByText("创建任务「复习线性代数」")).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole("button", { name: "确认执行", exact: true })).toHaveCount(0);
  await expect
    .poll(async () => {
      const tasks = await (await page.request.get("/api/v1/tasks")).json();
      return tasks.map((task: { title: string }) => task.title);
    })
    .toContain("复习线性代数");
  await expect(page.getByText("清单：收件箱", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "设置提醒", exact: true }).click();
  await page.getByLabel("提醒时间").fill("2030-01-10T09:00");
  await page.getByRole("button", { name: /保\s*存/, exact: true }).click();
  await expect(page.getByText(/提醒：2030-01-10 09:00/)).toBeVisible();
  await page.getByRole("button", { name: "更换清单", exact: true }).click();
  await page.getByRole("button", { name: /保\s*存/, exact: true }).click();
  await expect(page.getByText(/提醒：2030-01-10 09:00/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("task-result.png"), fullPage: true });
  await page.getByRole("button", { name: "撤销创建", exact: true }).click();
  await expect(page.getByText("已撤销，任务已移入垃圾箱，可从垃圾箱恢复。")).toBeVisible();
  expect(await (await page.request.get("/api/v1/tasks")).json()).toEqual([]);
});

test("Agent 接收并识别用户上传的图片", async ({ page }) => {
  await login(page);
  await page.goto("/agent");
  await page.getByRole("button", { name: "新对话" }).waitFor();
  const consent = page.getByRole("button", { name: "同意并开始" });
  await consent
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => undefined);
  if (await consent.isVisible()) await consent.click();
  const input = page.getByPlaceholder(/例如/);
  await input.waitFor({ state: "visible", timeout: 10000 });
  await page.locator('input[type="file"]').setInputFiles({
    name: "test.png",
    mimeType: "image/png",
    buffer: PNG_1x1,
  });
  await expect(page.locator(".agent-image-thumb")).toBeVisible({ timeout: 5000 });
  await input.fill("看看这张图");
  await page.getByRole("button", { name: /发\s*送/ }).click();
  await expect(page.getByText("我看到了你发送的图片。")).toBeVisible({
    timeout: 15000,
  });
});
