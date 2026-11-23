import { useCallback, useEffect, useRef, useState } from "react";
import { errorOf, request } from "./api";
import { Dialog, Empty, Field, bytesLabel as formatBytes, formatDate } from "./ui";
import type { Evidence, SearchHit, Selection, SourceFile, SourceList, SourceVersion, S3PanelProps } from "./s3-types";

export function EvidenceView({ evidence }: { evidence: Evidence }) {
  return <div className="evidence">
    <p><strong>{evidence.path}</strong> · 第 {evidence.startLine}–{evidence.endLine} 行</p>
    <p className="muted small">固定材料版本 {evidence.sourceVersionId.slice(0, 8)} · 文件校验 {evidence.fileSha256.slice(0, 12)}</p>
    <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{evidence.text || "（空行）"}</pre>
  </div>;
}

export function ProjectsPanel({ workspace, reload, notify, onDirty }: S3PanelProps) {
  const datasetId = workspace.state.datasetId;
  const [data, setData] = useState<SourceList | null>(null);
  const [selected, setSelected] = useState("");
  const [filePage, setFilePage] = useState<{ versionId: string; offset: number; rows: SourceFile[] } | null>(null);
  const [offset, setOffset] = useState(0);
  const [choice, setChoice] = useState<Selection | null>(null);
  const [name, setName] = useState("");
  const [refreshProject, setRefreshProject] = useState<string | null>(null);
  const [operation, setOperation] = useState("");
  const [busy, setBusy] = useState<{ token: string; label: string } | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ versionId: string; scopeVersion: string; query: string; hits: SearchHit[] } | null>(null);
  const [scope, setScope] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [cleanup, setCleanup] = useState(false);
  const alive = useRef(true);
  const picking = useRef(false);
  const pendingChoice = useRef<Selection | null>(null);
  const active = useRef<{ token: string; stopped: boolean } | null>(null);
  const currentDataset = useRef(datasetId);
  currentDataset.current = datasetId;
  const source = useCallback(<T,>(command: Record<string, unknown>) =>
    request<T>("source", { datasetId, command }), [datasetId]);
  const load = useCallback(async () => {
    const next = await source<SourceList>({ kind: "list" });
    if (!alive.current || currentDataset.current !== datasetId) return;
    setData(next);
    setSelected((id) => next.versions.some((v) => v.id === id) ? id : next.versions[0]?.id ?? "");
  }, [datasetId, source]);
  useEffect(() => {
    alive.current = true;
    void load().catch((e) => notify(errorOf(e).message, true));
    return () => {
      alive.current = false;
      const token = pendingChoice.current?.token ?? active.current?.token;
      if (token) void source({ kind: "cancel", token }).catch(() => undefined);
    };
  }, [load, notify, source]);
  useEffect(() => onDirty(!!choice || scope !== null || !!busy), [choice, scope, busy, onDirty]);
  useEffect(() => setOffset(0), [selected]);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void source<SourceFile[]>({ kind: "files", versionId: selected, offset })
      .then((rows) => { if (!cancelled) setFilePage({ versionId: selected, offset, rows }); })
      .catch((e) => { if (!cancelled) notify(errorOf(e).message, true); });
    return () => { cancelled = true; };
  }, [selected, offset, source, notify]);
  const version = data?.versions.find((v) => v.id === selected);
  const asset = workspace.state.assets.find((a) => a.id === version?.assetId);
  const files = filePage?.versionId === selected && filePage.offset === offset ? filePage.rows : [];
  const canSearch = !busy && !!query.trim() && asset?.status === "available";
  const hits = result && result.versionId === selected && result.scopeVersion === version?.scopeVersion &&
    result.query === query.trim() && asset?.status === "available" ? result.hits : null;

  async function choose(isDirectory: boolean, project: SourceVersion | null = null) {
    if (picking.current || pendingChoice.current || active.current) return;
    picking.current = true;
    try {
      const result = await request<Selection | null>("source_select", { datasetId, isDirectory });
      if (!result) return;
      if (!alive.current || currentDataset.current !== datasetId) {
        await source({ kind: "cancel", token: result.token });
        return;
      }
      pendingChoice.current = result;
      setChoice(result);
      setName(project?.name ?? result.name.replace(/\.zip$/i, ""));
      setRefreshProject(project?.projectId ?? null);
      setOperation(crypto.randomUUID());
    } catch (e) { if (alive.current) notify(errorOf(e).message, true); }
    finally { picking.current = false; }
  }
  async function discardChoice() {
    if (choice) await source({ kind: "cancel", token: choice.token }).catch(() => undefined);
    pendingChoice.current = null;
    setChoice(null);
  }
  async function importProject() {
    if (active.current || !choice || !name.trim()) return;
    const token = choice.token;
    active.current = { token, stopped: false };
    pendingChoice.current = null;
    setBusy({ token, label: "正在只读导入…" });
    setChoice(null);
    try {
      const result = await source<SourceVersion>({ kind: "import", token, projectId: refreshProject, name: name.trim(), operationId: operation });
      if (!alive.current || currentDataset.current !== datasetId) return;
      await reload();
      await load();
      setSelected(result.id);
      notify("项目版本已保存。请核对排除／失败清单，并在外发前确认范围。");
    } catch (e) { if (alive.current) notify(errorOf(e).message, true); }
    finally { finishOperation(token); }
  }
  async function search() {
    if (!version || !canSearch || active.current || picking.current || pendingChoice.current) return;
    const token = crypto.randomUUID();
    active.current = { token, stopped: false };
    setBusy({ token, label: "正在本地检索…" });
    setResult(null);
    try {
      const hits = await source<SearchHit[]>({ kind: "search", versionId: version.id, query, token });
      if (alive.current && currentDataset.current === datasetId && active.current?.token === token && !active.current.stopped)
        setResult({ versionId: version.id, scopeVersion: version.scopeVersion, query: query.trim(), hits });
    } catch (e) { if (alive.current) notify(errorOf(e).message, true); }
    finally { finishOperation(token); }
  }
  function finishOperation(token: string) {
    if (active.current?.token !== token) return;
    active.current = null;
    if (alive.current) setBusy(null);
  }
  async function stop(token: string) {
    if (active.current?.token !== token) return;
    active.current.stopped = true;
    try { await source({ kind: "cancel", token }); }
    catch (e) { if (alive.current) notify(errorOf(e).message, true); }
  }
  async function saveScope(paths: string[], acknowledge: boolean) {
    if (!version) return;
    try {
      const updated = await source<SourceVersion>({ kind: "set_scope", versionId: version.id, expectedScopeVersion: version.scopeVersion, paths, confirmed: acknowledge });
      if (!alive.current || currentDataset.current !== datasetId) return;
      setData(previous => previous && { ...previous, versions: previous.versions.map(v => v.id === updated.id ? updated : v) });
      setScope(null);
      await reload();
      notify(paths.length ? "可外发范围已保存；后续场次使用本次授权。" : "外发授权已撤回，相关正在运行的调用已停止。");
    } catch (e) { notify(errorOf(e).message, true); }
  }
  return <section className="workflow-panel" aria-label="项目材料">
    <div className="section-title">
      <div><h2>项目材料</h2><p className="muted">完整项目留在本机，只读导入；不会运行源码、安装依赖或执行 README 指令。</p></div>
      <div className="actions">
        <button className="primary" disabled={!!busy || !!choice} onClick={() => void choose(true)}>导入项目目录</button>
        <button disabled={!!busy || !!choice} onClick={() => void choose(false)}>导入项目 ZIP</button>
      </div>
    </div>
    {data && <p className="muted small">当前保护上限：{data.limits.files.toLocaleString()} 个条目，单文件 {formatBytes(data.limits.fileBytes)}，读取总量 {formatBytes(data.limits.totalBytes)}。{data.limits.encoding}。</p>}
    {busy && <div className="notice" role="status">{busy.label} <button onClick={() => void stop(busy.token)}>停止</button></div>}
    {!data?.versions.length ? <Empty title="还没有项目材料">选择完整源码目录或 ZIP；被排除和不可读的文件会单独列出。</Empty> : <>
      <Field label="项目及固定版本"><select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={!!busy}>
        {data.versions.map((v) => <option key={v.id} value={v.id}>{v.name} · {formatDate(v.createdAt)} · {v.id.slice(0, 8)}</option>)}
      </select></Field>
      {version && <>
        <p>可读 {version.readableFiles} / 清单 {version.totalFiles} 项 · 原内容 {formatBytes(version.sourceBytes)} · 应用副本 {asset ? formatBytes(asset.bytes) : "未知"}</p>
        <p className={asset?.status === "available" ? "muted" : "notice error"}>{asset?.status === "available"
          ? "这是已保存的固定版本。原目录后续变化不会替换当前材料或旧报告。"
          : "完整材料副本不可用；已保存的报告和引用片段仍保留，不能据此全量复查项目。"}</p>
        <div className="actions">
          <button disabled={!!busy} onClick={() => void choose(true, version)}>从目录刷新为新版本</button>
          <button disabled={!!busy} onClick={() => void choose(false, version)}>从 ZIP 刷新为新版本</button>
          <button disabled={!!busy || asset?.status !== "available"} onClick={() => { setScope(version.allowedPaths.join("\n")); setConfirmed(false); }}>确认外发范围</button>
          <button disabled={!!busy || !version.allowedPaths.length} onClick={() => void saveScope([], false)}>撤回外发授权</button>
          <button disabled={!!busy || asset?.status !== "available"} onClick={() => setCleanup(true)}>清理完整副本</button>
        </div>
        <p className="notice">{version.allowedPaths.length ? "已授权范围：" + version.allowedPaths.join("、") : "尚未授权向模型发送项目内容。本地检索不需要外发授权。"}</p>
        <div className="form-grid">
          <Field label="本地检索关键词" hint="输入路径、类／函数名或关键词，以空格分隔；不进行网络搜索。">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="例如 cancel_context generation" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} />
          </Field>
          <div className="actions"><button disabled={!canSearch} onClick={() => void search()}>检索固定材料</button></div>
        </div>
        {hits?.length === 0 && <p className="notice">没有命中当前关键词。此结果只说明检索覆盖不足，不能据此断言项目没有该功能。</p>}
        {hits?.map((hit) => <details key={hit.evidence.id}><summary>{hit.evidence.path} · {hit.evidence.startLine}–{hit.evidence.endLine} 行 · {hit.allowed ? "在外发范围内" : "仅本地可见"}</summary><EvidenceView evidence={hit.evidence} /></details>)}
        <h3>文件清单</h3>
        <p className="muted small">需要补选默认排除目录中的资料时，可将该目录单独作为材料导入；可识别凭证仍会排除。秘密识别并非穷尽，请核对授权范围。</p>
        <div className="table-scroll"><table><thead><tr><th>路径</th><th>状态</th><th>说明</th><th>大小</th></tr></thead><tbody>
          {files.map((file) => <tr key={file.id}><td style={{ overflowWrap: "anywhere" }}>{file.path}</td><td>{{ readable: "已读取", excluded: "已排除", failed: "读取失败" }[file.status]}</td><td>{file.reason || file.lines + " 行"}</td><td>{formatBytes(file.bytes)}</td></tr>)}
        </tbody></table></div>
        <div className="actions"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 200))}>上一页</button><span>{files.length ? `${offset + 1}–${offset + files.length}` : "—"} / {version.totalFiles}</span><button disabled={!files.length || offset + files.length >= version.totalFiles} onClick={() => setOffset(offset + 200)}>下一页</button></div>
      </>}
    </>}
    {choice && <Dialog title={refreshProject ? "保存项目新版本" : "导入项目"} onCancel={() => void discardChoice()} actions={<>
      <button onClick={() => void discardChoice()}>取消</button><button className="primary" disabled={!name.trim()} onClick={() => void importProject()}>只读导入</button>
    </>}>
      <p>已选择：{choice.name}（{choice.isDirectory ? "目录" : "ZIP"}）</p>
      <Field label="项目名称"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></Field>
      <p>保留可读源码副本并生成文件清单；默认排除秘密、依赖、构建产物及 Git 历史。此操作不会授权全量外发。</p>
    </Dialog>}
    {scope !== null && version && <Dialog title="确认项目可外发范围" onCancel={() => setScope(null)} actions={<>
      <button onClick={() => setScope(null)}>取消</button><button className="primary" disabled={!confirmed || !scope.trim()} onClick={() => void saveScope(scope.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), true)}>保存外发范围</button>
    </>}>
      <p>项目：{version.name} · 版本 {version.id.slice(0, 8)}。面试只选取任务需要的相关片段，完整导入不等于全仓发送。</p>
      <Field label="允许的路径" hint="每行一个文件路径或以 / 结尾的目录；* 表示本版全部已读取文件。"><textarea rows={7} value={scope} onChange={(e) => setScope(e.target.value)} placeholder="src/&#10;README.md" /></Field>
      <p className="muted">聊天服务：{workspace.state.providers.find((p) => p.purpose === "chat")?.name || "尚未配置"}。可在场次中查看实际发送内容。</p>
      <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我已核对范围，允许向自己配置的聊天服务发送其中相关片段。</label>
    </Dialog>}
    {cleanup && version && <Dialog title="清理完整项目副本" onCancel={() => setCleanup(false)} actions={<>
      <button onClick={() => setCleanup(false)}>取消</button><button onClick={async () => {
        try { await source({ kind: "cleanup", versionId: version.id, confirmed: true }); setCleanup(false); await reload(); await load(); notify("完整应用副本已清理，原项目与已保存证据保留。"); }
        catch (e) { notify(errorOf(e).message, true); }
      }}>确认清理应用副本</button>
    </>}>
      <p>只清理 {version.name} 的当前应用副本，不删除原目录／ZIP。旧报告和引用片段保留，但无法再全量复查。重新分析完整项目需要重新导入。</p>
    </Dialog>}
  </section>;
}
