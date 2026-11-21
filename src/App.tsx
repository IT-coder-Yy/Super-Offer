import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { errorOf, loadWorkspace, request } from "./api";
import { ApplicationsPanel } from "./ApplicationsPanel";
import { ProfilePanel } from "./ProfilePanel";
import { ModelPanel } from "./ModelPanel";
import { BackupPanel } from "./BackupPanel";
import { BrowserPanel } from "./BrowserPanel";
import { ProjectsPanel } from "./ProjectsPanel";
import { InterviewPanel } from "./InterviewPanel";
import { Dialog } from "./ui";
import type { ProfileData, Workspace } from "./types";

const navigation = [
  {
    id: "applications",
    name: "投递看板",
    symbol: "▦",
    description: "记录每一次申请，安排下一步。",
  },
  {
    id: "profiles",
    name: "个人档案",
    symbol: "▤",
    description: "准备适合不同岗位的简历与资料。",
  },
  {
    id: "models",
    name: "AI 服务",
    symbol: "◇",
    description: "由你选择服务，掌握每一次调用。",
  },
  { id: "browser", name: "浏览器填写", symbol: "▣", description: "连接现有浏览器，核对每一步填写。" },
  { id: "projects", name: "项目材料", symbol: "⌘", description: "只读保存项目，为回答保留依据。" },
  { id: "interview", name: "文字面试", symbol: "◌", description: "围绕岗位和项目练习，按证据改进回答。" },
  {
    id: "backup",
    name: "数据备份",
    symbol: "↗",
    description: "把已保存的求职进度带在身边。",
  },
];
export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [failure, setFailure] = useState("");
  const [tab, setTab] = useState("applications");
  const [notice, setNotice] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [profileDirty, setProfileDirty] = useState(false);
  const [applicationDirty, setApplicationDirty] = useState(false);
  const [modelDirty, setModelDirty] = useState(false);
  const [browserDirty, setBrowserDirty] = useState(false);
  const [sourceDirty, setSourceDirty] = useState(false);
  const [interviewDirty, setInterviewDirty] = useState(false);
  const [profileSelection, setProfileSelection] = useState<{versionId: string; data: ProfileData} | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const workspaceRef = useRef<Workspace | null>(null);
  const reloadQueue = useRef<Promise<void>>(Promise.resolve());
  const notify = useCallback(
    (message: string, error = false) => setNotice({ message, error }),
    [],
  );
  const reload = useCallback(() => {
    const nextLoad = reloadQueue.current.then(async () => {
      const next = await loadWorkspace();
      if (
        workspaceRef.current &&
        workspaceRef.current.state.datasetId !== next.state.datasetId
      ) {
        setProfileDirty(false);
        setApplicationDirty(false);
        setModelDirty(false);
        setBrowserDirty(false);
        setSourceDirty(false);
        setInterviewDirty(false);
        setProfileSelection(null);
      }
      workspaceRef.current = next;
      setWorkspace(next);
      setFailure("");
      return next;
    });
    reloadQueue.current = nextLoad.then(
      () => {},
      () => {},
    );
    return nextLoad;
  }, []);
  useEffect(() => {
    void reload().catch((e) => setFailure(errorOf(e).message));
  }, [reload]);
  const hasUnsavedEdits = profileDirty || applicationDirty || modelDirty || browserDirty || sourceDirty || interviewDirty;
  const guarded = useRef(false);
  guarded.current =
    hasUnsavedEdits ||
    !!workspace && Object.values(workspace.activity).some(Boolean) ||
    !!workspace?.state.tasks.some((t) => t.status === "running");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void reload().catch((e) => notify(errorOf(e).message, true));
      }, 120);
    };
    const subscriptions = [
      listen("state-changed", schedule),
      listen("model-task-updated", schedule),
      listen("request-close", () => {
        if (guarded.current) setCloseOpen(true);
        else
          void request("exit", { confirmed: true }).catch((e) =>
            notify(errorOf(e).message, true),
          );
      }),
    ];
    for (const subscription of subscriptions)
      void subscription
        .then((unlisten) => {
          if (disposed) unlisten();
        })
        .catch(() => {});
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const subscription of subscriptions)
        void subscription.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [reload, notify]);
  const current = navigation.find((item) => item.id === tab)!;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <div>
            <strong>Super-Offer</strong>
            <small>求职工作台</small>
          </div>
        </div>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "active" : ""}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => setTab(item.id)}
            >
              <span aria-hidden="true">{item.symbol}</span>
              {item.name}
              {((item.id === "profiles" && profileDirty) ||
                (item.id === "applications" && applicationDirty) ||
                (item.id === "models" && modelDirty) ||
                (item.id === "browser" && browserDirty) ||
                (item.id === "projects" && sourceDirty) ||
                (item.id === "interview" && interviewDirty)) && (
                <i aria-label="有未保存编辑" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="local-dot" /> 本地保存<small>资料、投递与面试</small>
        </div>
      </aside>
      <main>
        <header className="page-header">
          <div>
            <h1>{current.name}</h1>
            <p>{current.description}</p>
          </div>
          <span className="workspace-label">我的求职空间</span>
        </header>
        {notice && (
          <div
            className={`toast ${notice.error ? "error" : ""}`}
            role={notice.error ? "alert" : "status"}
          >
            <span>{notice.message}</span>
            <button
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => setNotice(null)}
            >
              ×
            </button>
          </div>
        )}
        {failure ? (
          <div className="startup-error">
            <h2>无法打开本地工作区</h2>
            <p>{failure}</p>
            <button
              className="primary"
              onClick={() =>
                void request("exit", { confirmed: true }).catch((e) =>
                  setFailure(errorOf(e).message),
                )
              }
            >
              退出应用后重试
            </button>
          </div>
        ) : !workspace ? (
          <p className="loading" role="status">
            正在读取本地资料…
          </p>
        ) : (
          <div key={workspace.state.datasetId} className="pages">
            <section hidden={tab !== "applications"}>
              <ApplicationsPanel
                workspace={workspace}
                reload={reload}
                notify={notify}
                onDirty={setApplicationDirty}
              />
            </section>
            <section hidden={tab !== "profiles"}>
              <ProfilePanel
                workspace={workspace}
                reload={reload}
                notify={notify}
                onDirty={setProfileDirty}
                onSelection={setProfileSelection}
              />
            </section>
            <section hidden={tab !== "models"}>
              <ModelPanel
                workspace={workspace}
                reload={reload}
                notify={notify}
                onDirty={setModelDirty}
              />
            </section>
            <section hidden={tab !== "browser"}>
              <BrowserPanel workspace={workspace} reload={reload} notify={notify} onDirty={setBrowserDirty} profileSelection={profileSelection} />
            </section>
            <section hidden={tab !== "projects"}>
              <ProjectsPanel workspace={workspace} reload={reload} notify={notify} onDirty={setSourceDirty} />
            </section>
            <section hidden={tab !== "interview"}>
              <InterviewPanel workspace={workspace} reload={reload} notify={notify} onDirty={setInterviewDirty} />
            </section>
            <section hidden={tab !== "backup"}>
              <BackupPanel
                workspace={workspace}
                reload={reload}
                notify={notify}
                hasUnsavedEdits={hasUnsavedEdits}
              />
            </section>
          </div>
        )}
      </main>
      {closeOpen && (
        <Dialog
          title="退出前处理当前工作"
          onCancel={() => setCloseOpen(false)}
          actions={
            <>
              <button className="secondary" onClick={() => setCloseOpen(false)}>
                返回继续编辑
              </button>
              <button
                className="primary"
                onClick={() =>
                  void request("exit", { confirmed: true }).catch((e) =>
                    notify(errorOf(e).message, true),
                  )
                }
              >
                放弃未保存编辑并停止任务后退出
              </button>
            </>
          }
        >
          <p>
            未保存编辑会丢失。填写、项目导入和模型任务会停止，已经保存的回答与结果继续保留。
          </p>
        </Dialog>
      )}
    </div>
  );
}
