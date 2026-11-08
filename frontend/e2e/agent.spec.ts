import { test, expect } from "./fixtures";
import { login } from "./support";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

test("Agent 提出任务并只在确认后创建", async ({ page }) => {
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
  const before = await (await page.request.get("/api/v1/tasks")).json();
  expect(before).toEqual([]);
  await page.getByRole("button", { name: "确认执行" }).click();
  await expect
    .poll(async () => {
      const tasks = await (await page.request.get("/api/v1/tasks")).json();
      return tasks.map((task: { title: string }) => task.title);
    })
    .toContain("复习线性代数");
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
