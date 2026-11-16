export type Fields = Record<string, string>;
export interface ProfileData {
  basic: Fields;
  education: Fields[];
  experience: Fields[];
  projects: Fields[];
  skills: Fields;
  certificates: Fields[];
  intentions: Fields;
  answers: Fields[];
  resumeAssetId: string | null;
}
export interface ProfileVersion {
  id: string;
  profileId: string;
  createdAt: string;
  data: ProfileData;
}
export interface Profile {
  id: string;
  name: string;
  currentVersionId: string;
  versions: ProfileVersion[];
}
export type Stage =
  | "saved"
  | "pending"
  | "applied"
  | "assessment"
  | "interview"
  | "offer"
  | "closed";
export type EndReason = "rejected" | "withdrawn" | "joined";
export interface JobData {
  company: string;
  title: string;
  channel: string;
  batch: string;
  jobCode: string;
  url: string;
  jd: string;
}
export interface JobSnapshot {
  id: string;
  createdAt: string;
  data: JobData;
}
export interface Application {
  id: string;
  jobSnapshotId: string;
  profileVersionId: string | null;
  stage: Stage;
  endReason: EndReason | null;
  confirmedSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  nextAction: string;
  dueAt: string | null;
  notes: string;
}
export interface ApplicationEvent {
  id: string;
  applicationId: string;
  operationId: string;
  kind: string;
  occurredAt: string;
  recordedAt: string;
  source: string;
  jobSnapshotId: string;
  profileVersionId: string | null;
  detail: Record<string, unknown>;
}
export interface InterviewRound {
  id: string;
  applicationId: string;
  title: string;
  scheduledAt: string;
  location: string;
  notes: string;
  completed: boolean;
}
export interface FileAsset {
  id: string;
  kind: "resume" | "audio" | "source";
  name: string;
  sha256: string;
  bytes: number;
  status: "available" | "missing" | "cleaned" | "excluded_by_user";
  createdAt: string;
}
export type Purpose = "chat" | "asr";
export interface Provider {
  purpose: Purpose;
  name: string;
  endpoint: string;
  model: string;
  version: string;
}
export interface AppError {
  code: string;
  message: string;
}
export interface TaskInput {
  purpose: Purpose;
  contextId: string;
  text: string;
  assetId: string | null;
  stream: boolean;
  versions: { kind: string; id: string }[];
}
export interface ModelTask {
  id: string;
  contextId: string;
  generation: string;
  datasetId: string;
  purpose: Purpose;
  provider: Provider;
  input: TaskInput;
  versions: { kind: string; id: string }[];
  status: string;
  progress: string;
  content: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    audioSeconds: number | null;
    cost: number | null;
  };
  error: AppError | null;
  startedAt: string;
  updatedAt: string;
}
export interface Snapshot {
  contractVersion: number;
  schemaVersion: number;
  datasetId: string;
  revision: number;
  profiles: Profile[];
  jobs: JobSnapshot[];
  applications: Application[];
  events: ApplicationEvent[];
  interviews: InterviewRound[];
  assets: FileAsset[];
  providers: Provider[];
  tasks: ModelTask[];
}
export interface Workspace {
  state: Snapshot;
  providerStatus: {
    purpose: Purpose;
    hasKey: boolean;
    error: AppError | null;
  }[];
  dataDirectory: string;
}
export interface Manifest {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  createdAt: string;
  counts: Record<string, number>;
  files: { path: string; bytes: number; sha256: string }[];
  assets: FileAsset[];
}
export interface BackupReceipt {
  id: string;
  path: string;
  manifest: Manifest;
}
export interface RestorePreview {
  token: string;
  manifest: Manifest;
  currentCounts: Record<string, number>;
  currentDatasetId: string;
  currentRevision: number;
}
export const STAGES: Record<Stage, string> = {
  saved: "收藏",
  pending: "待投递",
  applied: "已投递",
  assessment: "笔试",
  interview: "面试",
  offer: "Offer",
  closed: "已结束",
};
export const END_REASONS: Record<EndReason, string> = {
  rejected: "拒绝",
  withdrawn: "主动撤回",
  joined: "已入职",
};
export const emptyProfile = (): ProfileData => ({
  basic: {},
  education: [],
  experience: [],
  projects: [],
  skills: {},
  certificates: [],
  intentions: {},
  answers: [],
  resumeAssetId: null,
});
export const emptyJob = (): JobData => ({
  company: "",
  title: "",
  channel: "",
  batch: "",
  jobCode: "",
  url: "",
  jd: "",
});
