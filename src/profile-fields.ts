import { emptyProfile, type Fields, type ProfileData } from "./types.ts";

export interface FieldDefinition {
  key: string;
  label: string;
  multiline?: boolean;
  placeholder?: string;
}
export interface FieldGroup {
  key: keyof Omit<ProfileData, "resumeAssetId">;
  label: string;
  repeat: boolean;
  fields: FieldDefinition[];
}
const f = (
  key: string,
  label: string,
  multiline = false,
  placeholder = "",
): FieldDefinition => ({ key, label, multiline, placeholder });
export const FIELD_GROUPS: FieldGroup[] = [
  {
    key: "basic",
    label: "基本信息",
    repeat: false,
    fields: [
      f("name", "姓名"),
      f("phone", "手机"),
      f("email", "邮箱"),
      f("city", "现居城市"),
      f("hometown", "籍贯"),
      f("birthDate", "出生日期", false, "YYYY-MM-DD，可留空"),
      f("gender", "性别"),
      f("politicalStatus", "政治面貌"),
      f("website", "个人主页"),
      f("github", "GitHub"),
    ],
  },
  {
    key: "education",
    label: "教育经历",
    repeat: true,
    fields: [
      f("school", "学校"),
      f("major", "专业"),
      f("degree", "学历"),
      f("startDate", "开始时间", false, "YYYY-MM"),
      f("endDate", "结束时间", false, "YYYY-MM；在读可留空"),
      f("gpa", "成绩 / GPA"),
      f("ranking", "排名"),
      f("courses", "相关课程", true),
      f("description", "校园经历", true),
    ],
  },
  {
    key: "experience",
    label: "工作与实习",
    repeat: true,
    fields: [
      f("company", "公司"),
      f("title", "岗位"),
      f("type", "经历类型", false, "实习 / 全职"),
      f("startDate", "开始时间", false, "YYYY-MM"),
      f("endDate", "结束时间", false, "YYYY-MM；在职可留空"),
      f("responsibilities", "职责", true),
      f("achievements", "成果", true),
    ],
  },
  {
    key: "projects",
    label: "项目经历",
    repeat: true,
    fields: [
      f("name", "项目名称"),
      f("role", "项目角色"),
      f("startDate", "开始时间", false, "YYYY-MM"),
      f("endDate", "结束时间", false, "YYYY-MM"),
      f("technology", "技术栈"),
      f("url", "项目链接"),
      f("description", "项目介绍", true),
      f("contribution", "个人贡献", true),
      f("results", "项目成果", true),
    ],
  },
  {
    key: "skills",
    label: "技能与语言",
    repeat: false,
    fields: [
      f("technical", "技术技能", true),
      f("languages", "语言能力", true),
    ],
  },
  {
    key: "certificates",
    label: "证书与奖励",
    repeat: true,
    fields: [
      f("name", "证书 / 奖励"),
      f("issuer", "颁发机构"),
      f("date", "获得时间", false, "YYYY-MM"),
      f("description", "说明", true),
    ],
  },
  {
    key: "intentions",
    label: "求职意向",
    repeat: false,
    fields: [
      f("roles", "目标岗位"),
      f("cities", "目标城市"),
      f("availableFrom", "到岗时间"),
      f("duration", "实习时长"),
      f("salary", "期望薪资"),
      f("employmentType", "求职类型"),
    ],
  },
  {
    key: "answers",
    label: "自定义问答",
    repeat: true,
    fields: [f("question", "题目", true), f("answer", "回答", true)],
  },
];
export interface Suggestion {
  path: string;
  label: string;
  value: string;
  evidence: string;
  previous: string;
  choice: "pending" | "keep" | "save" | "once";
}
export function sameProfileData(a: ProfileData, b: ProfileData): boolean {
  const ordered = (_key: string, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value;
  return JSON.stringify(a, ordered) === JSON.stringify(b, ordered);
}
export function readField(data: ProfileData, path: string): string {
  const [group, index, field] = path.split(".");
  const value = data[group as keyof ProfileData];
  return Array.isArray(value)
    ? (value[Number(index)]?.[field] ?? "")
    : typeof value === "object" && value
      ? (value[index] ?? "")
      : "";
}
export function writeField(
  data: ProfileData,
  path: string,
  value: string,
): ProfileData {
  const result = structuredClone(data);
  const [groupKey, index, field] = path.split(".");
  const group = FIELD_GROUPS.find((g) => g.key === groupKey);
  if (
    !group ||
    !group.fields.some((f) => f.key === (group.repeat ? field : index))
  )
    throw new Error("未知档案字段");
  const target = result[group.key];
  if (group.repeat && Array.isArray(target)) {
    const row = Number(index);
    if (!Number.isInteger(row) || row < 0 || row >= 200)
      throw new Error("条目标识无效");
    while (target.length <= row) target.push({});
    target[row][field] = value;
  } else if (!Array.isArray(target)) target[index] = value;
  return result;
}
export function applySuggestions(data: ProfileData, suggestions: Suggestion[]) {
  let saved = structuredClone(data);
  const once: Fields = {};
  for (const suggestion of suggestions) {
    if (suggestion.choice === "save")
      saved = writeField(saved, suggestion.path, suggestion.value);
    if (suggestion.choice === "once") once[suggestion.path] = suggestion.value;
  }
  return {
    saved,
    once,
    pending: suggestions.filter((s) => s.choice === "pending"),
  };
}
export function materializeSelection(
  data: ProfileData,
  overrides: Fields,
): ProfileData {
  return Object.entries(overrides).reduce(
    (current, [path, value]) => writeField(current, path, value),
    structuredClone(data),
  );
}
export function parseSuggestions(
  text: string,
  existing: ProfileData = emptyProfile(),
  onAmbiguous?: (entry: string) => void,
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  let group = FIELD_GROUPS[0];
  let row = 0;
  let entry: { field: FieldDefinition; value: string; evidence: string }[] = [];
  const nextRows: Record<string, number> = {};
  const add = (
    g: FieldGroup,
    field: FieldDefinition,
    value: string,
    evidence: string,
  ) => {
    if (!value.trim()) return;
    const path = `${g.key}.${g.repeat ? `${row}.` : ""}${field.key}`;
    if (suggestions.some((s) => s.path === path)) return;
    const previous = readField(existing, path);
    if (previous === value.trim()) return;
    suggestions.push({
      path,
      label: `${g.label}${g.repeat ? ` ${row + 1}` : ""} · ${field.label}`,
      value: value.trim(),
      evidence,
      previous,
      choice: previous ? "pending" : "save",
    });
  };
  const flush = () => {
    if (!entry.length) return;
    const fields = Object.fromEntries(
      entry.map((item) => [item.field.key, item.value]),
    );
    const firstKey = group.fields[0].key;
    const rows = existing[group.key] as Fields[];
    let matches = rows
      .map((value, index) => ({ value, index }))
      .filter(
        ({ value }) => fields[firstKey] && value[firstKey] === fields[firstKey],
      );
    if (matches.length > 1) {
      const identity = [
        "degree", "major", "title", "type", "role", "startDate", "url", "issuer", "date",
      ];
      matches = matches.filter(({ value }) =>
        identity.every(
          (key) => !fields[key] || !value[key] || fields[key] === value[key],
        ),
      );
      if (matches.length !== 1) {
        onAmbiguous?.(`${group.label}：${fields[firstKey]}`);
        entry = [];
        return;
      }
    }
    if (!fields[firstKey]) {
      onAmbiguous?.(`${group.label}：缺少${group.fields[0].label}`);
    } else {
      row = matches[0]?.index ?? (nextRows[group.key] ?? rows.length);
      if (!matches.length) nextRows[group.key] = row + 1;
      for (const item of entry) add(group, item.field, item.value, item.evidence);
    }
    entry = [];
  };
  const aliases: Record<string, string> = {
    教育背景: "education",
    教育经历: "education",
    工作经历: "experience",
    实习经历: "experience",
    工作与实习: "experience",
    项目经历: "projects",
    项目经验: "projects",
    专业技能: "skills",
    技能与语言: "skills",
    技能: "skills",
    证书与奖励: "certificates",
    证书: "certificates",
    求职意向: "intentions",
    自定义问答: "answers",
    基本信息: "basic",
  };
  for (const original of text.split(/\r?\n/)) {
    const line = original.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = aliases[line.replace(/[：:]$/, "")];
    if (heading) {
      flush();
      group = FIELD_GROUPS.find((g) => g.key === heading)!;
      continue;
    }
    const pieces = line.split(/[；;|｜]/).map((p) => p.trim());
    for (const piece of pieces) {
      const match = piece.match(/^([^：:]{1,20})[：:]\s*(.+)$/);
      if (!match) continue;
      const key = match[1].trim();
      const value = match[2].trim();
      const field = group.fields.find(
        (f) =>
          f.label === key ||
          f.label.split(" / ").includes(key) ||
          (key === "电话" && f.key === "phone") ||
          (key === "技术" && f.key === "technology"),
      );
      if (!field) continue;
      if (group.repeat) {
        if (
          field === group.fields[0] &&
          entry.some((item) => item.field === field)
        ) flush();
        entry.push({ field, value, evidence: original });
      } else add(group, field, value, original);
    }
  }
  flush();
  const basic = FIELD_GROUPS[0];
  for (const [key, regex] of [
    ["email", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
    ["phone", /(?<!\d)1[3-9]\d{9}(?!\d)/g],
  ] as const) {
    const matches = [...new Set(text.match(regex) ?? [])];
    if (matches.length === 1)
      add(
        basic,
        basic.fields.find((f) => f.key === key)!,
        matches[0],
        text.split(/\r?\n/).find((l) => l.includes(matches[0])) ?? matches[0],
      );
  }
  return suggestions;
}
export function missingGroups(data: ProfileData): string[] {
  return FIELD_GROUPS.filter((group) => {
    const value = data[group.key];
    return Array.isArray(value)
      ? !value.some((row) => Object.values(row).some((v) => v.trim()))
      : !Object.values(value).some((v) => v.trim());
  }).map((group) => group.label);
}

export function shiftOverridesAfterRemoval(
  overrides: Fields,
  group: string,
  index: number,
): Fields {
  return Object.fromEntries(
    Object.entries(overrides).flatMap(([path, value]) => {
      const [owner, row, field] = path.split(".");
      if (owner !== group) return [[path, value]];
      const current = Number(row);
      return current === index
        ? []
        : [
            [
              `${owner}.${current > index ? current - 1 : current}.${field}`,
              value,
            ],
          ];
    }),
  );
}
