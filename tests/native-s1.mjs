import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { docx, pdf } from "./fixtures.mjs";

const root = resolve(
  ".s0-work",
  `s1-native-${new Date().toISOString().replaceAll(":", "-")}`,
);
await mkdir(root, { recursive: true });
const executable = resolve(
  process.env.SUPER_OFFER_TEST_EXE ||
    ".s0-work/tauri-target/debug/super-offer.exe",
);
const results = [],
  errors = [];
let browser, page, child;
let service;
async function clearTestKeys() {
  if (!page || page.isClosed()) return;
  const workspace = await invoke("snapshot");
  assert.equal(resolve(workspace.dataDirectory), resolve(root, "data"));
  for (const config of workspace.state.providers) {
    await invoke("save_provider", {
      datasetId: workspace.state.datasetId,
      config: {
        purpose: config.purpose,
        name: config.name,
        endpoint: config.endpoint,
        model: config.model,
        expectedVersion: config.version,
        key: null,
        removeKey: true,
      },
    });
  }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function step(name, fn) {
  await fn();
  results.push({ name, status: "通过", at: new Date().toISOString() });
  console.log(`PASS ${name}`);
}
async function poll(fn, message) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await delay(100);
  }
  throw Error(message);
}
async function invoke(kind, fields = {}) {
  return page.evaluate(
    ({ kind, fields }) =>
      window.__TAURI_INTERNALS__.invoke("request", {
        request: { kind, ...fields },
      }),
    { kind, fields },
  );
}
async function snapshot() {
  return (await invoke("snapshot")).state;
}
async function start() {
  const port = await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  child = spawn(executable, [], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SUPER_OFFER_DATA_DIR: join(root, "data"),
      WEBVIEW2_USER_DATA_FOLDER: join(root, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
  child.on("error", (error) => errors.push(error.message));
  await poll(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      if (child.exitCode !== null)
        throw Error(`原生程序提前退出 ${child.exitCode}`);
      return false;
    }
  }, "原生 WebView 未就绪");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await poll(async () => {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find(
        (p) =>
          p.url().includes("tauri.localhost") || p.url().startsWith("tauri:"),
      );
    return !!page;
  }, "没有本地应用页面");
  page.setDefaultTimeout(7000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "新增申请", exact: true }).waitFor();
}
async function stop() {
  if (page && !page.isClosed())
    await invoke("exit", { confirmed: true }).catch(() => {});
  if (child && child.exitCode === null)
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(4000),
    ]);
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) child.kill();
  browser = null;
  page = null;
}
async function tab(name) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
}
async function saveProfile() {
  await page.getByRole("button", { name: "保存进度", exact: true }).click();
  await poll(
    async () =>
      !(await page.locator(".profile-editor").innerText()).includes(
        "有未保存修改",
      ),
    "档案保存未完成",
  );
}
async function summary(title) {
  const locator = page
    .locator(".profile-editor details")
    .filter({ has: page.locator("summary", { hasText: title }) })
    .first();
  if (!(await locator.getAttribute("open")))
    await locator.locator("summary").click();
  return locator;
}
async function importFile(path) {
  await page.getByLabel("选择简历文件").setInputFiles(path);
  await page.getByRole("dialog", { name: "核对简历提取内容" }).waitFor();
}

