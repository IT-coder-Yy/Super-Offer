import {
  STAGES,
  type Application,
  type Snapshot,
  type Stage,
} from "./types.ts";
export interface Filters {
  query: string;
  stage: string;
  dateField: "createdAt" | "confirmedSubmittedAt";
  from: string;
  to: string;
}
export function filterApplications(
  state: Snapshot,
  filters: Filters,
): Application[] {
  return state.applications.filter((application) => {
    const job = state.jobs.find(
      (j) => j.id === application.jobSnapshotId,
    )?.data;
    if (filters.stage && application.stage !== filters.stage) return false;
    if (
      filters.query &&
      ![job?.company, job?.title, job?.channel, job?.batch, job?.jobCode]
        .join(" ")
        .toLocaleLowerCase()
        .includes(filters.query.toLocaleLowerCase())
    )
      return false;
    const stamp = application[filters.dateField];
    if (filters.from || filters.to) {
      if (!stamp) return false;
      // 过滤以用户本地日历日为边界，避免 UTC 截断改变跨日申请归属。
      const day = new Date(stamp);
      if (filters.from && day < new Date(`${filters.from}T00:00:00`))
        return false;
      if (filters.to) {
        const end = new Date(`${filters.to}T00:00:00`);
        end.setDate(end.getDate() + 1);
        if (day >= end) return false;
      }
    }
    return true;
  });
}
export function stageCounts(
  applications: Application[],
): Record<Stage, number> {
  const counts = Object.fromEntries(
    Object.keys(STAGES).map((stage) => [stage, 0]),
  ) as Record<Stage, number>;
  for (const application of applications) counts[application.stage]++;
  return counts;
}
