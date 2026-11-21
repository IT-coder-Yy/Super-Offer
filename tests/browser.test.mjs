import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { BrowserConnection } from "../browser/engine.mjs";
import { inferMappings, readValue } from "../browser/mapping.mjs";
import { fixture, profile } from "./browser-fixture.mjs";
import { FIELD_GROUPS, writeField } from "../src/profile-fields.ts";

test("公开地址只保留快手数字岗位路由，不外显查询和敏感片段", () => {
  const base = "https://zhaopin.kuaishou.cn/recruit/e/";
  const route = "#/official/trainee/job-info/33086";
  const connection = new BrowserConnection();
  for (const [url, expected] of [
    [base + route, base + route],
    [base + "?tracking=private-token" + route, base + route],
    [base + route + "?token=private-token&account=private-account", base + route],
    [base + "#access_token=private-token", base],
    [base + "#/official/trainee/account/private-account", base],
    [base + route + "/private-account", base],
    [base + route + "&token=private-token", base],
    [base + route + "#private-token", base],
    [base + route + "%3Ftoken=private-token", base],
    ["https://zhaopin.kuaishou.cn/account/" + route, "https://zhaopin.kuaishou.cn/account/"],
    [base.replace(".cn", ".cn.example.invalid") + route, base.replace(".cn", ".cn.example.invalid")],
    [base.replace("https:", "http:") + route, base.replace("https:", "http:")],
    [base.replace(".cn", ".cn:8443") + route, base.replace(".cn", ".cn:8443")],
    ["https://example.invalid/app?token=private-token" + route, "https://example.invalid/app"],
    ["invalid URL", ""],
  ]) {
    connection.page = { url: () => url };
    assert.equal(connection.state().url, expected);
    connection.record({ fieldId: "address", label: "地址", status: "pending", actual: "", reason: "" });
    assert.equal(connection.state().results.at(-1).url, expected);
  }
});

test("连接失败保留发生阶段并隐藏调试地址", async (t) => {
  const connection = new BrowserConnection();
  let failure, elapsed = 0, now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.method(chromium, "connectOverCDP", async (channel, options) => {
    assert.equal(channel, "msedge");
    assert.equal(options.noDefaults, true);
    now += elapsed;
    throw failure;
  });
  for (const [name, log, duration, code] of [
    ["Error", "DevToolsActivePort file not found at", 10, "BROWSER_AUTH_REQUIRED"],
    ["TimeoutError", "<ws connecting>", 90_000, "BROWSER_CONNECT_TIMEOUT"],
    ["Error", "Could not connect to msedge", 90_001, "BROWSER_CONNECT_TIMEOUT"],
    ["TimeoutError", "<ws connected>", 90_000, "BROWSER_ATTACH_FAILED"],
    ["Error", "<ws error>", 30, "BROWSER_CONNECT_FAILED"],
  ]) {
    elapsed = duration;
    failure = Object.assign(new Error(`${log} private-endpoint-for-test`), { name });
    await assert.rejects(connection.connect("msedge"), (error) =>
      error.code === code && !error.message.includes("private-endpoint-for-test"),
    );
    assert.equal(connection.state().connected, false);
  }
});

test("登录中断保留进度，验证码不能由草稿写入", async (t) => {
  const { page, connection } = await setup(t);
  await page
    .locator("#name")
    .evaluate((el) =>
      el.parentElement.insertAdjacentHTML(
        "beforebegin",
        '<label>密码<input type="password" id="password"></label>',
      ),
    );
  await fill(connection);
  assert.equal(await page.locator("#name").inputValue(), "");
  assert.match(connection.message, /本人.*登录/);
  await page.locator("#password").evaluate((el) => el.parentElement.remove());
  await page
    .locator("#name")
    .evaluate((el) =>
      el.parentElement.insertAdjacentHTML(
        "beforebegin",
        '<label>验证码<input id="captcha"></label>',
      ),
    );
  const field = (await connection.inspect()).find((f) => f.label === "验证码");
  await connection.applyDraft(field.id, "123456");
  assert.equal(await page.locator("#captcha").inputValue(), "");
  assert.ok(
    connection.state().results.some((x) => x.reason.includes("本人在网站处理")),
  );
});
test("未读取的嵌入表单明确列待办并继续本页其它字段", async (t) => {
  const { page, connection } = await setup(t);
  await page
    .locator("form")
    .evaluate((el) =>
      el.insertAdjacentHTML(
        "afterbegin",
        '<iframe title="受控嵌入表单" srcdoc="<input>"></iframe>',
      ),
    );
  await connection.fill("full", true);
  await connection.job;
  assert.equal(await page.locator("#name").inputValue(), "合成甲");
  assert.ok(
    connection.state().results.some((x) => x.fieldId === "embedded-frames"),
  );
  assert.equal(page.url(), server.url + "/");
});
let browser, server;
before(async () => {
  const executablePath = process.env.SUPER_OFFER_TEST_BROWSER;
  let selected = "SUPER_OFFER_TEST_BROWSER";
  if (executablePath) {
    browser = await chromium.launch({ executablePath, headless: true });
  } else {
    const failures = [];
    for (const channel of ["msedge", "chrome"]) {
      try {
        browser = await chromium.launch({ channel, headless: true });
        selected = channel;
        break;
      } catch (error) {
        failures.push(`${channel}: ${error.message.split("\n")[0]}`);
      }
    }
    if (!browser)
      throw new Error(
        "无法启动已安装的 Edge/Chrome；请通过 SUPER_OFFER_TEST_BROWSER 指定受控测试用 Chromium 可执行文件。\n" +
          failures.join("\n"),
      );
  }
  console.info(`受控浏览器：${selected} ${browser.version()}`);
  browser.setMaxListeners(100);
  server = await fixture();
});
after(async () => {
  await browser?.close();
  await server?.close();
});
async function setup(t, selected = profile()) {
  const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    }),
    page = await context.newPage();
  await page.goto(server.url);
  const events = [],
    connection = new BrowserConnection((e) => events.push(e));
  connection.attach(browser);
  const targets = await connection.listTargets();
  const target = targets.find((x) => connection.targets.get(x.id) === page);
  await connection.select({
    targetId: target.id,
    runId: crypto.randomUUID(),
    profile: selected,
    profiles: [{ id: selected.id, name: selected.name }],
    autoAdvance: false,
  });
  t.after(async () => {
    await connection.detach();
    await context.close();
  });
  return { context, page, connection, events };
}
async function fill(connection, mode = "full") {
  await connection.fill(mode);
  await connection.job;
  return connection.state();
}
async function panelNodes(connection) {
  const { root } = await connection.session.send("DOM.getDocument", { depth: -1, pierce: true });
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) visit(child);
  };
  visit(root);
  return nodes;
}
async function panelClick(page, connection, command) {
  const point = await connection.evaluate("controlPoint", command);
  assert.ok(point, `面板按钮 ${command} 应可见`);
  assert.ok(point.x > 0 && point.y > 0 && point.x < page.viewportSize().width && point.y < page.viewportSize().height);
  await page.mouse.click(point.x, point.y);
}
async function until(check, message) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}
async function chooseLastProfile(page, connection, events, count = 1) {
  await panelClick(page, connection, "profile");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await until(() => events.filter((e) => e.event === "profile").length === count, "原生下拉选择应发送换档请求");
  return events.filter((e) => e.event === "profile").at(-1);
}
const formilyField = (key, title, control = '<input class="ud__native-input">', required = true) =>
  `<div id="formily-item-${key}" class="ud-formily-item" data-test="${key}"><div class="ud-formily-item-label">${title}${required ? '<span class="ud-formily-item-asterisk">*</span>' : ""}</div><div class="ud-formily-item-control"><label class="ud__input-input-wrap"><div>${control}</div></label></div></div>`;
const formilySelect = (value) =>
  `<div class="ud__select"><span class="ud__select__selector__selectItem">${value}</span><span><input type="search" class="ud__select__selector__search__input"></span></div>`;
const formilyCard = (content) =>
  `<div class="apply-form-array-card__fixture"><div class="apply-form-array-card-content__fixture">${content}</div></div>`;
const formilyModule = (title, content) =>
  `<div class="applyFormModuleWrapper-windows"><div class="applyFormModuleWrapper-left"><div class="applyFormModuleWrapper-title"><p class="applyFormModuleWrapper-text sofiaBold">${title}</p></div></div><div class="applyFormModuleWrapper-right">${content}</div></div>`;
const formilyFixture = () =>
  formilyModule("基本信息", formilyField("name", "姓名") + formilyField("email", "邮箱", '<input class="ud__native-input" value="website@example.invalid">') +
    formilyField("phone", "手机号", formilySelect("+86") + '<input type="tel" class="ud__native-input">') +
    formilyField("identity", "个人证件", formilySelect("居民身份证") + '<input class="ud__native-input">')) +
  formilyModule("教育经历", formilyCard(formilyField("school", "学校") + formilyField("major", "专业")) +
    formilyCard(formilyField("school", "学校") + formilyField("major", "专业"))) +
  formilyModule("项目经历", formilyCard(formilyField("project_name", "项目名称", '<input class="ud__native-input" value="网站已有项目">') +
    formilyField("project_role", "项目角色", undefined, false) + formilyField("date_range", "起止时间", '<input readonly placeholder="开始日期"><input readonly placeholder="结束日期">'))) +
  formilyField("consent", "同意隐私协议", '<input type="checkbox">') + '<button type="submit">最终提交申请</button>';

