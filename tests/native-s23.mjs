import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as portServer } from "node:net";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { docx } from "./fixtures.mjs";

const root = resolve(".s0-work", `s23-native-${new Date().toISOString().replaceAll(":", "-")}`);
const executable = resolve(process.env.SUPER_OFFER_TEST_EXE || ".s0-work/tauri-target/debug/super-offer.exe");
await mkdir(root, { recursive: true });
const results = [], errors = [], requests = [];
const sentPrompts = [];
const resumeApproved = "受控简历核准使用的片段";
const resumePrivate = "受控简历只供本地预览的段落";
let browser, page, child, service, datasetId, applicationId, practiceId, repracticeId, simulationId;
let failFollowUp = false, holdQuestion = false, webviewVersion;
let blameNextSkip = false, prematureFeedback = false;
const prematureMarker = "本机模拟服务在追问阶段提前返回的整场评价";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function poll(fn, message) {
  for (let i = 0; i < 150; i++) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  throw Error(message);
}
async function step(name, fn) {
  await fn();
  results.push({ name, status: "通过", at: new Date().toISOString() });
  console.log(`PASS ${name}`);
}
async function invoke(kind, fields = {}) {
  return page.evaluate(async ({ kind, fields }) => {
    try { return await window.__TAURI_INTERNALS__.invoke("request", { request: { kind, ...fields } }); }
    catch (error) { throw Error(JSON.stringify(error)); }
  }, { kind, fields });
}
async function snapshot() { return (await invoke("snapshot")).state; }
async function interview(command) { return invoke("interview", { datasetId, command }); }
async function view(sessionId) { return interview({ kind: "get", sessionId }); }
async function waitView(sessionId, predicate, message) {
  return poll(async () => { const value = await view(sessionId); return predicate(value) && value; }, message);
}
async function tab(name) { await page.getByRole("navigation").getByRole("button", { name, exact: true }).click(); }
async function click(name) { await page.getByRole("button", { name, exact: true }).click(); }
async function start() {
  const port = await new Promise((done) => {
    const server = portServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => done(port)); });
  });
  child = spawn(executable, [], { windowsHide: true, stdio: "ignore", env: {
    ...process.env, SUPER_OFFER_DATA_DIR: join(root, "data"), WEBVIEW2_USER_DATA_FOLDER: join(root, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  } });
  child.on("error", (error) => errors.push(error.message));
  await poll(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; }
    catch { if (child.exitCode !== null) throw Error(`原生程序提前退出 ${child.exitCode}`); return false; }
  }, "原生 WebView 未就绪");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  await poll(() => {
    page = browser.contexts().flatMap((context) => context.pages()).find((p) => p.url().includes("tauri.localhost") || p.url().startsWith("tauri:"));
    return !!page;
  }, "没有本地应用页面");
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("navigation").waitFor();
  const workspace = await invoke("snapshot");
  assert.equal(resolve(workspace.dataDirectory), resolve(root, "data"));
  datasetId = workspace.state.datasetId;
  webviewVersion = await browser.version();
}
async function stop() {
  if (page && !page.isClosed()) await invoke("exit", { confirmed: true }).catch(() => {});
  if (child && child.exitCode === null) await Promise.race([new Promise((done) => child.once("exit", done)), delay(4000)]);
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) child.kill();
  page = browser = null;
}
async function clearKey() {
  if (!page || page.isClosed()) return;
  const workspace = await invoke("snapshot");
  assert.equal(resolve(workspace.dataDirectory), resolve(root, "data"));
  for (const config of workspace.state.providers) {
    await invoke("save_provider", { datasetId, config: { purpose: config.purpose, name: config.name,
      endpoint: config.endpoint, model: config.model, expectedVersion: config.version, key: null, removeKey: true } });
  }
}
async function screenshots(name) {
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: width === 900 ? 620 : 820 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} 在 ${width} 宽溢出`);
    await page.screenshot({ path: join(root, `${name}-${width}.png`), fullPage: true });
  }
}
async function newSession(mode) {
  const prior = new Set((await interview({ kind: "list" })).map((item) => item.id));
  await click("新建文字面试");
  const dialog = page.getByRole("dialog", { name: "新建文字面试", exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel("主问题数量").inputValue(), "6");
  assert.equal(await dialog.getByLabel("面试模式").inputValue(), "practice");
  await dialog.getByLabel("面试模式").selectOption(mode);
  await dialog.getByLabel("关联申请（可选）", { exact: true }).selectOption(applicationId);
  await dialog.getByLabel("我实际负责的内容", { exact: true }).fill("我会先保存状态；这是合成样本，不是真实经历。");
  await dialog.getByLabel("本场重点／检索关键词（可选）").fill("任务取消和失败恢复");
  await dialog.getByRole("button", { name: "保存场次", exact: true }).click();
  const created = await poll(async () => (await interview({ kind: "list" })).find((item) => !prior.has(item.id)), "场次未保存");
  await dialog.waitFor({ state: "hidden" });
  const current = await view(created.id);
  assert.equal(current.session.mode, mode);
  assert.equal(current.session.questionCount, 6);
  assert.equal(current.session.applicationId, applicationId);
  assert.equal(current.session.turns.length, 0);
  return created.id;
}
async function startQuestion(sessionId, number) {
  await click(number === 1 ? "开始本场" : "继续本场");
  const view = await waitView(sessionId, (v) => v.session.status === "waiting_answer" && v.session.turns.at(-1).mainNumber === number, `第 ${number} 题未出现`);
  await page.getByRole("heading", { name: `第 ${number} 题`, exact: true }).waitFor();
  return view;
}
function reportFor(input) {
  const answer = input.turns.find((turn) => turn.answer?.text)?.answer.text;
  return { summary: "受控服务的合成反馈，不能作为真实评价效果。", referenceAnswer: "先保存状态，再停止任务；知识参考需要核查。",
    points: [{ category: answer ? "strength" : "material_gap", basis: answer ? "user_statement" : "knowledge",
      answerQuote: answer || "", observation: answer ? "反馈引用本场实际已保存回答。" : "该题没有提供回答。", action: "补充失败分支", evidenceIds: [] }],
    weaknesses: [{ title: "取消边界", practicePrompt: "说明晚到结果的处理", evidenceIds: [] }] };
}
function replyFor(input) {
  if (input.step === "question") return { question: `第 ${input.turns.length + 1} 个合成主问题：如何保存状态并取消任务？`, evidenceIds: [] };
  if (input.step === "follow_up") {
    if (!prematureFeedback) return { question: null, decision: "sufficient", evidenceIds: [] };
    prematureFeedback = false;
    return { ...reportFor(input), summary: prematureMarker };
  }
  const report = reportFor(input);
  if (input.step === "feedback" && blameNextSkip) {
    blameNextSkip = false;
    Object.assign(report.points[0], { category: "not_mentioned", observation: "作答遗漏了取消边界。" });
  }
  return report;
}
async function startService() {
  service = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.equal(request.headers.authorization, "Bearer synthetic-s23-fixture-key");
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.stream, true);
      const prompt = body.messages.map((message) => message.content).find((text) => text.includes("\n资料："));
      const input = JSON.parse(prompt.split("\n资料：").at(-1));
      sentPrompts.push(prompt);
      requests.push({ step: input.step, mode: input.mode, mainQuestionCount: input.mainQuestionCount,
        turnCount: input.turns.length, answerIds: input.turns.filter((turn) => turn.answer).map((turn) => turn.answer.id),
        approvedResumePresent: prompt.includes(resumeApproved), privateResumePresent: prompt.includes(resumePrivate) });
      if (input.step === "follow_up" && failFollowUp) {
        failFollowUp = false;
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "合成服务故障" } }));
        return;
      }
      const result = replyFor(input);
      const text = JSON.stringify(result);
      const delta = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(delta(text.slice(0, 8)));
      const wait = input.step === "question" && holdQuestion ? 3000 : 35;
      if (wait === 3000) holdQuestion = false;
      const timer = setTimeout(() => response.end(`${delta(text.slice(8))}data: ${JSON.stringify({ choices: [], usage: { total_tokens: 17 } })}\n\ndata: [DONE]\n\n`), wait);
      response.on("close", () => clearTimeout(timer));
    } catch (error) {
      errors.push(`替身协议: ${error.message}`);
      response.writeHead(500);
      response.end("fixture failure");
    }
  });
  await new Promise((done) => service.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${service.address().port}/chat`;
}
async function hashes() {
  const paths = [executable, "tests/native-s23.mjs", "src/App.tsx", "src/BrowserPanel.tsx", "src/ProjectsPanel.tsx", "src/InterviewPanel.tsx",
    "src-tauri/src/desktop.rs", "src-tauri/src/store.rs", "src-tauri/src/model.rs", "src-tauri/src/source.rs", "src-tauri/src/interview.rs", "src-tauri/Cargo.lock"];
  return Promise.all(paths.map(async (path) => ({ path: resolve(path), sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
}

const evidence = { executable, root, platform: process.platform, arch: process.arch, nodeVersion: process.version,
  limits: ["仅自有合成工作区与本机 SSE 协议替身；不代表真实模型评价效果。", "未连接用户 Chrome/Edge 或招聘网站。", "未控制原生文件选择对话框；项目导入行为由独立 Rust 回归覆盖。"],
  files: await hashes(), status: "进行中" };
try {
  await start();
  await step("S2-02 / S3-01：原生新页面空态、浏览器运行时与无任意路径导入入口", async () => {
    await tab("浏览器填写");
    await page.getByText("先准备一份档案", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "一键填写", exact: true }).isDisabled(), true);
    await assert.rejects(invoke("browser", { datasetId, command: { kind: "targets" } }), /请先连接浏览器/);
    const browserState = await invoke("browser", { datasetId, command: { kind: "status" } });
    assert.equal(browserState.state.connected, false);
    assert.equal(browserState.history.length, 0);
    await screenshots("browser-empty");
    await tab("项目材料");
    await page.getByText("还没有项目材料", { exact: true }).waitFor();
    const command = { kind: "import", token: "not-native-selected", projectId: null, name: "合成无授权", operationId: randomUUID() };
    await assert.rejects(invoke("source", { datasetId, command }), /SELECTION_REQUIRED/);
    await assert.rejects(invoke("source", { datasetId, command: { ...command, path: root } }), /unknown field/);
    assert.equal((await invoke("source", { datasetId, command: { kind: "list" } })).versions.length, 0);
    await screenshots("projects-empty");
    await tab("文字面试");
    await page.getByText("从一场文字练习开始", { exact: true }).waitFor();
    await screenshots("interview-empty");
  });
  const endpoint = await startService();
  await invoke("save_provider", { datasetId, config: { purpose: "chat", name: "本机 S23 协议替身", endpoint, model: "fixture-model",
    expectedVersion: null, key: "synthetic-s23-fixture-key", removeKey: false } });
  applicationId = (await invoke("mutate", { datasetId, operationId: randomUUID(), mutation: { kind: "create_application",
    job: { company: "合成公司", title: "AI Agent 开发", channel: "受控样本", batch: "合成批次", jd: "任务状态与取消" },
    profileVersionId: null, stage: "saved", duplicateAcknowledged: false } })).applicationId;
  await page.reload();
  await page.getByRole("navigation").waitFor();
  await tab("文字面试");
  const applicationBefore = (await snapshot()).applications.find((item) => item.id === applicationId);

  await step("S3-05 / AC21：界面默认六题练习与自动保存草稿、退出重启恢复", async () => {
    practiceId = await newSession("practice");
    assert.equal(requests.length, 0, "保存场次不应调用模型");
    await startQuestion(practiceId, 1);
    await page.getByLabel("当前回答", { exact: true }).fill("我会先保存状态，再停止任务。");
    const saved = await waitView(practiceId, (value) => value.session.draft === "我会先保存状态，再停止任务。", "输入未自动保存");
    assert.equal(saved.session.turns[0].answer, null);
    await stop();
    await start();
    await tab("文字面试");
    await page.getByLabel("已保存场次", { exact: true }).selectOption(practiceId);
    await poll(async () => (await page.getByLabel("当前回答", { exact: true }).inputValue()) === saved.session.draft, "重启后草稿未回显");
    assert.equal((await view(practiceId)).session.turns[0].answer, null);
  });
  await step("S3-06 / AC23：发送后服务失败，手动重试保留唯一回答和配置", async () => {
    failFollowUp = true;
    await click("发送回答");
    const failed = await waitView(practiceId, (value) => value.session.status === "paused" && value.session.error, "替身故障未保留可恢复状态");
    const answer = failed.session.turns[0].answer;
    assert.equal(answer.text, "我会先保存状态，再停止任务。");
    assert.equal(failed.session.turns.filter((turn) => turn.answer).length, 1);
    await click("手动重试／继续");
    await waitView(practiceId, (value) => value.session.pending?.kind === "feedback" && value.session.status === "ready", "重试未完成充分性判定");
    await click("生成本题反馈");
    const recovered = await waitView(practiceId, (value) => value.reports.length === 1, "本题反馈未生成");
    assert.deepEqual(recovered.session.turns[0].answer, answer);
    assert.equal(recovered.session.turns.length, 1, "回答充分时不能凑追问");
    assert.deepEqual(recovered.session.provider, failed.session.provider);
    assert.equal(recovered.reports[0].content.points[0].answerQuote, answer.text);
    await page.getByRole("heading", { name: "第 1 题反馈", exact: true }).waitFor();
    assert.match(await page.getByLabel("已保存场次", { exact: true }).locator("option:checked").innerText(), /等待继续/);
    await screenshots("practice-feedback");
  });
  await step("S3-05 / S3-07 / AC21：六个主问题与按题反馈、整场报告和薄弱点复练", async () => {
    for (let number = 2; number <= 6; number++) {
      await startQuestion(practiceId, number);
      blameNextSkip = number === 2;
      if (number === 4) assert.equal(await page.getByLabel("当前回答", { exact: true }).inputValue(), "");
      if (number === 3) {
        const input = page.getByLabel("当前回答", { exact: true });
        await input.fill("只属于第3题的未发草稿");
        await click("查看解析并结束本题");
        await click("返回编辑");
        assert.equal(await input.inputValue(), "只属于第3题的未发草稿");
        await click("查看解析并结束本题");
        await click("确认查看解析");
      } else {
        await click("跳过本题");
      }
      if (number === 2) {
        const failed = await waitView(practiceId, (v) => v.session.error?.code === "EVIDENCE_INVALID", "跳过的题被算作作答遗漏");
        assert.equal(failed.reports.length, 1);
        assert.equal(failed.session.turns.at(-1).answer.disposition, "skip");
        await click("手动重试／继续");
      }
      await waitView(practiceId, (value) => value.reports.length === number, `第 ${number} 题反馈未生成`);
    }
    await click("继续本场");
    const finished = await waitView(practiceId, (value) => value.session.status === "completed", "六题练习未完成");
    assert.deepEqual(finished.session.turns.map((turn) => turn.mainNumber), [1, 2, 3, 4, 5, 6]);
    assert.equal(finished.reports.length, 7);
    assert.equal(finished.reports.at(-1).mainNumber, null);
    assert.equal(finished.session.turns[2].answer, null);
    assert.ok(sentPrompts.every((prompt) => !prompt.includes("只属于第3题的未发草稿")));
    assert.ok(finished.session.turns.every((turn) => turn.followUp <= 2));
    await page.getByText("原始模型报告（未核实）", { exact: true }).first().click();
    await page.getByRole("button", { name: "围绕此项复练", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "创建薄弱点复练", exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel("主问题数量").inputValue(), "6");
    assert.equal(await dialog.getByLabel("本场重点／检索关键词（可选）").inputValue(), "说明晚到结果的处理");
    await dialog.getByRole("button", { name: "保存场次", exact: true }).click();
    const created = await poll(async () => (await interview({ kind: "list" })).find((item) => item.id !== practiceId), "复练未保存");
    repracticeId = created.id;
    const repractice = await view(repracticeId);
    assert.equal(repractice.session.mode, "practice");
    assert.equal(repractice.session.repracticeOf, finished.reports[0].id);
    assert.equal(repractice.session.turns.length, 0);
    assert.deepEqual((await view(practiceId)).reports, finished.reports);
    await dialog.waitFor({ state: "hidden" });
  });
  await step("S3-05 / S3-07 / AC22：六题模拟结束前无评估，结束后报告且申请阶段不变", async () => {
    simulationId = await newSession("simulation");
    for (let number = 1; number <= 6; number++) {
      await startQuestion(simulationId, number);
      assert.equal(await page.getByRole("button", { name: "查看解析并结束本题", exact: true }).count(), 0);
      if (number === 1) {
        prematureFeedback = true;
        await page.getByLabel("当前回答", { exact: true }).fill("我会先保存状态，再停止任务。");
        await click("发送回答");
        const failed = await waitView(simulationId, (v) => v.session.error?.code === "MODEL_OUTPUT_INVALID", "提前返回的报告未被拦截");
        assert.equal(failed.session.partial, "");
        assert.deepEqual(failed.reports, []);
        await page.getByText(failed.session.error.message, { exact: true }).waitFor();
        assert.equal(await page.getByText(prematureMarker, { exact: false }).count(), 0);
        await tab("AI 服务");
        await page.getByRole("heading", { name: "任务与用量" }).waitFor();
        assert.equal(await page.locator(".task-content").filter({ hasText: prematureMarker }).count(), 0);
        const visibleTask = (await snapshot()).tasks.find((t) => t.id === failed.session.pending.taskId);
        assert.equal(visibleTask.usage.totalTokens, 17);
        assert.equal(visibleTask.content, "");
        await tab("文字面试");
        await page.getByLabel("已保存场次", { exact: true }).selectOption(simulationId);
        await click("手动重试／继续");
      } else await click("跳过本题");
      const current = await waitView(simulationId, (value) => value.session.status === "ready", `模拟第 ${number} 题未结束`);
      assert.equal(current.reports.length, 0);
      assert.equal(current.session.finished, false);
      assert.equal(await page.getByRole("heading", { name: "本场报告", exact: true }).count(), 0);
    }
    await click("结束本场并生成报告");
    await page.getByRole("dialog", { name: "结束本场并生成报告", exact: true }).getByRole("button", { name: "确认结束", exact: true }).click();
    const completed = await waitView(simulationId, (value) => value.session.status === "completed", "模拟报告未生成");
    assert.equal(completed.reports.length, 1);
    assert.equal(completed.reports[0].mainNumber, null);
    assert.deepEqual(completed.session.turns.map((turn) => turn.mainNumber), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual((await snapshot()).applications.find((item) => item.id === applicationId), applicationBefore);
    assert.equal(requests.filter((item) => item.mode === "simulation" && item.step === "feedback").length, 0);
    await page.getByRole("heading", { name: "本场报告", exact: true }).waitFor();
    assert.match(await page.getByLabel("已保存场次", { exact: true }).locator("option:checked").innerText(), /已完成/);
    await screenshots("simulation-report");
    await tab("AI 服务");
    await page.locator(".task-content").filter({ hasText: prematureMarker }).waitFor();
    await tab("文字面试");
  });
  await step("S3-06 / AC40：停止后不发新调用，部分内容与暂停状态可重启恢复", async () => {
    await page.getByLabel("已保存场次", { exact: true }).selectOption(repracticeId);
    holdQuestion = true;
    await click("开始本场");
    await waitView(repracticeId, (value) => value.session.status === "generating" && value.session.partial, "未收到可停止的部分内容");
    await click("停止生成");
    const stopped = await waitView(repracticeId, (value) => value.session.status === "paused" && value.session.error?.code === "CANCELLED", "停止未生效");
    assert.ok(stopped.session.partial);
    const count = requests.length;
    await delay(400);
    assert.equal(requests.length, count);
    await stop();
    await start();
    const recovered = await view(repracticeId);
    assert.equal(recovered.session.status, "paused");
    assert.equal(recovered.session.partial, stopped.session.partial);
    assert.equal(requests.length, count);
    assert.deepEqual((await snapshot()).applications.find((item) => item.id === applicationId), applicationBefore);
  });
  await step("S3-04 / AC19：旧档案配套简历在本地提取，只有本场勾选的文字进入请求", async () => {
    const bytes = [...docx([resumeApproved, resumePrivate])];
    const asset = await invoke("import_asset", { datasetId, name: "合成配套简历.docx", bytes, assetKind: "resume" });
    const saved = await invoke("mutate", { datasetId, operationId: randomUUID(), mutation: { kind: "save_profile",
      profileId: null, expectedVersionId: null, name: "简历授权样本", data: { resumeAssetId: asset.id } } });
    await invoke("mutate", { datasetId, operationId: randomUUID(), mutation: { kind: "save_profile",
      profileId: saved.profileId, expectedVersionId: saved.versionId, name: "简历授权样本", data: { resumeAssetId: null } } });
    await page.reload();
    await tab("文字面试");
    for (const allow of [false, true]) {
      const prior = new Set((await interview({ kind: "list" })).map((item) => item.id));
      await click("新建文字面试");
      const dialog = page.getByRole("dialog", { name: "新建文字面试", exact: true });
      await dialog.getByLabel("档案固定版本（可选）", { exact: true }).selectOption(saved.versionId);
      await dialog.getByRole("button", { name: "从配套简历提取文字", exact: true }).click();
      const preview = dialog.getByLabel("本次使用的简历文字", { exact: true });
      await poll(async () => (await preview.inputValue()).includes(resumePrivate), "本地预览没有读到固定版本的配套简历");
      const consent = dialog.getByLabel("我已核对简历文字，同意在本场发给所选聊天服务", { exact: true });
      assert.equal(await consent.isChecked(), false);
      await consent.check();
      await preview.fill(resumeApproved);
      assert.equal(await consent.isChecked(), false, "编辑后的文字应重新确认");
      if (allow) await consent.check();
      await dialog.getByRole("button", { name: "保存场次", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      const session = (await interview({ kind: "list" })).find((item) => !prior.has(item.id));
      const result = await startQuestion(session.id, 1);
      assert.equal(result.session.profileVersionId, saved.versionId);
      assert.deepEqual(result.session.confirmedResume ?? null, allow ? { assetId: asset.id, text: resumeApproved } : null);
      assert.equal(requests.at(-1).approvedResumePresent, allow);
      assert.equal(requests.at(-1).privateResumePresent, false);
    }
  });
  assert.equal(errors.length, 0, errors.join("\n"));
  await clearKey();
  assert.equal((await invoke("snapshot")).providerStatus.find((item) => item.purpose === "chat").hasKey, false);
  evidence.status = "通过";
} catch (error) {
  evidence.status = "失败";
  evidence.failure = String(error);
  console.error(error);
  if (page) {
    await page.screenshot({ path: join(root, "failure.png"), fullPage: true }).catch(() => {});
    await writeFile(join(root, "failure-dom.txt"), await page.locator("body").innerText().catch(() => ""));
  }
  process.exitCode = 1;
} finally {
  await clearKey().catch((error) => { errors.push(`合成 Key 清理失败: ${error.message}`); process.exitCode = 1; });
  if (service) { service.closeAllConnections(); await new Promise((done) => service.close(done)); }
  await stop();
  if (errors.length) evidence.status = "失败";
  await writeFile(join(root, "results.json"), JSON.stringify({ ...evidence, webviewVersion, results, errors, requests }, null, 2));
  console.log(`证据目录：${root}`);
}
