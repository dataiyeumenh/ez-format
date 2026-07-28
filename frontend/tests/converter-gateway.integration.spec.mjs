import { expect, test } from "@playwright/test";
import { stat } from "node:fs/promises";
import path from "node:path";

const live = process.env.QA_EXPECT_LIVE === "true";
const frontendOrigin = String(process.env.QA_FRONTEND_URL || "").replace(/\/$/, "");
const gatewayOrigin = String(process.env.QA_GATEWAY_URL || "").replace(/\/$/, "");
const ownerEmail = String(process.env.QA_OWNER_EMAIL || "");
const ownerPassword = String(process.env.QA_OWNER_PASSWORD || "");
const rawFixture = String(process.env.QA_RAW_FIXTURE || "");

const capabilitiesPath = "/api/converter/capabilities";
const loginPath = "/api/auth/login";
const analyzePath = "/api/converter/uploads/analyze";

function isGatewayResponse(response, pathname, method = "GET") {
  const url = new URL(response.url());
  return (
    url.origin === gatewayOrigin &&
    url.pathname === pathname &&
    response.request().method() === method
  );
}

function assertLiveInputs() {
  for (const [label, value] of Object.entries({
    frontendOrigin,
    gatewayOrigin,
    ownerEmail,
    ownerPassword,
    rawFixture,
  })) {
    expect(value, `${label} is required for the real browser journey`).not.toBe("");
  }
  expect(new URL(frontendOrigin).origin).not.toBe(new URL(gatewayOrigin).origin);
}

async function loginThroughUi(page) {
  await page.goto(`${frontendOrigin}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(ownerEmail);
  await page.locator('input[name="password"]').fill(ownerPassword);

  const loginResponsePromise = page.waitForResponse((response) =>
    isGatewayResponse(response, loginPath, "POST"),
  );
  await page.getByRole("button", { name: "Đăng nhập vào tài khoản" }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.status(), await loginResponse.text()).toBe(200);
  await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem("token")))).toBe(true);
}

async function openConvertPage(page) {
  const capabilitiesResponsePromise = page.waitForResponse((response) =>
    isGatewayResponse(response, capabilitiesPath),
  );
  await page.goto(`${frontendOrigin}/convert`, { waitUntil: "domcontentloaded" });
  const capabilitiesResponse = await capabilitiesResponsePromise;
  expect(capabilitiesResponse.status(), await capabilitiesResponse.text()).toBe(200);
  await expect(page.getByRole("heading", { name: /Chuyển đổi Excel/ })).toBeVisible();
  return capabilitiesResponse.json();
}

function downloadButton(page) {
  return page.getByRole("button", { name: /Tải file kết quả|Tải lại file kết quả/ }).first();
}

async function setRequiredRow(row, values) {
  await row.locator("select").selectOption(values.source || "");
  await row.locator('input[placeholder="Giá trị mặc định"]').fill(values.defaultValue || "");
  await row.locator('input[placeholder^="VD:"]').fill(values.formula || "");
}

async function stubAiCapabilities(page, gateway) {
  await page.route(`**${capabilitiesPath}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ai: {
          gateway,
          model: gateway === "online" ? "online" : "offline",
          mapping: "not_run",
        },
        capabilities: {},
      }),
    });
  });
}

test.describe("converter gateway real browser release journey", () => {
  test.skip(!live, "Run through qa-converter-gateway.ps1 with live UI prerequisites");
  test.setTimeout(240_000);

  test.beforeEach(() => {
    assertLiveInputs();
  });

  test("user login, mapping, readiness gates, preview, and download run through the UI", async ({
    page,
  }) => {
    await loginThroughUi(page);
    const capabilities = await openConvertPage(page);

    const expectedAiCopy =
      capabilities?.ai?.gateway === "offline"
        ? "AI offline — đang dùng heuristic an toàn"
        : capabilities?.ai?.gateway === "online"
          ? "AI Gateway online — chưa chạy AI mapping"
          : null;
    if (expectedAiCopy) await expect(page.getByText(expectedAiCopy, { exact: true })).toBeVisible();

    await page.getByLabel("Template chuẩn từ phần mềm kế toán").selectOption("bsn_sales");
    const analyzeResponsePromise = page.waitForResponse((response) =>
      isGatewayResponse(response, analyzePath, "POST"),
    );
    await page.locator('input[type="file"]').setInputFiles(rawFixture);
    const analyzeResponse = await analyzeResponsePromise;
    expect(analyzeResponse.status(), await analyzeResponse.text()).toBe(200);

    await expect(
      page.getByRole("heading", { name: "Ghép cột Excel → Chuẩn định dạng kế toán" }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(path.basename(rawFixture), { exact: true })).toBeVisible();

    const requiredRow = page
      .getByRole("row")
      .filter({ has: page.getByText("Số chứng từ (*)", { exact: true }) })
      .last();
    await expect(requiredRow).toBeVisible();
    const original = {
      source: await requiredRow.locator("select").inputValue(),
      defaultValue: await requiredRow
        .locator('input[placeholder="Giá trị mặc định"]')
        .inputValue(),
      formula: await requiredRow.locator('input[placeholder^="VD:"]').inputValue(),
    };
    expect(
      Boolean(original.source || original.defaultValue || original.formula),
      "The release fixture must auto-map the required invoice-number field",
    ).toBe(true);

    await setRequiredRow(requiredRow, {});
    await page.getByRole("button", { name: "Kiểm tra lỗi", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Còn lỗi cần sửa" })).toBeVisible({
      timeout: 120_000,
    });
    await expect(downloadButton(page)).toBeDisabled();

    await setRequiredRow(requiredRow, original);
    await page.getByRole("button", { name: "Kiểm tra lỗi", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Cần rà soát trước khi tải" })).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByRole("heading", { name: "Xem trước dữ liệu đầu ra" })).toBeVisible();
    await expect(downloadButton(page)).toBeDisabled();

    const warningAcknowledgement = page.getByLabel(
      "Tôi đã kiểm tra các cảnh báo nghiệp vụ/kế toán và vẫn muốn tải file.",
    );
    await expect(warningAcknowledgement).toBeVisible();
    await warningAcknowledgement.check();
    await expect(downloadButton(page)).toBeEnabled();

    const downloadPromise = page.waitForEvent("download");
    await downloadButton(page).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.xls$/i);
    const downloadedPath = await download.path();
    expect(downloadedPath).toBeTruthy();
    expect((await stat(downloadedPath)).size).toBeGreaterThan(0);
  });

  test("AI online/offline copy and the 390px Convert layout render in a real browser", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginThroughUi(page);

    await stubAiCapabilities(page, "online");
    await page.goto(`${frontendOrigin}/convert`, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("AI Gateway online — chưa chạy AI mapping", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Dùng AI hỗ trợ ghép cột", { exact: true })).toBeVisible();

    await page.unroute(`**${capabilitiesPath}`);
    await stubAiCapabilities(page, "offline");
    await page.goto(`${frontendOrigin}/convert`, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("AI offline — đang dùng heuristic an toàn", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Chọn file Excel" })).toBeVisible();
    await expect(page.getByLabel("Template chuẩn từ phần mềm kế toán")).toBeVisible();

    const viewport = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(viewport.clientWidth).toBe(390);
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
  });
});