test("已观察的Formily局部标题与模块卡片识别姓名学校项目角色，重复ID不串经历", async (t) => {
  const selected = profile();
  selected.data.projects = [{ name: "合成项目", role: "合成项目角色" }];
  const { page, connection } = await setup(t, selected);
  await page.locator("form").evaluate((form, html) => { form.innerHTML = html; }, formilyFixture());
  const fields = await connection.inspect();
  assert.equal(fields.length, 15);
  assert.equal(fields.find((field) => field.label === "姓名*").path, "basic.name");
  assert.deepEqual(fields.filter((field) => field.label === "学校*").map((field) => [field.section, field.path]),
    [["教育经历", "education.0.school"], ["教育经历", "education.1.school"]]);
  assert.equal(fields.find((field) => field.label === "项目角色").path, "projects.0.role");
  assert.equal(fields.find((field) => field.label === "项目角色").required, false);
  assert.ok(fields.every((field) => !field.label.includes("居民身份证") && !field.label.includes("网站已有项目")));
  await panelClick(page, connection, "fill");
  await until(() => connection.status === "waiting", "网页面板应完成合成控件填写");
  assert.equal(await page.locator('[data-test="name"] input').inputValue(), "合成甲");
  assert.deepEqual(await page.locator('[data-test="school"] input').evaluateAll((elements) => elements.map((el) => el.value)), ["样本大学", "样本研究院"]);
  assert.equal(await page.locator('[data-test="project_role"] input').inputValue(), "合成项目角色");
  assert.equal(await page.locator('[data-test="project_name"] input').inputValue(), "网站已有项目");
  assert.equal(await page.locator('[data-test="email"] input').inputValue(), "website@example.invalid");
  await page.locator('[data-test="school"] input').nth(1).fill("本人修正学校");
  await panelClick(page, connection, "blank");
  await until(() => connection.status === "waiting", "补充填写应完成");
  await connection.job;
  assert.equal(await page.locator('[data-test="school"] input').nth(1).inputValue(), "本人修正学校");
  assert.equal(await page.evaluate(() => submissions), 0);
});

test("Formily国家区号和证件筛选框只读选中值，复合日期只读字段与协议不写", async (t) => {
  const { page, connection } = await setup(t);
  await page.locator("form").evaluate((form, html) => { form.innerHTML = html; }, formilyFixture());
  await page.locator('[data-test="school"] input').first().evaluate((el) => { el.readOnly = true; el.value = "官网只读学校"; });
  const fields = await connection.inspect();
  const filters = fields.filter((field) => field.type === "custom-select");
  assert.deepEqual(filters.map((field) => [field.value, field.path]), [["+86", null], ["居民身份证", null]]);
  assert.equal(fields.filter((field) => field.type === "composite").length, 2);
  await connection.fill("full", true);
  await connection.job;
  assert.equal(await page.locator('[data-test="phone"] input[type="tel"]').inputValue(), "13900000000");
  assert.equal(await page.locator('[data-test="school"] input').first().inputValue(), "官网只读学校");
  for (const field of filters) await connection.applyDraft(field.id, "不能写入的合成资料");
  assert.deepEqual(await page.locator('.ud__select__selector__search__input').evaluateAll((elements) => elements.map((el) => el.value)), ["", ""]);
  assert.deepEqual(await page.locator('.ud__select__selector__selectItem').allTextContents(), ["+86", "居民身份证"]);
  assert.deepEqual(await page.locator('[data-test="date_range"] input').evaluateAll((elements) => elements.map((el) => el.value)), ["", ""]);
  assert.equal(await page.locator('[data-test="consent"] input').isChecked(), false);
  assert.equal(await page.evaluate(() => submissions), 0);
});

test("Formily第一条未识别也不移动第二条索引，嵌套或缺模块卡片不猜", async (t) => {
  const { page, connection } = await setup(t);
  const html = formilyModule("教育经历", formilyCard(formilyField("unknown", "未支持的资料")) +
    formilyCard(formilyField("school", "学校") + formilyCard(formilyField("nested_school", "学校")))) +
    formilyCard(formilyField("orphan_school", "学校")) + '<button type="submit">最终提交</button>';
  await page.locator("form").evaluate((form, markup) => { form.innerHTML = markup; }, html);
  const schools = (await connection.inspect()).filter((field) => field.label === "学校*");
  assert.deepEqual(schools.map((field) => field.path), ["education.1.school", null, null]);
  await fill(connection);
  assert.equal(await page.locator('[data-test="school"] input').inputValue(), "样本研究院");
  assert.equal(await page.locator('[data-test="nested_school"] input').inputValue(), "");
  assert.equal(await page.locator('[data-test="orphan_school"] input').inputValue(), "");
  assert.equal(await page.evaluate(() => submissions), 0);
});

test("Formily字段标题只归当前控件，父项不吞子项标题或值", async (t) => {
  const { page, connection } = await setup(t);
  const html = formilyField("parent", "个人证件", formilyField("name", "姓名") +
    formilyField("ambiguous", "开始时间", '<input class="ud__native-input"><input class="ud__native-input">'));
  await page.locator("form").evaluate((form, markup) => { form.innerHTML = markup; }, html);
  const fields = await connection.inspect();
  assert.deepEqual(fields.map((field) => field.label), ["姓名*", "开始时间*", "开始时间*"]);
  assert.equal(fields[0].path, "basic.name");
  assert.ok(fields.slice(1).every((field) => field.path === null && field.type === "composite"));
  await fill(connection);
  assert.equal(await page.locator('[data-test="name"] input').inputValue(), "合成甲");
  assert.deepEqual(await page.locator('[data-test="ambiguous"] input').evaluateAll((elements) => elements.map((el) => el.value)), ["", ""]);
});

test("Formily必填只认本字段可见星号，空值和复合日期阻止下一步但不冒填", async (t) => {
  const selected = profile();
  selected.data.basic.name = "";
  const { page, connection } = await setup(t, selected);
  const html = formilyField("name", "姓名") + formilyField("role", "项目角色", undefined, false) +
    formilyField("email", "邮箱") + formilyField("parent", "父项", formilyField("note", "备注", undefined, false)) +
    formilyField("date", "起止时间", '<input><input>') + '<button type="button" id="next">下一步</button><button type="submit">最终提交申请</button>';
  await page.locator("form").evaluate((form, markup) => {
    form.innerHTML = markup;
    form.querySelector('[data-test="email"] .ud-formily-item-asterisk').style.display = "none";
    window.nextClicks = 0;
    form.querySelector("#next").onclick = () => window.nextClicks++;
  }, html);
  const fields = await connection.inspect();
  const name = fields.find((field) => field.label === "姓名*");
  assert.equal(name.required, true);
  assert.equal(name.valid, false);
  assert.equal(await page.locator('[data-test="name"] input').evaluate((el) => el.required), false);
  assert.equal(fields.find((field) => field.label === "项目角色").required, false);
  assert.equal(fields.find((field) => field.label === "邮箱*").required, false);
  assert.equal(fields.find((field) => field.label === "备注").required, false);
  assert.ok(fields.filter((field) => field.type === "composite").every((field) => field.required && !field.valid && field.path === null));
  await connection.fill("full", true);
  await connection.job;
  assert.equal(await page.evaluate(() => nextClicks), 0);
  assert.deepEqual(await page.locator('[data-test="date"] input').evaluateAll((elements) => elements.map((el) => el.value)), ["", ""]);
  assert.match(connection.message, /必填校验未完成/);
  await page.locator('[data-test="name"] input').fill("本人补全");
  await page.locator('[data-test="date"] input').nth(0).fill("2020-09");
  await page.locator('[data-test="date"] input').nth(1).fill("2024-06");
  await connection.advance();
  assert.equal(await page.evaluate(() => nextClicks), 1);
  assert.equal(await page.evaluate(() => submissions), 0);
});

test("ATSX意向城市内部搜索不映射或写入，搜索词不算选择也不放行必填", async (t) => {
  const { page, connection } = await setup(t);
  const html = formilyField("city", "意向城市", '<div class="atsx-select-selection atsx-select-selection--multiple" role="combobox"><input type="text" class="atsx-select-search__field"></div>') +
    '<button type="button" id="next">下一步</button><button type="submit">最终提交申请</button>';
  await page.locator("form").evaluate((form, markup) => {
    form.innerHTML = markup;
    window.nextClicks = 0;
    form.querySelector("#next").onclick = () => window.nextClicks++;
  }, html);
  const fields = await connection.inspect();
  assert.equal(fields.length, 2);
  assert.ok(fields.every((field) => field.type === "custom-select" && field.path === null && field.required && !field.valid && field.value === ""));
  await connection.fill("full", true);
  await connection.job;
  assert.equal(await page.locator(".atsx-select-search__field").inputValue(), "");
  assert.equal(await page.evaluate(() => nextClicks), 0);
  assert.ok(connection.results.some((result) => result.status === "pending" && result.reason.includes("自定义选项")));
  await page.locator(".atsx-select-search__field").fill("杭州");
  const searched = await connection.inspect();
  assert.ok(searched.every((field) => field.value === "" && !field.valid && field.path === null));
  await connection.applyDraft(fields.at(-1).id, "北京");
  await connection.advance();
  await connection.fill("blank", true);
  await connection.job;
  assert.equal(await page.locator(".atsx-select-search__field").inputValue(), "杭州");
  assert.equal(await page.evaluate(() => nextClicks), 0);
  assert.equal(await page.evaluate(() => submissions), 0);
});

