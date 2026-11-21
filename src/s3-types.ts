import type { AppError, Provider, Workspace } from "./types";

export interface S3PanelProps {
  workspace: Workspace;
  reload: () => Promise<Workspace>;
  notify: (message: string, error?: boolean) => void;
  onDirty: (dirty: boolean) => void;
}
export interface SourceVersion {
  id: string;
  projectId: string;
  name: string;
  assetId: string;
  createdAt: string;
  readableFiles: number;
  totalFiles: number;
  sourceBytes: number;
  scopeVersion: string;
  allowedPaths: string[];
  scopeHistory: { id: string; paths: string[] }[];
}
export interface SourceFile {
  id: string;
  sourceVersionId: string;
  path: string;
  status: "readable" | "excluded" | "failed";
  reason: string;
  bytes: number;
  sha256: string;
  lines: number;
}
export interface Evidence {
  id: string;
  sourceVersionId: string;
  path: string;
  fileSha256: string;
  startLine: number;
  endLine: number;
  text: string;
  sha256: string;
}
export interface SearchHit { evidence: Evidence; score: number; allowed: boolean }
export interface Selection { token: string; name: string; isDirectory: boolean }
export interface SourceList {
  versions: SourceVersion[];
  limits: { files: number; fileBytes: number; totalBytes: number; encoding: string };
}
export interface SourceChoice { versionId: string; scopeVersion: string }
export interface Answer { id: string; text: string; disposition: string; savedAt: string }
export interface Turn {
  id: string;
  mainNumber: number;
  followUp: number;
  question: string;
  evidenceIds: string[];
  answer: Answer | null;
  closed: boolean;
}
export interface Pending {
  kind: "question" | "follow_up" | "feedback" | "final_report";
  taskId: string | null;
  generation: string;
  evidenceIds: string[];
}
export interface ConfirmedResume { assetId: string; text: string }
export interface ReportCorrection {
  id: string;
  reportId: string;
  pointIndex: number;
  text: string;
  evidenceIds: string[];
  createdAt: string;
}
export interface ResumePreview {
  profileId: string;
  profileVersionId: string;
  assetId: string;
  name: string;
  bytes: number[];
}
export interface InterviewSession {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  applicationId: string | null;
  profileVersionId: string | null;
  confirmedResume: ConfirmedResume | null;
  jobSnapshotId: string | null;
  sources: SourceChoice[];
  contribution: string;
  role: string;
  stage: string;
  focus: string;
  mode: "practice" | "simulation";
  questionCount: number;
  provider: Provider;
  status: "ready" | "generating" | "waiting_answer" | "paused" | "completed";
  draft: string;
  turns: Turn[];
  pending: Pending | null;
  reportIds: string[];
  finished: boolean;
  partial: string;
  error: AppError | null;
  repracticeOf: string | null;
  reportCorrections?: ReportCorrection[];
}
export interface FeedbackPoint {
  category: "strength" | "not_mentioned" | "incorrect" | "material_gap" | "expression";
  basis: "source_fact" | "user_statement" | "inference" | "knowledge";
  turnId?: string | null;
  answerQuote: string;
  observation: string;
  action: string;
  evidenceIds: string[];
}
export interface InterviewReport {
  id: string;
  sessionId: string;
  createdAt: string;
  mainNumber: number | null;
  taskId: string;
  evidenceIds: string[];
  content: {
    summary: string;
    referenceAnswer: string;
    points: FeedbackPoint[];
    weaknesses: { title: string; practicePrompt: string; evidenceIds: string[]; pointIndex?: number | null }[];
  };
}
export interface SessionView {
  session: InterviewSession;
  reports: InterviewReport[];
  reportEvidence: Record<string, Evidence[]>;
}
export interface SessionSummary {
  id: string;
  role: string;
  mode: string;
  stage: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  finished: boolean;
  applicationId: string | null;
}

export function evidenceTimingLabel(
  turns: readonly Turn[],
  report: Pick<InterviewReport, "mainNumber">,
  point: Pick<FeedbackPoint, "turnId" | "answerQuote">,
  evidenceId: string,
): string {
  const candidates = turns.filter((turn) =>
    (report.mainNumber === null || turn.mainNumber === report.mainNumber)
    && (point.turnId == null || turn.id === point.turnId)
    && (!point.answerQuote || turn.answer?.text.includes(point.answerQuote)),
  );
  if (!candidates.length) return "具体题目未定位，无法确认是否随题提供";
  const given = candidates.filter((turn) => turn.evidenceIds.includes(evidenceId)).length;
  if (given === candidates.length) return candidates.length === 1
    ? "答题时已给的材料" : "答题时已给的材料（所有可能题均提供）";
  if (given === 0) return candidates.length === 1
    ? "补充材料（本题作答时未提供）" : "补充材料（所有可能题作答时均未提供）";
  return "具体题目未定位（仅部分可能题提供过此材料）";
}
