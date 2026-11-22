// 此函数只在选定页面的 CDP 隔离世界运行；页面主世界没有业务桥接权限。
export function installWorld(binding, documentId) {
  globalThis.__superOffer?.dispose();
  let mountedUrl = location.href;
  const elements = new Map(),
    ids = new WeakMap(),
    owned = new WeakMap(),
    touched = new WeakSet(),
    writes = new Map(),
    validationResults = new Map(),
    uploadStates = new WeakMap(),
    forms = new Set(document.forms);
  let sequence = 0,
    view = { generation: "", status: "ready", profileName: "", profiles: [] },
    writing = false,
    lastTick = Date.now(),
    pendingProfile = null,
    profileRequestSequence = 0,
    profilesKey = "",
    pendingNext = null;
  const host = document.createElement("aside");
  host.id = "super-offer-controls";
  host.style.cssText =
    "all:initial;position:fixed;right:12px;top:12px;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host{font:14px system-ui,sans-serif;color:#17202a;color-scheme:light}
    *{box-sizing:border-box}[hidden]{display:none!important}
    section{width:min(280px,calc(100vw - 24px));max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);overflow:auto;padding:12px;border:1px solid #bacbc3;border-radius:12px;background:#fff;box-shadow:0 4px 24px #0002}
    header{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;background:#fff}strong{font-size:14px}label{display:block;font-size:12px;color:#47564f}
    p{font-size:12px;line-height:1.5;margin:10px 0;overflow-wrap:anywhere}
    select,button{font:inherit;min-height:36px;border:1px solid #bacbc3;border-radius:6px;background:#fff;color:inherit;padding:7px 9px;scroll-margin-top:42px;scroll-margin-bottom:6px}
    select{display:block;width:100%;margin-top:4px}button{cursor:pointer}button:hover{background:#edf4ef}button:disabled{cursor:default;opacity:.5}
    button:focus-visible,select:focus-visible{outline:3px solid #39745a;outline-offset:2px}
    .primary,.controls{display:grid;gap:6px;grid-template-columns:1fr 1fr}.primary button{background:#255c46;color:#fff;border-color:#255c46}.primary button:hover{background:#1b4936}.controls{margin-top:8px}
    .collapse{font-size:12px;padding:5px 7px;min-height:32px}.launcher{background:#255c46;color:#fff;box-shadow:0 3px 16px #0002}.launcher:hover{background:#1b4936}
    small{display:block;color:#5d6572;font-size:11px;line-height:1.5;margin-top:10px}
  `;
  const box = document.createElement("section");
  box.id = "super-offer-panel";
  box.setAttribute("aria-label", "Super-Offer 填写面板");
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = "Super-Offer";
  const collapse = document.createElement("button");
  collapse.type = "button";
  collapse.className = "collapse";
  collapse.textContent = "收起面板";
  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "launcher";
  launcher.textContent = "打开填写面板";
  launcher.setAttribute("aria-controls", box.id);
  launcher.setAttribute("aria-expanded", "true");
  launcher.hidden = true;
  const toggle = (open) => {
    box.hidden = !open;
    launcher.hidden = open;
    launcher.setAttribute("aria-expanded", String(open));
    (open ? collapse : launcher).focus();
  };
  collapse.addEventListener("click", (e) => {
    if (e.isTrusted) toggle(false);
  });
  launcher.addEventListener("click", (e) => {
    if (e.isTrusted) toggle(true);
  });
  shadow.addEventListener("keydown", (e) => {
    if (e.isTrusted && e.key === "Escape" && !box.hidden) {
      e.preventDefault();
      e.stopPropagation();
      toggle(false);
    }
  });
  const profile = document.createElement("select");
  profile.setAttribute("aria-label", "填写档案");
  const profileLabel = document.createElement("label");
  profileLabel.textContent = "填写档案";
  profileLabel.append(profile);
  const status = document.createElement("p");
  status.setAttribute("aria-live", "polite");
  const buttons = new Map();
  const send = (command, extra = {}) =>
    globalThis[binding](
      JSON.stringify({
        command,
        documentId,
        generation: view.generation,
        ...extra,
      }),
    );
  profile.addEventListener("change", (e) => {
    if (!e.isTrusted || profile.value === view.profileVersionId) return;
    pendingProfile = {
      requestId: `${documentId}:${++profileRequestSequence}`,
      versionId: profile.value,
    };
    render();
    send("profile", {
      profileVersionId: profile.value,
      requestId: pendingProfile.requestId,
    });
  });
  profile.addEventListener("blur", () => render());
  header.append(title, collapse);
  const primary = document.createElement("div"),
    controls = document.createElement("div");
  primary.className = "primary";
  controls.className = "controls";
  box.append(header, profileLabel, status, primary, controls);
  for (const [command, label] of Object.entries({
    fill: "一键填写",
    blank: "补充填写",
    pause: "暂停",
    resume: "继续",
    stop: "停止",
    return: "返回客户端",
  })) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", (e) => {
      if (e.isTrusted) send(command, { profileVersionId: view.profileVersionId });
    });
    buttons.set(command, button);
    (command === "fill" || command === "blank" ? primary : controls).append(button);
  }
  const note = document.createElement("small");
  note.textContent = "停在最终提交前。手动修改优先。";
  box.append(note);
  shadow.append(style, launcher, box);
  const render = () => {
    const key = JSON.stringify(view.profiles);
    // 心跳不重建正在操作的原生下拉菜单。
    if (key !== profilesKey &&
        (shadow.activeElement !== profile || !profile.options.length)) {
      profile.replaceChildren(
        ...view.profiles.map((p) => {
          const option = document.createElement("option");
          option.value = p.id;
          option.textContent = p.name;
          return option;
        }),
      );
      profilesKey = key;
    }
    const selected = pendingProfile?.versionId || view.profileVersionId || "";
    if (profile.value !== selected &&
        (pendingProfile || shadow.activeElement !== profile)) profile.value = selected;
    const expired = Date.now() - lastTick > 6000;
    const connected = view.connected && !expired;
    profile.disabled = !connected || !!pendingProfile || view.status === "stopped";
    status.textContent = expired
      ? "连接已断开，请返回客户端重新连接"
      : pendingProfile
        ? "正在切换档案，确认后才能填写；未完成可返回客户端核对"
        : `${view.profileName || "未选档案"} · ${view.message || view.status} · 已填 ${view.filled || 0} · 待处理 ${view.pending || 0}`;
    for (const [command, button] of buttons) {
      button.disabled = command !== "return" && (!connected || view.status === "stopped" ||
        (["fill", "blank", "resume"].includes(command) && (!!pendingProfile || view.status === "running")));
    }
  };
  const lease = setInterval(() => {
    if (Date.now() - lastTick > 6000) render();
  }, 1000);
  const mount = () => {
    if (!host.isConnected && document.body) document.body.append(host);
  };
  const observer = new MutationObserver(mount);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  mount();
  const radios = (el) =>
    !el.name ? [el] : [...document.querySelectorAll("input[type=radio]")].filter(
      (x) => x.name === el.name && x.form === el.form,
    );
  const onInput = (event) => {
    if (event.isTrusted && !writing && event.target !== host) {
      touched.add(event.target);
      if (event.target.type === "radio")
        for (const el of radios(event.target)) touched.add(el);
    }
  };
  const onUserClick = (event) => {
    if (event.isTrusted && event.target !== host) {
      pendingNext = null;
      if (["running", "waiting"].includes(view.status)) send("user-navigation");
    }
  };
  document.addEventListener("click", onUserClick, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);
  const normalize = (x) =>
    String(x ?? "")
      .replace(/[\s:：*＊]/g, "")
      .toLowerCase();
  const visible = (el) =>
    !!(
      el.getClientRects().length && getComputedStyle(el).visibility !== "hidden"
    );
  const labelText = (label) => {
    const copy = label.cloneNode(true);
    for (const child of copy.querySelectorAll(
      "input,select,textarea,[role=listbox],button,.ud-formily-item,.ud-formily-item-control,.ud__select__selector__selectItem",
    ))
      child.remove();
    return copy.textContent;
  };
  const formily = (el) => {
    const item = el.closest(".ud-formily-item");
    if (!item) return null;
    const controls = [...item.children].filter((node) => node.classList.contains("ud-formily-item-control"));
    const labels = [...item.children].filter((node) => node.classList.contains("ud-formily-item-label"));
    return controls.length === 1 && controls[0].contains(el) && labels.length === 1
      ? { item, control: controls[0], labelElement: labels[0], label: labelText(labels[0]).trim() }
      : null;
  };
  const required = (el) => {
    if (el.required || el.getAttribute("aria-required") === "true") return true;
    const owner = formily(el);
    return !!owner && [...owner.labelElement.querySelectorAll(".ud-formily-item-asterisk")]
      .some((marker) => marker.closest(".ud-formily-item") === owner.item &&
        visible(marker) && marker.textContent.trim() === "*");
  };
  const atsxSelect = (el) => {
    const selector = el.closest(".atsx-select-selection[role=combobox]");
    return !!selector &&
      (el === selector || el.matches("input.atsx-select-search__field")) &&
      !!selector.querySelector("input.atsx-select-search__field");
  };
  const customSearch = (el) => el.matches(".ud__select__selector__search__input") || atsxSelect(el);
  const unsupportedControl = (el) => {
    if (customSearch(el)) return "custom-select";
    const owner = formily(el);
    if (owner && !["radio", "checkbox", "file"].includes(el.type)) {
      const inputs = [...owner.control.querySelectorAll("input,textarea")].filter((node) =>
        node.closest(".ud-formily-item") === owner.item && visible(node) &&
        !customSearch(node) && !["hidden", "radio", "checkbox", "file", "button", "submit"].includes(node.type),
      );
      if (inputs.length > 1) return "composite";
    }
    return null;
  };
  const labels = (el) => [el.getAttribute("aria-label"), ...[...(el.labels ?? [])].map(labelText)].filter((s) => s?.trim());
  const labelledBy = (el) =>
    (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  const caption = (el) =>
    labels(el).join(" ").trim() || labelledBy(el) ||
    formily(el)?.label ||
    el.getAttribute("placeholder") || "";
  const label = (el) =>
    caption(el) ||
    el.getAttribute("name") ||
    el.id ||
    "未命名字段";
  const key = (el) => {
    if (!ids.has(el)) {
      const id = `f${++sequence}`;
      ids.set(el, id);
      elements.set(id, el);
    }
    return ids.get(el);
  };
  const selectedOption = (el) => {
    const owner = formily(el);
    if (!owner) return "";
    for (let node = el.parentElement; node && node !== owner.item; node = node.parentElement) {
      const selected = [...node.querySelectorAll(".ud__select__selector__selectItem")]
        .filter((item) => item.closest(".ud-formily-item") === owner.item);
      if (selected.length) return selected.map((item) => item.textContent.trim()).join(", ");
    }
    return "";
  };
  const radioValue = (el, selected = radios(el).find((x) => x.checked)) => {
    if (!selected) return "";
    return !selected.value || radios(el).filter((x) => x.value === selected.value).length > 1
      ? label(selected) : selected.value;
  };
  const optionDisabled = (option) => option.disabled ||
    (option.parentElement?.tagName === "OPTGROUP" && option.parentElement.disabled);
  const choiceOf = (el) => el.tagName === "SELECT" ? el.selectedOptions[0]
    : el.type === "radio" ? radios(el).find((x) => x.checked) : undefined;
  const selectValue = (el, selected = choiceOf(el)) => {
    if (!selected || (!selected.value && selected.index === 0)) return "";
    return [...el.options].filter((option) => option.value === selected.value).length > 1
      ? selected.label : selected.value;
  };
  const value = (el) =>
    // 尚无该选择器已选项的可靠DOM依据，搜索词不能当作已选城市。
    atsxSelect(el)
      ? ""
      : customSearch(el)
      ? selectedOption(el)
      : el.type === "file"
      ? [...(el.files ?? [])].map((x) => x.name).join(", ")
      : el.type === "radio"
        ? radioValue(el)
        : el.tagName === "SELECT"
          ? selectValue(el)
        : el.type === "checkbox"
          ? el.checked
            ? el.value || label(el)
            : ""
          : (el.value ?? el.textContent ?? "");
  const moduleOf = (el) => {
    const root = el.closest(".applyFormModuleWrapper-windows");
    if (!root) return null;
    const right = [...root.children].filter((node) => node.classList.contains("applyFormModuleWrapper-right"));
    const titles = root.querySelectorAll(":scope > .applyFormModuleWrapper-left > .applyFormModuleWrapper-title > p.applyFormModuleWrapper-text");
    return right.length === 1 && right[0].contains(el) && titles.length === 1
      ? { root, right: right[0], title: titles[0].textContent.trim() }
      : null;
  };
  const isArrayCard = (node) => [...node.classList].some((name) => name.startsWith("apply-form-array-card__"));
  const entry = (el) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (isArrayCard(node)) {
        const module = moduleOf(el);
        const cards = module ? [...module.right.querySelectorAll('[class*="apply-form-array-card__"]')]
          .filter((card) => {
            if (!isArrayCard(card) || card.closest(".applyFormModuleWrapper-windows") !== module.root) return false;
            for (let parent = card.parentElement; parent && parent !== module.right; parent = parent.parentElement)
              if (isArrayCard(parent)) return false;
            return true;
          }) : [];
        // 数字索引只来自当前模块卡片的DOM顺序，不能用重复的表单ID。
        return { entryId: key(node), entryIndex: cards.indexOf(node) };
      }
      if (node.matches("fieldset,[data-entry],.repeat-item,.education-item,.experience-item,.project-item"))
        return { entryId: key(node) };
    }
    return { entryId: null };
  };
  const section = (el) => {
    const module = moduleOf(el);
    if (module?.title) return module.title;
    const root = el.closest(
      "fieldset,[data-section],section,[role=group],.form-section,.form-group",
    );
    return (
      root?.getAttribute("aria-label") ||
      root?.querySelector("legend,h1,h2,h3,h4,[role=heading]")?.textContent ||
      root?.getAttribute("data-section") ||
      ""
    ).trim();
  };
  const uploadScope = (el) => {
    let scope = el;
    for (let parent = el.parentElement; parent && !parent.matches("form,body,html"); parent = parent.parentElement) {
      if (parent.querySelectorAll("input:not([type=hidden]),textarea,select").length !== 1) break;
      scope = parent;
      if (parent.matches("fieldset,[role=group],.upload,.form-group,.ud-formily-item")) break;
    }
    return scope;
  };
  const resumeCaption = (name) =>
    /^(?:请)?(?:(?:上传|添加|选择|替换)(?:您的|你的)?)?(?:个人|求职|应聘|附件)?简历(?:附件|文件)?(?:上传)?$/.test(name) ||
    /^(?:(?:upload|attach|choose|select)(?:a|your)?)?(?:resume(?:cv)?|cv(?:resume)?|curriculumvitae)(?:file|attachment)?$/.test(name);
  const captionKey = (s) => normalize(s.normalize("NFKD").replace(/\p{M}/gu, "")).replace(/[()/_✱-]/g, "");
  const resumeUpload = (el) => {
    const names = [...labels(el), labelledBy(el), formily(el)?.label].filter(Boolean).map(captionKey);
    const specific = names.filter((s) => !/^(?:上传|附件|文件|上传附件|上传文件|选择文件|upload|attachment|file|choosefile|selectfile)$/.test(s));
    if (specific.length) return specific.every(resumeCaption);
    const scope = uploadScope(el);
    const heading = scope.getAttribute("aria-label") || scope.querySelector(":scope > legend, :scope > h2, :scope > h3, :scope > [role=heading]")?.textContent;
    return !!heading && resumeCaption(captionKey(heading));
  };
  const uploadFeedback = (el, scope) => {
    const text = scope.innerText || "";
    if (el.getAttribute("aria-invalid") === "true" || /上传失败|格式不支持|超过.{0,6}(限制|大小)|upload failed/i.test(text)) return "failed";
    const messages = [...scope.querySelectorAll('output,[role=status],[role=alert],[aria-live]')]
      .filter(visible).map((node) => node.innerText);
    const completed = /^(?:(?:文件|简历附件|简历|附件)?(?:上传成功|上传完成|已上传)|(?:(?:file|resume|attachment)\s+)?(?:uploaded(?: successfully)?|upload (?:complete(?:d)?|success(?:ful)?)))[!！。.]?$/i;
    return [...messages, ...text.split(/\r?\n/)].some((line) => completed.test(line.trim())) ? "success" : "";
  };
  const existingUpload = (scope) => [...scope.querySelectorAll("a[href]")].some((link) => {
    const title = `${link.textContent.trim()} ${link.getAttribute("aria-label") || ""}`.trim();
    const reference = `${title} ${link.getAttribute("href")}`;
    return visible(link) && !/模板|示例|template|sample/i.test(reference) && (link.hasAttribute("download") ||
      /\.(?:pdf|docx?)(?:$|[?#\s])/i.test(reference) || /(?:查看|下载|预览)(?:已上传的?|我的)?简历|(?:view|download|preview)\s+(?:your\s+)?(?:resume|cv)\b/i.test(title));
  });
  const uploadState = (el) => {
    const scope = uploadScope(el);
    const signature = JSON.stringify({
      accept: el.accept, label: label(el), resume: resumeUpload(el),
      files: [...el.files].map(({ name, size, lastModified, type }) => ({ name, size, lastModified, type })),
      existing: el.getAttribute("data-existing-file"), feedback: uploadFeedback(el, scope),
      links: [...scope.querySelectorAll("a[href]")].filter(visible).map((link) => [link.getAttribute("href"), link.textContent, link.getAttribute("aria-label")]),
    });
    let state = uploadStates.get(el);
    if (state?.signature !== signature) {
      state = { signature, id: `${documentId}:upload:${++sequence}` };
      uploadStates.set(el, state);
    }
    return state.id;
  };
  const field = (el) => ({
    id: key(el),
    ...entry(el),
    label: (el.type === "radio"
      ? el.closest("fieldset,[role=radiogroup]")?.querySelector("legend")
          ?.textContent ||
        el.closest("[role=radiogroup]")?.getAttribute("aria-label") ||
        el.name
      : label(el)
    ).slice(0, 400),
    section: section(el).slice(0, 200),
    hasCaption: !!caption(el),
    type: unsupportedControl(el) || el.type || el.getAttribute("role") || el.tagName.toLowerCase(),
    ...(el.type === "file" && { resumeUpload: resumeUpload(el), uploadState: uploadState(el) }),
    value: String(value(el)),
    required: required(el),
    disabled: !!el.disabled || !!el.readOnly,
    options:
      el.tagName === "SELECT"
        ? [...el.options]
            .map((x) => ({ id: key(x), value: x.value, label: x.label, disabled: !!optionDisabled(x) }))
        : el.type === "radio"
          ? radios(el).map((x) => ({ id: key(x), value: x.value, label: label(x), disabled: !!x.disabled }))
          : [],
    autocomplete: el.autocomplete || "",
    owned: owned.has(el),
    touched: touched.has(el),
    valid: validValue(el) && (!required(el) || !!String(value(el)).trim()),
  });
  const validValue = (el) => (el.type === "radio" ? radios(el) : [el]).every((item) =>
    (!item.validity || item.validity.valid) && item.getAttribute("aria-invalid") !== "true");
  const loginReason = () => {
    const inputs = [...document.querySelectorAll("input")].filter(visible);
    if (inputs.some((el) => el.type === "password"))
      return "检测到可见密码输入框，请本人确认登录状态；工具不填写密码";
    const identity = (el) =>
      ["tel", "email"].includes(el.type) ||
      /手机|电话|邮箱|phone|mobile|email/i.test(label(el));
    const code = (el) =>
      el.autocomplete === "one-time-code" ||
      /验证码|校验码|verification.?code|one.?time.?code|otp/i.test(label(el));
    const loginAction = (el) =>
      visible(el) &&
      !el.closest("header,nav,[role=navigation]") &&
      /^(?:登录|登入|立即登录|登录注册|注册登录|login|signin)$/i.test(
        normalize(el.textContent || el.value),
      );
    const actions = [
      ...document.querySelectorAll("button,[role=button],input[type=submit]"),
    ].filter(loginAction);
    if (
      actions.some((action) => {
        const scope = action.closest("form,[role=form],dialog,[role=dialog]");
        if (!scope) return false;
        const scoped = inputs.filter((el) => scope.contains(el));
        return scoped.some(identity) && scoped.some(code);
      })
    )
      return "检测到验证码登录表单，请本人处理登录和协议；工具不会填写登录资料";
    const loginPath = /(?:^|\/)(?:login|sign[-_]?in)(?:\/|$)/i.test(
      location.pathname,
    );
    const headings = [
      ...document.querySelectorAll("h1,h2,h3,[role=heading],[role=tab]"),
    ].filter((el) => visible(el) && !el.closest("header,nav,[role=navigation]"));
    if (
      loginPath &&
      (actions.length || headings.some((el) =>
        /^(?:登录|扫码登录|二维码登录|手机(?:号|号码)?登录|邮箱登录|signin|login)$/i.test(
          normalize(el.textContent),
        ),
      ))
    )
      return "检测到明确的登录页面，请本人处理登录和协议；工具不会操作登录控件";
    return "";
  };
  const inspect = () => {
    if (!forms.size) for (const form of document.forms) forms.add(form);
    const reason = loginReason();
    return {
      documentId,
      fields: reason ? [] : [
        ...document.querySelectorAll("input,select,textarea,[role=combobox]"),
      ]
        .filter(
          (el) =>
            visible(el) &&
            !["hidden", "password", "submit", "button", "reset"].includes(
              el.type,
            ) &&
            (el.type !== "radio" || radios(el)[0] === el) &&
            !host.contains(el),
        )
        .slice(0, 1500)
        .map(field),
      needsLogin: !!reason,
      loginReason: reason,
      embeddedFrames: [...document.querySelectorAll("iframe")].filter(visible)
        .length,
      url: location.origin + location.pathname,
    };
  };
  const pending = (el, reason) => {
    if (el) {
      el.style.outline = "2px solid #c62828";
      el.setAttribute("data-super-offer-pending", reason);
    }
  };
  const clearPending = (el) => {
    if (el.hasAttribute("data-super-offer-pending")) {
      el.style.outline = "";
      el.removeAttribute("data-super-offer-pending");
    }
  };
  const safe = (packet) =>
    location.href === mountedUrl && packet.documentId === documentId &&
    packet.generation === view.generation &&
    view.status === "running" && view.connected && Date.now() - lastTick <= 6000;
  const matchesExpected = (el, expected) => {
    const current = field(el);
    return !expected || Object.entries(expected).every(([key, value]) =>
      JSON.stringify(current[key]) === JSON.stringify(value));
  };
  const identity = (el) => {
    const { id, label, section, hasCaption, type, entryId, entryIndex, autocomplete, options } = field(el);
    return { id, label, section, hasCaption, type, entryId, entryIndex, autocomplete, options };
  };
  const staleField = (el) => {
    const reason = "当前字段或选项已变化，请重新检查";
    pending(el, reason);
    return { status: "stale-field", label: field(el).label, actual: String(value(el)), reason };
  };
  const reviewWrites = () => {
    if (writes.size && loginReason()) { writes.clear(); return; }
    for (const [el, attempt] of writes) {
      if (location.href !== mountedUrl || attempt.generation !== view.generation ||
          !view.connected || Date.now() - lastTick > 6000 || !["running", "waiting"].includes(view.status)) {
        writes.delete(el);
        continue;
      }
      let actual = String(value(el)), reason = "", status = "verify";
      if (!el.isConnected || !visible(el) || el.disabled || el.readOnly || !matchesExpected(el, attempt.expected))
        reason = "写入后字段已变化，保留现场，请重新检查";
      else if (touched.has(el)) reason = "用户已编辑，保留手改内容";
      else if (actual !== attempt.value || choiceOf(el) !== attempt.choice)
        reason = "页面随后改变了内容，保留现场，请核对";
      else if (!validValue(el)) {
        // 仅撤回仍能确认属于本代次、原控件且未被手改的这次写入。
        writes.delete(el);
        try { attempt.restore(); } catch { /* 以下回读报告恢复是否完成。 */ }
        actual = String(value(el));
        const restored = actual === attempt.before && choiceOf(el) === attempt.beforeChoice;
        if (restored && attempt.previous) owned.set(el, attempt.previous);
        else owned.delete(el);
        reason = restored ? "页面随后校验未通过，已恢复写入前内容，请核对" : "页面随后校验未通过，网站未恢复原值，请本人核对";
        status = "pending";
      }
      if (reason) {
        writes.delete(el);
        pending(el, reason);
        validationResults.set(key(el), { fieldId: key(el), label: field(el).label, actual, status, reason });
      }
    }
  };
  const validationObserver = new MutationObserver(reviewWrites);
  validationObserver.observe(document.documentElement, {
    attributes: true, childList: true, subtree: true,
    attributeFilter: ["aria-invalid", "disabled", "readonly", "type", "name", "required", "pattern", "value"],
  });
  const write = async (packet) => {
    const el = elements.get(packet.fieldId);
    const result = {
      fieldId: packet.fieldId,
      label: el ? field(el).label : "",
      actual: el ? String(value(el)) : "",
      status: "pending",
      reason: "",
    };
    const fail = (reason) => {
      pending(el, reason);
      return { ...result, reason };
    };
    if (!safe(packet))
      return { ...result, status: "stale", reason: "任务或页面已变化" };
    const login = loginReason();
    if (login) return { ...result, reason: login, needsLogin: true };
    if (!el?.isConnected || !visible(el)) return fail("字段已消失或不可访问");
    if (!matchesExpected(el, packet.expected)) return { ...result, ...staleField(el) };
    const current = String(value(el)), previous = owned.get(el), beforeChoice = choiceOf(el);
    if (current.trim() && (packet.mode === "blank" || touched.has(el))) {
      if (!validValue(el)) return fail("页面校验未通过，保留原有内容，请本人修正");
      clearPending(el);
      return { ...result, status: "preserved", reason: touched.has(el) ? "用户手动修改优先" : "补空保留非空内容" };
    }
    if (touched.has(el)) return fail("用户手动修改优先");
    if (unsupportedControl(el)) return fail("自定义选项或复合控件请本人操作，不向内部输入框写入资料");
    if (el.disabled || el.readOnly) return fail("字段不可写");
    if (
      /验证码|密码|同意|承诺|声明|captcha|verification code|consent|password/i.test(
        label(el),
      )
    )
      return fail("此项须本人在网站处理，工具不代填");
    if (packet.value == null || packet.value === "")
      return current && previous
        ? fail("换档缺值，保留旧内容，请人工核对")
        : fail("档案缺少此项");
    if (current && (!previous || previous.value !== current || previous.choice !== beforeChoice))
      return fail("原有内容或来源无法确认，已保留");
    if (
      ["checkbox", "file"].includes(el.type) ||
      !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
    )
      return fail("此控件需要人工选择或附件操作");
    if (el.tagName === "SELECT" && el.multiple) return fail("多选下拉请本人核对选择");
    let wanted = String(packet.value), choice;
    if (el.type === "radio" || el.tagName === "SELECT") {
      const radio = el.type === "radio";
      const options = (radio ? radios(el) : [...el.options]).filter(
        (x) =>
          !(radio ? x.disabled : optionDisabled(x)) && (!radio || visible(x)) &&
          (normalize(x.value) === normalize(wanted) ||
            normalize(radio ? label(x) : x.label) === normalize(wanted)),
      );
      if (!options.length) return fail("找不到对应选项");
      if (options.length !== 1) return fail("选项存在歧义，请本人选择");
      choice = options[0];
      wanted = radio ? radioValue(el, choice) : selectValue(el, choice);
    }
    if (el.type === "month" && /^\d{4}-\d{2}-\d{2}$/.test(wanted))
      wanted = wanted.slice(0, 7);
    if (el.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(wanted))
      return fail("日期缺少日，不能猜测");
    const proto =
      el.tagName === "SELECT"
        ? HTMLSelectElement.prototype
        : el.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (!setter) return fail("控件没有可用写入入口");
    const writeValue = (v, selected) => {
      writing = true;
      try {
        if (el.type === "radio") {
          const group = radios(el);
          if (selected && group.includes(selected)) { selected.click(); return; }
          const checked = group.find((x) => x.checked);
          if (checked) checked.checked = false;
        } else if (el.tagName === "SELECT") {
          const index = [...el.options].indexOf(selected);
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex").set.call(el, index);
        } else setter.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } finally {
        writing = false;
      }
    };
    let reason = "";
    try {
      el.scrollIntoView({ block: "center", behavior: "instant" });
      if (!matchesExpected(el, packet.expected)) return { ...result, ...staleField(el) };
      writeValue(wanted, choice);
    } catch { reason = "页面拒绝写入"; }
    if (String(value(el)) === wanted && validValue(el))
      await new Promise((resolve) => setTimeout(resolve, 30));
    const actual = String(value(el));
    if (!safe(packet)) return { ...result, status: "stale", actual, reason: "任务或页面已变化" };
    if (!el.isConnected || touched.has(el)) return { ...result, status: "verify", actual, reason: "字段已变化或用户已编辑，请核对实际内容" };
    if (!matchesExpected(el, packet.expected)) return { ...result, ...staleField(el) };
    if (reason || actual !== wanted || !validValue(el) || choiceOf(el) !== choice) {
      if (actual !== current || choiceOf(el) !== beforeChoice) {
        try { writeValue(current, beforeChoice); } catch { /* 按下方实际回读报告。 */ }
      }
      const restored = String(value(el));
      if (!reason) reason = "写后回读或页面校验未通过";
      if (restored !== current || choiceOf(el) !== beforeChoice) {
        owned.delete(el);
        reason += "，网站未恢复原值，请本人核对";
      }
      return { ...fail(reason), actual: restored };
    }
    owned.set(el, { value: actual, choice });
    writes.set(el, { generation: packet.generation, value: actual, choice,
      before: current, beforeChoice, previous, expected: identity(el),
      restore: () => writeValue(current, beforeChoice) });
    clearPending(el);
    return {
      ...result,
      actual,
      status: current ? "updated" : "filled",
      reason: "已回读页面值；未确认服务端保存",
    };
  };
  const action = (packet) => {
    if (!safe(packet)) return { status: "stale" };
    const login = loginReason();
    if (login) return { status: "pending", reason: login, needsLogin: true };
    if (packet.action === "expand") {
      for (const el of document.querySelectorAll("details:not([open])"))
        el.open = true;
      return { status: "done" };
    }
    let labels;
    if (packet.action === "add") labels = packet.labels;
    else if (packet.action === "next")
      labels = ["下一步", "下一页", "继续填写", "next"];
    else if (packet.action === "save" && packet.confirmed === true)
      labels = ["保存草稿", "暂存", "save draft"];
    else return { status: "pending", reason: "此动作须本人处理" };
    const matches = [
      ...document.querySelectorAll("button,[role=button]"),
    ].filter(
      (el) =>
        visible(el) &&
        !el.disabled &&
        labels.some((x) => normalize(el.textContent) === normalize(x)),
    );
    if (matches.length !== 1) {
      if (
        packet.action === "next" &&
        [...document.querySelectorAll("button,input[type=submit]")].some(
          (el) =>
            visible(el) &&
            /提交|投递|立即申请|submit/i.test(el.textContent || el.value),
        )
      )
        return {
          status: "final",
          reason: "检测到提交入口，已停留等待本人核对；未最终提交",
        };
      return {
        status: "pending",
        reason: "未找到唯一明确的下一步／新增／草稿入口",
      };
    }
    const el = matches[0];
    if (
      el.type === "submit" ||
      /提交|投递|申请职位|确认申请|apply|submit/i.test(el.textContent)
    )
      return { status: "pending", reason: "可能属于最终提交，交由本人处理" };
    if (
      packet.action === "next" &&
      [...document.querySelectorAll("input,textarea,select")].some(
          (x) => visible(x) && required(x) &&
            (!String(value(x)).trim() || !validValue(x)),
      )
    )
      return { status: "pending", reason: "本页必填校验未完成，请补齐后继续" };
    if (packet.action === "next") {
      pendingNext = { generation: packet.generation, documentId };
      const link = el.closest("a[href]");
      if (link && new URL(link.href).origin === location.origin) {
        send("next-destination", { url: link.href });
        pendingNext = null;
      }
    }
    el.click();
    return { status: "done" };
  };
  const onNavigate = (event) => {
    if (!pendingNext || !event.isTrusted) return;
    if (event.userInitiated || !["push", "replace"].includes(event.navigationType)) {
      pendingNext = null;
      return;
    }
    if (pendingNext.generation === view.generation &&
        pendingNext.documentId === documentId && ["running", "waiting"].includes(view.status) &&
        new URL(event.destination.url).origin === location.origin) {
      send("next-destination", { url: event.destination.url });
      pendingNext = null;
    }
  };
  globalThis.navigation?.addEventListener("navigate", onNavigate);
  globalThis.__superOffer = {
    documentId,
    inspect,
    write,
    action,
    update(next) {
      lastTick = Date.now();
      if (next.generation !== view.generation || !next.connected ||
          !["running", "waiting"].includes(next.status)) {
        writes.clear();
        validationResults.clear();
        pendingNext = null;
      }
      view = next;
      if (pendingProfile &&
          next.profileSelection?.requestId === pendingProfile.requestId &&
          next.profileSelection.status !== "pending") {
        pendingProfile = null;
      }
      render();
      return true;
    },
    reconcile(packet) {
      if (packet.documentId !== documentId || packet.generation !== view.generation ||
          !["running", "waiting"].includes(view.status)) return [];
      reviewWrites();
      const results = [...validationResults.values()];
      validationResults.clear();
      return results;
    },
    formAnchor() {
      const previous = new URL(mountedUrl), current = new URL(location.href);
      if (previous.origin !== current.origin || previous.pathname !== current.pathname || previous.search !== current.search)
        return false;
      const inOriginalForm = (hash) => {
        let name;
        try { name = decodeURIComponent(hash.slice(1)); } catch { return false; }
        if (!name || /^[\/!]/.test(name) || /[?=]/.test(name)) return false;
        const targets = [...document.querySelectorAll("[id],[name]")]
          .filter((el) => el.id === name || el.getAttribute("name") === name);
        return targets.length === 1 && [...forms].some((form) => form.isConnected && (form === targets[0] || form.contains(targets[0])));
      };
      if ((previous.hash && !inOriginalForm(previous.hash)) || !inOriginalForm(current.hash)) return false;
      mountedUrl = location.href;
      return true;
    },
    controlPoint(command) {
      const element = command === "profile" ? profile
        : command === "collapse" ? collapse
          : command === "open" ? launcher : buttons.get(command);
      if (!element?.getClientRects().length) return null;
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = element.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    },
    fieldState(id) {
      const el = elements.get(id);
      return el?.isConnected ? field(el) : null;
    },
    mark(packet) {
      if (!safe(packet)) return { status: "stale", actual: "", reason: "任务或页面已变化" };
      const login = loginReason();
      if (login) return { status: "pending", actual: "", needsLogin: true, reason: login };
      const el = elements.get(packet.fieldId);
      if (!el?.isConnected) return { status: "pending", actual: "", reason: "字段已消失或不可访问" };
      if (!matchesExpected(el, packet.expected)) return staleField(el);
      const actual = String(value(el));
      if (!validValue(el)) {
        const reason = "页面校验未通过，保留原有内容，请本人修正";
        pending(el, reason);
        return { status: "pending", actual, reason };
      }
      if (actual.trim()) {
        clearPending(el);
        return { status: "preserved", actual, reason: packet.reason };
      }
      pending(el, packet.reason);
      return { status: "pending", actual, reason: packet.reason };
    },
    uploadTarget(packet) {
      const el = elements.get(packet.fieldId);
      if (!safe(packet) || !el?.isConnected || el.type !== "file")
        return { ready: false, reason: "上传入口或任务已变化" };
      const login = loginReason();
      if (login) return { ready: false, reason: login, needsLogin: true };
      const info = { label: label(el).slice(0, 400), actual: value(el) };
      const unavailable = (reason) => { pending(el, reason); return { ...info, ready: false, reason }; };
      if (!packet.expectedUploadState || packet.expectedUploadState !== uploadState(el))
        return { ...unavailable("上传入口或已有附件已变化，请重新检查并确认"), stale: true };
      if (!visible(el) || el.disabled) return unavailable("上传入口当前不可用");
      if (!resumeUpload(el)) return unavailable("未确认是简历上传入口，请本人核对附件用途");
      if (touched.has(el))
        return unavailable("用户已修改附件，请人工处理");
      const scope = uploadScope(el);
      const feedback = uploadFeedback(el, scope);
      if (
        !packet.confirmed && (el.files?.length || el.getAttribute("data-existing-file") || existingUpload(scope) || feedback === "success")
      )
        return unavailable("已有附件，需确认替换");
      const marker = `${documentId}_${packet.fieldId}`;
      el.setAttribute("data-super-offer-upload", marker);
      return { ...info, ready: true, marker, accept: el.accept, feedback };
    },
    element(id) {
      return elements.get(id);
    },
    uploaded({ fieldId, name, previousFeedback }) {
      const el = elements.get(fieldId);
      const actual = el?.files?.[0]?.name;
      if (!el?.isConnected || actual !== name) {
        pending(el, "附件回读失败");
        return { status: "pending", reason: "附件回读失败" };
      }
      const feedback = uploadFeedback(el, uploadScope(el));
      if (feedback === "failed" && previousFeedback !== "failed") {
        pending(el, "网站报告附件上传失败");
        return { status: "pending", actual, reason: "网站报告附件上传失败" };
      }
      if (feedback === "success" && previousFeedback !== "success") {
        owned.set(el, { value: actual });
        el.style.outline = "";
        el.removeAttribute("data-super-offer-pending");
        return {
          status: "filled",
          actual,
          reason: "附件名和可见上传完成状态已核对",
        };
      }
      return {
        status: "verify",
        actual,
        reason: "已选择文件，仍需核对网站上传完成状态",
      };
    },
    dispose(packet) {
      if (packet && packet.documentId !== documentId) return [];
      // 只收已经发生的校验结果；撤权后不再为断开操作改动网页内容。
      const results = packet?.documentId === documentId && packet.generation === view.generation &&
        ["running", "waiting"].includes(view.status) ? [...validationResults.values()] : [];
      view = { ...view, generation: "", status: "stopped", connected: false };
      clearInterval(lease);
      observer.disconnect();
      validationObserver.disconnect();
      writes.clear();
      validationResults.clear();
      pendingNext = null;
      globalThis.navigation?.removeEventListener("navigate", onNavigate);
      document.removeEventListener("click", onUserClick, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("change", onInput, true);
      host.remove();
      delete globalThis.__superOffer;
      return results;
    },
  };
  send("ready");
  return true;
}