const intentionDefinitions = FIELD_GROUPS.find((group) => group.key === "intentions").fields;
const intentionValues = { 目标岗位: "合成开发岗位", 目标城市: "杭州", 到岗时间: "2026-12-01" };
function withIntentions(selected, values) {
  for (const [label, value] of Object.entries(values)) {
    const definition = intentionDefinitions.find((field) => field.label === label);
    assert.ok(definition, `${label} 应来自正式 S1 档案字段`);
    selected.data = writeField(selected.data, `intentions.${definition.key}`, value);
  }
  return selected;
}

test("正式S1求职意向键和标题可填写原生文本与下拉，写后逐项回读", async (t) => {
  const selected = profile();
  selected.data.intentions = {};
  withIntentions(selected, intentionValues);
  const { page, connection } = await setup(t, selected);
  const aliasLabels = { 目标岗位: "意向岗位", 目标城市: "期望城市", 到岗时间: "可入职时间" };
  const controls = Object.entries(intentionValues).map(([title, value]) => {
    const definition = intentionDefinitions.find((field) => field.label === title);
    return `<label>${definition.label}<input id="${definition.key}-text"></label><label>${aliasLabels[title]}<select id="${definition.key}-select"><option value=""></option><option value="code-${definition.key}">${value}</option></select></label>`;
  }).join("");
  await page.locator("form").evaluate((form, html) => {
    form.innerHTML = `<fieldset><legend>求职意向</legend>${html}</fieldset><button type="submit">最终提交申请</button>`;
  }, controls);
  const fields = await connection.inspect();
  assert.equal(fields.length, 6);
  for (const [label, expected] of Object.entries(intentionValues)) {
    const key = intentionDefinitions.find((field) => field.label === label).key;
    assert.equal(fields.find((field) => field.label === label).path, `intentions.${key}`);
    assert.equal(fields.find((field) => field.label === aliasLabels[label]).path, `intentions.${key}`);
    assert.equal(readValue(selected.data, `intentions.${key}`), expected);
  }
  await fill(connection);
  for (const [label, expected] of Object.entries(intentionValues)) {
    const key = intentionDefinitions.find((field) => field.label === label).key;
    assert.equal(await page.locator(`#${key}-text`).inputValue(), expected);
    assert.equal(await page.locator(`#${key}-select`).inputValue(), `code-${key}`);
    assert.equal(await page.locator(`#${key}-select option:checked`).textContent(), expected);
  }
  assert.equal(connection.results.filter((result) => result.status === "filled").length, 6);
  assert.equal(await page.evaluate(() => submissions), 0);
});

test("旧求职意向可读取，当前S1字段优先且显式清空不回填旧值", async (t) => {
  const legacy = profile();
  legacy.data.intentions = { role: "旧岗位", city: "旧城市", availableDate: "旧到岗时间" };
  const { page, connection } = await setup(t, legacy);
  const controls = Object.keys(intentionValues).map((label) => `<label>${label}<input></label>`).join("");
  const markup = `<fieldset><legend>求职意向</legend>${controls}</fieldset><button type="submit">最终提交申请</button>`;
  await page.locator("form").evaluate((form, html) => { form.innerHTML = html; }, markup);
  const values = () => page.locator("form input").evaluateAll((nodes) => nodes.map((node) => node.value));
  await fill(connection);
  assert.deepEqual(await values(), ["旧岗位", "旧城市", "旧到岗时间"]);
  const current = withIntentions(structuredClone(legacy), intentionValues);
  current.id = "current-intentions";
  await connection.switchProfile(current, [{ id: current.id, name: current.name }]);
  await fill(connection);
  assert.deepEqual(await values(), Object.values(intentionValues));
  const empty = withIntentions(structuredClone(current), { 目标岗位: "", 目标城市: " ", 到岗时间: "" });
  empty.id = "empty-intentions";
  await connection.switchProfile(empty, [{ id: empty.id, name: empty.name }]);
  await fill(connection);
  assert.deepEqual(await values(), Object.values(intentionValues));
  assert.equal(connection.results.filter((result) => result.reason.includes("换档缺值")).length, 3);
  for (const label of Object.keys(intentionValues)) {
    const key = intentionDefinitions.find((field) => field.label === label).key;
    assert.equal(readValue(empty.data, `intentions.${key}`), null);
  }
  await page.locator("form").evaluate((form, html) => { form.innerHTML = html; }, markup);
  await fill(connection, "blank");
  assert.deepEqual(await values(), ["", "", ""]);
  assert.equal(await page.evaluate(() => submissions), 0);
});

test("S1求职意向有值也不填写城市组合搜索或复合到岗日期", async (t) => {
  const { page, connection } = await setup(t, withIntentions(profile(), intentionValues));
  const controls = formilyField("city", "目标城市", '<div class="atsx-select-selection atsx-select-selection--multiple" role="combobox"><input type="text" class="atsx-select-search__field"></div>') +
    formilyField("dates", "到岗时间", '<input class="ud__native-input"><input class="ud__native-input">');
  await page.locator("form").evaluate((form, html) => {
    form.innerHTML = html + '<button id="next" type="button">下一步</button><button type="submit">最终提交申请</button>';
    window.nextClicks = 0;
    form.querySelector("#next").onclick = () => window.nextClicks++;
  }, formilyModule("求职意向", controls));
  const fields = await connection.inspect();
  assert.equal(fields.length, 4);
  assert.ok(fields.every((field) => field.path === null));
  assert.deepEqual(fields.map((field) => field.type), ["custom-select", "custom-select", "composite", "composite"]);
  await connection.fill("full", true);
  await connection.job;
  assert.deepEqual(await page.locator("form input").evaluateAll((nodes) => nodes.map((node) => node.value)), ["", "", ""]);
  assert.equal(await page.evaluate(() => nextClicks), 0);
  assert.equal(await page.evaluate(() => submissions), 0);
});

test("描述仅在已确认项目卡映射项目介绍，同名实习与无栏目不猜且保留手改", async (t) => {
  const selected = profile();
  selected.data = writeField(selected.data, "projects.0.description", "合成项目的整体介绍");
  selected.data = writeField(selected.data, "projects.0.contribution", "合成个人贡献");
  selected.data = writeField(selected.data, "projects.0.results", "合成项目成果");
  selected.data = writeField(selected.data, "experience.0.responsibilities", "不能套用为描述的实习职责");
  const { page, connection } = await setup(t, selected);
  const description = (id) => formilyField(id, "描述", '<textarea class="ud__native-input"></textarea>');
  const controls = formilyModule("项目经历", formilyCard(description("project-description") +
    formilyField("contribution", "个人贡献", "<textarea></textarea>") +
    formilyField("results", "项目成果", "<textarea></textarea>") +
    formilyCard(description("nested-description"))) + description("no-card-description")) +
    formilyModule("实习经历", formilyCard(description("intern-description"))) +
    formilyCard(description("no-section-description"));
  await page.locator("form").evaluate((form, html) => {
    form.innerHTML = html + '<button type="submit">最终提交申请</button>';
  }, controls);
  const fields = await connection.inspect();
  await fill(connection);
  assert.equal(await page.locator('[data-test="project-description"] textarea').inputValue(), "合成项目的整体介绍");
  assert.equal(fields.find((field) => field.label === "描述*" && field.section === "项目经历" && field.entryIndex === 0).path, "projects.0.description");
  assert.equal(fields.filter((field) => field.label === "描述*" && field.path !== null).length, 1);
  for (const id of ["nested-description", "no-card-description", "intern-description", "no-section-description"])
    assert.equal(await page.locator(`[data-test="${id}"] textarea`).inputValue(), "");
  assert.equal(await page.locator('[data-test="contribution"] textarea').inputValue(), "合成个人贡献");
  assert.equal(await page.locator('[data-test="results"] textarea').inputValue(), "合成项目成果");
  await page.locator('[data-test="project-description"] textarea').fill("本人手改的项目介绍");
  const next = structuredClone(selected);
  next.id = "next-project-description";
  next.data = writeField(next.data, "projects.0.description", "新档案项目介绍");
  await connection.switchProfile(next, [{ id: next.id, name: next.name }]);
  await fill(connection, "blank");
  await fill(connection);
  assert.equal(await page.locator('[data-test="project-description"] textarea').inputValue(), "本人手改的项目介绍");
  assert.equal(await page.evaluate(() => submissions), 0);
});

