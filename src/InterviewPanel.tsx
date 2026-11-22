import { useCallback, useEffect, useRef, useState } from "react";
import { errorOf, request } from "./api";
import { Dialog, Empty, Field, formatDate } from "./ui";
import { EvidenceView } from "./ProjectsPanel";
import { extractResume } from "./resume-parser";
import { evidenceTimingLabel } from "./s3-types";
import type { ConfirmedResume, Evidence, InterviewReport, ResumePreview, S3PanelProps, SessionSummary, SessionView, SourceList, SourceVersion } from "./s3-types";

interface Creation {
  applicationId: string;
  profileVersionId: string;
  jobSnapshotId: string;
  sourceIds: string[];
  contribution: string;
  role: string;
  stage: string;
  focus: string;
  mode: "practice" | "simulation";
  questionCount: number;
  repracticeOf: string | null;
  resume: ConfirmedResume | null;
  resumeConfirmed: boolean;
}
interface CorrectionDraft {
  reportId: string;
  pointIndex: number;
  revision: number;
  operationId: string;
  text: string;
  evidenceIds: string[];
  confirmed: boolean;
}
const fresh = (): Creation => ({
  applicationId: "", profileVersionId: "", jobSnapshotId: "", sourceIds: [],
  contribution: "", role: "AI Agent", stage: "intern", focus: "",
  mode: "practice", questionCount: 6, repracticeOf: null,
  resume: null, resumeConfirmed: false,
});
const statusLabel: Record<string, string> = { ready: "等待继续", generating: "正在生成", waiting_answer: "等待回答", paused: "已暂停", completed: "已完成" };
const pointLabel = { strength: "回答亮点", not_mentioned: "没有提及", incorrect: "明确答错", material_gap: "材料不足", expression: "表达问题" };
const basisLabel = { source_fact: "模型源码解读", user_statement: "用户说明", inference: "未验证推断", knowledge: "模型知识参考，待核查" };

