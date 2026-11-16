import { useState } from "react";
import { errorOf, fileBytes, request } from "./api";
import type { BackupReceipt, RestorePreview, Workspace } from "./types";
import { Dialog, Field, formatDate, bytesLabel } from "./ui";

interface Props {
  workspace: Workspace;
  reload: () => Promise<Workspace>;
  notify: (message: string, error?: boolean) => void;
  hasUnsavedEdits: boolean;
}
const countNames: Record<string, string> = {
  profiles: "个人档案",
  profile_versions: "档案版本",
  jobs: "岗位快照",
  applications: "申请",
  events: "时间线事件",
  interviews: "面试轮次",
  assets: "材料副本",
  providers: "服务配置",
  tasks: "模型任务",
  operations: "已保存操作",
};
export function BackupPanel({
  workspace,
  reload,
  notify,
  hasUnsavedEdits,
}: Props) {
  const [audio, setAudio] = useState(false);
  const [receipt, setReceipt] = useState<BackupReceipt | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [licenses, setLicenses] = useState<string | null>(null);
  const running = workspace.state.tasks.some((t) => t.status === "running");
  async function cancelPreview() {
    try {
      await request("restore_cancel");
      setPreview(null);
    } catch (e) {
      notify(errorOf(e).message, true);
    }
  }
  return (
    <div className="backup-page">
      <details className="settings-section">
        <summary>第三方许可</summary>
        <p className="muted">查看本版本随包保留的组件来源与许可全文。</p>
        <button
          className="secondary"
          onClick={async () => {
            try {
              const response = await fetch("/third-party-notices.txt");
              if (!response.ok) throw Error();
              setLicenses(await response.text());
            } catch {
              notify("无法读取随包许可，请检查应用文件。", true);
            }
          }}
        >
          查看第三方许可
        </button>
      </details>
      {licenses && (
        <Dialog
          wide
          title="第三方许可全文"
          onCancel={() => setLicenses(null)}
          actions={
            <button className="primary" onClick={() => setLicenses(null)}>
              关闭
            </button>
          }
        >
          <textarea
            className="source-text license-text"
            aria-label="第三方许可全文内容"
            value={licenses}
            readOnly
            wrap="off"
            spellCheck={false}
          />
        </Dialog>
      )}
      <section className="settings-section">
        <h2>导出本地备份</h2>
        <p className="muted">
          包含已保存的档案、简历副本、申请、面试轮次、任务结果及非秘密配置。API
          Key 与浏览器登录状态不包含在内。
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={audio}
            onChange={(e) => setAudio(e.target.checked)}
          />
          包含已导入的测试音频副本
        </label>
        {hasUnsavedEdits && (
          <p className="notice">有未保存编辑。备份仅包含已保存版本。</p>
        )}
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await request<BackupReceipt>("backup_create", {
                includeAudio: audio,
                includeSource: false,
              });
              setReceipt(result);
              notify("备份已生成并通过完整性校验。");
            } catch (e) {
              notify(errorOf(e).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          生成备份
        </button>
        {receipt && (
          <div className="backup-receipt">
            <strong>
              备份已就绪 · {formatDate(receipt.manifest.createdAt)}
            </strong>
            <p className="path">{receipt.path}</p>
            <button
              className="secondary"
              onClick={async () => {
                try {
                  const result = await request<{ saved: boolean }>(
                    "backup_save_as",
                    { backupId: receipt.id },
                  );
                  if (result.saved) notify("备份已保存到所选位置。");
                } catch (e) {
                  notify(errorOf(e).message, true);
                }
              }}
            >
              另存到其他位置
            </button>
          </div>
        )}
      </section>
      <section className="settings-section">
        <h2>从备份整体恢复</h2>
        <p className="muted">
          先选择文件核对范围，确认后会自动备份当前数据，再替换为备份中的内容。两套数据不会合并。
        </p>
        {(hasUnsavedEdits || running) && (
          <p className="notice">
            {hasUnsavedEdits ? "请先保存或放弃未保存编辑。" : ""}
            {running ? "请先停止正在运行的模型任务。" : ""}
          </p>
        )}
        <Field label="选择 Super-Offer 备份">
          <input
            type="file"
            accept=".superoffer"
            disabled={busy || hasUnsavedEdits || running}
            onChange={async (e) => {
              const input = e.currentTarget;
              const file = input.files?.[0];
              if (!file) return;
              setBusy(true);
              try {
                const result = await request<RestorePreview>(
                  "restore_preview",
                  { bytes: await fileBytes(file, 256 * 1024 * 1024) },
                );
                setPreview(result);
                setConfirmed(false);
              } catch (error) {
                notify(errorOf(error).message, true);
              } finally {
                input.value = "";
                setBusy(false);
              }
            }}
          />
        </Field>
      </section>
      <section className="settings-section">
        <h2>本机资料目录</h2>
        <p className="path">{workspace.dataDirectory}</p>
        <p className="muted">
          导入文件保留应用副本，不修改原件。恢复后需重新填写
          Key；旧数据集与自动备份继续保留，便于回退。
        </p>
      </section>
      {preview && (
        <Dialog
          wide
          title="核对整体恢复范围"
          onCancel={() => {
            if (!busy) void cancelPreview();
          }}
          actions={
            <>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void cancelPreview()}
              >
                取消恢复
              </button>
              <button
                className="primary"
                disabled={busy || !confirmed || hasUnsavedEdits || running}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await request<{
                      previousBackup: BackupReceipt;
                    }>("restore_commit", {
                      token: preview.token,
                      confirmed,
                      hasUnsavedEdits,
                    });
                    setPreview(null);
                    await reload();
                    notify(
                      `恢复完成。恢复前备份：${result.previousBackup.path}`,
                    );
                  } catch (e) {
                    setPreview(null);
                    notify(errorOf(e).message, true);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "正在备份并恢复…" : "先备份当前数据并整体恢复"}
              </button>
            </>
          }
        >
          <p>
            备份时间：{formatDate(preview.manifest.createdAt)} · 格式 v
            {preview.manifest.formatVersion} · 数据版本 v
            {preview.manifest.schemaVersion}
          </p>
          <table>
            <thead>
              <tr>
                <th>对象</th>
                <th>当前数量</th>
                <th>恢复后数量</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(preview.manifest.counts).map(([name, count]) => (
                <tr key={name}>
                  <td>{countNames[name] ?? name}</td>
                  <td>{preview.currentCounts[name] ?? 0}</td>
                  <td>{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>文件范围</h3>
          {preview.manifest.assets.length ? (
            <ul className="asset-list">
              {preview.manifest.assets.map((asset) => (
                <li key={asset.id}>
                  <strong>{asset.name}</strong>
                  <span>
                    {bytesLabel(asset.bytes)} ·{" "}
                    {
                      {
                        available: "包含并已校验",
                        missing: "副本缺失",
                        cleaned: "已清理",
                        excluded_by_user: "导出时未包含",
                      }[asset.status]
                    }
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">此备份没有材料副本。</p>
          )}
          <p className="notice">
            Key
            不会恢复。当前数据中未出现在备份里的内容，将不在恢复后的工作区显示。
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我已核对范围，确认整体替换当前工作区
          </label>
        </Dialog>
      )}
    </div>
  );
}