test("网页面板两主按钮真实鼠标填写和补充，保留官网值与手改并停在提交前", async (t) => {
  const { context, page, connection } = await setup(t);
  const other = await context.newPage();
  await other.goto(server.url);
  await page.locator("form").evaluate((form) => {
    form.innerHTML = '<label>姓名<input id="name"></label><label>邮箱<input id="email" value="website@example.invalid"></label><label>手机<input id="phone"></label><button type="submit">最终提交申请</button>';
  });
  await page.bringToFront();
  const text = (await panelNodes(connection)).filter((node) => node.nodeType === 3).map((node) => node.nodeValue);
  assert.ok(text.includes("一键填写"));
  assert.ok(text.includes("补充填写"));
  await panelClick(page, connection, "fill");
  await until(() => connection.status === "waiting", "网页填写应结束");
  assert.equal(await page.locator("#name").inputValue(), "合成甲");
  assert.equal(await page.locator("#phone").inputValue(), "13900000000");
  assert.equal(await page.locator("#email").inputValue(), "website@example.invalid");
  await page.locator("#name").fill("本人手改");
  await page.locator("form").evaluate((form) => form.insertAdjacentHTML("afterbegin", '<label>GitHub<input id="tail"></label>'));
  await panelClick(page, connection, "blank");
  await until(async () => (await page.locator("#tail").inputValue()) !== "" && connection.status === "waiting", "补充填写应完成空项回读");
  assert.equal(await page.locator("#tail").inputValue(), "https://example.invalid/code");
  assert.equal(await page.locator("#name").inputValue(), "本人手改");
  assert.equal(await page.locator("#email").inputValue(), "website@example.invalid");
  assert.equal(await page.evaluate(() => submissions), 0);
  assert.equal(await other.locator("#super-offer-controls").count(), 0);
  assert.equal(await page.evaluate(() => document.querySelector("#super-offer-controls").shadowRoot), null);
  assert.equal(await page.evaluate(() => typeof globalThis.__superOffer), "undefined");
  assert.ok(connection.results.some((item) => item.actual === "https://example.invalid/code" && item.status === "filled"));
});

test("网页面板可鼠标收起键盘重开，矮窄视口保留操作且入口不填写或导航", async (t) => {
  const { page, connection, events } = await setup(t);
  const originalUrl = page.url();
  await panelClick(page, connection, "collapse");
  assert.equal(await connection.evaluate("controlPoint", "fill"), null);
  assert.ok(await connection.evaluate("controlPoint", "open"));
  await connection.changed();
  assert.equal(await connection.evaluate("controlPoint", "fill"), null);
  await page.keyboard.press("Enter");
  assert.ok(await connection.evaluate("controlPoint", "fill"));
  await page.keyboard.press("Escape");
  assert.equal(await connection.evaluate("controlPoint", "fill"), null);
  await panelClick(page, connection, "open");
  await page.setViewportSize({ width: 280, height: 200 });
  const bounds = await page.locator("#super-offer-controls").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 280 && bounds.y + bounds.height <= 200);
  await panelClick(page, connection, "stop");
  await until(() => connection.status === "stopped", "窄视口停止按钮应可用");
  await panelClick(page, connection, "return");
  await until(() => events.some((event) => event.event === "return"), "窄视口返回按钮应可用");
  assert.equal(await page.locator("#name").inputValue(), "");
  assert.equal(page.url(), originalUrl);
  assert.equal(await page.evaluate(() => submissions), 0);
});

test("选档时心跳保留原生选项，立刻点击填写不会使用旧档案", async (t) => {
  const { page, connection, events } = await setup(t);
  const next = profile("合成乙");
  connection.profiles.push({ id: next.id, name: next.name });
  await connection.changed();
  const options = async () => (await panelNodes(connection)).find((node) => node.nodeName === "SELECT" && node.attributes?.includes("填写档案")).children.map((node) => node.backendNodeId);
  const before = await options();
  await panelClick(page, connection, "profile");
  await connection.changed();
  assert.deepEqual(await options(), before);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await until(() => events.some((event) => event.event === "profile"), "应请求切换档案");
  const request = events.find((event) => event.event === "profile");
  assert.equal(request.profileVersionId, next.id);
  await connection.changed();
  assert.deepEqual(await options(), before);
  await panelClick(page, connection, "fill");
  await assert.rejects(connection.fill(), /切换尚未确认/);
  await page.waitForTimeout(50);
  assert.equal(await page.locator("#name").inputValue(), "");
  assert.equal(connection.profile.id, "合成甲");
  await assert.rejects(connection.dispatch({ kind: "profile", runId: request.runId, requestId: request.requestId, profile: profile(), profiles: connection.profiles }), { code: "STALE_TASK" });
  assert.equal(connection.profileSelection.status, "pending");
  await connection.dispatch({ kind: "profile", runId: request.runId, requestId: request.requestId, profile: next, profiles: connection.profiles });
  assert.equal(await page.locator("#name").inputValue(), "");
  await panelClick(page, connection, "fill");
  await until(async () => (await page.locator("#name").inputValue()) === "合成乙", "确认后应只填写所选乙档案");
  await connection.job;
  assert.equal(await page.evaluate(() => submissions), 0);
});

test("换档失败可在网页重选，停止后的确认不自动填写，过期run不操作当前页", async (t) => {
  const { page, connection, events } = await setup(t);
  const next = profile("合成乙");
  connection.profiles.push({ id: next.id, name: next.name });
  await connection.changed();
  const first = await chooseLastProfile(page, connection, events);
  await connection.dispatch({ kind: "profile_failed", runId: first.runId, requestId: first.requestId, message: "档案读取失败" });
  const text = (await panelNodes(connection)).filter((node) => node.nodeType === 3).map((node) => node.nodeValue).join(" ");
  assert.match(text, /档案读取失败.*重新选择或返回客户端/);
  assert.equal(connection.profile.id, "合成甲");
  const second = await chooseLastProfile(page, connection, events, 2);
  await panelClick(page, connection, "stop");
  await until(() => connection.status === "stopped", "应立即停止");
  for (const command of [
    { kind: "control", action: "pause" },
    { kind: "disconnect" },
    { kind: "profile", requestId: second.requestId, profile: next, profiles: connection.profiles },
  ]) await assert.rejects(connection.dispatch({ ...command, runId: "unrelated-run" }), { code: "STALE_TASK" });
  assert.equal(connection.status, "stopped");
  await connection.dispatch({ kind: "profile", runId: second.runId, requestId: second.requestId, profile: next, profiles: connection.profiles });
  assert.equal(connection.status, "stopped");
  assert.equal(await page.locator("#name").inputValue(), "");
  assert.equal(await page.evaluate(() => submissions), 0);
});

test("换档途中刷新后拒绝迟到确认，不把旧请求绑定到新文档", async (t) => {
  const { page, connection, events } = await setup(t);
  const next = profile("合成乙");
  connection.profiles.push({ id: next.id, name: next.name });
  await connection.changed();
  const request = await chooseLastProfile(page, connection, events);
  const previousDocument = connection.documentId;
  await page.reload();
  await until(() => connection.context && connection.documentId !== previousDocument, "刷新应重建隔离面板");
  await assert.rejects(connection.dispatch({ kind: "profile", runId: request.runId, requestId: request.requestId, profile: next, profiles: connection.profiles }), { code: "STALE_TASK" });
  await assert.rejects(connection.dispatch({ kind: "profile_failed", runId: request.runId, requestId: request.requestId, message: "迟到失败" }), { code: "STALE_TASK" });
  assert.equal(connection.profile.id, "合成甲");
  assert.equal(await page.locator("#name").inputValue(), "");
});

test("选定页面板成功后只切前台一次，心跳不抢焦点且未授权标签无面板", async (t) => {
  const { context, page, connection, events } = await setup(t);
  const other = await context.newPage();
  await other.goto(server.url);
  await other.bringToFront();
  const original = page.bringToFront.bind(page);
  let foreground = 0;
  t.mock.method(page, "bringToFront", async () => { foreground++; await original(); });
  const target = (await connection.listTargets()).find((item) => connection.targets.get(item.id) === page);
  events.length = 0;
  await connection.select({ targetId: target.id, runId: crypto.randomUUID(), profile: profile(), profiles: [{ id: "合成甲", name: "合成甲" }], autoAdvance: false });
  assert.equal(foreground, 1);
  assert.equal(await page.evaluate(() => document.hasFocus()), true);
  assert.equal(events.filter((event) => event.event === "ready").length, 1);
  await other.bringToFront();
  await connection.changed();
  await connection.control("pause");
  assert.equal(foreground, 1);
  assert.equal(await other.evaluate(() => document.hasFocus()), true);
  assert.equal(await other.locator("#super-offer-controls").count(), 0);
});

test("绑定时页面离开已确认流程不发ready或切前台", async (t) => {
  const { page, connection, events } = await setup(t);
  const target = (await connection.listTargets()).find((item) => connection.targets.get(item.id) === page);
  const mount = connection.mount.bind(connection);
  let moved = false, foreground = 0;
  t.mock.method(connection, "mount", async () => {
    if (!moved) { moved = true; await page.goto(server.url + "/unconfirmed-flow"); }
    return mount();
  });
  t.mock.method(page, "bringToFront", async () => { foreground++; });
  events.length = 0;
  await connection.select({ targetId: target.id, runId: crypto.randomUUID(), profile: profile(), profiles: [] });
  assert.equal(connection.status, "paused");
  assert.equal(connection.context, null);
  assert.equal(events.some((event) => event.event === "ready"), false);
  assert.equal(foreground, 0);
  assert.equal(await page.locator("#super-offer-controls").count(), 0);
});

