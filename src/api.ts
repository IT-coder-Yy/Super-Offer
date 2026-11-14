import { invoke } from "@tauri-apps/api/core";
import type { AppError, Snapshot, Workspace } from "./types";

export function request<T>(
  kind: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  return invoke<T>("request", { request: { kind, ...data } });
}
export function mutate<T = Record<string, string>>(
  state: Snapshot,
  mutation: Record<string, unknown>,
  operationId = crypto.randomUUID(),
): Promise<T> {
  return request<T>("mutate", {
    datasetId: state.datasetId,
    operationId,
    mutation,
  });
}
export const loadWorkspace = () => request<Workspace>("snapshot");
export function errorOf(error: unknown): AppError {
  if (
    typeof error === "object" &&
    error &&
    "code" in error &&
    "message" in error
  )
    return error as AppError;
  return {
    code: "CONNECTION_FAILED",
    message: "无法连接本地应用，请重新打开 Super-Offer 后重试。",
  };
}
export async function fileBytes(file: File, max: number): Promise<number[]> {
  if (!file.size || file.size > max)
    throw {
      code: "INPUT_INVALID",
      message: `文件须为非空文件，最大 ${max / 1024 / 1024} MB。`,
    };
  return Array.from(new Uint8Array(await file.arrayBuffer()));
}
