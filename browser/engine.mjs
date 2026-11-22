import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { installWorld } from "./page.mjs";
import { inferMappings, readValue, repeated, addLabels } from "./mapping.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stopped = () =>
  Object.assign(new Error("任务或页面已变化，请重新核对后继续。"), {
    code: "STALE_TASK",
  });
const fieldIdentity = ({ id, label, section, type, entryId, entryIndex, autocomplete }) =>
  ({ id, label, section, type, entryId, entryIndex, autocomplete });
const publicUrl = (raw) => {
  try {
    const u = new URL(raw);
    const fragment = u.hash.split("?")[0];
    // 只展示已核实的公开岗位路由，片段里的查询、令牌和账户路径仍不外显。
    const jobRoute =
      u.origin === "https://zhaopin.kuaishou.cn" &&
      u.pathname === "/recruit/e/" &&
      /^#\/official\/trainee\/job-info\/\d+$/.test(fragment)
        ? fragment
        : "";
    return u.origin + u.pathname + jobRoute;
  } catch {
    return "";
  }
};
export class BrowserConnection {
  constructor(emit = () => {}) {
    this.emit = emit;
    this.browser = null;
    this.page = null;
    this.session = null;
    this.context = null;
    this.targetId = null;
    this.origin = null;
    this.generation = randomUUID();
    this.documentId = null;
    this.status = "disconnected";
    this.message = "尚未连接浏览器";
    this.results = [];
    this.profile = null;
    this.profiles = [];
    this.profileSelection = null;
    this.targets = new Map();
    this.job = null;
    this.closed = false;
    this.heartbeat = null;
  }
  state() {
    return {
      connected: !!this.browser?.isConnected(),
      targetId: this.targetId,
      documentId: this.documentId,
      generation: this.generation,
      runId: this.runId || null,
      status: this.status,
      message: this.message,
      url: this.page ? publicUrl(this.page.url()) : "",
      profileVersionId: this.profile?.id || null,
      profileName: this.profile?.name || "",
      results: this.results,
      pending: this.results.filter((x) =>
        ["pending", "verify"].includes(x.status),
      ).length,
    };
  }
  async changed() {
    const state = this.state();
    const view = {
      connected: state.connected,
      generation: state.generation,
      status: state.status,
      message: state.message,
      profileVersionId: state.profileVersionId,
      profileName: state.profileName,
      filled: state.results.filter((item) => ["filled", "updated"].includes(item.status)).length,
      pending: state.pending,
      profiles: this.profiles.map(({ id, name }) => ({ id, name })),
      profileSelection: this.profileSelection
        ? { requestId: this.profileSelection.requestId, status: this.profileSelection.status }
        : null,
    };
    if (this.context) {
      const context = this.context,
        generation = this.generation;
      await this.evaluate("update", view).catch(() => {
        if (context === this.context && generation === this.generation)
          this.context = null;
      });
    }
    this.emit({ event: "state", state: this.state() });
  }
  async connect(channel) {
    if (!["chrome", "msedge"].includes(channel))
      throw new Error("请选择 Chrome 或 Edge。");
    await this.disconnect();
    this.closed = false;
    const timeout = 90_000;
    const deadline = performance.now() + timeout;
    try {
      this.browser = await chromium.connectOverCDP(channel, {
        noDefaults: true,
        timeout,
      });
    } catch (error) {
      // 仅使用 Playwright 的阶段标志，不将含本机路径和调试地址的日志带入界面。
      if (error.message.includes("<ws connected>")) {
        throw Object.assign(
          new Error("浏览器已接受连接，但页面初始化未完成。请核对浏览器状态后重试。"),
          { code: "BROWSER_ATTACH_FAILED" },
        );
      }
      // 使用 channel 名时，Playwright 也可能将握手超时包装为普通 Error。
      if (error.name === "TimeoutError" || performance.now() >= deadline) {
        throw Object.assign(
          new Error("等待浏览器连接超时。请将浏览器置于前台，核对连接提示后重试。"),
          { code: "BROWSER_CONNECT_TIMEOUT" },
        );
      }
      const discoveryFailed = /DevToolsActivePort file not found|invalid DevToolsActivePort file/.test(error.message);
      throw Object.assign(
        new Error(
          discoveryFailed
            ? "未找到可用的调试入口。请确认所选浏览器正在运行并已开启现有会话调试。"
            : "未能建立浏览器连接。请在所选浏览器核对连接请求后重试。",
        ),
        { code: discoveryFailed ? "BROWSER_AUTH_REQUIRED" : "BROWSER_CONNECT_FAILED" },
      );
    }
    this.attach(this.browser);
    await this.changed();
    return this.listTargets();
  }
  attach(browser) {
    this.browser = browser;
    this.status = "connected";
    this.message = "请选择本次申请页面";
    browser.on("disconnected", () => {
      this.generation = randomUUID();
      this.context = null;
      this.status = "disconnected";
      this.message = "浏览器已断开，进度保留；重连后重新核对页面";
      this.emit({ event: "state", state: this.state() });
    });
  }
  async listTargets() {
    if (!this.browser?.isConnected()) throw new Error("请先连接浏览器。");
    this.targets.clear();
    this.listedUrls = new Map();
    const list = [];
    for (const context of this.browser.contexts())
      for (const page of context.pages()) {
        if (!/^https?:/.test(page.url())) continue;
        const cdp = await context.newCDPSession(page);
        try {
          const { targetInfo } = await cdp.send("Target.getTargetInfo");
          this.targets.set(targetInfo.targetId, page);
          this.listedUrls.set(targetInfo.targetId, page.url());
          list.push({
            id: targetInfo.targetId,
            title: (await page.title()).slice(0, 300),
            url: publicUrl(page.url()),
          });
        } finally {
          await cdp.detach();
        }
      }
    return list;
  }
  async select(config) {
    const detaching = this.detach();
    const selection = this.selection = { runId: config.runId };
    await detaching;
    try {
      if (selection !== this.selection) throw stopped();
      return await this.bind(config, selection);
    } catch (error) {
      if (selection === this.selection) {
        await this.detach();
        await this.changed();
      }
      throw error;
    }
  }
  async bind(config, selection) {
    const page = this.targets.get(config.targetId);
    if (!page || page.isClosed())
      throw new Error("所选页面已关闭，请刷新页面列表。");
    if (this.listedUrls.get(config.targetId) !== page.url())
      throw new Error("页面地址已变化，请刷新页面列表后重新选择。");
    this.page = page;
    this.targetId = config.targetId;
    this.origin = new URL(page.url()).origin;
    this.profile = config.profile;
    this.profiles = config.profiles;
    this.runId = config.runId;
    this.runStopped = false;
    this.results = (config.previousResults || []).slice(-5000);
    this.autoAdvance = config.autoAdvance !== false;
    this.generation = randomUUID();
    this.status = "ready";
    this.message = "已连接；填写停在最终提交前";
    this.allowedPages = new Set([page.url()]);
    const session = await page.context().newCDPSession(page);
    if (selection !== this.selection) {
      await session.detach();
      throw stopped();
    }
    this.session = session;
    const binding = "__superOfferSend",
      worldName = "super-offer-private-world";
    this.binding = binding;
    this.worldName = worldName;
    this.session.on("Runtime.bindingCalled", (event) => {
      if (
        event.name !== binding ||
        event.executionContextId !== this.context ||
        event.payload.length > 2000
      )
        return;
      let data;
      try {
        data = JSON.parse(event.payload);
      } catch {
        return;
      }
      if (
        !data ||
        data.documentId !== this.documentId ||
        data.generation !== this.generation
      )
        return;
      if (data.command === "user-navigation") {
        this.expectedNavigation = false;
        return;
      }
      if (
        [
          "fill",
          "blank",
          "pause",
          "resume",
          "stop",
          "return",
          "profile",
        ].includes(data.command)
      ) {
        if (data.command === "profile") {
          void this.requestProfile(data.profileVersionId, data.requestId).catch(
            () => {},
          );
        } else if (data.command === "return") this.emit({ event: "return" });
        else if (["fill", "blank", "resume"].includes(data.command) && data.profileVersionId !== this.profile?.id)
          void this.changed();
        else if (data.command === "fill" || data.command === "blank")
          void this.fill(data.command === "blank" ? "blank" : "full").catch(
            () => {},
          );
        else void this.control(data.command).catch(() => {});
      }
    });
    await session.send("Runtime.enable");
    await session.send("Page.enable");
    await session.send("Runtime.addBinding", {
      name: binding,
      executionContextName: worldName,
    });
    if (selection !== this.selection) throw stopped();
    this.navigation = (frame) => {
      if (frame !== page.mainFrame() || page !== this.page) return;
      const continueFlow = this.expectedNavigation === this.generation;
      if (continueFlow && !this.runStopped && new URL(page.url()).origin === this.origin)
        this.allowedPages.add(page.url());
      this.expectedNavigation = false;
      this.profileSelection = null;
      const generation = this.generation = randomUUID();
      // 单页路由切换仍共用原文档，撤下旧浮框及事件监听。
      if (this.context) void this.evaluate("dispose").catch(() => {});
      this.context = null;
      if (!this.runStopped) {
        this.status = "paused";
        this.message = "页面已变化，重新核对后继续；原有非空内容将保留";
      }
      void this.mount()
        .then((mounted) => {
          if (mounted && continueFlow && generation === this.generation && !this.runStopped && this.autoAdvance)
            return this.fill(this.mode || "full", true, true);
        })
        .catch(() => this.changed());
    };
    page.on("framenavigated", this.navigation);
    this.closeListener = () => {
      this.context = null;
      this.generation = randomUUID();
      this.status = "disconnected";
      this.message = "目标页面已关闭，进度保留";
      void this.changed();
    };
    page.on("close", this.closeListener);
    const mounted = await this.mount();
    if (selection !== this.selection) throw stopped();
    this.heartbeat = setInterval(() => void this.changed(), 1500);
    this.heartbeat.unref?.();
    if (mounted && this.page === page && this.context) {
      const documentId = this.documentId;
      await page.bringToFront();
      if (this.page === page && this.context && this.documentId === documentId)
        this.emit({ event: "ready" });
    }
    return this.state();
  }
  async mount() {
    const page = this.page,
      session = this.session,
      generation = this.generation;
    if (
      !page ||
      page.isClosed() ||
      new URL(page.url()).origin !== this.origin
    ) {
      this.status = this.runStopped ? "stopped" : "paused";
      this.message = "页面已离开授权站点，请返回后重新选择目标页";
      await this.changed();
      return false;
    }
    if (!this.allowedPages.has(page.url())) {
      this.status = this.runStopped ? "stopped" : "paused";
      this.message = "页面已离开已确认的申请流程，请刷新页面列表后重新选择";
      await this.changed();
      return false;
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
    if (session !== this.session || generation !== this.generation) return;
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send(
      "Page.createIsolatedWorld",
      { frameId: frameTree.frame.id, worldName: this.worldName },
    );
    if (session !== this.session || generation !== this.generation) return;
    this.context = executionContextId;
    this.documentId = randomUUID();
    const result = await session.send("Runtime.evaluate", {
      expression: `(${installWorld.toString()})(${JSON.stringify(this.binding)},${JSON.stringify(this.documentId)})`,
      contextId: this.context,
      returnByValue: true,
    });
    if (result.exceptionDetails || result.result.value !== true)
      throw new Error("无法建立网页控制入口，请留在客户端重试。");
    await this.changed();
    return this.context === executionContextId;
  }
  async evaluate(method, data) {
    const contextId = this.context,
      session = this.session;
    if (!contextId || !session || this.page?.isClosed()) throw stopped();
    const result = await session.send("Runtime.evaluate", {
      expression: `globalThis.__superOffer?.${method}(${JSON.stringify(data) ?? ""})`,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    });
    if (contextId !== this.context || session !== this.session) throw stopped();
    if (result.exceptionDetails || result.result.value === undefined)
      throw stopped();
    return result.result.value;
  }
  packet(extra = {}) {
    return {
      documentId: this.documentId,
      generation: this.generation,
      ...extra,
    };
  }
  check(generation) {
    if (
      generation !== this.generation ||
      this.runStopped ||
      this.status !== "running" ||
      !this.context ||
      !this.browser?.isConnected()
    )
      throw stopped();
  }
  assertActive() {
    if (this.runStopped || !this.runId) throw stopped();
  }
  fieldToken(field) {
    return createHash("sha256").update(JSON.stringify([
      this.runId, this.documentId, this.generation, fieldIdentity(field), field.path,
    ])).digest("hex");
  }
  async inspect(report = false) {
    const generation = this.generation;
    const document = await this.evaluate("inspect");
    if (generation !== this.generation) throw stopped();
    const fields = inferMappings(document.fields);
    if (report) {
      this.reportInspection(document, fields);
      if (document.needsLogin && !this.runStopped) {
        if (this.status === "running") this.generation = randomUUID();
        this.pauseForLogin(document, false);
      }
      for (const field of fields) field.fieldToken = this.fieldToken(field);
      await this.changed();
    }
    return fields;
  }
  reportInspection(document, fields) {
    const notices = [];
    if (document.needsLogin)
      notices.push(
        document.loginReason || "检测到可见密码输入框，请本人确认登录状态；工具不填写密码",
      );
    if (document.embeddedFrames)
      notices.push(
        `检测到 ${document.embeddedFrames} 个可见嵌入页面（iframe），其中的表单尚未读取，请人工核对`,
      );
    if (!fields.length && !notices.length)
      notices.push(
        "未识别出表单字段，可能尚未进入申请表、页面仍在加载或控件暂不支持；不能仅据此判断需要登录",
      );
    this.results = this.results.filter((x) => x.fieldId !== "page-inspection");
    if (notices.length)
      this.record({
        fieldId: "page-inspection",
        label: "当前页面检查",
        status: "pending",
        reason: notices.join("；"),
        actual: "",
      });
  }
  pauseForLogin(document, recordPending = true) {
    if (!document.needsLogin) return false;
    this.status = "paused";
    this.expectedNavigation = false;
    this.message = document.loginReason || document.reason ||
      "页面需要本人登录或处理密码；进度保留，完成后继续";
    if (recordPending)
      this.record({
        fieldId: "access",
        label: "登录状态",
        status: "pending",
        reason: this.message,
        actual: "",
      });
    return true;
  }
  record(item) {
    const result = {
      ...item,
      documentId: this.documentId,
      url: publicUrl(this.page?.url() || ""),
    };
    const index = this.results.findIndex(
      (x) => x.documentId === result.documentId && x.fieldId === result.fieldId,
    );
    if (index < 0) this.results.push(result);
    else this.results[index] = result;
    if (this.results.length > 5000) this.results = this.results.slice(-5000);
  }
  async fill(mode = "full", autoAdvance = this.autoAdvance, automatic = false) {
    this.assertActive();
    if (this.profileSelection?.status === "pending")
      throw new Error("档案切换尚未确认，请稍后重试或返回客户端核对。");
    if (!["full", "blank"].includes(mode) || !this.profile)
      throw new Error("请先选择档案与填写模式。");
    if (this.job && this.status === "running")
      throw new Error("当前正在填写，可暂停或停止。");
    this.autoAdvance = autoAdvance === true;
    if (!automatic) this.automaticSteps = 0;
    const generation = this.generation = randomUUID();
    this.status = "running";
    this.message = mode === "blank" ? "正在补充空白" : "正在填写";
    this.mode = mode;
    await this.changed();
    if (generation !== this.generation) throw stopped();
    this.job = this.run(generation, mode)
      .catch((error) => {
        if (generation === this.generation) {
          this.status = error.code === "STALE_TASK" ? "paused" : "interrupted";
          this.message = "填写中断，进度保留，请核对页面后继续";
        }
      })
      .finally(async () => {
        if (generation === this.generation) {
          if (this.status === "running") {
            this.status = "waiting";
            this.message = "本页处理完成，请核对待处理项；未最终提交";
          }
          await this.changed();
        }
      });
    return this.state();
  }
  async run(generation, mode) {
    this.check(generation);
    this.results = this.results.filter(
      (x) => !["page-inspection", "access"].includes(x.fieldId),
    );
    let document = await this.evaluate("inspect");
    this.check(generation);
    if (this.pauseForLogin(document)) return;
    await this.evaluate("action", this.packet({ action: "expand" }));
    for (const group of repeated) {
      const wanted = this.profile.data[group]?.length || 0;
      for (let attempt = 0; attempt < Math.min(wanted, 100); attempt++) {
        this.check(generation);
        const fields = await this.inspect();
        this.check(generation);
        const matching = fields.filter((x) => x.group === group);
        const present = matching.length
          ? Math.max(...matching.map((x) => x.index)) + 1
          : 0;
        if (present >= wanted) break;
        const result = await this.evaluate(
          "action",
          this.packet({ action: "add", labels: addLabels[group] }),
        );
        this.check(generation);
        if (result.status !== "done") {
          if (matching.length)
            this.record({
              fieldId: `group-${group}`,
              label: group,
              status: "pending",
              reason: "无法确认或新增经历区块，请人工处理，其它区块继续",
              actual: "",
            });
          break;
        }
        await delay(100);
        this.check(generation);
        const after = (await this.inspect()).filter((x) => x.group === group);
        this.check(generation);
        const count = after.length
          ? Math.max(...after.map((x) => x.index)) + 1
          : 0;
        if (count <= present) {
          this.record({
            fieldId: `group-${group}`,
            label: group,
            status: "pending",
            reason: "新增经历后未读到新条目，停止重试以免重复",
            actual: "",
          });
          break;
        }
      }
    }
    document = await this.evaluate("inspect");
    this.check(generation);
    if (this.pauseForLogin(document)) return;
    const fields = inferMappings(document.fields);
    if (!fields.length) {
      this.reportInspection(document, fields);
      this.status = "waiting";
      this.message =
        "尚未识别到可填写字段，请等待页面加载或进入申请表后再次点击填写／补空";
      return;
    }
    if (document.embeddedFrames)
      this.record({
        fieldId: "embedded-frames",
        label: "嵌入页面",
        status: "pending",
        reason: "存在未读取的嵌入页面，请核对其中是否包含表单并人工处理；其它字段继续",
        actual: "",
      });
    for (const field of fields) {
      this.check(generation);
      if (field.type === "file") {
        await this.upload(field.id, false, generation);
        if (this.status === "paused") return;
        await this.changed();
        continue;
      }
      const content = readValue(this.profile.data, field.path);
      if (!field.path) {
        this.record({
          fieldId: field.id,
          label: field.label,
          status: field.value ? "preserved" : "pending",
          reason: field.reason,
          actual: field.value,
        });
        await this.changed();
        continue;
      }
      const result = await this.evaluate(
        "write",
        this.packet({ fieldId: field.id, value: content, mode }),
      );
      this.check(generation);
      if (result.status === "stale") throw stopped();
      if (this.pauseForLogin(result)) return;
      await delay(30);
      this.check(generation);
      const readback = await this.evaluate("fieldState", field.id);
      this.check(generation);
      if (
        ["filled", "updated"].includes(result.status) &&
        (!readback ||
          readback.value !== result.actual ||
          !readback.valid ||
          readback.touched)
      ) {
        result.status = "verify";
        result.reason = "页面随后改变或用户已编辑，需核对实际内容";
        result.actual = readback?.value ?? "";
      }
      this.record({ ...result, path: field.path });
      await this.changed();
    }
    if (
      this.autoAdvance &&
      !document.embeddedFrames &&
      this.automaticSteps < 50
    ) {
      this.check(generation);
      this.expectedNavigation = generation;
      const before = fields.map((x) => x.id).join(",");
      const next = await this.evaluate(
        "action",
        this.packet({ action: "next" }),
      );
      this.check(generation);
      if (next.needsLogin) {
        this.pauseForLogin(next);
        return;
      }
      if (next.status === "done") {
        this.automaticSteps++;
        await delay(200);
        if (generation === this.generation && this.context) {
          this.expectedNavigation = false;
          const after = (await this.inspect()).map((x) => x.id).join(",");
          this.check(generation);
          if (after !== before) return this.run(generation, mode);
          this.status = "waiting";
          this.message = "已触发下一步，请核对网站反馈后继续";
        }
      } else {
        this.expectedNavigation = false;
        this.status = "waiting";
        this.message = next.reason || "本页处理完成；最终提交由本人完成";
      }
    }
  }
  async requestProfile(versionId, requestId) {
    this.assertActive();
    if (
      !this.profiles.some((x) => x.id === versionId) ||
      typeof requestId !== "string" || requestId.length > 100 ||
      !requestId.startsWith(`${this.documentId}:`) ||
      this.profileSelection?.status === "pending"
    ) return;
    this.expectedNavigation = false;
    this.generation = randomUUID();
    const request = {
      requestId, versionId, documentId: this.documentId,
      status: "pending", stopped: false,
    };
    this.profileSelection = request;
    this.status = "paused";
    this.message = "正在切换档案，确认后才能填写";
    await this.changed();
    if (this.profileSelection !== request ||
        request.documentId !== this.documentId) throw stopped();
    this.emit({ event: "profile", profileVersionId: versionId, runId: this.runId, requestId });
  }
  checkProfileRequest(runId, requestId) {
    if (runId && runId !== this.runId) throw stopped();
    if (requestId && (
      runId !== this.runId || this.profileSelection?.requestId !== requestId ||
      this.profileSelection.status !== "pending" ||
      this.profileSelection.documentId !== this.documentId || !this.context
    )) throw stopped();
  }
  async switchProfile(profile, profiles, runId = null, requestId = null) {
    this.checkProfileRequest(runId, requestId);
    if (requestId && profile.id !== this.profileSelection.versionId) throw stopped();
    const previous = this.profileSelection;
    this.expectedNavigation = false;
    this.generation = randomUUID();
    this.profile = profile;
    this.profiles = profiles;
    this.profileSelection = previous ? { ...previous, status: "applied" } : null;
    this.status = this.runStopped ? "stopped" : "ready";
    this.message = this.runStopped
      ? "档案已切换；任务仍已停止，网页未改动"
      : "已切换档案，网页未改动；再次填写时检查归属和缺值";
    await this.changed();
    return this.state();
  }
  async profileFailed(runId, requestId, message) {
    this.checkProfileRequest(runId, requestId);
    if (!requestId) throw stopped();
    this.profileSelection = { ...this.profileSelection, status: "failed" };
    this.status = this.profileSelection.stopped ? "stopped" : "paused";
    this.message = `${typeof message === "string" ? message.slice(0, 300) : "档案切换失败"}；未使用新档案，请重新选择或返回客户端核对`;
    await this.changed();
    return this.state();
  }
  async control(action, runId = null) {
    if (runId && runId !== this.runId) throw stopped();
    if (this.runStopped && action === "stop") return this.state();
    this.assertActive();
    if (action === "resume") return this.fill(this.mode || "full");
    if (!["pause", "stop"].includes(action))
      throw new Error("不支持的填写控制");
    this.expectedNavigation = false;
    this.runStopped = action === "stop";
    if (action === "stop" && this.profileSelection?.status === "pending")
      this.profileSelection.stopped = true;
    this.generation = randomUUID();
    this.status = action === "stop" ? "stopped" : "paused";
    this.message =
      action === "stop"
        ? "已停止；网站已有草稿不会被撤销"
        : "已暂停；已有进度保留";
    await this.changed();
    return this.state();
  }
  async applyDraft(fieldId, content, fieldToken) {
    this.assertActive();
    if (typeof fieldToken !== "string" || !fieldToken) throw stopped();
    if (
      typeof content !== "string" ||
      !content.trim() ||
      content.length > 12000
    )
      throw new Error("建议内容无效");
    const inspected = this.generation;
    const document = await this.evaluate("inspect");
    if (inspected !== this.generation) throw stopped();
    if (this.pauseForLogin(document)) {
      await this.changed();
      return this.state();
    }
    const field = inferMappings(document.fields).find((item) => item.id === fieldId);
    if (!field || fieldToken !== this.fieldToken(field)) throw stopped();
    const generation = this.generation = randomUUID();
    this.status = "running";
    await this.changed();
    this.check(generation);
    const result = await this.evaluate(
      "write",
      this.packet({ fieldId, expected: fieldIdentity(field), value: content, mode: this.mode || "full" }),
    );
    this.check(generation);
    if (result.status === "stale") {
      this.status = "paused";
      this.message = "题目已变化，请重新检查后确认写入";
      await this.changed();
      throw stopped();
    }
    if (!this.pauseForLogin(result)) {
      this.record(result);
      this.status = "waiting";
    }
    await this.changed();
    return this.state();
  }
  async upload(fieldId, confirmed, generation = this.generation) {
    const attachment = this.profile?.attachment;
    const target = await this.evaluate(
      "uploadTarget",
      this.packet({ fieldId, confirmed }),
    );
    this.check(generation);
    if (this.pauseForLogin(target)) return;
    const record = (result) => this.record({ fieldId, label: target.label || "上传附件", actual: target.actual || "", ...result });
    if (!target.ready || !attachment) {
      record({ status: "pending", reason: target.reason || "所选档案没有可用配套简历" });
      return;
    }
    const ext = attachment.name.split(".").pop().toLowerCase();
    const mime =
      ext === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const accepted = target.accept
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (
      accepted.length &&
      !accepted.some(
        (x) =>
          x === `.${ext}` || x === mime || x === "application/*" || x === "*/*",
      )
    ) {
      record({
        status: "pending",
        reason: "此上传入口不接受配套简历格式",
      });
      return;
    }
    try {
      const buffer = await readFile(attachment.path);
      if (
        buffer.length !== attachment.bytes ||
        buffer.length > 10 * 1024 * 1024 ||
        createHash("sha256").update(buffer).digest("hex") !== attachment.sha256
      )
        throw new Error("材料副本已变化");
      this.check(generation);
      const inputs = await this.page.locator(`input[type=file][data-super-offer-upload="${target.marker}"]`).elementHandles();
      let previousFeedback;
      try {
        this.check(generation);
        if (inputs.length !== 1) {
          record({ status: "pending", reason: "无法确认唯一上传入口，请核对" });
          return;
        }
        const current = await this.evaluate("uploadTarget", this.packet({ fieldId, confirmed }));
        this.check(generation);
        if (this.pauseForLogin(current)) return;
        if (!current.ready || current.marker !== target.marker || current.accept !== target.accept) {
          record({ status: "pending", reason: current.reason || "上传入口已变化，请核对" });
          return;
        }
        previousFeedback = current.feedback;
        // 页面重绘时只操作刚刚核对的原控件。
        await inputs[0].setInputFiles({ name: attachment.name, mimeType: mime, buffer }, { timeout: 6000 });
      } finally {
        await Promise.all(inputs.map((input) => input.dispose()));
      }
      this.check(generation);
      let result;
      for (let attempt = 0; attempt < 8; attempt++) {
        result = await this.evaluate("uploaded", {
          fieldId,
          name: attachment.name,
          previousFeedback,
        });
        this.check(generation);
        if (result?.status !== "verify") break;
        await delay(150);
        this.check(generation);
      }
      record(result || { status: "verify", reason: "请核对网站上传状态" });
    } catch (error) {
      if (error.code === "STALE_TASK") throw error;
      this.check(generation);
      record({
        status: "pending",
        reason: "附件选择或上传失败，其它字段继续",
      });
    }
  }
  async replaceAttachment(fieldId, confirmed) {
    this.assertActive();
    if (!confirmed) throw new Error("替换附件需要确认");
    if (this.profileSelection?.status === "pending") throw new Error("档案切换尚未确认，请稍后重试");
    const generation = this.generation = randomUUID();
    this.status = "running";
    await this.changed();
    this.check(generation);
    await this.upload(fieldId, true, generation);
    if (generation !== this.generation) throw stopped();
    if (this.status === "running") this.status = "waiting";
    await this.changed();
    return this.state();
  }
  async advance(save) {
    this.assertActive();
    const generation = this.generation = randomUUID();
    this.status = "running";
    await this.changed();
    this.check(generation);
    this.expectedNavigation = save ? false : generation;
    const runId = this.runId;
    let result;
    try {
      result = await this.evaluate("action", this.packet({ action: save ? "save" : "next", confirmed: !!save }));
    } catch (error) {
      // 单页网站可能在点击返回前同步换步，原隔离世界已被撤下。
      if (runId === this.runId && generation !== this.generation) return this.state();
      throw error;
    }
    if (!save && result.status === "done" && generation === this.generation) await delay(200);
    if (generation !== this.generation) return this.state();
    this.check(generation);
    this.expectedNavigation = false;
    if (!this.pauseForLogin(result)) {
      this.status = "waiting";
      this.message =
        result.status === "done"
          ? save
            ? "已触发明确草稿保存，请核对网站反馈"
            : "已触发下一步，等待页面并重新核对"
          : result.reason;
    }
    await this.changed();
    return this.state();
  }
  async detach() {
    this.selection = null;
    this.generation = randomUUID();
    this.profileSelection = null;
    this.expectedNavigation = false;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.page && this.navigation) this.page.off("framenavigated", this.navigation);
    if (this.page && this.closeListener) this.page.off("close", this.closeListener);
    const disposing = this.context && this.evaluate("dispose").catch(() => {});
    const session = this.session;
    this.context = null;
    this.session = null;
    this.page = null;
    this.targetId = null;
    this.documentId = null;
    this.runId = null;
    this.profile = null;
    this.profiles = [];
    this.results = [];
    this.status = this.browser?.isConnected() ? "connected" : "disconnected";
    this.message = this.status === "connected" ? "请选择本次申请页面" : "尚未连接浏览器";
    await disposing;
    if (session) await session.detach().catch(() => {});
  }
  async disconnect() {
    await this.detach();
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close().catch(() => {});
    this.status = "disconnected";
    this.message = "连接已关闭，已有进度保留";
    this.emit({ event: "state", state: this.state() });
  }
  async dispatch(command) {
    if (["fill", "draft", "upload", "advance", "inspect"].includes(command.kind) &&
        command.runId && command.runId !== this.runId) throw stopped();
    switch (command.kind) {
      case "connect":
        return this.connect(command.channel);
      case "targets":
        return this.listTargets();
      case "select":
        return this.select(command);
      case "unselect":
        if (command.runId) {
          const active = this.runId || this.selection?.runId;
          if (!active) return this.state();
          if (command.runId !== active) throw stopped();
        }
        await this.detach();
        await this.changed();
        return this.state();
      case "state":
        return this.state();
      case "inspect":
        return this.inspect(true);
      case "fill":
        return this.fill(command.mode, command.autoAdvance ?? this.autoAdvance);
      case "control":
        return this.control(command.action, command.runId);
      case "profile":
        return this.switchProfile(
          command.profile, command.profiles, command.runId, command.requestId,
        );
      case "profile_failed":
        return this.profileFailed(command.runId, command.requestId, command.message);
      case "draft":
        if (!command.runId) throw stopped();
        return this.applyDraft(command.fieldId, command.value, command.fieldToken);
      case "upload":
        return this.replaceAttachment(command.fieldId, command.confirmed);
      case "advance":
        return this.advance(command.saveDraft === true);
      case "disconnect":
        if (command.runId && command.runId !== this.runId) throw stopped();
        await this.disconnect();
        return this.state();
      default:
        throw new Error("不支持的浏览器命令");
    }
  }
}
