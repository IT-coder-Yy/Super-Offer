import { useEffect, useState } from "react";
import { errorOf, mutate } from "./api";
import { filterApplications, stageCounts, type Filters } from "./dashboard";
import {
  END_REASONS,
  STAGES,
  emptyJob,
  type Application,
  type EndReason,
  type JobData,
  type Stage,
  type Workspace,
} from "./types";
import { Dialog, Empty, Field, formatDate, localDateTime } from "./ui";

interface Props {
  workspace: Workspace;
  reload: () => Promise<Workspace>;
  notify: (message: string, error?: boolean) => void;
  onDirty: (dirty: boolean) => void;
}
interface Edit {
  application: Application | null;
  job: JobData;
  profileVersionId: string;
  stage: Stage;
  endReason: EndReason | "";
  nextAction: string;
  dueAt: string;
  notes: string;
}
const newEdit = (): Edit => ({
  application: null,
  job: emptyJob(),
  profileVersionId: "",
  stage: "saved",
  endReason: "",
  nextAction: "",
  dueAt: "",
  notes: "",
});
export function ApplicationsPanel({
  workspace,
  reload,
  notify,
  onDirty,
}: Props) {
  const state = workspace.state;
  const [filters, setFilters] = useState<Filters>({
    query: "",
    stage: "",
    dateField: "createdAt",
    from: "",
    to: "",
  });
  const [edit, setEdit] = useState<Edit | null>(null);
  const [baseEdit, setBaseEdit] = useState("");
  const [busy, setBusy] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<Edit | null | undefined>(
    undefined,
  );
  const [duplicate, setDuplicate] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submissionTime, setSubmissionTime] = useState(localDateTime());
  const [submissionChecked, setSubmissionChecked] = useState(false);
  const [round, setRound] = useState({
    id: null as string | null,
    title: "",
    scheduledAt: "",
    location: "",
    notes: "",
    completed: false,
  });
  const [roundOpen, setRoundOpen] = useState(false);
  const dirty = !!edit && JSON.stringify(edit) !== baseEdit;
  useEffect(() => {
    onDirty(dirty || roundOpen);
  }, [dirty, roundOpen, onDirty]);
  const applications = filterApplications(state, filters);
  const counts = stageCounts(applications);
  const submitted = applications.filter((a) => a.confirmedSubmittedAt).length;
  const selected =
    edit?.application &&
    state.applications.find((a) => a.id === edit.application?.id);
  const events = selected
    ? state.events
        .filter((e) => e.applicationId === selected.id)
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    : [];
  const rounds = selected
    ? state.interviews
        .filter((r) => r.applicationId === selected.id)
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
    : [];
  const todos = applications
    .filter((a) => a.nextAction && a.stage !== "closed")
    .sort((a, b) => (a.dueAt ?? "z").localeCompare(b.dueAt ?? "z"));
  function applicationEdit(application: Application, current = state): Edit {
    return {
      application,
      job: structuredClone(
        current.jobs.find((j) => j.id === application.jobSnapshotId)!.data,
      ),
      profileVersionId: application.profileVersionId ?? "",
      stage: application.stage,
      endReason: application.endReason ?? "",
      nextAction: application.nextAction,
      dueAt: localDateTime(application.dueAt),
      notes: application.notes,
    };
  }
  function setEditor(next: Edit | null) {
    setEdit(next);
    setBaseEdit(JSON.stringify(next));
    setDiscardTarget(undefined);
  }
  function openEditor(next: Edit | null) {
    if (dirty) setDiscardTarget(next);
    else setEditor(next);
  }
  async function save(acknowledge = false) {
    if (!edit || busy) return;
    setBusy(true);
    try {
      const mutation = edit.application
        ? {
            kind: "update_application",
            id: edit.application.id,
            expectedRevision: edit.application.revision,
            job: edit.job,
            profileVersionId: edit.profileVersionId || null,
            stage: edit.stage,
            endReason: edit.endReason || null,
            nextAction: edit.nextAction,
            dueAt: edit.dueAt ? new Date(edit.dueAt).toISOString() : null,
            notes: edit.notes,
          }
        : {
            kind: "create_application",
            job: edit.job,
            profileVersionId: edit.profileVersionId || null,
            stage: edit.stage,
            duplicateAcknowledged: acknowledge,
          };
      const result = await mutate<{ applicationId: string }>(state, mutation);
      const next = await reload();
      setEditor(
        applicationEdit(
          next.state.applications.find((a) => a.id === result.applicationId)!,
          next.state,
        ),
      );
      setDuplicate(false);
      notify("申请记录已保存。");
    } catch (error) {
      const known = errorOf(error);
      if (known.code === "DUPLICATE_CONFIRMATION") setDuplicate(true);
      else notify(known.message, true);
    } finally {
      setBusy(false);
    }
  }
  const update = (values: Partial<Edit>) =>
    setEdit((previous) => (previous ? { ...previous, ...values } : null));
  const updateJob = (values: Partial<JobData>) =>
    setEdit((previous) =>
      previous ? { ...previous, job: { ...previous.job, ...values } } : null,
    );
  return (
    <div className={`applications-layout ${edit ? "with-detail" : ""}`}>
      <div className="board-content">
        <div className="board-toolbar">
          <p className="summary-line">
            共 <strong>{applications.length}</strong> 份申请<span>·</span>
            本人确认已投 <strong>{submitted}</strong> 份
          </p>
          <button className="primary" onClick={() => openEditor(newEdit())}>
            新增申请
          </button>
        </div>
        <div className="stage-strip" aria-label="阶段分布">
          {Object.entries(STAGES).map(([stage, label]) => (
            <button
              key={stage}
              className={filters.stage === stage ? "active" : ""}
              onClick={() =>
                setFilters((previous) => ({
                  ...previous,
                  stage: previous.stage === stage ? "" : stage,
                }))
              }
            >
              <span className={`stage-dot ${stage}`} />
              <span>{label}</span>
              <strong>{counts[stage as Stage]}</strong>
            </button>
          ))}
        </div>
        <div className="filters">
          <input
            aria-label="搜索公司、岗位、渠道或批次"
            placeholder="搜索公司、岗位、渠道或批次"
            value={filters.query}
            onChange={(e) => setFilters({ ...filters, query: e.target.value })}
          />
          <select
            aria-label="阶段筛选"
            value={filters.stage}
            onChange={(e) => setFilters({ ...filters, stage: e.target.value })}
          >
            <option value="">全部阶段</option>
            {Object.entries(STAGES).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="日期筛选口径"
            value={filters.dateField}
            onChange={(e) =>
              setFilters({
                ...filters,
                dateField: e.target.value as Filters["dateField"],
              })
            }
          >
            <option value="createdAt">创建日期</option>
            <option value="confirmedSubmittedAt">确认提交日期</option>
          </select>
          <input
            aria-label="起始日期"
            type="date"
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
          <span>至</span>
          <input
            aria-label="截止日期"
            type="date"
            value={filters.to}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
        </div>
        {!applications.length ? (
          <Empty
            title={
              state.applications.length
                ? "没有匹配的申请"
                : "从一个心仪的岗位开始"
            }
          >
            {state.applications.length
              ? "调整搜索词、阶段或日期范围。"
              : "先收藏岗位，准备好后再投递。填表完成不会自动算作已投。"}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="applications-table">
              <thead>
                <tr>
                  <th>公司与岗位</th>
                  <th>渠道 / 批次</th>
                  <th>当前阶段</th>
                  <th>提交事实</th>
                  <th>下一步</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((application) => {
                  const job = state.jobs.find(
                    (j) => j.id === application.jobSnapshotId,
                  )!.data;
                  return (
                    <tr
                      key={application.id}
                      className={
                        selected?.id === application.id ? "selected" : ""
                      }
                    >
                      <td>
                        <button
                          className="row-link"
                          onClick={() =>
                            openEditor(applicationEdit(application))
                          }
                        >
                          <strong>{job.company}</strong>
                          <span>{job.title}</span>
                        </button>
                      </td>
                      <td>
                        {job.channel || "未填写"}
                        <small>{job.batch || "未填写批次"}</small>
                      </td>
                      <td>
                        <span className={`status ${application.stage}`}>
                          {STAGES[application.stage]}
                        </span>
                        {application.endReason && (
                          <small>{END_REASONS[application.endReason]}</small>
                        )}
                      </td>
                      <td>
                        {application.confirmedSubmittedAt
                          ? "本人已确认"
                          : "尚未确认"}
                        <small>
                          {formatDate(application.confirmedSubmittedAt, false)}
                        </small>
                      </td>
                      <td>
                        {application.nextAction || "—"}
                        <small>{formatDate(application.dueAt)}</small>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <section className="todo-section">
          <div className="section-title">
            <h2>待办事项</h2>
            <span className="muted small">与上方筛选范围一致</span>
          </div>
          {todos.length ? (
            todos.map((application) => (
              <button
                key={application.id}
                className="todo-row"
                onClick={() => openEditor(applicationEdit(application))}
              >
                <span className="todo-marker" />
                <span>
                  <strong>{application.nextAction}</strong>
                  <small>
                    {
                      state.jobs.find((j) => j.id === application.jobSnapshotId)
                        ?.data.company
                    }
                  </small>
                </span>
                <time>
                  {application.dueAt
                    ? formatDate(application.dueAt)
                    : "未定时间"}
                </time>
              </button>
            ))
          ) : (
            <p className="muted">
              还没有待办。在申请明细中记录下一步与提醒时间。
            </p>
          )}
          {state.interviews
            .filter(
              (r) =>
                !r.completed &&
                applications.some(
                  (a) => a.id === r.applicationId && a.stage !== "closed",
                ),
            )
            .map((r) => (
              <button
                key={r.id}
                className="todo-row"
                onClick={() =>
                  openEditor(
                    applicationEdit(
                      state.applications.find((a) => a.id === r.applicationId)!,
                    ),
                  )
                }
              >
                <span className="todo-marker interview" />
                <span>
                  <strong>{r.title}</strong>
                  <small>待完成的面试</small>
                </span>
                <time>{formatDate(r.scheduledAt)}</time>
              </button>
            ))}
        </section>
      </div>
      {edit && (
        <fieldset
          className="application-detail"
          disabled={busy}
          aria-label="申请明细"
        >
          <div className="section-title">
            <h2>{edit.application ? "申请明细" : "新增申请"}</h2>
            <button
              className="icon-button"
              aria-label="关闭申请明细"
              onClick={() => openEditor(null)}
            >
              ×
            </button>
          </div>
          <p className="muted small">
            {dirty ? "有未保存修改" : "岗位与档案按保存版本保留历史依据。"}
          </p>
          <div className="form-grid">
            <Field label="公司">
              <input
                value={edit.job.company}
                onChange={(e) => updateJob({ company: e.target.value })}
              />
            </Field>
            <Field label="岗位">
              <input
                value={edit.job.title}
                onChange={(e) => updateJob({ title: e.target.value })}
              />
            </Field>
            <Field label="招聘渠道">
              <input
                value={edit.job.channel}
                onChange={(e) => updateJob({ channel: e.target.value })}
              />
            </Field>
            <Field label="招聘批次">
              <input
                value={edit.job.batch}
                onChange={(e) => updateJob({ batch: e.target.value })}
              />
            </Field>
            <Field label="岗位编号">
              <input
                value={edit.job.jobCode}
                onChange={(e) => updateJob({ jobCode: e.target.value })}
              />
            </Field>
            <Field label="来源链接">
              <input
                value={edit.job.url}
                onChange={(e) => updateJob({ url: e.target.value })}
              />
            </Field>
          </div>
          <Field label="岗位描述 / JD">
            <textarea
              rows={5}
              value={edit.job.jd}
              onChange={(e) => updateJob({ jd: e.target.value })}
            />
          </Field>
          <Field label="关联档案版本">
            <select
              value={edit.profileVersionId}
              onChange={(e) => update({ profileVersionId: e.target.value })}
            >
              <option value="">暂不关联</option>
              {state.profiles.flatMap((profile) =>
                [...profile.versions].reverse().map((version, i) => (
                  <option key={version.id} value={version.id}>
                    {profile.name} · 版本 {profile.versions.length - i}
                  </option>
                )),
              )}
            </select>
          </Field>
          <Field label="当前阶段">
            <select
              value={edit.stage}
              onChange={(e) => {
                const stage = e.target.value as Stage;
                if (stage === "applied" && !selected?.confirmedSubmittedAt) {
                  notify("请先点击“确认已提交”记录实际提交事实。", true);
                  return;
                }
                update({
                  stage,
                  endReason: stage === "closed" ? edit.endReason : "",
                });
              }}
            >
              {Object.entries(STAGES)
                .filter(
                  ([key]) =>
                    edit.application || ["saved", "pending"].includes(key),
                )
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
          </Field>
          {edit.stage === "closed" && (
            <Field label="结束原因">
              <select
                value={edit.endReason}
                onChange={(e) =>
                  update({ endReason: e.target.value as EndReason })
                }
              >
                <option value="">请选择</option>
                {Object.entries(END_REASONS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {edit.application && (
            <>
              <Field label="下一步待办">
                <input
                  value={edit.nextAction}
                  onChange={(e) => update({ nextAction: e.target.value })}
                />
              </Field>
              <Field label="待办时间">
                <input
                  type="datetime-local"
                  value={edit.dueAt}
                  onChange={(e) => update({ dueAt: e.target.value })}
                />
              </Field>
              <Field label="备注">
                <textarea
                  rows={2}
                  value={edit.notes}
                  onChange={(e) => update({ notes: e.target.value })}
                />
              </Field>
            </>
          )}
          <div className="actions sticky-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? "保存中…" : "保存申请"}
            </button>
            {selected && !selected.confirmedSubmittedAt && (
              <button
                className="secondary"
                disabled={dirty || busy}
                onClick={() => {
                  setSubmissionTime(localDateTime());
                  setSubmissionChecked(false);
                  setSubmitOpen(true);
                }}
              >
                确认已提交
              </button>
            )}
          </div>
          {selected && (
            <>
              <div className="section-title">
                <h3>多轮面试</h3>
                <button
                  className="text-button"
                  disabled={dirty}
                  onClick={() => {
                    setRound({
                      id: null,
                      title: "",
                      scheduledAt: "",
                      location: "",
                      notes: "",
                      completed: false,
                    });
                    setRoundOpen(true);
                  }}
                >
                  添加轮次
                </button>
              </div>
              {rounds.map((r) => (
                <button
                  className="round-row"
                  key={r.id}
                  disabled={dirty}
                  onClick={() => {
                    setRound({
                      ...r,
                      scheduledAt: localDateTime(r.scheduledAt),
                    });
                    setRoundOpen(true);
                  }}
                >
                  <strong>{r.title}</strong>
                  <span>
                    {formatDate(r.scheduledAt)} ·{" "}
                    {r.completed ? "已完成" : "待完成"}
                  </span>
                </button>
              ))}
              {!rounds.length && (
                <p className="muted small">同一申请可记录多轮面试。</p>
              )}
              <h3 className="timeline-title">进展时间线</h3>
              <ol className="timeline">
                {events.map((event) => (
                  <li key={event.id}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>
                        {(
                          {
                            created: "创建申请",
                            updated: "更新申请",
                            submitted: "本人确认已提交",
                            interview: "记录面试轮次",
                          } as Record<string, string>
                        )[event.kind] ?? event.kind}
                      </strong>
                      <time>{formatDate(event.occurredAt)}</time>
                      {event.detail.stage !== undefined && (
                        <p>{STAGES[event.detail.stage as Stage]}</p>
                      )}
                      {event.detail.endReason != null && (
                        <p>
                          {END_REASONS[event.detail.endReason as EndReason]}
                        </p>
                      )}
                      {typeof event.detail.title === "string" && (
                        <p>{event.detail.title}</p>
                      )}
                      <small>用户记录 · 保留当时岗位与档案版本</small>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </fieldset>
      )}
      {discardTarget !== undefined && (
        <Dialog
          title="申请编辑尚未保存"
          onCancel={() => setDiscardTarget(undefined)}
          actions={
            <>
              <button
                className="secondary"
                onClick={() => setDiscardTarget(undefined)}
              >
                返回编辑
              </button>
              <button
                className="primary"
                onClick={() => setEditor(discardTarget)}
              >
                放弃修改并继续
              </button>
            </>
          }
        >
          <p>如需保留，请返回并点击“保存申请”。</p>
        </Dialog>
      )}
      {duplicate && (
        <Dialog
          title="核对疑似重复申请"
          onCancel={() => setDuplicate(false)}
          actions={
            <>
              <button className="secondary" onClick={() => setDuplicate(false)}>
                返回核对
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void save(true)}
              >
                确认是独立申请
              </button>
            </>
          }
        >
          <p>
            已有同公司、岗位与批次的记录。请核对是否只是不同渠道的同一次申请。
          </p>
          <p>确认后会保留两份独立记录，并记录此次判断；不会自动合并。</p>
        </Dialog>
      )}
      {submitOpen && selected && (
        <Dialog
          title="确认本人已实际提交"
          onCancel={() => setSubmitOpen(false)}
          actions={
            <>
              <button
                className="secondary"
                onClick={() => setSubmitOpen(false)}
              >
                取消
              </button>
              <button
                className="primary"
                disabled={!submissionChecked || busy || !submissionTime}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await mutate(state, {
                      kind: "confirm_submitted",
                      id: selected.id,
                      expectedRevision: selected.revision,
                      confirmed: true,
                      submittedAt: new Date(submissionTime).toISOString(),
                    });
                    const next = await reload();
                    setEditor(
                      applicationEdit(
                        next.state.applications.find(
                          (a) => a.id === selected.id,
                        )!,
                        next.state,
                      ),
                    );
                    setSubmitOpen(false);
                    notify("已记录实际提交，同一申请只统计一次。");
                  } catch (e) {
                    notify(errorOf(e).message, true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                记录已提交
              </button>
            </>
          }
        >
          <p>填表完成、保存官网草稿不等于实际提交。</p>
          <Field label="实际提交时间">
            <input
              type="datetime-local"
              value={submissionTime}
              onChange={(e) => setSubmissionTime(e.target.value)}
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={submissionChecked}
              onChange={(e) => setSubmissionChecked(e.target.checked)}
            />
            我已在招聘网站完成最终提交
          </label>
        </Dialog>
      )}
      {roundOpen && selected && (
        <Dialog
          title={round.id ? "编辑面试轮次" : "添加面试轮次"}
          busy={busy}
          onCancel={() => setRoundOpen(false)}
          actions={
            <>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setRoundOpen(false)}
              >
                取消
              </button>
              <button
                className="primary"
                disabled={busy || !round.scheduledAt}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await mutate(state, {
                      kind: "save_interview",
                      ...round,
                      applicationId: selected.id,
                      expectedRevision: selected.revision,
                      scheduledAt: new Date(round.scheduledAt).toISOString(),
                    });
                    const next = await reload();
                    setEditor(
                      applicationEdit(
                        next.state.applications.find(
                          (a) => a.id === selected.id,
                        )!,
                        next.state,
                      ),
                    );
                    setRoundOpen(false);
                    notify("面试轮次已保存。当前阶段由你单独确认。");
                  } catch (e) {
                    notify(errorOf(e).message, true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                保存轮次
              </button>
            </>
          }
        >
          <Field label="轮次名称">
            <input
              disabled={busy}
              value={round.title}
              placeholder="例如：技术一面"
              onChange={(e) => setRound({ ...round, title: e.target.value })}
            />
          </Field>
          <Field label="面试时间">
            <input
              disabled={busy}
              type="datetime-local"
              value={round.scheduledAt}
              onChange={(e) =>
                setRound({ ...round, scheduledAt: e.target.value })
              }
            />
          </Field>
          <Field label="地点或会议链接">
            <input
              disabled={busy}
              value={round.location}
              onChange={(e) => setRound({ ...round, location: e.target.value })}
            />
          </Field>
          <Field label="轮次备注">
            <textarea
              disabled={busy}
              value={round.notes}
              onChange={(e) => setRound({ ...round, notes: e.target.value })}
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              disabled={busy}
              checked={round.completed}
              onChange={(e) =>
                setRound({ ...round, completed: e.target.checked })
              }
            />
            此轮面试已完成
          </label>
        </Dialog>
      )}
    </div>
  );
}