test("面板心跳只发送必要视图，不含完整档案、附件路径或历史填写内容", async (t) => {
  const { connection, events } = await setup(t);
  connection.profile.attachment = { name: "synthetic.pdf", path: "/private-synthetic-file", bytes: 1, sha256: "" };
  connection.profiles[0].data = { private: "profile-must-stay-in-host" };
  connection.record({ fieldId: "historical", label: "旧项", status: "pending", actual: "historical-private-value", reason: "待处理" });
  const evaluate = connection.evaluate.bind(connection);
  let view;
  t.mock.method(connection, "evaluate", (method, value) => {
    if (method === "update") view = value;
    return evaluate(method, value);
  });
  await connection.changed();
  assert.deepEqual(Object.keys(view).sort(), ["connected", "filled", "generation", "message", "pending", "profileName", "profileSelection", "profileVersionId", "profiles", "status"].sort());
  assert.deepEqual(view.profiles, [{ id: "合成甲", name: "合成甲" }]);
  assert.equal(view.pending, 1);
  assert.equal(view.filled, 0);
  const payload = JSON.stringify(view);
  assert.ok(!payload.includes("private") && !payload.includes("historical") && !payload.includes("synthetic.pdf"));
  assert.equal(events.filter((event) => event.event === "state").at(-1).state.results[0].actual, "historical-private-value");
});

test("普通HTTP非安全上下文仍能从网页选档并确认后填写", async (t) => {
  const { context, page, connection, events } = await setup(t);
  await context.route("http://synthetic-form.example.invalid/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: '<!doctype html><label>姓名<input id="name"></label><button type="submit">最终提交</button>',
  }));
  await page.goto("http://synthetic-form.example.invalid/application");
  assert.equal(await page.evaluate(() => isSecureContext), false);
  assert.equal(await page.evaluate(() => typeof crypto.randomUUID), "undefined");
  const next = profile("合成乙"), profiles = [{ id: "合成甲", name: "合成甲" }, { id: next.id, name: next.name }];
  const target = (await connection.listTargets()).find((item) => connection.targets.get(item.id) === page);
  await connection.select({ targetId: target.id, runId: crypto.randomUUID(), profile: profile(), profiles, autoAdvance: false });
  const request = await chooseLastProfile(page, connection, events);
  assert.ok(request.requestId.startsWith(connection.documentId + ":"));
  await connection.dispatch({ kind: "profile", runId: request.runId, requestId: request.requestId, profile: next, profiles });
  await panelClick(page, connection, "fill");
  await until(async () => (await page.locator("#name").inputValue()) === "合成乙", "HTTP网页应能使用确认后的档案");
  await connection.job;
});

test("受控快手SPA的页面列表、填写状态和结果保留岗位号而隐藏片段秘密", async (t) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const connection = new BrowserConnection();
  t.after(async () => {
    await connection.detach();
    await context.close();
  });
  // 所有请求在本机回放，不访问真实招聘站，也不使用用户浏览器。
  await context.route("**/*", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: '<!doctype html><meta charset="utf-8"><title>受控快手岗位</title><form onsubmit="window.submissions++;return false"><label>姓名<input id="name"></label><button type="submit">最终提交申请</button></form><script>window.submissions=0</script>',
  }));
  const expected = "https://zhaopin.kuaishou.cn/recruit/e/#/official/trainee/job-info/33086";
  await page.goto(expected + "?token=private-token&account=private-account");
  connection.attach(browser);
  const targets = await connection.listTargets();
  const target = targets.find((x) => connection.targets.get(x.id) === page);
  assert.equal(target.url, expected);
  const selected = profile();
  await connection.select({
    targetId: target.id,
    runId: crypto.randomUUID(),
    profile: selected,
    profiles: [{ id: selected.id, name: selected.name }],
    autoAdvance: false,
  });
  await fill(connection, "blank");
  assert.equal(await page.locator("#name").inputValue(), "合成甲");
  assert.equal(connection.state().url, expected);
  assert.ok(connection.state().results.some((x) => x.status === "filled"));
  assert.ok(connection.state().results.every((x) => x.url === expected));
  assert.equal(await page.evaluate(() => window.submissions), 0);
});

test("只读检查区分密码框、嵌入页面和零字段，提示可消除且不写入网页", async (t) => {
  const { page, connection } = await setup(t);
  const check = () => connection.dispatch({ kind: "inspect" });
  const notices = () => connection.state().results.filter((x) => x.fieldId === "page-inspection");
  connection.record({ fieldId: "kept", label: "既有结果", status: "filled", actual: "合成值", reason: "已回读" });
  await page.locator("form").evaluate((form) => {
    form.innerHTML = "<p>公开岗位介绍</p>";
    window.inputEvents = 0;
    document.addEventListener("input", () => window.inputEvents++);
    document.addEventListener("change", () => window.inputEvents++);
  });
  assert.deepEqual(await connection.inspect(), []);
  assert.equal(notices().length, 0);
  assert.deepEqual(await check(), []);
  assert.equal(connection.state().status, "ready");
  assert.match(notices()[0].reason, /未识别出表单字段/);
  assert.match(notices()[0].reason, /不能仅据此判断需要登录/);
  await page.locator("form").evaluate((form) => {
    form.innerHTML = '<label>密码<input id="password" type="password" value="synthetic-password"></label>';
  });
  assert.deepEqual(await check(), []);
  assert.equal(notices().length, 1);
  assert.match(notices()[0].reason, /检测到可见密码输入框/);
  assert.equal(await page.locator("#password").inputValue(), "synthetic-password");
  assert.ok(!notices()[0].reason.includes("synthetic-password"));
  await page.locator("form").evaluate((form) => {
    form.innerHTML = '<input type="password" style="display:none"><iframe id="visible-frame" srcdoc="<input id=embedded value=untouched>"></iframe><iframe hidden srcdoc="<input>"></iframe>';
  });
  assert.equal(await page.locator('input[type="password"]').isVisible(), false);
  assert.equal(await page.frameLocator("#visible-frame").locator("#embedded").inputValue(), "untouched");
  assert.deepEqual(await check(), []);
  assert.match(notices()[0].reason, /1 个可见嵌入页面/);
  assert.ok(!notices()[0].reason.includes("可见密码"));
  assert.equal(await page.frameLocator("#visible-frame").locator("#embedded").inputValue(), "untouched");
  await page.locator("form").evaluate((form) => {
    form.innerHTML = '<label>姓名<input id="name" value="原有合成值"></label>';
  });
  const fields = await check();
  assert.ok(Array.isArray(fields));
  assert.equal(fields[0].path, "basic.name");
  assert.equal(notices().length, 0);
  assert.equal(connection.state().results.find((x) => x.fieldId === "kept").actual, "合成值");
  assert.equal(await page.locator("#name").inputValue(), "原有合成值");
  assert.equal(await page.evaluate(() => window.inputEvents), 0);
  assert.equal(await page.evaluate(() => window.submissions), 0);
});

test("停止后晚到的只读检查不覆盖当前任务提示", async (t) => {
  const { connection } = await setup(t);
  const original = connection.evaluate.bind(connection);
  let resume, observed;
  const gate = new Promise((resolve) => { resume = resolve; });
  const entered = new Promise((resolve) => { observed = resolve; });
  t.mock.method(connection, "evaluate", async (method, data) => {
    const result = await original(method, data);
    if (method === "inspect") {
      observed();
      await gate;
    }
    return result;
  });
  const pending = connection.dispatch({ kind: "inspect" });
  await entered;
  await connection.control("stop");
  resume();
  await assert.rejects(pending, (error) => error.code === "STALE_TASK");
  assert.equal(connection.state().status, "stopped");
  assert.ok(connection.state().results.every((x) => x.fieldId !== "page-inspection"));
});

test("空页全填和补空保留待办且不点下一步，迟到表单可显式重试", async (t) => {
  const { page, connection } = await setup(t);
  await page.locator("form").evaluate((form) => {
    form.innerHTML = '<p>申请页正在加载</p><button type="button" id="empty-next">下一步</button>';
    window.nextClicks = 0;
    document.querySelector("#empty-next").onclick = () => window.nextClicks++;
  });
  for (const mode of ["full", "blank"]) {
    await connection.dispatch({ kind: "inspect" });
    await connection.fill(mode, true);
    await connection.job;
    assert.equal(connection.status, "waiting");
    assert.match(connection.message, /再次点击填写／补空/);
    assert.ok(connection.state().results.some((x) => x.fieldId === "page-inspection" && x.status === "pending"));
    assert.equal(await page.evaluate(() => window.nextClicks), 0);
    assert.equal(await page.evaluate(() => document.readyState), "complete");
  }
  await page.locator("form").evaluate((form) => {
    form.innerHTML = '<label>姓名<input id="name"></label><label>邮箱<input id="email"></label><button type="submit">最终提交申请</button>';
  });
  await fill(connection, "blank");
  assert.equal(await page.locator("#name").inputValue(), "合成甲");
  assert.equal(await page.locator("#email").inputValue(), "fixture@example.invalid");
  assert.ok(connection.state().results.every((x) => x.fieldId !== "page-inspection"));
  assert.equal(await page.evaluate(() => window.submissions), 0);
});

test("无字段经历区和折叠资料仍能展开新增后填写", async (t) => {
  const { page, connection } = await setup(t);
  await page.locator("form").evaluate((form) => {
    form.innerHTML = '<section id="education"><h2>教育经历</h2><button id="add" type="button">新增教育经历</button></section>';
    document.querySelector("#add").onclick = () => document.querySelector("#add").insertAdjacentHTML("beforebegin", '<fieldset><legend>教育经历</legend><label>学校<input name="school"></label></fieldset>');
  });
  assert.equal((await connection.inspect()).length, 0);
  await fill(connection);
  assert.deepEqual(await page.locator('[name="school"]').evaluateAll((els) => els.map((el) => el.value)), ["样本大学", "样本研究院"]);
  await page.locator("form").evaluate((form) => form.insertAdjacentHTML("afterbegin", '<details><summary>基本资料</summary><label>姓名<input id="name"></label></details>'));
  await fill(connection);
  assert.equal(await page.locator("details").evaluate((el) => el.open), true);
  assert.equal(await page.locator("#name").inputValue(), "合成甲");
  assert.ok(connection.state().results.every((x) => x.fieldId !== "page-inspection"));
});