try {
  const sourceLines = [
    "姓名：合成求职者",
    "手机：13800000000",
    "邮箱：sample@example.test",
    "教育经历",
    "学校：样本大学；专业：计算机；开始时间：2022-09；结束时间：2026-06",
    "项目经历",
    "项目名称：合成项目；个人贡献：仅供验收；项目介绍：原项目描述",
    "自定义问答",
    "题目：为什么选择我们？；回答：合成回答，不是个人真实经历。",
  ];
  const resume = join(root, "resume.docx"),
    revised = join(root, "revised.pdf"),
    scanned = join(root, "no-text.pdf"),
    bad = join(root, "bad.docx");
  await writeFile(resume, docx(sourceLines));
  await writeFile(
    revised,
    pdf([
      "姓名：合成求职者",
      "教育经历",
      "学校：样本大学；开始时间：2023-09；结束时间：2027-06",
      "专业技能",
      "技术技能：Rust、TypeScript",
    ]),
  );
  await writeFile(scanned, pdf([]));
  await writeFile(bad, "not a DOCX");
  await start();
  await step("AC01 / AC34：中文 DOCX 提取、人工确认、缺项保存", async () => {
    await tab("个人档案");
    await page.getByLabel("档案名称", { exact: true }).fill("AI 开发 · 样本 A");
    await importFile(resume);
    const dialog = page.getByRole("dialog");
    assert.match(
      await dialog.locator(".source-text").innerText(),
      /合成求职者/,
    );
    await dialog.getByRole("button", { name: "应用已确认字段" }).click();
    assert.equal(
      await page.getByLabel("姓名", { exact: true }).inputValue(),
      "合成求职者",
    );
    await saveProfile();
    const state = await snapshot();
    assert.equal(state.profiles.length, 1);
    assert.equal(
      state.profiles[0].versions[0].data.answers[0].answer,
      "合成回答，不是个人真实经历。",
    );
    assert.equal(state.profiles[0].versions[0].data.experience.length, 0);
  });
  await step("AC02 / AC37：复制隔离、自定义问答与独立版本", async () => {
    await page.getByRole("button", { name: "复制档案", exact: true }).click();
    await page.getByLabel("新档案名称").fill("后端开发 · 样本 B");
    await page.getByRole("button", { name: "确认复制" }).click();
    await poll(
      async () => (await snapshot()).profiles.length === 2,
      "复制未完成",
    );
    await poll(
      async () =>
        (
          await page.getByLabel("档案名称", { exact: true }).inputValue()
        ).includes("样本 B"),
      "副本选择未完成",
    );
    await summary("项目经历");
    await page.getByLabel("项目介绍", { exact: true }).fill("B 档案独立修改");
    await summary("自定义问答");
    await page
      .getByLabel("回答", { exact: true })
      .fill("用户主动编辑的 B 回答");
    await saveProfile();
    const state = await snapshot();
    const a = state.profiles.find((p) => p.name.includes("样本 A"));
    assert.equal(a.versions[0].data.projects[0].description, "原项目描述");
    assert.equal(
      a.versions[0].data.answers[0].answer,
      "合成回答，不是个人真实经历。",
    );
  });
  await step("AC03 / AC34：中文 PDF、日期冲突、仅本次与更新档案", async () => {
    await importFile(revised);
    const dialog = page.getByRole("dialog");
    assert.match(await dialog.locator(".source-text").innerText(), /2023-09/);
    const start = dialog
      .locator(".suggestion")
      .filter({ has: page.locator("strong", { hasText: "开始时间" }) });
    const end = dialog
      .locator(".suggestion")
      .filter({ has: page.locator("strong", { hasText: "结束时间" }) });
    assert.equal(await start.locator("select").inputValue(), "pending");
    await start.locator("select").selectOption("once");
    await end.locator("select").selectOption("save");
    await dialog.getByRole("button", { name: "应用已确认字段" }).click();
    assert.equal(
      await page.getByLabel("开始时间", { exact: true }).first().inputValue(),
      "2022-09",
    );
    await saveProfile();
    const state = await snapshot();
    const b = state.profiles.find((p) => p.name.includes("样本 B"));
    const latest = b.versions.find((v) => v.id === b.currentVersionId);
    assert.equal(latest.data.education[0].startDate, "2022-09");
    assert.equal(latest.data.education[0].endDate, "2027-06");
    await page.getByRole("button", { name: "查看本次资料" }).click();
    const preview = page.getByRole("dialog");
    assert.equal(
      await preview
        .getByLabel("开始时间", { exact: true })
        .first()
        .inputValue(),
      "2023-09",
    );
    await preview.getByRole("button", { name: "关闭", exact: true }).click();
    await page.locator(".profile-option").filter({ hasText: "样本 A" }).click();
    await page.getByRole("button", { name: "不保存直接切换" }).click();
    await poll(
      async () =>
        (
          await page.getByLabel("档案名称", { exact: true }).inputValue()
        ).includes("样本 A"),
      "档案 A 尚未选中",
    );
  });
  await step("AC04：取消、不保存、保存并切换、失败保留草稿", async () => {
    const aButton = page
      .locator(".profile-option")
      .filter({ hasText: "样本 A" });
    const bButton = page
      .locator(".profile-option")
      .filter({ hasText: "样本 B" });
    await page.getByLabel("姓名", { exact: true }).fill("未保存修改");
    await bButton.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("姓名", { exact: true }).inputValue(),
      "未保存修改",
    );
    await bButton.click();
    await page.getByRole("button", { name: "不保存直接切换" }).click();
    await aButton.click();
    await poll(
      async () =>
        (
          await page.getByLabel("档案名称", { exact: true }).inputValue()
        ).includes("样本 A"),
      "档案 A 尚未选中",
    );
    assert.equal(
      await page.getByLabel("姓名", { exact: true }).inputValue(),
      "合成求职者",
    );
    await page.getByLabel("现居城市").fill("杭州");
    await bButton.click();
    await page.getByRole("button", { name: "保存并切换" }).click();
    await poll(
      async () =>
        (await page.getByLabel("档案名称").inputValue()).includes("样本 B"),
      "未切换",
    );
    await aButton.click();
    await poll(
      async () =>
        (
          await page.getByLabel("档案名称", { exact: true }).inputValue()
        ).includes("样本 A"),
      "档案 A 尚未选中",
    );
    assert.equal(await page.getByLabel("现居城市").inputValue(), "杭州");
    await page.getByLabel("档案名称").fill("");
    await bButton.click();
    await page.getByRole("button", { name: "保存并切换" }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(
      await page.getByLabel("档案名称", { exact: true }).inputValue(),
      "",
    );
    assert.ok(await page.getByRole("dialog").isVisible());
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await page.getByLabel("档案名称", { exact: true }).fill("AI 开发 · 样本 A");
  });
  await step("AC34：无文字 PDF 和损坏 DOCX 明确失败", async () => {
    for (const file of [scanned, bad]) {
      await page.getByLabel("选择简历文件").setInputFiles(file);
      await page.getByRole("alert").waitFor();
      await poll(
        async () =>
          !(await page
            .getByRole("button", { name: "导入简历预填" })
            .isDisabled()),
        "导入未结束",
      );
      assert.equal(await page.getByRole("dialog").count(), 0);
    }
    assert.equal((await snapshot()).assets.length, 2);
  });
  await step(
    "AC16 / AC17 / AC38：真实提交确认、阶段、待办与多轮面试",
    async () => {
      await tab("投递看板");
      await page.getByRole("button", { name: "新增申请", exact: true }).click();
      await page.getByLabel("公司", { exact: true }).fill("样本公司");
      await page.getByLabel("岗位", { exact: true }).fill("AI 应用开发");
      await page.getByLabel("招聘渠道").fill("官网");
      await page.getByLabel("招聘批次").fill("秋招");
      await page.getByLabel("岗位描述 / JD").fill("仅供验收的岗位");
      const state = await snapshot();
      await page
        .getByLabel("关联档案版本")
        .selectOption(state.profiles[0].currentVersionId);
      await page.getByRole("button", { name: "保存申请", exact: true }).click();
      await poll(
        async () => (await snapshot()).applications.length === 1,
        "申请未保存",
      );
      assert.equal(
        (await snapshot()).applications[0].confirmedSubmittedAt,
        null,
      );
      await page
        .getByRole("button", { name: "确认已提交", exact: true })
        .click();
      await page.getByLabel("我已在招聘网站完成最终提交").check();
      await page
        .getByRole("button", { name: "记录已提交", exact: true })
        .click();
      await poll(
        async () => !!(await snapshot()).applications[0].confirmedSubmittedAt,
        "提交未记录",
      );
      await page.getByLabel("当前阶段").selectOption("interview");
      await page.getByLabel("下一步待办").fill("准备技术面试");
      await page.getByRole("button", { name: "保存申请", exact: true }).click();
      await poll(
        async () => (await snapshot()).applications[0].stage === "interview",
        "阶段未保存",
      );
      for (const n of [1, 2]) {
        await page
          .getByRole("button", { name: "添加轮次", exact: true })
          .click();
        await page.getByLabel("轮次名称").fill(`技术 ${n} 面`);
        await page
          .getByLabel("面试时间", { exact: true })
          .fill(`2026-11-2${n}T10:00`);
        await page.getByRole("button", { name: "保存轮次" }).click();
        await poll(
          async () => (await snapshot()).interviews.length === n,
          "轮次未保存",
        );
      }
      assert.equal(
        (await snapshot()).events.filter((e) => e.kind === "submitted").length,
        1,
      );
      await page.getByLabel("当前阶段").selectOption("offer");
      await page.getByRole("button", { name: "保存申请", exact: true }).click();
      await poll(
        async () => (await snapshot()).applications[0].stage === "offer",
        "Offer 未保存",
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(root, "board.png") });
      await page.getByLabel("当前阶段").selectOption("closed");
      await page.getByLabel("结束原因").selectOption("joined");
      await page.getByRole("button", { name: "保存申请", exact: true }).click();
      await poll(
        async () => (await snapshot()).applications[0].stage === "closed",
        "结束未保存",
      );
      assert.match(
        await page.locator(".summary-line").innerText(),
        /本人确认已投 1 份/,
      );
    },
  );
  await step(
    "S1-06：原生独立配置、普通／SSE／multipart、停止及未知用量",
    async () => {
      const received = [];
      service = httpServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        received.push({
          url: request.url,
          contentType: request.headers["content-type"],
          body: body.toString(),
        });
        assert.equal(
          request.headers.authorization,
          "Bearer synthetic-native-fixture-key",
        );
        if (request.url === "/asr") {
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              text: "可控服务的合成转写，不代表真实识别效果。",
            }),
          );
          return;
        }
        const input = JSON.parse(body);
        if (!input.stream) {
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              choices: [{ message: { content: "普通协议通过" } }],
              usage: {
                prompt_tokens: 3,
                completion_tokens: 4,
                total_tokens: 7,
              },
            }),
          );
          return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "已收到合成内容" } }] })}\n\n`,
        );
        if (input.messages[0].content.includes("cancel")) {
          const timer = setTimeout(
            () => response.end("data: [DONE]\n\n"),
            5000,
          );
          response.on("close", () => clearTimeout(timer));
        } else
          response.end(
            `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 7 } })}\n\ndata: [DONE]\n\n`,
          );
      });
      await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
      const endpoint = `http://127.0.0.1:${service.address().port}`;
      await tab("AI 服务");
      const configs = page.locator(".provider-grid > .settings-section");
      for (const [i, purpose] of ["chat", "asr"].entries()) {
        const form = configs.nth(i);
        await form
          .getByLabel("服务名称", { exact: true })
          .fill(`合成 ${purpose} 服务`);
        await form
          .getByLabel("模型名称", { exact: true })
          .fill(`${purpose}-fixture`);
        await form
          .getByLabel("完整接口地址", { exact: true })
          .fill(`${endpoint}/${purpose}`);
        await form
          .getByLabel("API Key", { exact: true })
          .fill("synthetic-native-fixture-key");
        await form
          .getByRole("button", {
            name: i === 0 ? "保存聊天配置" : "保存转写配置",
          })
          .click();
        await poll(
          async () =>
            (await invoke("snapshot")).providerStatus.some(
              (p) => p.purpose === purpose && p.hasKey,
            ),
          "Key 未保存",
        );
        assert.equal(
          await form.getByLabel("API Key", { exact: true }).inputValue(),
          "",
        );
      }
      await page.getByLabel("流式接收", { exact: true }).uncheck();
      await page.getByRole("button", { name: "发送测试", exact: true }).click();
      await poll(
        async () =>
          (await snapshot()).tasks.filter((t) => t.status === "completed")
            .length === 1,
        "普通任务未完成",
      );
      await page.getByLabel("流式接收", { exact: true }).check();
      await page.getByRole("button", { name: "发送测试", exact: true }).click();
      await poll(
        async () =>
          (await snapshot()).tasks.filter((t) => t.status === "completed")
            .length === 2,
        "流式任务未完成",
      );
      await page.getByLabel("测试文字", { exact: true }).fill("cancel fixture");
      await page.getByRole("button", { name: "发送测试", exact: true }).click();
      await poll(
        async () =>
          (await snapshot()).tasks.some(
            (t) => t.status === "running" && t.content,
          ),
        "未收到可保留部分内容",
      );
      await page.getByRole("button", { name: "停止任务", exact: true }).click();
      await poll(
        async () =>
          (await snapshot()).tasks.some(
            (t) => t.status === "cancelled" && t.content,
          ),
        "取消未保留结果",
      );
      await page.getByLabel("音频转写", { exact: true }).check();
      const audio = Buffer.alloc(3244);
      audio.write("RIFF");
      audio.writeUInt32LE(3236, 4);
      audio.write("WAVEfmt ", 8);
      audio.writeUInt32LE(16, 16);
      audio.writeUInt16LE(1, 20);
      audio.writeUInt16LE(1, 22);
      audio.writeUInt32LE(16000, 24);
      audio.writeUInt32LE(32000, 28);
      audio.writeUInt16LE(2, 32);
      audio.writeUInt16LE(16, 34);
      audio.write("data", 36);
      audio.writeUInt32LE(3200, 40);
      const audioFile = join(root, "synthetic.wav");
      await writeFile(audioFile, audio);
      await page
        .getByLabel("测试音频", { exact: true })
        .setInputFiles(audioFile);
      await page.getByRole("button", { name: "发送测试", exact: true }).click();
      await poll(
        async () =>
          (await snapshot()).tasks.some(
            (t) => t.purpose === "asr" && t.status === "completed",
          ),
        "ASR 未完成",
      );
      const asr = (await snapshot()).tasks.find((t) => t.purpose === "asr");
      assert.equal(asr.usage.totalTokens, null);
      assert.equal(asr.usage.cost, null);
      assert.match(
        received.find((r) => r.url === "/asr").contentType,
        /multipart/,
      );
      assert.match(received.find((r) => r.url === "/asr").body, /name="model"/);
      for (const i of [0, 1]) {
        const form = configs.nth(i);
        await form.getByLabel("删除已保存的 Key").check();
        await form
          .getByRole("button", {
            name: i === 0 ? "保存聊天配置" : "保存转写配置",
          })
          .click();
        await poll(
          async () =>
            !(await invoke("snapshot")).providerStatus.find(
              (p) => p.purpose === (i === 0 ? "chat" : "asr"),
            ).hasKey,
          "合成 Key 未清理",
        );
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(root, "models.png") });
      assert.equal((await snapshot()).tasks.length, 4);
      service.closeAllConnections();
      await new Promise((resolve) => service.close(resolve));
      service = null;
    },
  );
  let exported, expected;
  await step("AC35：界面导出与清单校验", async () => {
    await tab("数据备份");
    await page.getByLabel("包含已导入的测试音频副本").check();
    await page.getByRole("button", { name: "生成备份", exact: true }).click();
    await page.locator(".backup-receipt").waitFor();
    exported = await page.locator(".backup-receipt .path").innerText();
    expected = await snapshot();
    assert.ok((await readFile(exported)).length > 0);
  });
  await step("S1-08：退出原生进程、重启读取相同档案和申请", async () => {
    await stop();
    await start();
    const actual = await snapshot();
    assert.deepEqual(actual, expected);
    await tab("个人档案");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(root, "profiles.png") });
  });
  await step("AC36：取消恢复不改变数据，确认后先备份再整体替换", async () => {
    const state = await snapshot();
    await invoke("mutate", {
      datasetId: state.datasetId,
      operationId: crypto.randomUUID(),
      mutation: {
        kind: "copy_profile",
        versionId: state.profiles[0].currentVersionId,
        name: "恢复后不应合并的档案",
      },
    });
    await tab("数据备份");
    await page.getByLabel("选择 Super-Offer 备份").setInputFiles(exported);
    await page.getByRole("dialog", { name: "核对整体恢复范围" }).waitFor();
    await page.getByRole("button", { name: "取消恢复", exact: true }).click();
    assert.equal((await snapshot()).profiles.length, 3);
    await page.getByLabel("选择 Super-Offer 备份").setInputFiles(exported);
    await page.getByRole("dialog", { name: "核对整体恢复范围" }).waitFor();
    await page.screenshot({
      path: join(root, "restore-preview.png"),
      fullPage: true,
    });
    await page.getByLabel("我已核对范围，确认整体替换当前工作区").check();
    await page
      .getByRole("button", { name: "先备份当前数据并整体恢复", exact: true })
      .click();
    await poll(
      async () => (await snapshot()).datasetId !== expected.datasetId,
      "恢复未完成",
    );
    const actual = await snapshot();
    assert.equal(actual.profiles.length, 2);
    assert.deepEqual(actual.profiles, expected.profiles);
    assert.deepEqual(actual.applications, expected.applications);
    assert.deepEqual(actual.interviews, expected.interviews);
    assert.equal(actual.assets.length, 3);
    assert.match(await page.getByRole("status").innerText(), /恢复前备份/);
  });
  await step("S1-08：恢复后再次重启仍为同一套完整数据", async () => {
    const before = await snapshot();
    await stop();
    await start();
    assert.deepEqual(await snapshot(), before);
    assert.equal(errors.length, 0, errors.join("\n"));
  });
  await step("离线许可与 900×620 窄窗口布局", async () => {
    await tab("数据备份");
    await page.getByText("第三方许可", { exact: true }).click();
    await page
      .getByRole("button", { name: "查看第三方许可", exact: true })
      .click();
    await page.getByRole("dialog", { name: "第三方许可全文" }).waitFor();
    assert.match(
      await page.getByLabel("第三方许可全文内容").inputValue(),
      /Mozilla Public License/,
    );
    await page.screenshot({ path: join(root, "licenses.png") });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await tab("投递看板");
    assert.equal(await page.locator(".todo-row").count(), 0);
    await page.setViewportSize({ width: 900, height: 620 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({ path: join(root, "board-900.png") });
  });
  await step("PR1：保存轮次期间锁定编辑和关闭，失败保留草稿并可重试", async () => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.locator(".row-link").first().click();
    await page.getByRole("button", { name: "添加轮次", exact: true }).click();
    await page.getByLabel("轮次名称", { exact: true }).fill("回归轮次 A");
    await page.getByLabel("面试时间", { exact: true }).fill("2026-12-01T10:00");
    const before = (await snapshot()).interviews.length;
    // 只延迟本次合成请求；成功分支仍调用真实 Rust 后端。
    await page.evaluate(() => {
      window.regressionFetch = window.fetch;
      window.fetch = (input, options) => {
        let request;
        if (typeof options?.body === "string") {
          try { request = JSON.parse(options.body).request; } catch {}
        }
        if (request?.mutation?.kind !== "save_interview")
          return window.regressionFetch(input, options);
        return new Promise((resolve, reject) => {
          window.releaseInterview = (fail) => {
            window.releaseInterview = null;
            if (fail) resolve(new Response(JSON.stringify({
              code: "WRITE_FAILED", message: "合成写入失败，请重试。",
            }), { headers: { "Content-Type": "application/json", "Tauri-Response": "error" } }));
            else window.regressionFetch(input, options).then(resolve, reject);
          };
        });
      };
    });
    try {
      const dialog = page.getByRole("dialog", { name: "添加面试轮次" });
      for (const fail of [true, false]) {
        await dialog.getByRole("button", { name: "保存轮次", exact: true }).click();
        await poll(() => page.evaluate(() => !!window.releaseInterview), "未收到合成保存请求");
        for (const label of ["轮次名称", "面试时间", "地点或会议链接", "轮次备注", "此轮面试已完成"])
          assert.ok(await dialog.getByLabel(label, { exact: true }).isDisabled());
        for (const name of ["保存轮次", "取消", "关闭对话框"])
          assert.ok(await dialog.getByRole("button", { name, exact: true }).isDisabled());
        await page.keyboard.press("Escape");
        assert.ok(await dialog.isVisible());
        await page.evaluate((fail) => window.releaseInterview(fail), fail);
        if (fail) {
          await poll(async () => await dialog.getByLabel("轮次名称").isEnabled(), "失败后没有解锁");
          assert.equal(await dialog.getByLabel("轮次名称").inputValue(), "回归轮次 A");
          assert.equal((await snapshot()).interviews.length, before);
          await dialog.getByLabel("轮次名称").fill("回归轮次 B");
        } else {
          await poll(async () => await dialog.count() === 0, "成功后未关闭");
          const rounds = (await snapshot()).interviews;
          assert.equal(rounds.length, before + 1);
          assert.ok(rounds.some((r) => r.title === "回归轮次 B"));
        }
      }
    } finally {
      await page.evaluate(() => { window.fetch = window.regressionFetch; });
    }
  });
  await step("PR1：分段 DOCX 新增同校经历、更新与歧义手动映射", async () => {
    await tab("个人档案");
    await page.getByLabel("学历", { exact: true }).first().fill("本科");
    await saveProfile();
    const added = join(root, "same-school-paragraphs.docx");
    await writeFile(added, docx([
      "教育经历", "学校：样本大学", "学历：本科", "开始时间：2022-09", "结束时间：2026-06",
      "学校：样本大学", "学历：硕士", "开始时间：2026-09", "结束时间：2029-06",
    ]));
    await importFile(added);
    const review = page.getByRole("dialog", { name: "核对简历提取内容" });
    assert.equal(await review.locator(".suggestion").count(), 4);
    for (const label of await review.locator(".suggestion strong").allTextContents())
      assert.match(label, /教育经历 2/);
    assert.equal(await review.getByRole("status").count(), 0);
    await review.getByRole("button", { name: "应用已确认字段" }).click();
    assert.equal(await page.getByLabel("学校", { exact: true }).count(), 2);
    assert.equal(await page.getByLabel("学历", { exact: true }).first().inputValue(), "本科");
    assert.equal(await page.getByLabel("结束时间", { exact: true }).first().inputValue(), "2026-06");
    assert.equal(await page.getByLabel("学历", { exact: true }).nth(1).inputValue(), "硕士");
    assert.equal(await page.getByLabel("开始时间", { exact: true }).nth(1).inputValue(), "2026-09");
    assert.equal(await page.getByLabel("结束时间", { exact: true }).nth(1).inputValue(), "2029-06");
    await saveProfile();
    const updated = join(root, "same-school.docx");
    await writeFile(updated, docx(["教育经历", "学校：样本大学", "学历：硕士", "开始时间：2026-09", "结束时间：2030-06"]));
    await importFile(updated);
    assert.equal(await review.locator(".suggestion").count(), 1);
    assert.match(await review.locator(".suggestion strong").innerText(), /教育经历 2.*结束时间/);
    await review.locator(".suggestion select").selectOption("save");
    await review.getByRole("button", { name: "应用已确认字段" }).click();
    assert.equal(await page.getByLabel("学历", { exact: true }).first().inputValue(), "本科");
    assert.equal(await page.getByLabel("结束时间", { exact: true }).nth(1).inputValue(), "2030-06");
    await saveProfile();
    const ambiguous = join(root, "ambiguous-school.docx");
    await writeFile(ambiguous, docx(["教育经历", "学校：样本大学；结束时间：2031-06"]));
    await importFile(ambiguous);
    assert.match(await review.getByRole("status").innerText(), /无法唯一匹配/);
    assert.equal(await review.locator(".suggestion").count(), 0);
    await review.getByText("手动映射原文到字段", { exact: true }).click();
    await review.getByLabel("目标字段").selectOption("education.1.endDate");
    await review.getByLabel("已核对的文字").fill("2031-06");
    await review.getByRole("button", { name: "加入待确认字段" }).click();
    await review.locator(".suggestion select").selectOption("save");
    await review.getByRole("button", { name: "应用已确认字段" }).click();
    await saveProfile();
    assert.equal(await page.getByLabel("学历", { exact: true }).first().inputValue(), "本科");
    assert.equal(await page.getByLabel("结束时间", { exact: true }).nth(1).inputValue(), "2031-06");
  });
  await step("PR1：连续导入替换临时值，待确认及其他字段保留，清空后更新简历来源", async () => {
    const review = page.getByRole("dialog", { name: "核对简历提取内容" });
    async function choose(name, lines, choice) {
      const file = join(root, name);
      await writeFile(file, docx(lines));
      await importFile(file);
      const selects = review.locator(".suggestion select");
      assert.ok(await selects.count() > 0);
      for (const select of await selects.all()) await select.selectOption(choice);
      await review.getByRole("button", { name: "应用已确认字段" }).click();
    }
    async function preview(phone) {
      await page.getByRole("button", { name: "查看本次资料" }).click();
      const dialog = page.getByRole("dialog", { name: "本次资料预览" });
      assert.equal(await dialog.getByLabel("手机", { exact: true }).inputValue(), phone);
      assert.equal(await dialog.getByLabel("邮箱", { exact: true }).inputValue(), "once@example.test");
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    }
    await choose("once.docx", ["手机：13900000000", "邮箱：once@example.test"], "once");
    await preview("13900000000");
    await choose("save.docx", ["手机：13700000000"], "save");
    await saveProfile();
    assert.equal(await page.getByLabel("手机", { exact: true }).inputValue(), "13700000000");
    await preview("13700000000");
    assert.match(await page.locator(".profile-editor .notice").first().innerText(), /本次简历：once.docx/);
    await choose("new-once.docx", ["手机：13600000000"], "once");
    await preview("13600000000");
    await choose("pending.docx", ["手机：13500000000"], "pending");
    assert.ok(await review.isVisible());
    assert.equal(await review.locator(".suggestion select").inputValue(), "pending");
    await review.getByRole("button", { name: "取消预填" }).click();
    await preview("13600000000");
    await choose("keep.docx", ["手机：13500000000"], "keep");
    await preview("13700000000");
    await choose("clear-last.docx", ["邮箱：different@example.test"], "keep");
    assert.equal(await page.getByRole("button", { name: "查看本次资料" }).count(), 0);
    await saveProfile();
    const state = await snapshot();
    const profile = state.profiles[0];
    const data = profile.versions.find((v) => v.id === profile.currentVersionId).data;
    assert.equal(data.basic.phone, "13700000000");
    assert.equal(state.assets.find((a) => a.id === data.resumeAssetId).name, "clear-last.docx");
  });
  await step("PR1：学历前置重导入不重复，缺学校的后条不污染已保存经历", async () => {
    await page.getByRole("button", { name: "新建档案", exact: true }).click();
    await page.getByLabel("档案名称", { exact: true }).fill("经历边界回归");
    const reordered = join(root, "degree-first.docx");
    await writeFile(reordered, docx([
      "教育经历",
      "学历：本科；学校：甲大学；开始时间：2018-09；结束时间：2022-06",
      "学历：硕士；学校：乙大学；开始时间：2022-09；结束时间：2026-06",
    ]));
    const expected = [
      { school: "甲大学", degree: "本科", startDate: "2018-09", endDate: "2022-06" },
      { school: "乙大学", degree: "硕士", startDate: "2022-09", endDate: "2026-06" },
    ];
    async function savedEducation() {
      const profile = (await snapshot()).profiles.find((p) => p.name === "经历边界回归");
      return profile.versions.find((v) => v.id === profile.currentVersionId).data.education;
    }
    const review = page.getByRole("dialog", { name: "核对简历提取内容" });
    for (const count of [8, 0]) {
      await importFile(reordered);
      assert.equal(await review.locator(".suggestion").count(), count);
      assert.equal(await review.getByRole("status").count(), 0);
      await review.getByRole("button", { name: "应用已确认字段" }).click();
      await saveProfile();
      assert.deepEqual(await savedEducation(), expected);
    }
    for (const tail of [
      ["专业：计算机；学历：硕士；开始时间：2022-09；结束时间：2026-06"],
      ["学校：", "专业：计算机", "学历：硕士", "开始时间：2022-09", "结束时间：2026-06"],
    ]) {
      const partial = join(root, "missing-school.docx");
      await writeFile(partial, docx([
        "教育经历", "学校：甲大学；学历：本科；开始时间：2018-09；结束时间：2022-06", ...tail,
      ]));
      await importFile(partial);
      assert.match(await review.getByRole("status").innerText(), /缺少学校/);
      assert.equal(await review.locator(".suggestion").count(), 0);
      assert.match(await review.locator(".source-text").innerText(), /计算机/);
      await review.getByRole("button", { name: "应用已确认字段" }).click();
      await saveProfile();
      assert.deepEqual(await savedEducation(), expected);
    }
  });
  assert.equal(errors.length, 0, errors.join("\n"));
  await writeFile(
    join(root, "results.json"),
    JSON.stringify(
      {
        status: "通过",
        executable,
        webviewVersion: await browser.version(),
        root,
        results,
        errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  if (page) {
    await page
      .screenshot({ path: join(root, "failure.png"), fullPage: true })
      .catch(() => {});
    await writeFile(
      join(root, "failure-dom.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
  }
  await writeFile(
    join(root, "results.json"),
    JSON.stringify(
      {
        status: "失败",
        executable,
        root,
        results,
        errors,
        failure: String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  if (service) {
    service.closeAllConnections();
    service.close();
  }
  if (process.exitCode) await clearTestKeys().catch(() => {});
  await stop();
  console.log(`证据目录：${root}`);
}
