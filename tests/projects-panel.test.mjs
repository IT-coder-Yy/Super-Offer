import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

let server, browser, origin;
before(async () => {
  server = await createServer({
    configFile: false, envFile: false, publicDir: false, plugins: [react()],
    cacheDir: resolve(".s0-work/projects-panel-vite-cache"),
    optimizeDeps: { entries: ["index.html"] },
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false }, logLevel: "error",
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const executablePath = process.env.SUPER_OFFER_TEST_BROWSER;
  if (executablePath) browser = await chromium.launch({ executablePath });
  else {
    try { browser = await chromium.launch({ channel: "msedge" }); }
    catch { browser = await chromium.launch({ channel: "chrome" }); }
  }
  console.info(`项目材料界面 · 浏览器 ${browser.version()} · 本机受控 IPC`);
});
after(async () => { await browser?.close(); await server?.close(); });

async function setup(t) {
  const context = await browser.newContext();
  const external = [], errors = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(new URL(route.request().url()).origin);
    return route.abort();
  });
  await context.addInitScript(() => {
    const versions = ["a", "b"].map((id) => ({
      id, name: `材料 ${id}`, projectId: id, assetId: `asset-${id}`, createdAt: "2026-11-21T00:00:00Z",
      readableFiles: 1, totalFiles: 1, sourceBytes: 10, allowedPaths: ["src/"], scopeVersion: `scope-${id}`,
    }));
    const workspace = {
      activity: {}, providerStatus: [], dataDirectory: "合成工作区",
      state: { datasetId: "initial", contractVersion: 1, schemaVersion: 2, revision: 0,
        applications: [], events: [], jobs: [], interviews: [], providers: [], profiles: [], tasks: [],
        assets: versions.map(v => ({id: v.assetId, kind: "source", bytes: 10, status: "available"})) },
    };
    const callbacks = new Map(), subscriptions = new Map();
    let callbackId = 0;
    const f = window.projectFixture = {
      searches: [], selections: [], cancels: [], listDatasets: [], delayedFiles: null, holdFilesFor: "",
      replaceDataset() {
        workspace.state.datasetId = "restored";
        for (const handler of subscriptions.values()) handler();
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      transformCallback(fn) { callbacks.set(++callbackId, fn); return callbackId; },
      async invoke(kind, args) {
        if (kind === "plugin:event|listen") {
          if (args.event === "state-changed") subscriptions.set(args.handler, callbacks.get(args.handler));
          return args.handler;
        }
        if (kind === "plugin:event|unlisten") { subscriptions.delete(args.eventId); return; }
        if (kind !== "request") throw Error("未知 IPC " + kind);
        const req = args.request, cmd = req.command;
        if (req.kind === "snapshot") return structuredClone(workspace);
        if (req.kind === "interview" && cmd.kind === "list") return [];
        if (req.kind === "browser" && cmd.kind === "status") return { state: { results: [], status: "disconnected" }, run: null, history: [] };
        if (req.kind === "source_select")
          return new Promise(done => f.selections.push(done));
        if (req.kind !== "source") throw Error("未知请求 " + req.kind);
        const version = versions.find(v => v.id === cmd.versionId);
        switch (cmd.kind) {
          case "list":
            f.listDatasets.push(req.datasetId);
            return { versions: structuredClone(versions), limits: { files: 10, fileBytes: 100, totalBytes: 1000, encoding: "UTF-8" } };
          case "files": {
            const rows = [{ id: version.id, path: `files/${version.id}.rs`, status: "readable", bytes: 10, lines: 1 }];
            if (f.holdFilesFor === version.id) return new Promise(done => { f.delayedFiles = () => done(rows); });
            return rows;
          }
          case "search": {
            const result = [{ evidence: { id: version.id, sourceVersionId: version.id, path: `src/${cmd.query}.rs`,
              fileSha256: "synthetic-hash", startLine: 1, endLine: 1, text: cmd.query }, allowed: !!version.allowedPaths.length }];
            return new Promise(done => f.searches.push({ token: cmd.token, finish: () => done(result) }));
          }
          case "set_scope":
            if (f.holdScope) await new Promise(done => { f.releaseScope = done; });
            version.allowedPaths = cmd.paths;
            version.scopeVersion = crypto.randomUUID();
            return structuredClone(version);
          case "cleanup": {
            const asset = workspace.state.assets.find(a => a.id === version.assetId);
            asset.status = "cleaned";
            version.allowedPaths = [];
            version.scopeVersion = crypto.randomUUID();
            return structuredClone(asset);
          }
          case "cancel":
            f.cancels.push({dataset: req.datasetId, token: cmd.token});
            return true;
          default: throw Error("未知材料操作 " + cmd.kind);
        }
      },
    };
  });
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(15000);
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); assert.deepEqual(external, []); });
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.getByRole("navigation").getByRole("button", { name: "项目材料", exact: true }).click();
  const panel = page.getByRole("region", { name: "项目材料", exact: true });
  await panel.getByText("files/a.rs", { exact: true }).waitFor();
  return { page, panel, query: panel.getByLabel("本地检索关键词"), rows: panel.locator("summary") };
}

async function search(page, query, text, index = 0) {
  await query.fill(text);
  await query.press("Enter");
  await page.waitForFunction(i => !!window.projectFixture.searches[i], index);
}

