import type { ProfileData } from "./types";
export interface BrowserTarget {
  id: string;
  title: string;
  url: string;
}
export interface BrowserFieldResult {
  fieldId: string;
  label: string;
  actual: string;
  status: string;
  reason: string;
  path?: string | null;
  documentId?: string | null;
  url?: string;
}
export interface BrowserState {
  connected: boolean;
  targetId: string | null;
  documentId: string | null;
  generation: string;
  runId: string | null;
  status: string;
  message: string;
  url: string;
  profileVersionId: string | null;
  profileName: string;
  results: BrowserFieldResult[];
  pending: number;
}
export interface FillRun {
  id: string;
  datasetId: string;
  profileVersionId: string;
  applicationId: string | null;
  selection: ProfileData;
  createdAt: string;
  updatedAt: string;
  state: BrowserState;
}
export interface BrowserStatus {
  state: BrowserState;
  run: FillRun | null;
  history: Pick<
    FillRun,
    "id" | "createdAt" | "profileVersionId" | "applicationId" | "state"
  >[];
}
export interface BrowserField {
  id: string;
  label: string;
  section: string;
  type: string;
  resumeUpload?: boolean;
  value: string;
  path: string | null;
  options: { value: string; label: string }[];
  required: boolean;
  disabled: boolean;
  touched: boolean;
}
