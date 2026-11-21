import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { emptyProfile } from "../src/types.ts";

const previousFailure = "等待浏览器连接超时。请将浏览器置于前台，核对连接提示后重试。";
const currentFailure = "本次浏览器附着失败，请核对后重试。";
const unrelatedFailure = "合成的页面列表错误，仍需处理。";
const connectedMessage = "已连接现有浏览器，请选择本次申请页面。";
const evidenceDir = process.env.SUPER_OFFER_TEST_EVIDENCE_DIR;
let server, browser, origin;
before(async () => {
  server = await createServer({
    configFile: false, envFile: false, publicDir: false, plugins: [react()],
    cacheDir: resolve(".s0-work/browser-panel-vite-cache"),
    optimizeDeps: { entries: ["index.html"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false }, logLevel: "error",
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const executablePath = process.env.SUPER_OFFER_TEST_BROWSER;
  if (executablePath) browser = await chromium.launch({ executablePath, headless: true });
  else {
    const errors = [];
    for (const channel of ["msedge", "chrome"]) {
      try { browser = await chromium.launch({ channel, headless: true }); break; }
      catch (error) { errors.push(`${channel}: ${error.message.split("\n")[0]}`); }
    }
    if (!browser) throw Error("需安装 Edge/Chrome 或设置 SUPER_OFFER_TEST_BROWSER：\n" + errors.join("\n"));
  }
  console.info(`受控界面浏览器：${browser.version()}；真实 React 界面，本机 IPC 替身`);
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function setup(t) {
  const data = emptyProfile();
  data.basic.name = "合成档案姓名";
  const workspace = { activity: { browser: false, source: false, interview: false },
    state: { contractVersion: 1, schemaVersion: 2, datasetId: "synthetic-dataset", revision: 0,
      profiles: [{ id: "profile-a", name: "合成档案", currentVersionId: "version-a", versions: [{ id: "version-a", profileId: "profile-a", createdAt: "2026-11-21T00:00:00Z", data }] }],
      jobs: [], applications: [], events: [], interviews: [], assets: [], providers: [], tasks: [] },
    providerStatus: [], dataDirectory: "合成隔离工作区" };
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let externalRequests = 0;
  const errors = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequests++;
    return route.abort();
  });
  await context.addInitScript(({ workspace, unrelatedFailure, connectedMessage }) => {
    const fixture = window.__browserPanelFixture = {
      statusCalls: 0, connectionCalls: 0, pending: null,
      state: { connected: false, targetId: null, documentId: null, generation: "initial", runId: null,
        status: "disconnected", message: "连接已关闭，已有进度保留", url: "", profileVersionId: null,
        profileName: "", results: [], pending: 0 },
      finish(error) {
        const current = this.pending;
        if (!current) throw Error("没有待响应的合成连接");
        this.pending = null;
        if (error) current.reject({ code: "BROWSER_CONNECT_FAILED", message: error });
        else {
          this.state = { ...this.state, connected: true, status: "ready", message: connectedMessage, generation: `connected-${this.connectionCalls}` };
          current.resolve([{ id: "synthetic-target", title: "合成申请页", url: "https://example.invalid/apply" }]);
        }
      },
    };
    let listener = 0;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      transformCallback() { return ++listener; },
      async invoke(command, args) {
        if (command.startsWith("plugin:event|")) return ++listener;
        if (command !== "request") throw Error(`未定义 IPC ${command}`);
        const request = args.request;
        if (request.kind === "snapshot") return structuredClone(workspace);
        if (request.kind === "source" && request.command.kind === "list")
          return { versions: [], limits: { files: 100, fileBytes: 1000, totalBytes: 10000, encoding: "合成范围" } };
        if (request.kind === "interview" && request.command.kind === "list") return [];
        if (request.kind === "browser") {
          if (request.command.kind === "status") {
            fixture.statusCalls++;
            return { state: structuredClone(fixture.state), run: null, history: [] };
          }
          if (request.command.kind === "connect") {
            fixture.connectionCalls++;
            return new Promise((resolve, reject) => { fixture.pending = { resolve, reject }; });
          }
          if (fixture.fields && request.command.kind === "inspect") return fixture.fields;
          if (fixture.fields && request.command.kind === "upload") { fixture.uploads.push(request.command); return fixture.state; }
          if (["targets", "inspect"].includes(request.command.kind))
            throw { code: "FIXTURE_BUSINESS_ERROR", message: unrelatedFailure };
        }
        throw Error(`未定义合成请求 ${request.kind}/${request.command?.kind}`);
      },
    };
  }, { workspace, unrelatedFailure, connectedMessage });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await context.close();
    assert.equal(externalRequests, 0);
    assert.deepEqual(errors, []);
  });
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.getByRole("navigation").getByRole("button", { name: "浏览器填写", exact: true }).click();
  const panel = page.locator("section.workflow-panel").filter({ has: page.getByRole("heading", { name: "浏览器与投递", exact: true }) });
  await panel.getByText("连接已关闭，已有进度保留", { exact: true }).waitFor();
  return { page, panel };
}
async function startConnect(page) {
  await page.getByRole("button", { name: "连接现有浏览器", exact: true }).click();
  await page.getByRole("button", { name: "正在等待浏览器连接…", exact: true }).waitFor();
  await page.waitForFunction(() => !!window.__browserPanelFixture.pending);
}
async function finishConnect(page, error = null) {
  await page.evaluate((message) => window.__browserPanelFixture.finish(message), error);
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "连接现有浏览器" && !button.disabled));
}
async function capture(page, name) {
  if (!evidenceDir) return;
  const rendered = await page.evaluate(() => ({
    visibleText: document.body.innerText,
    connectionCalls: window.__browserPanelFixture.connectionCalls,
    statusCalls: window.__browserPanelFixture.statusCalls,
    connected: window.__browserPanelFixture.state.connected,
  }));
  const sourceHashes = {};
  for (const file of ["src/BrowserPanel.tsx", "src/App.tsx", "tests/browser-panel.test.mjs"])
    sourceHashes[file] = createHash("sha256").update(await readFile(file)).digest("hex");
  await page.screenshot({ path: resolve(evidenceDir, `${name}.png`), fullPage: true });
  await writeFile(resolve(evidenceDir, `${name}.json`), JSON.stringify({ browser: browser.version(), mode: "正式React界面＋受控IPC替身，非真实浏览器授权验收", sourceHashes, ...rendered }, null, 2));
}