test("新建面试说明实际外发材料，完整结构化档案仅留在本地", async t => {
  const { page } = await setup(t);
  await page.getByRole("navigation").getByRole("button", { name: "文字面试", exact: true }).click();
  await page.getByRole("button", { name: "新建文字面试", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建文字面试", exact: true });
  await dialog.waitFor();
  const text = await dialog.innerText();
  for (const material of ["已确认的简历文字", "所选岗位", "已发送的回答", "本人说明", "面试设置", "获准项目片段"]) {
    assert.ok(text.includes(material), `缺少外发材料说明：${material}`);
  }
  assert.ok(text.includes("完整结构化档案仅用于本地关联"));
  assert.ok(!text.includes("档案、JD和获准项目片段将按题发送"));
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
});

test("同一检索按两次回车只启动一次，停止后迟到的结果不显示", async t => {
  const { page, panel, query, rows } = await setup(t);
  await search(page, query, "first");
  await query.press("Enter");
  assert.equal(await page.evaluate(() => window.projectFixture.searches.length), 1);
  await panel.getByRole("button", { name: "停止", exact: true }).click();
  await page.waitForFunction(() => window.projectFixture.cancels.some(x => x.token === window.projectFixture.searches[0].token));
  await page.evaluate(() => window.projectFixture.searches[0].finish());
  await panel.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await rows.count(), 0);
  await search(page, query, "second", 1);
  await page.evaluate(() => window.projectFixture.searches[1].finish());
  await rows.filter({ hasText: "src/second.rs" }).waitFor();
});

test("外发范围撤回后，旧结果不能继续标为允许外发", async t => {
  const { page, panel, query, rows } = await setup(t);
  await search(page, query, "source");
  await page.evaluate(() => window.projectFixture.searches[0].finish());
  await rows.filter({ hasText: "在外发范围内" }).waitFor();
  await panel.getByRole("button", { name: "撤回外发授权" }).click();
  await panel.getByText(/尚未授权向模型发送/).waitFor();
  assert.equal(await rows.filter({ hasText: "在外发范围内" }).count(), 0);
  await search(page, query, "source", 1);
  await page.evaluate(() => window.projectFixture.searches[1].finish());
  await rows.filter({ hasText: "仅本地可见" }).waitFor();
});

test("撤回授权时已经启动的检索迟到，旧范围的命中不会重新显示", async t => {
  const { page, panel, query, rows } = await setup(t);
  await page.evaluate(() => { window.projectFixture.holdScope = true; });
  await panel.getByRole("button", { name: "撤回外发授权" }).click();
  await page.waitForFunction(() => !!window.projectFixture.releaseScope);
  await search(page, query, "oldscope");
  await page.evaluate(() => window.projectFixture.releaseScope());
  await panel.getByText(/尚未授权向模型发送/).waitFor();
  await page.evaluate(() => window.projectFixture.searches[0].finish());
  await panel.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await rows.filter({ hasText: "在外发范围内" }).count(), 0);
});

test("清理应用副本后清除检索结果，回车与按钮都不能再触发整库检索", async t => {
  const { page, panel, query, rows } = await setup(t);
  await search(page, query, "livecopy");
  await page.evaluate(() => window.projectFixture.searches[0].finish());
  await rows.filter({ hasText: "src/livecopy.rs" }).waitFor();
  await panel.getByRole("button", { name: "清理完整副本" }).click();
  await page.getByRole("button", { name: "确认清理应用副本" }).click();
  await panel.getByText(/完整材料副本不可用/).waitFor();
  assert.equal(await rows.count(), 0);
  assert.equal(await panel.getByRole("button", { name: "检索固定材料" }).isDisabled(), true);
  await query.press("Enter");
  assert.equal(await page.evaluate(() => window.projectFixture.searches.length), 1);
});

test("切换材料后等待文件清单时不会短暂挂着前一版本的文件", async t => {
  const { page, panel } = await setup(t);
  await page.evaluate(() => { window.projectFixture.holdFilesFor = "b"; });
  await panel.getByLabel("项目及固定版本").selectOption("b");
  await page.waitForFunction(() => !!window.projectFixture.delayedFiles);
  assert.equal(await panel.getByText("files/a.rs", { exact: true }).count(), 0);
  await page.evaluate(() => window.projectFixture.delayedFiles());
  await panel.getByText("files/b.rs", { exact: true }).waitFor();
});

test("选目录期间恢复数据，迟到的原数据集选择会释放", async t => {
  const { page, panel } = await setup(t);
  await panel.getByRole("button", { name: "导入项目目录" }).click();
  await page.waitForFunction(() => !!window.projectFixture.selections.length);
  await page.evaluate(() => window.projectFixture.replaceDataset());
  await page.waitForFunction(() => window.projectFixture.listDatasets.includes("restored"));
  await page.evaluate(() => window.projectFixture.selections[0]({ token: "late-folder", name: "合成目录", isDirectory: true }));
  await page.waitForFunction(() => window.projectFixture.cancels.some(x => x.dataset === "initial" && x.token === "late-folder"),
    undefined, { timeout: 2000 });
  assert.equal(await page.getByRole("dialog").count(), 0);
  await panel.getByRole("button", { name: "导入项目目录" }).click();
  await page.waitForFunction(() => window.projectFixture.selections.length === 2);
  await page.evaluate(() => window.projectFixture.selections[1]({ token: "current-folder", name: "当前目录", isDirectory: true }));
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  assert.deepEqual(await page.evaluate(() => window.projectFixture.cancels), [
    { dataset: "initial", token: "late-folder" }, { dataset: "restored", token: "current-folder" },
  ]);
});