const smsLogin = '<h2>手机号码登录</h2><input type="text" placeholder="手机号码" id="login-phone"><input type="text" placeholder="验证码" id="login-code"><button type="button" id="get-code">获取验证码</button><button type="button" id="login-submit">登录</button><label><input type="checkbox" id="consent">同意并阅读 用户协议 与 求职者个人信息保护指引</label><button type="button" id="login-next">下一步</button>';

test("验证码登录表单检查、全填、补空及浮框继续都等待本人", async (t) => {
  const { page, connection } = await setup(t);
  await page.locator("form").evaluate((form, html) => {
    form.innerHTML = html;
    window.loginActions = 0;
    for (const button of form.querySelectorAll("button")) button.onclick = () => window.loginActions++;
  }, smsLogin);
  assert.deepEqual(await connection.dispatch({ kind: "inspect" }), []);
  assert.match(connection.state().results.find((x) => x.fieldId === "page-inspection").reason, /验证码登录/);
  assert.equal(connection.status, "paused");
  assert.match(connection.message, /本人处理登录/);
  for (const mode of ["full", "blank"]) {
    await connection.fill(mode, true);
    await connection.job;
    assert.equal(connection.status, "paused");
    assert.match(connection.message, /本人处理登录/);
    assert.equal(await page.locator("#login-phone").inputValue(), "");
    assert.equal(await page.locator("#login-code").inputValue(), "");
    assert.equal(await page.locator("#consent").isChecked(), false);
  }
  const generation = connection.generation;
  const point = await connection.evaluate("controlPoint", "resume");
  await page.mouse.click(point.x, point.y);
  for (let i = 0; i < 50 && generation === connection.generation; i++) await page.waitForTimeout(20);
  assert.notEqual(connection.generation, generation);
  for (let i = 0; i < 50 && connection.status === "running"; i++) await page.waitForTimeout(20);
  assert.equal(connection.status, "paused");
  assert.equal(await page.locator("#login-phone").inputValue(), "");
  assert.equal(await page.evaluate(() => window.loginActions), 0);
  assert.equal(await page.evaluate(() => window.submissions), 0);
});

test("普通申请里的手机或验证码加顶栏登录不误判登录表单", async (t) => {
  const { page, connection } = await setup(t);
  for (const withCode of [false, true]) {
    await page.locator("form").evaluate((form, code) => {
      document.querySelector("header")?.remove();
      form.insertAdjacentHTML("beforebegin", '<header><button type="button">登录</button></header>');
      form.innerHTML = '<label>手机号码<input id="phone"></label><label>姓名<input id="name"></label>' + (code ? '<label>验证码<input id="captcha"></label>' : '');
    }, withCode);
    assert.equal((await connection.evaluate("inspect")).needsLogin, false);
    await fill(connection, "blank");
    assert.equal(await page.locator("#phone").inputValue(), "13900000000");
    assert.equal(await page.locator("#name").inputValue(), "合成甲");
    if (withCode) assert.equal(await page.locator("#captcha").inputValue(), "");
  }
});

test("明确登录路由的扫码视图不会自动下一步", async (t) => {
  const { page, connection } = await setup(t);
  await page.goto(server.url + "/campus/login");
  await page.locator("form").evaluate((form) => {
    form.innerHTML = '<h1>扫码登录</h1><p>请使用手机扫描二维码</p><button type="button" id="qr-next">下一步</button>';
    window.nextClicks = 0;
    document.querySelector("#qr-next").onclick = () => window.nextClicks++;
  });
  const targets = await connection.listTargets();
  const target = targets.find((x) => connection.targets.get(x.id) === page);
  await connection.select({ targetId: target.id, runId: crypto.randomUUID(), profile: profile(), profiles: [], autoAdvance: true });
  assert.deepEqual(await connection.dispatch({ kind: "inspect" }), []);
  await fill(connection);
  assert.equal(connection.status, "paused");
  assert.match(connection.message, /明确的登录页面/);
  assert.equal(await page.evaluate(() => window.nextClicks), 0);
});

test("检查后才出现的登录表单拦截旧字段草稿、下一步和附件", async (t) => {
  const { page, connection } = await setup(t);
  const fields = await connection.inspect();
  const phone = fields.find((x) => x.path === "basic.name");
  const file = fields.find((x) => x.type === "file");
  await page.locator("form").evaluate((form, html) => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = html;
    form.before(dialog);
    window.loginActions = 0;
    for (const button of dialog.querySelectorAll("button")) button.onclick = () => window.loginActions++;
  }, smsLogin);
  await connection.applyDraft(phone.id, "不能写入的合成草稿");
  assert.equal(connection.status, "paused");
  assert.equal(await page.locator("#name").inputValue(), "");
  await connection.advance(false);
  assert.equal(connection.status, "paused");
  await connection.advance(true);
  assert.equal(connection.status, "paused");
  connection.profile.attachment = { name: "fixture.pdf", path: "must-not-be-read", bytes: 0, sha256: "" };
  await connection.replaceAttachment(file.id, true);
  assert.equal(connection.status, "paused");
  assert.equal(await page.locator("#resume").evaluate((el) => el.files.length), 0);
  assert.equal(await page.evaluate(() => window.loginActions), 0);
  assert.equal(await page.evaluate(() => window.saved), 0);
  assert.equal(await page.evaluate(() => window.submissions), 0);
});

test("停止后晚到的空页填写不恢复待办或触发下一步", async (t) => {
  const { page, connection } = await setup(t);
  await page.locator("form").evaluate((form) => { form.innerHTML = '<p>加载中</p><button type="button">下一步</button>'; });
  const original = connection.evaluate.bind(connection);
  let resume, observed;
  const gate = new Promise((resolve) => { resume = resolve; });
  const entered = new Promise((resolve) => { observed = resolve; });
  t.mock.method(connection, "evaluate", async (method, data) => {
    const result = await original(method, data);
    if (method === "inspect") { observed(); await gate; }
    return result;
  });
  await connection.fill("blank", true);
  await entered;
  await connection.control("stop");
  resume();
  await connection.job;
  assert.equal(connection.status, "stopped");
  assert.match(connection.message, /已停止/);
  assert.ok(connection.state().results.every((x) => x.fieldId !== "page-inspection"));
});

test("填写中才出现的短信登录仍拦截当前字段和后续操作", async (t) => {
  const { page, connection } = await setup(t);
  const original = connection.evaluate.bind(connection);
  let appeared = false;
  t.mock.method(connection, "evaluate", async (method, data) => {
    if (method === "write" && !appeared) {
      appeared = true;
      await page.locator("form").evaluate((form, html) => {
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        dialog.innerHTML = html;
        form.before(dialog);
      }, smsLogin);
    }
    return original(method, data);
  });
  await connection.fill("full", true);
  await connection.job;
  assert.equal(appeared, true);
  assert.equal(connection.status, "paused");
  assert.equal(await page.locator("#name").inputValue(), "");
  assert.equal(await page.locator("#login-phone").inputValue(), "");
  assert.equal(await page.locator("#login-code").inputValue(), "");
  assert.equal(await page.locator("#consent").isChecked(), false);
  assert.equal(await page.evaluate(() => window.submissions), 0);
});

