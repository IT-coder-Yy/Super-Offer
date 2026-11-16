import { useEffect, useState } from "react";
import { errorOf, fileBytes, request } from "./api";
import type { FileAsset, Provider, Purpose, Workspace } from "./types";
import { Field, formatDate } from "./ui";

interface Props {
  workspace: Workspace;
  reload: () => Promise<Workspace>;
  notify: (message: string, error?: boolean) => void;
  onDirty: (dirty: boolean) => void;
}
const fresh = (purpose: Purpose): Provider => ({
  purpose,
  name: "",
  endpoint: "",
  model: "",
  version: "",
});
function Configuration({
  purpose,
  workspace,
  reload,
  notify,
  onDirty,
}: Props & { purpose: Purpose }) {
  const saved = workspace.state.providers.find((p) => p.purpose === purpose);
  const [draft, setDraft] = useState(saved ?? fresh(purpose));
  const [base, setBase] = useState(saved ?? fresh(purpose));
  const [key, setKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = workspace.providerStatus.find((p) => p.purpose === purpose);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(base) || !!key || removeKey;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  return (
    <fieldset className="settings-section" disabled={busy}>
      <div className="section-title">
        <h2>{purpose === "chat" ? "聊天服务" : "语音转写服务"}</h2>
        <span className={`key-state ${status?.hasKey ? "ready" : ""}`}>
          {status?.hasKey ? "Key 已保存在系统凭证库" : "尚未配置 Key"}
        </span>
      </div>
      <p className="muted">
        {purpose === "chat"
          ? "支持 OpenAI 兼容的 Chat Completions 普通与流式接口。"
          : "支持 multipart 音频转写接口，独立选择服务和模型。"}
      </p>
      {status?.error && <p className="notice error">{status.error.message}</p>}
      <div className="form-grid">
        <Field label="服务名称">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="便于辨认的名称"
          />
        </Field>
        <Field label="模型名称">
          <input
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            placeholder="填写服务商提供的模型 ID"
          />
        </Field>
      </div>
      <Field
        label="完整接口地址"
        hint="填写最终请求地址，使用 HTTPS；本机服务可使用 HTTP。"
      >
        <input
          type="url"
          value={draft.endpoint}
          onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
          placeholder={
            purpose === "chat"
              ? "https://你的服务地址/v1/chat/completions"
              : "https://你的服务地址/v1/audio/transcriptions"
          }
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field
        label="API Key"
        hint="留空保留现有 Key。已保存的 Key 不会回显或进入普通备份。"
      >
        <input
          type="password"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setRemoveKey(false);
          }}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={
            status?.hasKey ? "如需更换，请输入新的 Key" : "仅在本机填写"
          }
        />
      </Field>
      {status?.hasKey && (
        <label className="check">
          <input
            type="checkbox"
            checked={removeKey}
            onChange={(e) => {
              setRemoveKey(e.target.checked);
              setKey("");
            }}
          />
          删除已保存的 Key
        </label>
      )}
      <div className="actions">
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await request<Provider>("save_provider", {
                datasetId: workspace.state.datasetId,
                config: {
                  purpose,
                  name: draft.name,
                  model: draft.model,
                  endpoint: draft.endpoint,
                  expectedVersion: base.version || null,
                  key: key || null,
                  removeKey,
                },
              });
              setDraft(result);
              setBase(result);
              setKey("");
              setRemoveKey(false);
              await reload();
              notify("服务配置已保存。");
            } catch (e) {
              notify(errorOf(e).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          保存{purpose === "chat" ? "聊天" : "转写"}配置
        </button>
        {dirty && <span className="muted small">有未保存修改</span>}
      </div>
    </fieldset>
  );
}
export function ModelPanel(props: Props) {
  const { workspace, reload, notify, onDirty } = props;
  const [chatDirty, setChatDirty] = useState(false);
  const [asrDirty, setAsrDirty] = useState(false);
  const [purpose, setPurpose] = useState<Purpose>("chat");
  const [prompt, setPrompt] = useState("请回复：连接成功。");
  const [stream, setStream] = useState(true);
  const [audio, setAudio] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(
    () => onDirty(chatDirty || asrDirty),
    [chatDirty, asrDirty, onDirty],
  );
  const tasks = [...workspace.state.tasks].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
  const running = tasks.find(
    (t) => t.contextId === `settings:${purpose}` && t.status === "running",
  );
  async function start() {
    setBusy(true);
    try {
      let asset: FileAsset | null = null;
      if (purpose === "asr") {
        if (!audio)
          throw {
            code: "INPUT_INVALID",
            message: "请先选择 MP3、WAV 或 M4A 测试音频。",
          };
        asset = await request<FileAsset>("import_asset", {
          datasetId: workspace.state.datasetId,
          assetKind: "audio",
          name: audio.name,
          bytes: await fileBytes(audio, 50 * 1024 * 1024),
        });
      }
      await request("start_task", {
        datasetId: workspace.state.datasetId,
        input: {
          purpose,
          contextId: `settings:${purpose}`,
          text: purpose === "chat" ? prompt : "",
          assetId: asset?.id ?? null,
          stream: purpose === "chat" && stream,
          versions: asset ? [{ kind: "asset", id: asset.id }] : [],
        },
      });
      await reload();
    } catch (e) {
      notify(errorOf(e).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-page">
      <div className="provider-grid">
        <Configuration {...props} purpose="chat" onDirty={setChatDirty} />
        <Configuration {...props} purpose="asr" onDirty={setAsrDirty} />
      </div>
      <section className="settings-section">
        <h2>测试已保存的配置</h2>
        <p className="muted">
          仅发送下方文字或所选音频；点击测试会调用你的服务，可能产生费用。
        </p>
        <div className="actions">
          <label className="check">
            <input
              type="radio"
              name="test-purpose"
              checked={purpose === "chat"}
              onChange={() => setPurpose("chat")}
            />
            聊天
          </label>
          <label className="check">
            <input
              type="radio"
              name="test-purpose"
              checked={purpose === "asr"}
              onChange={() => setPurpose("asr")}
            />
            音频转写
          </label>
        </div>
        {purpose === "chat" ? (
          <>
            <Field label="测试文字">
              <textarea
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </Field>
            <label className="check">
              <input
                type="checkbox"
                checked={stream}
                onChange={(e) => setStream(e.target.checked)}
              />
              流式接收
            </label>
          </>
        ) : (
          <Field
            label="测试音频"
            hint="最大 50 MB。此处用于接口连通性测试，转写校对与复盘工作流将在后续阶段接入。"
          >
            <input
              type="file"
              accept=".mp3,.wav,.m4a"
              onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
            />
          </Field>
        )}
        <button
          className="primary"
          disabled={
            busy || !!running || (purpose === "chat" ? chatDirty : asrDirty)
          }
          onClick={() => void start()}
        >
          {running ? "正在接收…" : "发送测试"}
        </button>
      </section>
      <section className="settings-section">
        <div className="section-title">
          <h2>任务与用量</h2>
          <span className="muted small">用量以服务实际返回为准</span>
        </div>
        {!tasks.length && (
          <p className="muted">发起测试后，结果与停止记录会保存在这里。</p>
        )}
        {tasks.map((task) => (
          <article className="task-record" key={task.id}>
            <div className="section-title">
              <div>
                <strong>
                  {task.purpose === "chat" ? "聊天" : "音频转写"} ·{" "}
                  {task.provider.name}
                </strong>
                <small>
                  {task.provider.model} · {formatDate(task.startedAt)}
                </small>
              </div>
              {task.status === "running" && (
                <button
                  className="secondary"
                  onClick={async () => {
                    try {
                      await request("cancel_task", {
                        datasetId: workspace.state.datasetId,
                        taskId: task.id,
                      });
                      await reload();
                    } catch (e) {
                      notify(errorOf(e).message, true);
                    }
                  }}
                >
                  停止任务
                </button>
              )}
            </div>
            <p className={task.error ? "error-text" : "muted"}>
              {task.progress}
            </p>
            {task.content && <pre className="task-content">{task.content}</pre>}
            <div className="usage">
              <span>输入 tokens：{task.usage.inputTokens ?? "未知"}</span>
              <span>输出 tokens：{task.usage.outputTokens ?? "未知"}</span>
              <span>合计 tokens：{task.usage.totalTokens ?? "未知"}</span>
              <span>音频秒数：{task.usage.audioSeconds ?? "未知"}</span>
              <span>费用：{task.usage.cost ?? "未知"}</span>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