test("连接重试不保留旧超时或关闭提示，成功会话和临时编辑保持", async (t) => {
  const { page, panel } = await setup(t);
  await panel.getByText("仅本次填写的临时值（不修改档案）", { exact: true }).click();
  await panel.getByLabel("基本信息 · 姓名", { exact: true }).fill("合成临时姓名");
  await startConnect(page);
  await finishConnect(page, previousFailure);
  await page.getByRole("alert").filter({ hasText: previousFailure }).waitFor();
  await startConnect(page);
  const polls = await page.evaluate(() => window.__browserPanelFixture.statusCalls);
  await page.waitForFunction((count) => window.__browserPanelFixture.statusCalls > count, polls);
  await capture(page, "retry-pending");
  assert.equal(await page.getByText(previousFailure, { exact: true }).count(), 0);
  assert.equal(await panel.getByText("连接已关闭，已有进度保留", { exact: true }).count(), 0);
  assert.equal(await panel.getByRole("status").getByText("正在等待浏览器连接…", { exact: true }).count(), 1);
  await finishConnect(page);
  await panel.getByText(connectedMessage, { exact: true }).waitFor();
  assert.equal(await panel.getByLabel("本次申请页面").locator("option[value=synthetic-target]").count(), 1);
  assert.equal(await panel.getByLabel("基本信息 · 姓名", { exact: true }).inputValue(), "合成临时姓名");
  assert.equal(await panel.getByLabel("填写档案", { exact: true }).inputValue(), "version-a");
  assert.equal(await page.getByText(previousFailure, { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__browserPanelFixture.connectionCalls), 2);
  await capture(page, "retry-success");
});

test("连接重试再次失败显示本次错误，不回显前一次超时", async (t) => {
  const { page } = await setup(t);
  await startConnect(page);
  await finishConnect(page, previousFailure);
  await startConnect(page);
  await finishConnect(page, currentFailure);
  await page.getByRole("alert").filter({ hasText: currentFailure }).waitFor();
  assert.equal(await page.getByText(previousFailure, { exact: true }).count(), 0);
  assert.equal(await page.getByRole("alert").count(), 1);
  await capture(page, "retry-failure");
});

test("连接重试不清理其它业务提示，成功后其它操作错误仍正常回显", async (t) => {
  const { page, panel } = await setup(t);
  await startConnect(page);
  await finishConnect(page, previousFailure);
  await panel.getByRole("button", { name: "刷新页面列表", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: unrelatedFailure }).waitFor();
  await startConnect(page);
  assert.equal(await page.getByRole("alert").filter({ hasText: unrelatedFailure }).count(), 1);
  assert.equal(await page.getByText(previousFailure, { exact: true }).count(), 0);
  await finishConnect(page);
  await panel.getByText(connectedMessage, { exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").filter({ hasText: unrelatedFailure }).count(), 1);
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await panel.getByRole("button", { name: "核对字段／处理待办", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: unrelatedFailure }).waitFor();
  assert.equal(await panel.getByText(connectedMessage, { exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => window.__browserPanelFixture.state.connected), true);
  await capture(page, "unrelated-error-preserved");
});

test("配套附件替换只向明确的简历入口提供确认按钮", async (t) => {
  const { page, panel } = await setup(t);
  await startConnect(page);
  await finishConnect(page);
  await page.evaluate(() => {
    const common = { type: "file", section: "求职材料", value: "", options: [], path: null,
      required: false, disabled: false, touched: false };
    window.__browserPanelFixture.fields = [
      { ...common, id: "portfolio", label: "作品集", resumeUpload: false },
      { ...common, id: "resume", label: "简历", resumeUpload: true },
    ];
    window.__browserPanelFixture.uploads = [];
  });
  await panel.getByRole("button", { name: "核对字段／处理待办" }).click();
  const field = panel.getByLabel("当前页面字段"), replace = panel.getByRole("button", { name: "确认替换配套附件" });
  await field.selectOption("portfolio");
  await panel.getByText("未确认是简历上传入口，请在网站核对附件用途。").waitFor();
  assert.equal(await replace.count(), 0);
  await field.selectOption("resume");
  await replace.click();
  const dialog = page.getByRole("dialog", { name: "替换已有附件" });
  await dialog.getByRole("button", { name: "取消" }).click();
  assert.deepEqual(await page.evaluate(() => window.__browserPanelFixture.uploads), []);
  await replace.click();
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.__browserPanelFixture.uploads), [
    { kind: "upload", fieldId: "resume", confirmed: true },
  ]);
});
