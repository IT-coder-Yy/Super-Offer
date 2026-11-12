import { useEffect, useRef, useState } from "react";
import { errorOf, fileBytes, mutate, request } from "./api";
import {
  FIELD_GROUPS,
  applySuggestions,
  materializeSelection,
  missingGroups,
  parseSuggestions,
  readField,
  sameProfileData,
  shiftOverridesAfterRemoval,
  writeField,
  type Suggestion,
} from "./profile-fields";
import { extractResume } from "./resume-parser";
import {
  emptyProfile,
  type FileAsset,
  type Fields,
  type ProfileData,
  type ProfileVersion,
  type Workspace,
} from "./types";
import { Dialog, Field, formatDate, bytesLabel } from "./ui";

interface Props {
  workspace: Workspace;
  reload: () => Promise<Workspace>;
  notify: (message: string, error?: boolean) => void;
  onDirty: (dirty: boolean) => void;
}
export function ProfilePanel({ workspace, reload, notify, onDirty }: Props) {
  const state = workspace.state;
  const first = state.profiles[0];
  const initial = first?.versions.find((v) => v.id === first.currentVersionId);
  const [selected, setSelected] = useState<string | null>(first?.id ?? null);
  const [base, setBase] = useState<ProfileVersion | null>(initial ?? null);
  const [name, setName] = useState(first?.name ?? "");
  const [data, setData] = useState<ProfileData>(
    structuredClone(initial?.data ?? emptyProfile()),
  );
  const [savedName, setSavedName] = useState(first?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<string | null | undefined>(
    undefined,
  );
  const [copyVersion, setCopyVersion] = useState<string | null>(null);
  const [copyName, setCopyName] = useState("");
  const [review, setReview] = useState<{
    asset: FileAsset;
    text: string;
    suggestions: Suggestion[];
    ambiguous: string[];
  } | null>(null);
  const [once, setOnce] = useState<Fields>({});
  const [onceResume, setOnceResume] = useState<FileAsset | null>(null);
  const [history, setHistory] = useState<ProfileVersion | null>(null);
  const [selectionPreview, setSelectionPreview] = useState(false);
  const [manualPath, setManualPath] = useState("basic.name");
  const [manualValue, setManualValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const dirty =
    name !== savedName || !sameProfileData(data, base?.data ?? emptyProfile());
  useEffect(() => {
    onDirty(dirty || !!review || Object.keys(once).length > 0);
  }, [dirty, review, once, onDirty]);
  const current = state.profiles.find((p) => p.id === selected);
  const asset = state.assets.find((a) => a.id === data.resumeAssetId);
  const missing = missingGroups(data);
  async function select(target: string | null, currentWorkspace = workspace) {
    setBusy(true);
    try {
      if (selected)
        await request("cancel_context", {
          datasetId: state.datasetId,
          contextId: `profile:${selected}`,
        });
      const profile = currentWorkspace.state.profiles.find(
        (p) => p.id === target,
      );
      const version =
        profile?.versions.find((v) => v.id === profile.currentVersionId) ??
        null;
      setSelected(profile?.id ?? null);
      setBase(version);
      setName(profile?.name ?? "");
      setSavedName(profile?.name ?? "");
      setData(structuredClone(version?.data ?? emptyProfile()));
      setOnce({});
      setOnceResume(null);
      setReview(null);
      setHistory(null);
      setSwitchTarget(undefined);
    } finally {
      setBusy(false);
    }
  }
  function changeSelection(target: string | null) {
    if (target === selected && target !== null) return;
    if (dirty || review || Object.keys(once).length) setSwitchTarget(target);
    else void select(target).catch((e) => notify(errorOf(e).message, true));
  }
  async function save(target?: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await mutate<{ profileId: string; versionId: string }>(
        state,
        {
          kind: "save_profile",
          profileId: selected,
          expectedVersionId: base?.id ?? null,
          name,
          data,
        },
      );
      const next = await reload();
      const saved = next.state.profiles.find((p) => p.id === result.profileId)!;
      const version = saved.versions.find((v) => v.id === result.versionId)!;
      setSelected(result.profileId);
      setBase(version);
      setSavedName(saved.name);
      setName(saved.name);
      notify("档案已保存，历史版本保持不变。");
      if (target !== undefined) await select(target, next);
    } catch (error) {
      notify(errorOf(error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function importResume(file: File) {
    setBusy(true);
    try {
      const bytes = await fileBytes(file, 10 * 1024 * 1024);
      await request("validate_resume", { name: file.name, bytes });
      const text = await extractResume(file);
      const imported = await request<FileAsset>("import_asset", {
        datasetId: state.datasetId,
        name: file.name,
        bytes,
        assetKind: "resume",
      });
      await reload();
      const ambiguous: string[] = [];
      setReview({
        asset: imported,
        text,
        suggestions: parseSuggestions(text, data, (entry) =>
          ambiguous.push(entry),
        ),
        ambiguous,
      });
    } catch (error) {
      notify(
        error instanceof Error ? error.message : errorOf(error).message,
        true,
      );
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  function applyReview() {
    if (!review) return;
    const result = applySuggestions(data, review.suggestions, once);
    setData({
      ...result.saved,
      resumeAssetId:
        result.pending.length || Object.keys(result.once).length
          ? data.resumeAssetId
          : review.asset.id,
    });
    setOnce(result.once);
    setOnceResume(
      Object.keys(result.once).length
        ? review.suggestions.some((s) => s.choice === "once")
          ? review.asset
          : onceResume
        : null,
    );
    if (result.pending.length) {
      setReview({ ...review, suggestions: result.pending });
      notify("已应用无冲突字段，其余冲突仍待确认。");
    } else {
      setReview(null);
      notify("已放入编辑区，请核对后点击“保存进度”。");
    }
  }
  const renderData = (source: ProfileData, readOnly = false) =>
    FIELD_GROUPS.map((group) => {
      const value = source[group.key];
      const rows: Fields[] = Array.isArray(value) ? value : [value];
      return (
        <details
          className="field-section"
          key={group.key}
          open={readOnly || group.key === "basic" || group.key === "education"}
        >
          <summary>
            {group.label}
            <span>
              {group.repeat
                ? `${rows.length} 条`
                : Object.values(rows[0] ?? {}).some(Boolean)
                  ? "已填写"
                  : "可选填"}
            </span>
          </summary>
          {rows.map((row, index) => (
            <fieldset className="repeat-row" key={index}>
              <legend>
                {group.repeat ? `${group.label} ${index + 1}` : group.label}
              </legend>
              <div className="form-grid">
                {group.fields.map((field) => {
                  const path = `${group.key}.${group.repeat ? `${index}.` : ""}${field.key}`;
                  const props = {
                    value: row[field.key] ?? "",
                    readOnly,
                    placeholder: field.placeholder || "可留空",
                    onChange: (
                      event: React.ChangeEvent<
                        HTMLInputElement | HTMLTextAreaElement
                      >,
                    ) => {
                      setOnce((previous) =>
                        Object.fromEntries(
                          Object.entries(previous).filter(
                            ([key]) => key !== path,
                          ),
                        ),
                      );
                      setData((previous) =>
                        writeField(previous, path, event.target.value),
                      );
                    },
                  };
                  return (
                    <div
                      key={field.key}
                      className={field.multiline ? "full-width" : ""}
                    >
                      <Field label={field.label}>
                        {field.multiline ? (
                          <textarea {...props} rows={3} />
                        ) : (
                          <input {...props} />
                        )}
                      </Field>
                      {once[path] && !readOnly && (
                        <small className="once-note">
                          仅本次使用：{once[path]}
                        </small>
                      )}
                    </div>
                  );
                })}
              </div>
              {group.repeat && !readOnly && (
                <button
                  type="button"
                  className="text-button danger-text"
                  onClick={() => {
                    setOnce((previous) =>
                      shiftOverridesAfterRemoval(previous, group.key, index),
                    );
                    setData((previous) => ({
                      ...previous,
                      [group.key]: (previous[group.key] as Fields[]).filter(
                        (_, i) => i !== index,
                      ),
                    }));
                  }}
                >
                  移除此条
                </button>
              )}
            </fieldset>
          ))}
          {group.repeat && !readOnly && (
            <button
              type="button"
              className="text-button"
              onClick={() =>
                setData((previous) => ({
                  ...previous,
                  [group.key]: [...(previous[group.key] as Fields[]), {}],
                }))
              }
            >
              ＋ 添加{group.label}
            </button>
          )}
          {!rows.length && readOnly && <p className="muted">未填写</p>}
        </details>
      );
    });
  return (
    <div className="profile-layout">
      <aside className="profile-list">
        <div className="section-label">
          我的档案 <span>{state.profiles.length}</span>
        </div>
        {state.profiles.map((profile) => (
          <button
            type="button"
            key={profile.id}
            className={`profile-option ${profile.id === selected ? "selected" : ""}`}
            disabled={busy}
            onClick={() => changeSelection(profile.id)}
          >
            <strong>{profile.name}</strong>
            <span>{profile.versions.length} 个保存版本</span>
          </button>
        ))}
        <button
          type="button"
          className="secondary full-width"
          disabled={busy}
          onClick={() => changeSelection(null)}
        >
          新建档案
        </button>
        <p className="muted small">每份档案独立保存，可按岗位准备不同版本。</p>
      </aside>
      <fieldset className="profile-editor" disabled={busy}>
        <div className="editor-heading">
          <div>
            <h2>{selected ? name || "个人档案" : "新建个人档案"}</h2>
            <p className="muted">
              {dirty
                ? "有未保存修改"
                : base
                  ? `已保存于 ${formatDate(base.createdAt)}`
                  : "从手动录入或导入简历开始"}
            </p>
          </div>
          <div className="actions">
            <button
              className="secondary"
              disabled={
                !base || busy || dirty || !!review || !!Object.keys(once).length
              }
              onClick={() => {
                setCopyVersion(base?.id ?? null);
                setCopyName(`${name} · 副本`);
              }}
            >
              复制档案
            </button>
            <button
              className="primary"
              disabled={busy || !!review}
              onClick={() => void save()}
            >
              {busy ? "处理中…" : "保存进度"}
            </button>
          </div>
        </div>
        <Field label="档案名称">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：AI 应用开发 · 实习"
            maxLength={150}
          />
        </Field>
        <div className="resume-strip">
          <div>
            <strong>{asset?.name ?? "尚未配套简历"}</strong>
            <p className="muted small">
              {asset
                ? `${bytesLabel(asset.bytes)} · ${asset.status === "available" ? "应用副本已保留" : "副本缺失，请重新导入"}`
                : "支持文字版 PDF / DOCX，最大 10 MB；提取内容须由你确认。"}
            </p>
          </div>
          <input
            ref={input}
            type="file"
            accept=".pdf,.docx"
            aria-label="选择简历文件"
            onChange={(e) => {
              if (e.target.files?.[0]) void importResume(e.target.files[0]);
            }}
            hidden
          />
          <button
            className="secondary"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            导入简历预填
          </button>
        </div>
        {!!Object.keys(once).length && (
          <div className="notice">
            <span>
              有 {Object.keys(once).length} 个字段仅供本次使用，未写入档案。
              {onceResume && `本次简历：${onceResume.name}`}
            </span>
            <button
              className="text-button"
              onClick={() => setSelectionPreview(true)}
            >
              查看本次资料
            </button>
          </div>
        )}
        <div className="notice subtle">
          {missing.length
            ? `尚未填写：${missing.join("、")}。缺项不影响保存；招聘页面的必填要求另行核对。`
            : "所有类别都有内容，具体事实和日期仍以你的核对为准。"}
        </div>
        {renderData(data)}
        {current && (
          <details className="field-section">
            <summary>
              历史版本<span>{current.versions.length} 个</span>
            </summary>
            {[...current.versions].reverse().map((version, i) => (
              <div className="history-row" key={version.id}>
                <span>
                  版本 {current.versions.length - i} ·{" "}
                  {formatDate(version.createdAt)}
                  {version.id === current.currentVersionId ? " · 当前" : ""}
                </span>
                <button
                  className="text-button"
                  onClick={() => setHistory(version)}
                >
                  查看内容
                </button>
              </div>
            ))}
          </details>
        )}
      </fieldset>
      {switchTarget !== undefined && (
        <Dialog
          title="切换前处理当前编辑"
          onCancel={() => setSwitchTarget(undefined)}
          actions={
            <>
              <button
                className="secondary"
                onClick={() => setSwitchTarget(undefined)}
              >
                取消
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void select(switchTarget).catch((e) =>
                    notify(errorOf(e).message, true),
                  )
                }
              >
                不保存直接切换
              </button>
              <button
                className="primary"
                disabled={busy || !!review}
                onClick={() => void save(switchTarget)}
              >
                保存并切换
              </button>
            </>
          }
        >
          <p>
            尚未保存的修改或本次资料将在切换后清除。保存失败会留在当前档案。
          </p>
          {review && <p>请先完成简历提取确认，或选择不保存直接切换。</p>}
        </Dialog>
      )}
      {copyVersion && (
        <Dialog
          title="复制为独立档案"
          onCancel={() => setCopyVersion(null)}
          actions={
            <>
              <button
                className="secondary"
                onClick={() => setCopyVersion(null)}
              >
                取消
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await mutate<{ profileId: string }>(state, {
                      kind: "copy_profile",
                      versionId: copyVersion,
                      name: copyName,
                    });
                    const next = await reload();
                    setCopyVersion(null);
                    await select(result.profileId, next);
                    notify("已复制已保存版本，两份档案独立编辑。");
                  } catch (e) {
                    notify(errorOf(e).message, true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                确认复制
              </button>
            </>
          }
        >
          <Field label="新档案名称">
            <input
              value={copyName}
              onChange={(e) => setCopyName(e.target.value)}
            />
          </Field>
          <p className="muted">
            复制当前已保存的内容。未保存编辑不会带入副本。
          </p>
        </Dialog>
      )}
      {review && (
        <Dialog
          wide
          title="核对简历提取内容"
          onCancel={() => setReview(null)}
          actions={
            <>
              <button className="secondary" onClick={() => setReview(null)}>
                取消预填
              </button>
              <button className="primary" onClick={applyReview}>
                应用已确认字段
              </button>
            </>
          }
        >
          <p>
            {review.asset.name} ·
            提取仅提供建议，不会补造未知经历。日期冲突按字段选择。
          </p>
          <div className="parse-review">
            <div>
              <h3>原文</h3>
              <pre className="source-text">{review.text}</pre>
            </div>
            <div>
              <h3>字段建议</h3>
              {!!review.ambiguous.length && (
                <p className="notice" role="status">
                  以下经历无法唯一匹配，未自动预填。请使用下方“手动映射原文到字段”核对归属：
                  {review.ambiguous.join("；")}
                </p>
              )}
              {review.suggestions.length ? (
                review.suggestions.map((suggestion, index) => (
                  <div
                    className={`suggestion ${suggestion.previous ? "conflict" : ""}`}
                    key={suggestion.path}
                  >
                    <strong>{suggestion.label}</strong>
                    <p>{suggestion.value}</p>
                    <small>原文：{suggestion.evidence}</small>
                    {suggestion.previous && (
                      <p className="conflict-label">
                        档案原值：{suggestion.previous}
                      </p>
                    )}
                    <label className="field">
                      <span>处理方式</span>
                      <select
                        value={suggestion.choice}
                        onChange={(e) =>
                          setReview({
                            ...review,
                            suggestions: review.suggestions.map((s, i) =>
                              i === index
                                ? {
                                    ...s,
                                    choice: e.target
                                      .value as Suggestion["choice"],
                                  }
                                : s,
                            ),
                          })
                        }
                      >
                        <option value="pending">待确认</option>
                        <option value="keep">保留档案原值</option>
                        <option value="once">仅本次使用</option>
                        <option value="save">放入编辑区，保存后更新档案</option>
                      </select>
                    </label>
                  </div>
                ))
              ) : (
                <p className="muted">
                  没有可靠自动映射的字段。可以核对原文后手动选择字段。
                </p>
              )}
              <details>
                <summary>手动映射原文到字段</summary>
                <Field label="目标字段">
                  <select
                    value={manualPath}
                    onChange={(e) => setManualPath(e.target.value)}
                  >
                    {FIELD_GROUPS.flatMap((g) => {
                      const rows = g.repeat
                        ? Math.max((data[g.key] as Fields[]).length, 1)
                        : 1;
                      return Array.from({ length: rows }, (_, index) =>
                        g.fields.map((f) => (
                          <option
                            key={`${g.key}.${index}.${f.key}`}
                            value={`${g.key}.${g.repeat ? `${index}.` : ""}${f.key}`}
                          >
                            {g.label}
                            {g.repeat ? ` ${index + 1}` : ""} / {f.label}
                          </option>
                        )),
                      );
                    })}
                  </select>
                </Field>
                <Field label="已核对的文字">
                  <textarea
                    value={manualValue}
                    onChange={(e) => setManualValue(e.target.value)}
                  />
                </Field>
                <button
                  className="secondary"
                  disabled={!manualValue.trim()}
                  onClick={() => {
                    const previous = readField(data, manualPath);
                    setReview({
                      ...review,
                      suggestions: [
                        ...review.suggestions.filter(
                          (s) => s.path !== manualPath,
                        ),
                        {
                          path: manualPath,
                          label: manualPath,
                          value: manualValue,
                          evidence: "用户手动核对",
                          previous,
                          choice: previous ? "pending" : "save",
                        },
                      ],
                    });
                    setManualValue("");
                  }}
                >
                  加入待确认字段
                </button>
              </details>
            </div>
          </div>
        </Dialog>
      )}
      {history && (
        <Dialog
          wide
          title={`已保存版本 · ${formatDate(history.createdAt)}`}
          onCancel={() => setHistory(null)}
          actions={
            <button className="primary" onClick={() => setHistory(null)}>
              关闭
            </button>
          }
        >
          {renderData(history.data, true)}
        </Dialog>
      )}
      {selectionPreview && (
        <Dialog
          wide
          title="本次资料预览"
          onCancel={() => setSelectionPreview(false)}
          actions={
            <button
              className="primary"
              onClick={() => setSelectionPreview(false)}
            >
              关闭
            </button>
          }
        >
          <p>
            下列“仅本次”值随本次选择使用，不改变已保存档案；切换档案后清除。
          </p>
          {renderData(materializeSelection(data, once), true)}
        </Dialog>
      )}
    </div>
  );
}