export function InterviewPanel({ workspace, reload, notify, onDirty }: S3PanelProps) {
  const datasetId = workspace.state.datasetId;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [current, setCurrent] = useState<SessionView | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creation, setCreation] = useState<Creation | null>(null);
  const [readingResume, setReadingResume] = useState(false);
  const [resumeError, setResumeError] = useState("");
  const resumeRead = useRef(0);
  const [versions, setVersions] = useState<SourceVersion[]>([]);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [finish, setFinish] = useState(false);
  const [contextConfirmation, setContextConfirmation] = useState(false);
  const [correction, setCorrection] = useState<CorrectionDraft | null>(null);
  const [endIntent, setEndIntent] = useState<"skip" | "dont_know" | "reveal" | null>(null);
  const [sentTaskId, setSentTaskId] = useState("");
  const currentRef = useRef<SessionView | null>(null);
  const draftRef = useRef("");
  const busyRef = useRef(false);
  const saveInFlight = useRef<Promise<SessionView | null> | null>(null);
  const failedDraft = useRef<{ sessionId: string; text: string } | null>(null);
  const mounted = useRef(true);
  const selectedRef = useRef("");
  const creationOperation = useRef("");
  const lastAnswer = useRef<{ sessionId: string; turnId: string; text: string; disposition: string; operationId: string } | null>(null);
  const interview = useCallback(<T,>(command: Record<string, unknown>) =>
    request<T>("interview", { datasetId, command }), [datasetId]);
  const accept = useCallback((next: SessionView, reset = false) => {
    if (!mounted.current) return;
    const previous = currentRef.current;
    if (previous?.session.id === next.session.id && next.session.revision < previous.session.revision) return;
    const sent = lastAnswer.current;
    const acceptedAnswer = sent?.sessionId === next.session.id && next.session.turns.some((t) => t.answer?.id === sent.operationId);
    if (reset || acceptedAnswer || !previous || draftRef.current === previous.session.draft) {
      draftRef.current = next.session.draft;
      setDraft(next.session.draft);
      if (acceptedAnswer) lastAnswer.current = null;
    }
    currentRef.current = next;
    setCurrent(next);
    setSessions((items) => items.map((item) => item.id === next.session.id ? {
      ...item, status: next.session.status, updatedAt: next.session.updatedAt,
      turns: next.session.turns.length, finished: next.session.finished,
    } : item));
  }, []);
  const loadList = useCallback(async () => {
    const result = await interview<SessionSummary[]>({ kind: "list" });
    if (mounted.current) setSessions(result.map((item) => {
      const current = currentRef.current?.session;
      return current?.id === item.id ? { ...item, status: current.status, updatedAt: current.updatedAt, turns: current.turns.length, finished: current.finished } : item;
    }));
  }, [interview]);
  useEffect(() => {
    mounted.current = true;
    void loadList().catch((e) => notify(errorOf(e).message, true));
    return () => { mounted.current = false; resumeRead.current++; };
  }, [loadList, notify]);
  useEffect(() => {
    if (!selected) return;
    let disposed = false;
    let querying = false;
    const update = async () => {
      if (querying || busyRef.current || saveInFlight.current) return;
      querying = true;
      try {
        const next = await interview<SessionView>({ kind: "get", sessionId: selected });
        if (!disposed && selectedRef.current === selected) accept(next);
      } catch (e) { if (!disposed) notify(errorOf(e).message, true); }
      finally { querying = false; }
    };
    void update();
    const timer = setInterval(() => void update(), 850);
    return () => { disposed = true; clearInterval(timer); };
  }, [selected, interview, notify, accept]);
  const dirty = draft !== (current?.session.draft ?? "");
  useEffect(() => onDirty(dirty || !!creation || !!correction || saving), [dirty, creation, correction, saving, onDirty]);

  const saveDraft = useCallback(async (): Promise<SessionView | null> => {
    if (saveInFlight.current) await saveInFlight.current;
    const value = currentRef.current;
    if (!value || draftRef.current === value.session.draft || value.session.finished) return value;
    const sent = draftRef.current;
    setSaving(true);
    const promise = interview<SessionView>({
      kind: "save_draft", sessionId: value.session.id, expectedRevision: value.session.revision,
      operationId: crypto.randomUUID(), text: sent,
    }).then((next) => { failedDraft.current = null; accept(next); return next; })
      .catch((error: unknown) => { failedDraft.current = { sessionId: value.session.id, text: sent }; throw error; });
    saveInFlight.current = promise;
    try { return await promise; }
    finally { saveInFlight.current = null; if (mounted.current) setSaving(false); }
  }, [accept, interview]);
  useEffect(() => {
    if (!dirty || busy || saving || current?.session.finished) return;
    if (failedDraft.current?.sessionId === current?.session.id && failedDraft.current?.text === draft) return;
    const timer = setTimeout(() => { void saveDraft().catch((e) => notify(errorOf(e).message, true)); }, 500);
    return () => clearTimeout(timer);
  }, [dirty, busy, saving, current?.session.id, current?.session.finished, saveDraft, notify, draft]);
  async function selectSession(id: string) {
    busyRef.current = true;
    setBusy(true);
    try {
      await saveDraft();
      const next = await interview<SessionView>({ kind: "get", sessionId: id });
      selectedRef.current = id;
      setSelected(id);
      accept(next, true);
    } catch (e) { notify(errorOf(e).message, true); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function editCorrection(report: InterviewReport, pointIndex: number) {
    if (!current) return;
    const prior = current.session.reportCorrections?.filter((item) => item.reportId === report.id && item.pointIndex === pointIndex).at(-1);
    setCorrection({ reportId: report.id, pointIndex, revision: current.session.revision, operationId: crypto.randomUUID(),
      text: prior?.text ?? "", evidenceIds: prior?.evidenceIds ?? report.content.points[pointIndex].evidenceIds,
      confirmed: false });
  }
  async function saveCorrection() {
    if (!correction || !current) return;
    setBusy(true);
    busyRef.current = true;
    try {
      const next = await interview<SessionView>({ kind: "correct_report", sessionId: current.session.id,
        expectedRevision: correction.revision, operationId: correction.operationId, reportId: correction.reportId,
        pointIndex: correction.pointIndex, text: correction.text, evidenceIds: correction.evidenceIds, confirmed: correction.confirmed });
      accept(next);
      setCorrection(null);
      await reload();
      notify("人工更正已保存，原报告和回答保持原样。");
    } catch (e) {
      const error = errorOf(e);
      notify(error.message, true);
      if (error.code === "VERSION_CONFLICT") {
        const next = await interview<SessionView>({ kind: "get", sessionId: current.session.id }).catch(() => null);
        if (next) { accept(next); setCorrection((draft) => draft && { ...draft, revision: next.session.revision, confirmed: false }); }
      }
    } finally { busyRef.current = false; setBusy(false); }
  }
  async function run(kind: string, extra: Record<string, unknown> = {}) {
    busyRef.current = true;
    setBusy(true);
    try {
      const saved = kind === "stop" ? currentRef.current : await saveDraft();
      if (!saved) return;
      const command: Record<string, unknown> = { kind, sessionId: saved.session.id, ...extra };
      if (kind !== "stop") command.expectedRevision = saved.session.revision;
      const result = await interview<SessionView>(command);
      if (selectedRef.current === result.session.id) accept(result);
      await reload();
      await loadList();
    } catch (e) { notify(errorOf(e).message, true); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function answer(disposition: "answer" | "skip" | "dont_know") {
    const s = currentRef.current?.session;
    const turn = s?.turns.at(-1);
    if (!s || !turn) return;
    const value = disposition === "answer" ? draftRef.current : "";
    const previous = lastAnswer.current;
    const operationId = previous && previous.sessionId === s.id && previous.turnId === turn.id &&
      previous.text === value && previous.disposition === disposition ? previous.operationId : crypto.randomUUID();
    lastAnswer.current = { sessionId: s.id, turnId: turn.id, text: value, disposition, operationId };
    setEndIntent(null);
    await run("answer", { text: value, disposition, operationId });
  }
  async function openCreation(report?: InterviewReport, focus = "") {
    try {
      await saveDraft();
      const result = await request<SourceList>("source", { datasetId, command: { kind: "list" } });
      setVersions(result.versions);
      resumeRead.current++;
      setReadingResume(false);
      setResumeError("");
      const previous = currentRef.current?.session;
      setCreation(report && previous ? {
        applicationId: previous.applicationId ?? "", profileVersionId: previous.profileVersionId ?? "",
        jobSnapshotId: previous.jobSnapshotId ?? "", sourceIds: previous.sources.map((s) => s.versionId),
        contribution: previous.contribution, role: previous.role, stage: previous.stage, focus,
        mode: "practice", questionCount: 6, repracticeOf: report.id,
        resume: previous.confirmedResume ?? null, resumeConfirmed: false,
      } : fresh());
      creationOperation.current = crypto.randomUUID();
    } catch (e) { notify(errorOf(e).message, true); }
  }
  function changeCreationProfile(value: Creation) {
    resumeRead.current++;
    setReadingResume(false);
    setResumeError("");
    setCreation({ ...value, resume: null, resumeConfirmed: false });
  }
  function closeCreation() {
    resumeRead.current++;
    setReadingResume(false);
    setResumeError("");
    setCreation(null);
  }
  async function readResume() {
    if (!creation?.profileVersionId) return;
    const profileVersionId = creation.profileVersionId;
    const owner = workspace.state.profiles.find((profile) => profile.versions.some((version) => version.id === profileVersionId));
    if (!owner) return;
    const ticket = ++resumeRead.current;
    setReadingResume(true);
    setResumeError("");
    setCreation({ ...creation, resume: null, resumeConfirmed: false });
    try {
      const file = await interview<ResumePreview>({ kind: "resume_preview", profileId: owner.id, profileVersionId });
      const text = await extractResume(new File([new Uint8Array(file.bytes)], file.name));
      if (new TextEncoder().encode(text).length > 1_000_000) throw new Error("简历文字超过 1 MB，请精简后重新导入。");
      if (!mounted.current || ticket !== resumeRead.current) return;
      setCreation((current) => current?.profileVersionId === profileVersionId ? {
        ...current, resume: { assetId: file.assetId, text }, resumeConfirmed: false,
      } : current);
    } catch (error) {
      if (mounted.current && ticket === resumeRead.current) setResumeError(error instanceof Error ? error.message : errorOf(error).message);
    } finally {
      if (mounted.current && ticket === resumeRead.current) setReadingResume(false);
    }
  }
  async function create() {
    if (!creation) return;
    setBusy(true);
    busyRef.current = true;
    try {
      const result = await interview<SessionView>({
        kind: "create", operationId: creationOperation.current,
        applicationId: creation.applicationId || null, profileVersionId: creation.profileVersionId || null,
        confirmedResume: creation.resumeConfirmed ? creation.resume : null,
        jobSnapshotId: creation.jobSnapshotId || null,
        sources: creation.sourceIds.map((id) => { const v = versions.find((v) => v.id === id)!; return { versionId: id, scopeVersion: v.scopeVersion }; }),
        contribution: creation.contribution, role: creation.role, stage: creation.stage, focus: creation.focus,
        mode: creation.mode, questionCount: creation.questionCount, repracticeOf: creation.repracticeOf,
      });
      selectedRef.current = result.session.id;
      setSelected(result.session.id);
      accept(result, true);
      closeCreation();
      await loadList();
      await reload();
      notify("场次已保存。点击开始后才调用配置的聊天服务。");
    } catch (e) { notify(errorOf(e).message, true); }
    finally { setBusy(false); busyRef.current = false; }
  }
  async function showEvidence(id: string) {
    try { setEvidence(await request<Evidence>("source", { datasetId, command: { kind: "evidence", id } })); }
    catch (e) { notify(errorOf(e).message, true); }
  }
  const session = current?.session;
  const sessionTasks = session ? workspace.state.tasks.filter((t) => t.contextId === "interview:" + session.id) : [];
  const task = sessionTasks.find((t) => t.id === sentTaskId) ?? sessionTasks.at(-1);
  const active = session?.status === "generating";
  return <section className="workflow-panel" aria-label="文字面试">
    <div className="section-title"><div><h2>岗位与项目文字面试</h2><p className="muted">按真实回答追问，保留材料版本和评价依据。练习与模拟不会改变真实申请阶段。</p></div>
      <button className="primary" disabled={busy || saving} onClick={() => void openCreation()}>新建文字面试</button>
    </div>
    {sessions.length > 0 && <Field label="已保存场次"><select value={selected} disabled={busy || saving} onChange={(e) => void selectSession(e.target.value)}>
      <option value="">选择场次</option>{sessions.map((s) => <option key={s.id} value={s.id}>{s.role} · {s.mode === "practice" ? "练习" : "模拟"} · {formatDate(s.createdAt)} · {statusLabel[s.status]}</option>)}
    </select></Field>}
    {!session ? <Empty title="从一场文字练习开始">默认6个主问题，每题最多2次追问。可以选档案、岗位和已授权的项目版本；缺少材料会明确显示覆盖缺口。</Empty> : <>
      <div className="section-title"><h3>{session.role} · {session.mode === "practice" ? "练习" : "模拟"}</h3><span>{statusLabel[session.status]}</span></div>
      <p className="muted">{session.questionCount} 个主问题 · 每题最多2次追问 · {session.provider.name} / {session.provider.model}</p>
      {(!session.profileVersionId || !session.confirmedResume || !session.jobSnapshotId || !session.sources.length) && <p className="notice">材料覆盖不完整：{!session.profileVersionId && "缺少档案；"}{!session.confirmedResume && "缺少已确认的简历文字；"}{!session.jobSnapshotId && "缺少JD；"}{!session.sources.length && "缺少项目源码；"}相关结论只能说明材料不足。</p>}
      {session.confirmedResume && <details><summary>本场已确认的简历文字（固定版本）</summary><p className="muted">以下是本场保存的用户确认文字，不会随档案换版而更新。</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{session.confirmedResume.text}</pre></details>}
      {session.mode === "simulation" && !session.finished && <p className="notice">模拟模式在整场结束后统一反馈。当前不会展示评分或完整评估。</p>}
      {session.error && <p className="notice error" role="alert">{session.error.message}</p>}
      {session.turns.map((turn) => <article key={turn.id} className="settings-section">
        <h3>第 {turn.mainNumber} 题{turn.followUp > 0 ? " · 追问 " + turn.followUp : ""}</h3>
        <p style={{ whiteSpace: "pre-wrap" }}>{turn.question}</p>
        <div className="actions">{turn.evidenceIds.map((id, i) => <button key={id} onClick={() => void showEvidence(id)}>材料依据 {i + 1}</button>)}</div>
        {turn.answer ? <div><p className="muted small">已保存回答 · {turn.answer.disposition === "skip" ? "用户跳过" : turn.answer.disposition === "dont_know" ? "用户表示不会" : formatDate(turn.answer.savedAt)}</p><p style={{ whiteSpace: "pre-wrap" }}>{turn.answer.text}</p></div>
          : turn.closed && <p className="muted">本题已结束，没有提交回答。</p>}
      </article>)}
      {!session.finished && <Field label="当前回答" hint={saving ? "正在保存输入…" : dirty ? "有未保存输入；保存失败时内容会留在此处。" : "输入已保存到本机，点击发送才提交本题回答。"}>
        <textarea rows={7} value={draft} disabled={busy || active || session.status !== "waiting_answer"} onChange={(e) => { draftRef.current = e.target.value; setDraft(e.target.value); }} />
      </Field>}
      <div className="actions">
        {session.status === "waiting_answer" && <>
          <button className="primary" disabled={busy || saving || !draft.trim()} onClick={() => void answer("answer")}>发送回答</button>
          <button disabled={busy || saving} onClick={() => draft.trim() ? setEndIntent("dont_know") : void answer("dont_know")}>我不会，结束本题</button>
          <button disabled={busy || saving} onClick={() => draft.trim() ? setEndIntent("skip") : void answer("skip")}>跳过本题</button>
          {session.mode === "practice" && <button disabled={busy || saving} onClick={() => draft.trim() ? setEndIntent("reveal") : void run("reveal")}>查看解析并结束本题</button>}
        </>}
        {!active && session.status !== "waiting_answer" && session.status !== "completed" &&
          <button className="primary" disabled={busy || saving} onClick={() => void run("advance")}>{session.error ? "手动重试／继续" : !session.turns.length ? "开始本场" : session.pending?.kind === "feedback" ? "生成本题反馈" : "继续本场"}</button>}
        {(active || busy) && <button onClick={() => { void interview<SessionView>({ kind: "stop", sessionId: session.id }).then((next) => accept(next)).catch((e) => notify(errorOf(e).message, true)); }}>停止生成</button>}
        {!session.finished && session.turns.length > 0 && <button disabled={busy || saving || active} onClick={() => setFinish(true)}>结束本场并生成报告</button>}
        {dirty && <button disabled={busy || saving} onClick={() => void saveDraft().catch((e) => notify(errorOf(e).message, true))}>保存当前输入</button>}
        {session.status === "paused" && <button disabled={busy || saving} onClick={() => setContextConfirmation(true)}>核对当前配置与授权后继续</button>}
      </div>
      {session.partial && <details><summary>{active ? "查看正在接收的原始内容" : "查看保留的部分／未通过校验结果"}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{session.partial}</pre></details>}
      {task && <details><summary>查看本场实际发送内容</summary>
        <Field label="本场模型请求"><select value={task.id} onChange={(e) => setSentTaskId(e.target.value)}>
          {sessionTasks.map((item, i) => <option key={item.id} value={item.id}>第 {i + 1} 次 · {formatDate(item.startedAt)} · {item.versions.filter((v) => v.kind === "evidence").length} 段源码</option>)}
        </select></Field>
        <p className="muted">{task.provider.name} / {task.provider.model}</p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{task.input.text}</pre>
      </details>}
      {current.reports.map((report) => <article key={report.id} className="settings-section">
        <h3>{report.mainNumber === null ? "本场报告" : "第 " + report.mainNumber + " 题反馈"}</h3>
        <p className="muted">原文对照：已核对回答引文、材料版本与源码原文；模型解释未作语义核实。</p>
        {report.content.points.map((point, index) => {
          const history = session.reportCorrections?.filter((item) => item.reportId === report.id && item.pointIndex === index) ?? [];
          const corrected = history.at(-1);
          const sources = current.reportEvidence[report.id] ?? [];
          const linked = corrected?.evidenceIds ?? point.evidenceIds;
          return <section key={index} className="settings-section">
            <h4>第 {index + 1} 项 · {corrected ? "人工核对更正" : "原文对照"}</h4>
            {corrected && <><p style={{ whiteSpace: "pre-wrap" }}>{corrected.text}</p><p className="muted small">人工核对记录 · {formatDate(corrected.createdAt)}，不替换原始模型报告。</p><button disabled={busy || saving} onClick={() => void openCreation(report, corrected.text)}>围绕更正复练</button></>}
            {point.answerQuote ? <><p className="muted">实际回答原话</p><blockquote>{point.answerQuote}</blockquote></> : <p className="muted">本项未引用回答原话。</p>}
            {linked.length > 0 ? <><p className="muted">固定源码原文</p>{sources.filter((item) => linked.includes(item.id)).map((item) => <div key={item.id}>
              <p><strong>{evidenceTimingLabel(session.turns, report, point, item.id)}</strong></p>
              <EvidenceView evidence={item} />
            </div>)}</> : <p className="muted">本项没有引用项目源码。</p>}
            <button disabled={busy || saving || active || !sources.length} onClick={() => editCorrection(report, index)}>核对并更正第 {index + 1} 项</button>
            {history.length > 1 && <details><summary>查看此前人工更正</summary>{history.slice(0, -1).map((item) => <div key={item.id}><p>{formatDate(item.createdAt)}</p><p style={{ whiteSpace: "pre-wrap" }}>{item.text}</p><div className="actions">{item.evidenceIds.map((id, i) => <button key={id} onClick={() => void showEvidence(id)}>历史依据 {i + 1}</button>)}</div></div>)}</details>}
          </section>;
        })}
        <details><summary>原始模型报告（未核实）</summary>
        <p style={{ whiteSpace: "pre-wrap" }}>{report.content.summary}</p>
        {report.content.referenceAnswer && <details><summary>参考回答与解析</summary><p style={{ whiteSpace: "pre-wrap" }}>{report.content.referenceAnswer}</p></details>}
        {report.content.points.map((point, index) => <div key={index}>
          <p><strong>{pointLabel[point.category]}</strong> · <span className="muted">{basisLabel[point.basis]}</span></p>
          {point.answerQuote && <blockquote>{point.answerQuote}</blockquote>}
          <p style={{ whiteSpace: "pre-wrap" }}>{point.observation}</p><p>{point.action}</p>
          <div className="actions">{point.evidenceIds.map((id, i) => <button key={id} onClick={() => void showEvidence(id)}>查看引用 {i + 1}</button>)}</div>
        </div>)}
        {report.content.weaknesses.length > 0 && <h4>薄弱点与后续练习</h4>}
        {report.content.weaknesses.map((weakness, index) => <div key={index}><p><strong>{weakness.title}</strong></p><p>{weakness.practicePrompt}</p>
          <div className="actions">{weakness.evidenceIds.map((id, i) => <button key={id} onClick={() => void showEvidence(id)}>参考材料 {i + 1}</button>)}
            <button disabled={busy || saving} onClick={() => void openCreation(report, weakness.practicePrompt)}>围绕此项复练</button></div>
        </div>)}
        </details>
        <p className="muted small">评价依据本场回答和保存的材料；不代表录用概率，也不与不同岗位／题目／模型场次直接比较。</p>
      </article>)}
    </>}
    {creation && <Dialog title={creation.repracticeOf ? "创建薄弱点复练" : "新建文字面试"} wide busy={busy} onCancel={closeCreation} actions={<>
      <button disabled={busy} onClick={closeCreation}>取消</button><button className="primary" disabled={busy || readingResume} onClick={() => void create()}>保存场次</button>
    </>}>
      <div className="form-grid">
        <Field label="目标方向"><select value={creation.role} onChange={(e) => setCreation({ ...creation, role: e.target.value })}>{["AI Agent", "AI全栈", "Java/Python后端", "大模型算法"].map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="求职阶段"><select value={creation.stage} onChange={(e) => setCreation({ ...creation, stage: e.target.value })}><option value="intern">实习</option><option value="campus">校招</option><option value="experienced">社招</option></select></Field>
        <Field label="面试模式"><select value={creation.mode} onChange={(e) => setCreation({ ...creation, mode: e.target.value as Creation["mode"] })}><option value="practice">练习：按题组反馈</option><option value="simulation">模拟：整场结束反馈</option></select></Field>
        <Field label="主问题数量"><input type="number" min={1} max={50} value={creation.questionCount} onChange={(e) => setCreation({ ...creation, questionCount: Number(e.target.value) })} /></Field>
      </div>
      <Field label="关联申请（可选）"><select value={creation.applicationId} onChange={(e) => {
        const app = workspace.state.applications.find((a) => a.id === e.target.value);
        changeCreationProfile({ ...creation, applicationId: e.target.value, jobSnapshotId: app?.jobSnapshotId ?? creation.jobSnapshotId, profileVersionId: app?.profileVersionId ?? creation.profileVersionId });
      }}><option value="">不关联真实申请</option>{workspace.state.applications.map((a) => {
        const job = workspace.state.jobs.find((j) => j.id === a.jobSnapshotId);
        return <option key={a.id} value={a.id}>{job?.data.company} · {job?.data.title} · {job?.data.channel} · {job?.data.batch}</option>;
      })}</select></Field>
      <Field label="档案固定版本（可选）"><select value={creation.profileVersionId} onChange={(e) => changeCreationProfile({ ...creation, profileVersionId: e.target.value })}><option value="">未选择，保留材料缺口</option>
        {workspace.state.profiles.flatMap((p) => p.versions.map((v) => <option key={v.id} value={v.id}>{p.name} · {formatDate(v.createdAt)}</option>))}
      </select></Field>
      <section className="settings-section">
        <h3>本次简历文字</h3>
        <p className="muted">从所选档案的配套简历在本机提取，核对后勾选才用于本场。只发送确认文字，不发送简历文件；未确认时保留覆盖缺口。</p>
        <button disabled={busy || readingResume || !creation.profileVersionId} onClick={() => void readResume()}>{readingResume ? "正在本地提取…" : "从配套简历提取文字"}</button>
        {resumeError && <p className="notice" role="alert">简历文字不可用：{resumeError}；本场将保留简历文字覆盖缺口。</p>}
        {creation.resume && <>
          <Field label="本次使用的简历文字" hint="可修正解析结果。修改后需重新勾选确认；不会改写档案或简历原件。"><textarea rows={8} maxLength={1_000_000} value={creation.resume.text} onChange={(e) => setCreation({ ...creation, resume: { ...creation.resume!, text: e.target.value }, resumeConfirmed: false })} /></Field>
          <label className="check"><input type="checkbox" checked={creation.resumeConfirmed} disabled={!creation.resume.text.trim()} onChange={(e) => setCreation({ ...creation, resumeConfirmed: e.target.checked })} />我已核对简历文字，同意在本场发给所选聊天服务</label>
        </>}
      </section>
      <Field label="岗位快照（可选）"><select value={creation.jobSnapshotId} disabled={!!creation.applicationId} onChange={(e) => setCreation({ ...creation, jobSnapshotId: e.target.value })}><option value="">未选择，保留材料缺口</option>{workspace.state.jobs.map((j) => <option key={j.id} value={j.id}>{j.data.company} · {j.data.title} · {j.data.batch}</option>)}</select></Field>
      <fieldset><legend>已授权的项目版本（可选）</legend>
        {!versions.length && <p className="muted">还没有项目材料，可先在“项目材料”中导入并确认外发范围。</p>}
        {versions.map((v) => {
          const available = workspace.state.assets.some((a) => a.id === v.assetId && a.status === "available") && v.allowedPaths.length > 0;
          return <label className="check" key={v.id}><input type="checkbox" checked={creation.sourceIds.includes(v.id)} disabled={!available && !creation.sourceIds.includes(v.id)} onChange={(e) => setCreation({ ...creation, sourceIds: e.target.checked ? [...creation.sourceIds, v.id] : creation.sourceIds.filter((id) => id !== v.id) })} />{v.name} · {formatDate(v.createdAt)} · {available ? "已授权" : "副本不可用或尚未授权"}</label>;
        })}
      </fieldset>
      <Field label="我实际负责的内容" hint="只写能够确认的个人动作；源码存在不会自动算成个人贡献。"><textarea rows={4} value={creation.contribution} onChange={(e) => setCreation({ ...creation, contribution: e.target.value })} /></Field>
      <Field label="本场重点／检索关键词（可选）"><textarea rows={3} value={creation.focus} onChange={(e) => setCreation({ ...creation, focus: e.target.value })} placeholder="例如 工具调用、任务取消、状态恢复；可加入具体函数名。" /></Field>
      <p className="muted">每题最多2次追问；回答充分、没有新信息、不会或跳过时结束该题。题量规则不限制AI调用次数。</p>
      <p className="muted">生成问题与反馈时，会向你配置的聊天服务发送已确认的简历文字、所选岗位、已有题目和已发送的回答、本人说明、面试设置及获准项目片段。完整结构化档案仅用于本地关联。</p>
    </Dialog>}
    {evidence && <Dialog title="固定版本引用" wide onCancel={() => setEvidence(null)} actions={<button onClick={() => setEvidence(null)}>关闭</button>}><EvidenceView evidence={evidence} /></Dialog>}
    {correction && current && <Dialog title="核对并更正报告条目" wide busy={busy} onCancel={() => setCorrection(null)} actions={<>
      <button disabled={busy} onClick={() => setCorrection(null)}>取消</button>
      <button className="primary" disabled={busy || !correction.confirmed || !correction.text.trim() || !correction.evidenceIds.length} onClick={() => void saveCorrection()}>保存人工更正</button>
    </>}>
      <p>第 {correction.pointIndex + 1} 项的更正只保存在本地。原模型报告、任务原文和回答不变。</p>
      <details><summary>原模型解释</summary><p>{current.reports.find((report) => report.id === correction.reportId)?.content.points[correction.pointIndex]?.observation}</p></details>
      <Field label="人工更正内容"><textarea rows={4} value={correction.text} onChange={(e) => setCorrection({ ...correction, text: e.target.value, operationId: crypto.randomUUID(), confirmed: false })} /></Field>
      <p>选择已核对的固定源码原文，可选此报告其他条目使用的材料：</p>
      {(current.reportEvidence[correction.reportId] ?? []).map((item) => <div key={item.id}>
        <label><input type="checkbox" checked={correction.evidenceIds.includes(item.id)} onChange={(e) => setCorrection({ ...correction,
          evidenceIds: e.target.checked ? [...correction.evidenceIds, item.id] : correction.evidenceIds.filter((id) => id !== item.id),
          operationId: crypto.randomUUID(), confirmed: false })} />{item.path} · 第 {item.startLine}–{item.endLine} 行</label>
        <EvidenceView evidence={item} />
      </div>)}
      <label><input type="checkbox" checked={correction.confirmed} onChange={(e) => setCorrection({ ...correction, confirmed: e.target.checked })} />我已核对所选原文、版本与更正内容；这是人工核对记录。</label>
    </Dialog>}
    {finish && <Dialog title="结束本场并生成报告" onCancel={() => setFinish(false)} actions={<><button onClick={() => setFinish(false)}>取消</button><button className="primary" onClick={() => { setFinish(false); void run("finish"); }}>确认结束</button></>}>
      <p>将按已完成的问题和实际回答生成报告。尚未发送的输入留在本地，不会假装成已回答；真实申请阶段保持原样。</p>
    </Dialog>}
    {endIntent && <Dialog title="结束当前问题" onCancel={() => setEndIntent(null)} actions={<><button onClick={() => setEndIntent(null)}>返回编辑</button><button onClick={() => {
      if (endIntent === "reveal") { setEndIntent(null); void run("reveal"); }
      else void answer(endIntent);
    }}>{endIntent === "reveal" ? "确认查看解析" : endIntent === "skip" ? "确认跳过" : "确认不会"}</button></>}>
      <p>本题草稿不会作为回答发送。{endIntent === "reveal" ? "进入下一题时会清空输入框。" : "结束本题后会清空输入框。"}</p>
    </Dialog>}
    {contextConfirmation && <Dialog title="确认继续使用的模型与范围" onCancel={() => setContextConfirmation(false)} actions={<><button onClick={() => setContextConfirmation(false)}>取消</button><button className="primary" onClick={() => { setContextConfirmation(false); void run("confirm_context", { confirmed: true }); }}>确认更新并保留回答</button></>}>
      <p>使用当前聊天配置：{workspace.state.providers.find((p) => p.purpose === "chat")?.name} / {workspace.state.providers.find((p) => p.purpose === "chat")?.model}，以及所选固定材料版本的当前已确认外发范围。</p>
      <p>问题和回答不会重置；旧报告仍保留原任务及引用。材料版本不替换，缺少完整副本时需先重新导入。</p>
    </Dialog>}
  </section>;
}
