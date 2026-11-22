import { useEffect, useRef, useState } from "react";
import { errorOf, mutate, request } from "./api";
import { FIELD_GROUPS, materializeSelection } from "./profile-fields";
import {
  emptyJob,
  type Fields,
  type ModelTask,
  type ProfileData,
  type Workspace,
} from "./types";
import type {
  BrowserField,
  BrowserStatus,
  BrowserTarget,
} from "./browser-types";
import { Dialog, Empty, Field, formatDate } from "./ui";

interface Props {
  workspace: Workspace;
  reload: () => Promise<Workspace>;
  notify: (message: string, error?: boolean) => void;
  onDirty: (dirty: boolean) => void;
  profileSelection?: { versionId: string; data: ProfileData } | null;
}
const labels: Record<string, string> = {
  filled: "已填",
  updated: "已更新",
  pending: "待处理",
  preserved: "已保留",
  verify: "待核验",
  stale: "已失效",
};
export function BrowserPanel({
  workspace,
  reload,
  notify,
  onDirty,
  profileSelection,
}: Props) {
  const state = workspace.state;
  const [status, setStatus] = useState<BrowserStatus | null>(null),
    [targets, setTargets] = useState<BrowserTarget[]>([]);
  const [channel, setChannel] = useState("msedge"),
    [targetId, setTargetId] = useState(""),
    [versionId, setVersionId] = useState(""),
    [applicationId, setApplicationId] = useState("");
  const [overrides, setOverrides] = useState<Fields>({}),
    [busy, setBusy] = useState(false),
    [fields, setFields] = useState<BrowserField[]>([]);
  const [connecting, setConnecting] = useState(false),
    [connectionError, setConnectionError] = useState("");
  const [useProfileSelection, setUseProfileSelection] = useState(false);
  const [fieldId, setFieldId] = useState(""),
    [answer, setAnswer] = useState(""),
    [draftId, setDraftId] = useState(""),
    [allowAi, setAllowAi] = useState(false);
  const [newApplication, setNewApplication] = useState(false),
    [job, setJob] = useState(emptyJob()),
    [duplicate, setDuplicate] = useState(false);
  const [confirm, setConfirm] = useState<null | {
    title: string;
    detail: string;
    action: () => Promise<void>;
  }>(null);
  const epoch = useRef(0);
  const version = state.profiles
    .flatMap((p) => p.versions)
    .find((v) => v.id === versionId);
  const selectionBase =
    useProfileSelection && profileSelection?.versionId === versionId
      ? profileSelection.data
      : version?.data;
  const draft = state.tasks.find((t) => t.id === draftId);
  const selectedField = fields.find((f) => f.id === fieldId);
  const live = status?.state;
  const selectedApplication = state.applications.find(
    (a) => a.id === (status?.run?.applicationId || applicationId),
  );
  const call = <T,>(command: Record<string, unknown>) =>
    request<T>("browser", { datasetId: state.datasetId, command });
  const refresh = async () => {
    const value = await call<BrowserStatus>({ kind: "status" });
    setStatus(value);
    return value;
  };
  const perform = async (
    action: () => Promise<void>,
    onError?: (message: string) => void,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (error) {
      const message = errorOf(error).message;
      if (onError) onError(message);
      else notify(message, true);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    onDirty(
      !!answer.trim() || Object.keys(overrides).length > 0 || newApplication,
    );
  }, [answer, overrides, newApplication, onDirty]);
  useEffect(() => {
    epoch.current++;
    const current = epoch.current;
    let stopped = false;
    setStatus(null);
    setTargets([]);
    setTargetId("");
    setFields([]);
    setFieldId("");
    setDraftId("");
    setOverrides({});
    setAnswer("");
    setConnectionError("");
    const poll = async () => {
      try {
        const value = await call<BrowserStatus>({ kind: "status" });
        if (!stopped && current === epoch.current) setStatus(value);
      } catch {
        /* 操作时显示具体错误，后台轮询不覆盖当前编辑。 */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [state.datasetId]);
  useEffect(() => {
    if (!versionId && state.profiles[0])
      setVersionId(state.profiles[0].currentVersionId);
  }, [state.profiles, versionId]);
  const select = async () => {
    if (!version || !selectionBase)
      throw { code: "INPUT_INVALID", message: "请先选择档案。" };
    await call({
      kind: "select",
      targetId,
      profileVersionId: version.id,
      applicationId: applicationId || null,
      selection: materializeSelection(selectionBase, overrides),
    });
    setOverrides({});
    setDraftId("");
    setFields([]);
    setAnswer("");
  };
  const switchProfile = async () => {
    if (!version || !selectionBase) return;
    await call({
      kind: "switch_profile",
      profileVersionId: version.id,
      selection: materializeSelection(selectionBase, overrides),
    });
    setOverrides({});
    setDraftId("");
    setFields([]);
  };
  const inspect = async () => {
    setFields(await call<BrowserField[]>({ kind: "inspect" }));
    setFieldId("");
    setDraftId("");
  };
  const choose = (title: string, detail: string, action: () => Promise<void>) =>
    setConfirm({ title, detail, action });
  const saveAnswer = async () => {
    if (!version || !selectedField || !answer.trim()) return;
    const data = structuredClone(version.data);
    data.answers.push({ question: selectedField.label, answer: answer.trim() });
    await mutate(state, {
      kind: "save_profile",
      profileId: version.profileId,
      expectedVersionId: version.id,
      name:
        state.profiles.find((p) => p.id === version.profileId)?.name || "档案",
      data,
    });
    await reload();
    notify("已显式保存为该档案的新版本，当前填写仍使用原固定版本。");
  };
  const confirmSubmitted = async () => {
    let application = selectedApplication;
    if (!application) return;
    const usedVersion = status?.run?.profileVersionId;
    if (
      usedVersion &&
      application.profileVersionId !== usedVersion &&
      !application.confirmedSubmittedAt
    ) {
      const snapshot = state.jobs.find(
        (j) => j.id === application!.jobSnapshotId,
      );
      if (!snapshot)
        throw {
          code: "INPUT_INVALID",
          message: "岗位快照缺失，请先刷新核对。",
        };
      await mutate(state, {
        kind: "update_application",
        id: application.id,
        expectedRevision: application.revision,
        job: snapshot.data,
        profileVersionId: usedVersion,
        stage: application.stage,
        endReason: application.endReason,
        nextAction: application.nextAction,
        dueAt: application.dueAt,
        notes: application.notes,
      });
      const refreshed = await reload();
      application = refreshed.state.applications.find(
        (a) => a.id === application!.id,
      );
      if (!application)
        throw {
          code: "INPUT_INVALID",
          message: "申请记录已变化，请刷新核对。",
        };
    }
    await mutate(state, {
      kind: "confirm_submitted",
      id: application.id,
      expectedRevision: application.revision,
      confirmed: true,
      submittedAt: new Date().toISOString(),
    });
    await reload();
    notify("已记录你确认的实际提交；重复填写不会增加投递数。");
  };
  return (
    <section className="workflow-panel">
      <header className="section-title">
        <div>
          <h2>浏览器与投递</h2>
          <p className="muted">
            先在招聘网站登录并打开简历表单。在这里选定页面后，就能直接在网页悬浮窗里用个人档案填写。
          </p>
        </div>
      </header>
      <details>
        <summary>连接准备</summary>
        <ol>
          <li>
            在所选 {channel === "msedge" ? "Edge" : "Chrome"} 的地址栏打开{" "}
            <code>
              {channel === "msedge"
                ? "edge://inspect/#remote-debugging"
                : "chrome://inspect/#remote-debugging"}
            </code>
            。
          </li>
          <li>
            如果页面提供现有会话的远程调试选项，请本人开启；出现连接请求时，核对后允许
            Super-Offer 连接。
          </li>
          <li>点击“连接现有浏览器”，选中已打开的简历表单，再点击“在此页面打开悬浮窗”。</li>
        </ol>
        <p className="muted">
          若浏览器没有该选项，当前版本尚不能走此授权路径。应用不会自动修改安全设置，也不会强制换成专用浏览器实例。
        </p>
      </details>
      {!state.profiles.length && (
        <Empty title="先准备一份档案">
          到“个人档案”保存一份档案。填写时会使用其中已有的资料。
        </Empty>
      )}
      <div className="form-grid">
        <Field label="浏览器">
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            disabled={busy}
          >
            <option value="msedge">Edge</option>
            <option value="chrome">Chrome</option>
          </select>
        </Field>
        <div className="field">
          <label>授权连接</label>
          <button
            disabled={busy}
            onClick={() => {
              setConnecting(true);
              setConnectionError("");
              void perform(async () => {
                setTargetId("");
                setTargets([]);
                setTargets(
                  await call<BrowserTarget[]>({ kind: "connect", channel }),
                );
              }, setConnectionError).finally(() => setConnecting(false));
            }}
          >
            {connecting ? "正在等待浏览器连接…" : "连接现有浏览器"}
          </button>
          <small aria-live="polite">
            {connecting
              ? `请到 ${channel === "msedge" ? "Edge" : "Chrome"} 核对连接请求并允许，本次最多等待 90 秒。`
              : "连接前请在所选浏览器开启现有会话调试。"}
          </small>
          {connectionError && <p className="notice error" role="alert">{connectionError}</p>}
        </div>
        <Field label="本次申请页面">
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={busy}
          >
            <option value="">请选择页面</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title || t.url} — {t.url}
              </option>
            ))}
          </select>
        </Field>
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              setTargets(await call<BrowserTarget[]>({ kind: "targets" }));
            })
          }
        >
          刷新页面列表
        </button>
        <Field label="填写档案">
          <select
            value={versionId}
            disabled={busy}
            onChange={(e) => {
              setVersionId(e.target.value);
              setOverrides({});
              setAnswer("");
              setDraftId("");
              setUseProfileSelection(false);
            }}
          >
            <option value="">请选择档案</option>
            {state.profiles.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {p.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {p.name} · {formatDate(v.createdAt)}
                    {v.id === p.currentVersionId ? " · 当前版本" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="关联申请（可选）">
          <select
            value={applicationId}
            disabled={busy}
            onChange={(e) => setApplicationId(e.target.value)}
          >
            <option value="">暂不关联</option>
            {state.applications.map((a) => {
              const j = state.jobs.find((j) => j.id === a.jobSnapshotId);
              return (
                <option key={a.id} value={a.id}>
                  {j?.data.company} · {j?.data.title} · {j?.data.channel} ·{" "}
                  {j?.data.batch}
                </option>
              );
            })}
          </select>
        </Field>
      </div>
      {profileSelection?.versionId === versionId && (
        <label>
          <input
            type="checkbox"
            checked={useProfileSelection}
            onChange={(e) => {
              setUseProfileSelection(e.target.checked);
              setOverrides({});
            }}
          />
          使用档案页已确认的仅本次值。配套附件仍使用该档案原版本简历，请核对内容一致性。
        </label>
      )}
      <div className="actions">
        <button
          className="primary"
          disabled={busy || !version || !targetId}
          onClick={() => void perform(select)}
        >
          在此页面打开悬浮窗
        </button>
        <button
          disabled={busy || !live?.runId || !version}
          onClick={() => void perform(switchProfile)}
        >
          换档／应用仅本次值
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setJob({
              ...emptyJob(),
              url: targets.find((t) => t.id === targetId)?.url || "",
            });
            setNewApplication(true);
          }}
        >
          新建申请记录
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await call({ kind: "disconnect" });
            })
          }
        >
          断开连接
        </button>
      </div>
      {version && selectionBase && (
        <details>
          <summary>仅本次填写的临时值（不修改档案）</summary>
          <div className="form-grid">
            {FIELD_GROUPS.flatMap((group) => {
              const entries = Array.isArray(selectionBase[group.key])
                ? (selectionBase[group.key] as Fields[])
                : [selectionBase[group.key] as Fields];
              return entries.flatMap((entry, index) =>
                group.fields.map((field) => {
                  const path = group.repeat
                    ? `${group.key}.${index}.${field.key}`
                    : `${group.key}.${field.key}`;
                  return (
                    <Field
                      key={path}
                      label={`${group.label}${group.repeat ? ` ${index + 1}` : ""} · ${field.label}`}
                    >
                      <input
                        value={overrides[path] ?? entry[field.key] ?? ""}
                        onChange={(e) =>
                          setOverrides({ ...overrides, [path]: e.target.value })
                        }
                      />
                    </Field>
                  );
                }),
              );
            })}
          </div>
          <button onClick={() => setOverrides({})}>清除临时值</button>
        </details>
      )}
      <div role="status">
        <strong>{connecting ? "正在等待浏览器连接…" : live?.message || "尚未连接"}</strong>
        {live?.url && (
          <p>
            {live.url} · {live.profileName} · 待处理 {live.pending}
          </p>
        )}
      </div>
      <div className="actions">
        {[
          ["fill", "一键填写"],
          ["blank", "补充填写"],
          ["pause", "暂停"],
          ["resume", "继续"],
          ["stop", "停止"],
        ].map(([action, label]) => (
          <button
            key={action}
            disabled={busy || !live?.runId || !live.connected}
            onClick={() =>
              void perform(async () => {
                await call(
                  action === "fill" || action === "blank"
                    ? {
                        kind: "fill",
                        mode: action === "blank" ? "blank" : "full",
                      }
                    : { kind: "control", action },
                );
              })
            }
          >
            {label}
          </button>
        ))}
        <button
          disabled={busy || !live?.connected}
          onClick={() => void perform(inspect)}
        >
          核对字段／处理待办
        </button>
      </div>
      <div className="actions">
        <button
          disabled={busy || !live?.connected}
          onClick={() =>
            choose(
              "进入明确的下一步",
              "只操作可识别的下一步按钮；可能向网站保存当前资料。最终提交和不明确动作仍由你处理。",
              async () => {
                await call({
                  kind: "advance",
                  saveDraft: false,
                  confirmed: true,
                });
              },
            )
          }
        >
          下一步
        </button>
        <button
          disabled={busy || !live?.connected}
          onClick={() =>
            choose(
              "保存官网草稿",
              "保存草稿可能将已填写资料发送给招聘网站。",
              async () => {
                await call({
                  kind: "advance",
                  saveDraft: true,
                  confirmed: true,
                });
              },
            )
          }
        >
          保存明确草稿
        </button>
        <button
          disabled={
            busy ||
            !selectedApplication ||
            !!selectedApplication.confirmedSubmittedAt
          }
          onClick={() =>
            choose(
              "确认已经实际提交",
              "仅在你已经本人完成网站最终提交后记录为已投；此操作不会替你点击网站提交。",
              confirmSubmitted,
            )
          }
        >
          我已在网站完成提交
        </button>
      </div>
      {!!fields.length && (
        <section>
          <h3>字段与开放题</h3>
          <Field label="当前页面字段">
            <select
              value={fieldId}
              onChange={(e) => {
                setFieldId(e.target.value);
                setAnswer("");
                setDraftId("");
              }}
            >
              <option value="">选择待处理字段</option>
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.section} · {f.label} {f.value ? "（已有内容）" : ""}
                </option>
              ))}
            </select>
          </Field>
          {selectedField && (
            <>
              <p>
                页面现值：{selectedField.value || "空白"}。
                {selectedField.touched ? "你已手动修改，此字段将保留。" : ""}
              </p>
              {selectedField.type === "file" && !selectedField.resumeUpload && (
                <p>未确认是简历上传入口，请在网站核对附件用途。</p>
              )}
              {selectedField.type === "file" && selectedField.resumeUpload && (
                <button
                  disabled={busy || selectedField.disabled || selectedField.touched}
                  onClick={() =>
                    choose(
                      "替换已有附件",
                      "上传当前任务档案的配套简历；请确认允许替换网站已有附件。",
                      async () => {
                        await call({
                          kind: "upload",
                          fieldId,
                          confirmed: true,
                        });
                      },
                    )
                  }
                >
                  确认替换配套附件
                </button>
              )}
              {selectedField.type !== "file" && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={allowAi}
                      onChange={(e) => setAllowAi(e.target.checked)}
                    />
                    允许把当前字段与所选档案发给已配置的聊天模型，生成待确认建议
                  </label>
                  <button
                    disabled={busy || !allowAi}
                    onClick={() =>
                      void perform(async () => {
                        const task = await call<ModelTask>({
                          kind: "draft",
                          fieldId,
                          fieldToken: selectedField.fieldToken,
                        });
                        setDraftId(task.id);
                        await reload();
                      })
                    }
                  >
                    AI匹配／起草
                  </button>
                  {draft && (
                    <div>
                      <p>
                        模型：{draft.provider.name}／{draft.provider.model} ·{" "}
                        {draft.status}
                      </p>
                      <pre className="text-preview">
                        {draft.content || "正在生成…"}
                      </pre>
                      {draft.error && <p role="alert">{draft.error.message}</p>}
                      <button
                        disabled={busy || draft.status !== "completed"}
                        onClick={() =>
                          choose(
                            "核对模型建议后写入",
                            "请确认建议没有虚构经历、日期、个人贡献或其他事实。写入仍遵守手改和原有值保护。",
                            async () => {
                              await call({
                                kind: "apply_draft",
                                taskId: draft.id,
                                confirmed: true,
                              });
                              setDraftId("");
                              await inspect();
                            },
                          )
                        }
                      >
                        确认建议并写入
                      </button>
                      <button
                        disabled={busy || draft.status !== "running"}
                        onClick={() =>
                          void perform(async () => {
                            await request("cancel_task", {
                              datasetId: state.datasetId,
                              taskId: draft.id,
                            });
                            await reload();
                          })
                        }
                      >
                        停止生成
                      </button>
                      <button
                        disabled={!draft.content}
                        onClick={() => setAnswer(draft.content)}
                      >
                        复制到可编辑回答
                      </button>
                    </div>
                  )}
                  <Field label="核对后的回答">
                    <textarea
                      rows={5}
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                    />
                  </Field>
                  {!!version?.data.answers.length && (
                    <Field label="复用已保存问答">
                      <select
                        defaultValue=""
                        onChange={(e) => {
                          const item =
                            version.data.answers[Number(e.target.value)];
                          if (item) setAnswer(item.answer || "");
                        }}
                      >
                        <option value="">选择后核对再写入</option>
                        {version.data.answers.map((item, i) => (
                          <option key={i} value={i}>
                            {item.question}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <button
                    disabled={busy || !answer.trim()}
                    onClick={() =>
                      choose(
                        "确认回答后写入",
                        "只写入所选字段，不自动保存到档案。已有非空和手改内容仍保留。",
                        async () => {
                          await call({
                            kind: "write_answer",
                            fieldId,
                            fieldToken: selectedField.fieldToken,
                            value: answer,
                            confirmed: true,
                          });
                          setAnswer("");
                          await inspect();
                        },
                      )
                    }
                  >
                    确认回答并写入
                  </button>
                  <button
                    disabled={busy || !answer.trim() || !version}
                    onClick={() =>
                      choose(
                        "保存问答到指定档案",
                        "将当前字段问题和回答显式保存为所选档案的新版本，其它档案不变。",
                        saveAnswer,
                      )
                    }
                  >
                    主动保存问答到档案
                  </button>
                </>
              )}
            </>
          )}
        </section>
      )}
      <h3>本次结果</h3>
      <p>
        已填表示回读页面成功；服务端保存与正式投递需另行确认。红标和待处理项应人工核对。
      </p>
      {live?.results.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>字段</th>
                <th>结果</th>
                <th>页面值</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {live.results.map((item, i) => (
                <tr key={`${item.documentId}:${item.fieldId}:${i}`}>
                  <td>{item.label}</td>
                  <td>{labels[item.status] || item.status}</td>
                  <td>{item.actual}</td>
                  <td>{item.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>尚无填写结果。</p>
      )}
      <details>
        <summary>历史填写记录（重连不恢复字段覆盖权）</summary>
        {status?.history.map((run) => (
          <article key={run.id}>
            <strong>
              {formatDate(run.createdAt)} · {run.state.profileName}
            </strong>
            <p>
              {run.state.url} · {run.state.message} · {run.state.results.length}
              项
            </p>
            <button
              disabled={busy || !targetId}
              onClick={() =>
                choose(
                  "在所选页面恢复此任务",
                  "先在上方选择浏览器与本次申请页面。恢复固定档案和进度，但原有非空字段会重新核对，不恢复旧覆盖权。",
                  async () => {
                    await call({ kind: "resume_run", runId: run.id, targetId });
                    setVersionId(run.profileVersionId);
                    setApplicationId(run.applicationId || "");
                    setOverrides({});
                    setDraftId("");
                    setFields([]);
                  },
                )
              }
            >
              在所选页面恢复
            </button>
            <details>
              <summary>查看结果</summary>
              {run.state.results.map((r, i) => (
                <p key={i}>
                  {r.label}：{r.actual} — {r.reason}
                </p>
              ))}
            </details>
          </article>
        ))}
      </details>
      {confirm && (
        <Dialog
          title={confirm.title}
          busy={busy}
          onCancel={() => setConfirm(null)}
          actions={
            <>
              <button disabled={busy} onClick={() => setConfirm(null)}>
                取消
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await confirm.action();
                    setConfirm(null);
                  })
                }
              >
                确认
              </button>
            </>
          }
        >
          <p>{confirm.detail}</p>
        </Dialog>
      )}
      {newApplication && (
        <Dialog
          title="新建申请记录"
          wide
          busy={busy}
          onCancel={() => setNewApplication(false)}
          actions={
            <>
              <button disabled={busy} onClick={() => setNewApplication(false)}>
                取消
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const result = await mutate<{ applicationId: string }>(
                      state,
                      {
                        kind: "create_application",
                        job,
                        profileVersionId: versionId || null,
                        stage: "pending",
                        duplicateAcknowledged: duplicate,
                      },
                    );
                    await reload();
                    setApplicationId(result.applicationId);
                    setNewApplication(false);
                    setDuplicate(false);
                  })
                }
              >
                保存为待投递
              </button>
            </>
          }
        >
          <div className="form-grid">
            {[
              ["company", "公司"],
              ["title", "岗位"],
              ["channel", "渠道"],
              ["batch", "批次"],
              ["jobCode", "岗位编号"],
              ["url", "岗位链接"],
              ["jd", "职位说明"],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  value={job[key as keyof typeof job]}
                  onChange={(e) => setJob({ ...job, [key]: e.target.value })}
                />
              </Field>
            ))}
          </div>
          <label>
            <input
              type="checkbox"
              checked={duplicate}
              onChange={(e) => setDuplicate(e.target.checked)}
            />
            已核对疑似重复，确需独立申请记录
          </label>
        </Dialog>
      )}
    </section>
  );
}