test("字段语义不明确时不猜；正向取值只读取允许路径", () => {
  const [x] = inferMappings([
    { label: "开始时间", section: "", autocomplete: "" },
  ]);
  assert.equal(x.path, null);
  assert.equal(readValue(profile().data, "basic.name"), "合成甲");
  assert.equal(readValue(profile().data, "__proto__.x"), null);
});
test("空白表单写后回读、日期缺日不猜、局部失败仍处理长页尾部", async (t) => {
  const { page, connection } = await setup(t);
  const state = await fill(connection);
  assert.equal(await page.locator("#name").inputValue(), "合成甲");
  assert.equal(await page.locator("#gender").inputValue(), "f");
  assert.equal(
    await page.locator("#tail").inputValue(),
    "https://example.invalid/code",
  );
  assert.equal(await page.locator("#birth").inputValue(), "");
  assert.ok(state.results.some((x) => x.reason.includes("日期缺少")));
  assert.ok(state.results.some((x) => x.reason.includes("不可写")));
  assert.equal(await page.evaluate(() => window.submissions), 0);
});
test("补空不覆盖网站原有非空内容", async (t) => {
  const { page, connection } = await setup(t);
  await page.evaluate(
    () => (document.querySelector("#email").value = "existing@example.invalid"),
  );
  await fill(connection, "blank");
  assert.equal(
    await page.locator("#email").inputValue(),
    "existing@example.invalid",
  );
});
test("✱必填标记不影响明确字段识别，未知项、补空和手改保护仍保留", async (t) => {
  const { page, connection } = await setup(t);
  await page.evaluate(() => {
    document.querySelector("#name").parentElement.firstChild.textContent =
      "Full name✱";
    document.querySelector("#email").parentElement.firstChild.textContent =
      "Email ✱";
    document
      .querySelector("form")
      .insertAdjacentHTML(
        "afterbegin",
        '<label>Unfamiliar question✱<input id="unknown-required"></label>',
      );
  });
  await fill(connection);
  assert.equal(await page.locator("#name").inputValue(), "合成甲");
  assert.equal(
    await page.locator("#email").inputValue(),
    "fixture@example.invalid",
  );
  assert.equal(await page.locator("#unknown-required").inputValue(), "");
  assert.equal(
    (await connection.inspect()).find(
      (field) => field.label === "Unfamiliar question✱",
    ).path,
    null,
  );
  await page.locator("#name").fill("本人手改");
  const next = profile("合成乙");
  next.data.basic.email = "next@example.invalid";
  await connection.switchProfile(next, [{ id: next.id, name: next.name }]);
  await fill(connection, "blank");
  assert.equal(await page.locator("#name").inputValue(), "本人手改");
  assert.equal(
    await page.locator("#email").inputValue(),
    "fixture@example.invalid",
  );
  await fill(connection);
  assert.equal(await page.locator("#name").inputValue(), "本人手改");
  assert.equal(
    await page.locator("#email").inputValue(),
    "next@example.invalid",
  );
  assert.equal(await page.evaluate(() => window.submissions), 0);
});
test("重复执行不会重复新增教育经历", async (t) => {
  const { page, connection } = await setup(t);
  await fill(connection);
  await fill(connection);
  assert.equal(await page.locator("[name=school]").count(), 2);
  assert.deepEqual(
    await page
      .locator("[name=school]")
      .evaluateAll((xs) => xs.map((x) => x.value)),
    ["样本大学", "样本研究院"],
  );
});
test("手改后即使改回工具原值仍保留归属保护", async (t) => {
  const { page, connection } = await setup(t);
  await fill(connection);
  await page.locator("#name").fill("用户改动");
  await page.locator("#name").fill("合成甲");
  await connection.switchProfile(profile("合成乙"), [
    { id: "合成乙", name: "合成乙" },
  ]);
  await fill(connection);
  assert.equal(await page.locator("#name").inputValue(), "合成甲");
  assert.ok(
    connection.state().results.some((x) => x.reason.includes("手动修改")),
  );
});
test("换档更新工具值，缺值和减少经历保留旧内容并标红", async (t) => {
  const { page, connection } = await setup(t);
  await fill(connection);
  const next = profile("合成乙");
  delete next.data.basic.github;
  next.data.education = next.data.education.slice(0, 1);
  await connection.switchProfile(next, [{ id: next.id, name: next.name }]);
  await fill(connection);
  assert.equal(await page.locator("#name").inputValue(), "合成乙");
  assert.equal(
    await page.locator("#tail").inputValue(),
    "https://example.invalid/code",
  );
  assert.equal(
    await page.locator("[name=school]").nth(1).inputValue(),
    "样本研究院",
  );
  assert.ok(
    await page.locator("#tail").getAttribute("data-super-offer-pending"),
  );
});
test("页面拒绝写入时不能假报成功", async (t) => {
  const { page, connection } = await setup(t);
  await page.evaluate(() =>
    document
      .querySelector("#name")
      .addEventListener("input", (e) => (e.target.value = "")),
  );
  const result = await fill(connection);
  assert.equal(await page.locator("#name").inputValue(), "");
  assert.equal(
    result.results.find((x) => x.label === "姓名")?.status,
    "pending",
  );
  assert.equal(
    await page.locator("#tail").inputValue(),
    "https://example.invalid/code",
  );
});
test("停止使旧代次写入失效，手动已填值保留", async (t) => {
  const { page, connection } = await setup(t);
  await connection.fill();
  const old = connection.packet({
    fieldId: (await connection.inspect()).find((x) => x.label === "GitHub").id,
    value: "late",
    mode: "full",
  });
  await connection.control("stop");
  await connection.job;
  const before = await page.locator("#tail").inputValue();
  assert.equal((await connection.evaluate("write", old)).status, "stale");
  assert.equal(await page.locator("#tail").inputValue(), before);
});
test("刷新后仅旧值相同不足以恢复覆盖权", async (t) => {
  const { page, connection } = await setup(t);
  await fill(connection);
  await page.reload();
  await page.waitForTimeout(250);
  await page.evaluate(() => (document.querySelector("#name").value = "合成甲"));
  await connection.switchProfile(profile("合成乙"), [
    { id: "合成乙", name: "合成乙" },
  ]);
  await fill(connection);
  assert.equal(await page.locator("#name").inputValue(), "合成甲");
  assert.ok(
    connection.state().results.some((x) => x.reason.includes("来源无法确认")),
  );
});
test("目标页绑定，不随活动标签页转移；主世界无宿主桥接", async (t) => {
  const { context, page, connection } = await setup(t);
  const other = await context.newPage();
  await other.goto(server.url + "/other");
  await other.bringToFront();
  await fill(connection);
  assert.equal(await other.locator("#name").inputValue(), "");
  assert.equal(
    await page.evaluate(() => typeof globalThis.__superOfferSend),
    "undefined",
  );
  assert.equal(
    await page.evaluate(() => typeof globalThis.__superOffer),
    "undefined",
  );
});
test("主世界原型改写不取得隔离世界权限或破坏回读", async (t) => {
  const { page, connection } = await setup(t);
  await page.evaluate(() => {
    Array.prototype.toJSON = function () {
      return ["hostile"];
    };
  });
  await fill(connection);
  assert.equal(await page.locator("#name").inputValue(), "合成甲");
  assert.ok(
    connection
      .state()
      .results.some((x) => x.label === "姓名" && x.status === "filled"),
  );
});
test("真实鼠标浮框控制可暂停和返回；主世界伪造事件不触发", async (t) => {
  const { page, connection, events } = await setup(t);
  const point = await connection.evaluate("controlPoint", "return");
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(100);
  assert.ok(events.some((e) => e.event === "return"));
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent("super-offer", { detail: { command: "fill" } }),
    ),
  );
  await page.waitForTimeout(50);
  assert.equal(await page.locator("#name").inputValue(), "");
});
async function withTestAttachment(t, content = "synthetic") {
  const dir = await mkdtemp(path.join(tmpdir(), "so-browser-"));
  t.after(async () => {
    assert.ok(
      path
        .resolve(dir)
        .startsWith(path.resolve(tmpdir()) + path.sep + "so-browser-"),
    );
    await rm(dir, { recursive: true, force: true });
  });
  const bytes = Buffer.from(`%PDF-1.7\n${content}`);
  const file = path.join(dir, "fixture.pdf");
  await writeFile(file, bytes);
  const p = profile();
  p.attachment = {
    name: "fixture.pdf",
    path: file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return p;
}
test("已有附件需确认，上传失败不阻塞其它字段，成功需页面状态", async (t) => {
  const { page, connection } = await setup(t, await withTestAttachment(t));
  await page.evaluate(() => {
    document
      .querySelector("#resume")
      .setAttribute("data-existing-file", "old.pdf");
    window.failUpload = true;
  });
  await fill(connection);
  assert.ok(
    connection.state().results.some((x) => x.reason.includes("确认替换")),
  );
  const upload = (await connection.inspect()).find((x) => x.type === "file");
  await connection.replaceAttachment(upload.id, true);
  assert.ok(
    connection.state().results.some((x) => x.reason.includes("上传失败")),
  );
  assert.equal(
    await page.locator("#tail").inputValue(),
    "https://example.invalid/code",
  );
  await page.evaluate(() => (window.failUpload = false));
  await connection.replaceAttachment(upload.id, true);
  assert.ok(
    connection.state().results.some((x) => x.reason.includes("上传完成状态")),
  );
});
for (const mode of ["full", "blank"]) {
  test(`配套附件只送到明确的简历入口，其他上传口保持空白 ${mode}`, async (t) => {
    const { page, connection } = await setup(t, await withTestAttachment(t));
    await page.locator("fieldset").filter({ has: page.locator("#resume") }).evaluate((area) => {
      area.innerHTML = `<legend>材料</legend>
        <div><label>作品集<input type="file" accept=".pdf"></label></div>
        <div><label>学历证书<input type="file" accept=".pdf"></label></div>
        <div><label>上传附件<input type="file" accept=".pdf"></label></div>
        <div><label>简历照片<input type="file" accept=".pdf"></label></div>
        <div><label>Upload your CV<input type="file" accept=".pdf"></label><output></output></div>`;
      window.attachmentChanges = [];
      area.addEventListener("change", (event) => {
        const input = event.target;
        window.attachmentChanges.push(input.labels[0].textContent);
        const feedback = input.parentElement.parentElement.querySelector("output");
        if (feedback) feedback.textContent = "Upload complete";
      });
    });
    await fill(connection, mode);
    assert.deepEqual(await page.evaluate(() => window.attachmentChanges), ["Upload your CV"]);
    const files = page.locator("input[type=file]");
    assert.deepEqual(await files.evaluateAll((inputs) => inputs.map((el) => el.files.length)), [0, 0, 0, 0, 1]);
    assert.equal(await files.last().evaluate((el) => el.files[0].text()), "%PDF-1.7\nsynthetic");
    const fields = (await connection.inspect()).filter((field) => field.type === "file");
    const result = (field) => connection.state().results.find((row) => row.fieldId === field.id);
    assert.deepEqual(fields.map((f) => result(f).status), ["pending", "pending", "pending", "pending", "filled"]);
    for (const field of fields.slice(0, 4)) {
      await connection.replaceAttachment(field.id, true);
      assert.match(result(field).reason, /简历入口|简历上传入口/);
      assert.equal(result(field).label, field.label);
    }
    assert.deepEqual(await page.evaluate(() => window.attachmentChanges), ["Upload your CV"]);
    assert.equal(await page.locator("#tail").inputValue(), "https://example.invalid/code");
    assert.equal(await page.evaluate(() => window.submissions), 0);
  });
}
test("配套附件不会借用旁边证书的成功回执", async (t) => {
  const { page, connection } = await setup(t, await withTestAttachment(t));
  await page.locator("fieldset").filter({ has: page.locator("#resume") }).evaluate((area) => {
    area.innerHTML = `<legend>材料</legend><div><label>证书<input type="file" accept="image/png"></label><output></output></div>
      <div><label>简历附件<input id="resume" type="file"></label><output></output></div>`;
    area.querySelector("#resume").addEventListener("change", () => {
      const [certificateStatus, resumeHelp] = area.querySelectorAll("output");
      certificateStatus.textContent = "上传成功";
      resumeHelp.textContent = "请等待，上传成功后才可继续";
    });
  });
  await fill(connection);
  const resume = (await connection.inspect()).find((f) => f.label === "简历附件");
  const record = connection.state().results.find((r) => r.fieldId === resume.id);
  assert.equal(record.status, "verify");
  assert.equal(record.actual, "fixture.pdf");
});
test("配套附件在已有简历链接时先确认，原有成功字样不能充当新回执", async (t) => {
  const { page, connection } = await setup(t, await withTestAttachment(t, "profile A"));
  await page.locator("fieldset").filter({ has: page.locator("#resume") }).evaluate((area) => {
    area.innerHTML = `<legend>附件</legend><label>简历附件<input id="resume" type="file"></label>
      <a href="/previous-file.pdf">旧简历.pdf</a><output></output>`;
    window.attachmentChanges = 0;
    area.addEventListener("change", () => { window.attachmentChanges++; });
  });
  const resume = (await connection.inspect()).find((f) => f.label === "简历附件");
  const record = () => connection.state().results.find((r) => r.fieldId === resume.id);
  await fill(connection, "blank");
  assert.equal(await page.evaluate(() => window.attachmentChanges), 0);
  assert.match(record().reason, /确认替换/);
  await page.locator("a").evaluate((link) => { link.href = "/materials/123"; link.textContent = "查看简历"; });
  const next = await withTestAttachment(t, "profile B");
  next.id = "合成乙";
  await connection.switchProfile(next, [{ id: next.id, name: next.name }]);
  await fill(connection, "full");
  assert.equal(await page.evaluate(() => window.attachmentChanges), 0);
  await page.locator("output").evaluate((el) => { el.textContent = "上传成功"; });
  await connection.replaceAttachment(resume.id, true);
  assert.equal(await page.locator("#resume").evaluate((el) => el.files[0].text()), "%PDF-1.7\nprofile B");
  assert.equal(await page.evaluate(() => window.attachmentChanges), 1);
  assert.equal(record().status, "verify");
  assert.equal(record().actual, "fixture.pdf");
});
test("配套附件回执在停止后到达时不会更新结果", async (t) => {
  const { connection } = await setup(t, await withTestAttachment(t));
  const original = connection.evaluate.bind(connection);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.mock.method(connection, "evaluate", async (method, data) => {
    const result = await original(method, data);
    if (method === "uploaded") { entered.resolve(); await release.promise; }
    return result;
  });
  const resume = (await connection.inspect()).find((f) => f.type === "file");
  await connection.fill("full");
  await entered.promise;
  await connection.control("stop");
  release.resolve();
  await connection.job;
  assert.equal(connection.status, "stopped");
  assert.ok(!connection.state().results.some((r) => r.fieldId === resume.id));
});
test("明确下一步可访问第二页，最终提交仍不会触发", async (t) => {
  const { page, connection } = await setup(t);
  await fill(connection);
  connection.results = [];
  await connection.advance(false);
  await page.waitForURL("**/step2");
  await page.waitForTimeout(200);
  await fill(connection);
  assert.equal(
    await page.locator("#tail").inputValue(),
    "https://example.invalid/code",
  );
  await connection.advance(false);
  assert.equal(await page.evaluate(() => window.submissions), 0);
});
test("必要字段阻塞下一步，保存草稿仅在明确操作时发生", async (t) => {
  const { page, connection } = await setup(t);
  await connection.advance(false);
  assert.ok(page.url().endsWith("/"));
  assert.match(connection.message, /必填/);
  await page.locator("#name").fill("人工补齐");
  await connection.advance(true);
  assert.equal(await page.evaluate(() => window.saved), 1);
  assert.equal(await page.evaluate(() => window.submissions), 0);
});
test("换到其它站点必须重新选择，不能继续写入", async (t) => {
  const { page, connection } = await setup(t);
  const otherOrigin = server.url.replace("127.0.0.1", "localhost");
  await page.goto(otherOrigin);
  await page.waitForTimeout(150);
  assert.equal(connection.context, null);
  assert.match(connection.message, /离开授权站点/);
  await fill(connection);
  assert.equal(await page.locator("#name").inputValue(), "");
});
test("经历缺少某个控件时其它条目的对应关系不移位", async (t) => {
  const { page, connection } = await setup(t);
  await page.locator("#add").click();
  await page
    .locator("[name=major]")
    .first()
    .evaluate((el) => el.parentElement.remove());
  await fill(connection);
  assert.equal(await page.locator("[name=major]").inputValue(), "软件工程");
});
test("单选枚举写后回读，用户改选后保持手改优先", async (t) => {
  const { page, connection } = await setup(t);
  await page
    .locator("#gender")
    .evaluate(
      (el) =>
        (el.parentElement.outerHTML =
          '<fieldset><legend>性别</legend><label>男<input type="radio" name="gender" value="m"></label><label>女<input type="radio" name="gender" value="f"></label></fieldset>'),
    );
  await fill(connection);
  assert.equal(await page.locator("[name=gender]:checked").inputValue(), "f");
  await page.locator("[name=gender][value=m]").check();
  await fill(connection);
  assert.equal(await page.locator("[name=gender]:checked").inputValue(), "m");
});
test("复选框按勾选状态回读，未勾选列待处理并保留手改", async (t) => {
  const { page, connection } = await setup(t);
  await page.locator("form").evaluate((form) =>
    form.insertAdjacentHTML(
      "afterbegin",
      '<fieldset><legend>行业选项</legend>' +
        '<label>未选行业<input id="unchecked-industry" type="checkbox" value="IT/Tech"></label>' +
        '<label>已选行业<input id="checked-industry" type="checkbox" value="Education" checked></label>' +
        '<label>未设置提交值的选项<input id="empty-checkbox" type="checkbox" value="" checked></label>' +
        "</fieldset>",
    ),
  );
  assert.equal(await page.locator("#unchecked-industry").isChecked(), false);
  assert.equal(await page.locator("#checked-industry").isChecked(), true);
  const fields = (await connection.inspect()).filter(
    (field) => field.type === "checkbox",
  );
  assert.deepEqual(fields.map((field) => field.path), [null, null, null]);
  assert.deepEqual(fields.map((field) => field.value), [
    "",
    "Education",
    "未设置提交值的选项",
  ]);
  const results = () =>
    connection.state().results
      .filter((result) => fields.some((field) => field.id === result.fieldId))
      .map(({ status, actual }) => ({ status, actual }));
  await fill(connection, "blank");
  assert.deepEqual(results(), [
    { status: "pending", actual: "" },
    { status: "preserved", actual: "Education" },
    { status: "preserved", actual: "未设置提交值的选项" },
  ]);
  assert.equal(await page.locator("#unchecked-industry").isChecked(), false);
  assert.equal(await page.locator("#checked-industry").isChecked(), true);
  await page.locator("#unchecked-industry").check();
  await page.locator("#checked-industry").uncheck();
  for (const mode of ["full", "blank"]) {
    await fill(connection, mode);
    assert.equal(await page.locator("#unchecked-industry").isChecked(), true);
    assert.equal(await page.locator("#checked-industry").isChecked(), false);
    assert.deepEqual(results(), [
      { status: "preserved", actual: "IT/Tech" },
      { status: "pending", actual: "" },
      { status: "preserved", actual: "未设置提交值的选项" },
    ]);
  }
  assert.equal(await page.evaluate(() => window.submissions), 0);
});

test("自动跨步骤只因真正的必填校验等待，最终提交不执行", async (t) => {
  const { page, connection } = await setup(t);
  await connection.fill("full", true);
  await page.waitForURL("**/step2");
  await page.waitForFunction(
    () =>
      document.querySelector("#tail")?.value === "https://example.invalid/code",
  );
  assert.equal(await page.evaluate(() => window.submissions), 0);
  assert.ok(
    connection.state().results.some((x) => x.reason.includes("日期缺少")),
  );
});
test("同站点同标签页跳到其它申请也需重新确认流程", async (t) => {
  const { page, connection } = await setup(t);
  await page.goto(server.url + "/different-application");
  await page.waitForTimeout(150);
  assert.equal(connection.context, null);
  assert.match(connection.message, /申请流程/);
  await fill(connection);
  assert.equal(await page.locator("#name").inputValue(), "");
});
