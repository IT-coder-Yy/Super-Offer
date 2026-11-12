import test from "node:test";
import assert from "node:assert/strict";
import mammoth from "mammoth";
import { docx } from "./fixtures.mjs";
import { emptyProfile, type Application, type Snapshot } from "../src/types.ts";
import {
  FIELD_GROUPS,
  applySuggestions,
  materializeSelection,
  missingGroups,
  parseSuggestions,
  sameProfileData,
  shiftOverridesAfterRemoval,
  writeField,
} from "../src/profile-fields.ts";
import { filterApplications, stageCounts } from "../src/dashboard.ts";

test("字段覆盖、标签提取和多条经历；没有依据的姓名与经历不生成", () => {
  assert.deepEqual(
    FIELD_GROUPS.map((g) => g.key),
    [
      "basic",
      "education",
      "experience",
      "projects",
      "skills",
      "certificates",
      "intentions",
      "answers",
    ],
  );
  const text =
    "姓名：合成求职者\n手机：13800000000\n邮箱：sample@example.test\n教育经历\n学校：样本大学；专业：计算机；开始时间：2022-09；结束时间：2026-06\n\n学校：另一所大学；专业：软件工程\n工作与实习\n公司：样本公司；岗位：研发实习\n项目经历\n项目名称：合成项目；个人贡献：仅供测试\n技能\n技术技能：TypeScript\n证书\n证书：合成证书\n求职意向\n目标岗位：AI 开发\n自定义问答\n题目：为什么选择我们？；回答：合成回答";
  const suggestions = parseSuggestions(text);
  const result = applySuggestions(emptyProfile(), suggestions);
  assert.equal(result.saved.basic.name, "合成求职者");
  assert.equal(result.saved.education.length, 2);
  assert.equal(result.saved.education[1].school, "另一所大学");
  assert.equal(result.saved.experience[0].company, "样本公司");
  assert.equal(result.saved.answers[0].answer, "合成回答");
  assert.equal(result.saved.projects[0].contribution, "仅供测试");
  assert.equal(parseSuggestions("这是没有字段标签的自我介绍。").length, 0);
  assert.equal(
    parseSuggestions("联系 a@example.test 或 b@example.test").length,
    0,
  );
});

test("日期冲突仅本次使用、待确认、保留与保存相互独立", () => {
  let original = writeField(emptyProfile(), "education.0.school", "样本大学");
  original = writeField(original, "education.0.startDate", "2021-09");
  original = writeField(original, "education.0.endDate", "2025-06");
  const suggestions = parseSuggestions(
    "教育经历\n学校：样本大学；开始时间：2022-09；结束时间：2026-06；专业：计算机",
    original,
  );
  assert.equal(
    suggestions.find((s) => s.path.endsWith("startDate"))?.choice,
    "pending",
  );
  suggestions.find((s) => s.path.endsWith("startDate"))!.choice = "once";
  const result = applySuggestions(original, suggestions);
  assert.equal(result.saved.education[0].startDate, "2021-09");
  assert.equal(result.saved.education[0].major, "计算机");
  assert.equal(result.pending.length, 1);
  assert.equal(
    materializeSelection(result.saved, result.once).education[0].startDate,
    "2022-09",
  );
  result.pending[0].choice = "keep";
  assert.equal(
    applySuggestions(result.saved, result.pending).saved.education[0].endDate,
    "2025-06",
  );
  result.pending[0].choice = "save";
  assert.equal(
    applySuggestions(result.saved, result.pending).saved.education[0].endDate,
    "2026-06",
  );
  assert.equal(original.education[0].major, undefined);
});

test("同校本科和硕士按完整经历匹配，修改结束时间不覆盖本科", () => {
  const original = emptyProfile();
  original.education = [
    { school: "同一大学", degree: "本科", startDate: "2018-09", endDate: "2022-06" },
    { school: "同一大学", degree: "硕士", startDate: "2022-09", endDate: "2025-06" },
  ];
  const suggestions = parseSuggestions(
    "教育经历\n学校：同一大学；学历：本科；开始时间：2018-09；结束时间：2022-06\n学校：同一大学\n学历：硕士\n开始时间：2022-09\n结束时间：2026-06",
    original,
  );
  assert.deepEqual(suggestions.map((s) => s.path), ["education.1.endDate"]);
  const result = applySuggestions(original, suggestions.map((s) => ({ ...s, choice: "save" })));
  assert.deepEqual(result.saved.education[0], original.education[0]);
  assert.equal(result.saved.education[1].endDate, "2026-06");
});

test("单个同名候选也核对身份，新增硕士不会覆盖原本科", () => {
  const original = emptyProfile();
  original.education = [
    { school: "同一大学", degree: "本科", startDate: "2018-09", endDate: "2022-06" },
  ];
  const bachelor = "学校：同一大学；学历：本科；开始时间：2018-09；结束时间：2022-06";
  const master = "学校：同一大学；学历：硕士；开始时间：2022-09；结束时间：2026-06";
  for (const entries of [[bachelor, master], [master, bachelor], [master]]) {
    const ambiguous: string[] = [];
    const suggestions = parseSuggestions(
      ["教育经历", ...entries].join("\n"), original,
      (entry) => ambiguous.push(entry),
    );
    const after = applySuggestions(original, suggestions.map((s) => ({ ...s, choice: "save" }))).saved;
    assert.deepEqual(after.education[0], original.education[0]);
    assert.equal(after.education.length, 2);
    assert.equal(after.education[1].degree, "硕士");
    assert.equal(after.education[1].endDate, "2026-06");
    assert.deepEqual(ambiguous, []);
  }
});

test("本次导入已匹配的条目不再复用，即使首次匹配没有字段变更", () => {
  const original = emptyProfile();
  original.experience = [
    { company: "样本公司", title: "研发实习", startDate: "2023-01", endDate: "2023-06" },
  ];
  const suggestions = parseSuggestions(
    "工作经历\n公司：样本公司；岗位：研发实习；开始时间：2023-01；结束时间：2023-06\n公司：样本公司；岗位：研发实习；开始时间：2024-01；结束时间：2024-06",
    original,
  );
  const after = applySuggestions(original, suggestions.map((s) => ({ ...s, choice: "save" }))).saved;
  assert.deepEqual(after.experience[0], original.experience[0]);
  assert.equal(after.experience.length, 2);
  assert.equal(after.experience[1].startDate, "2024-01");
});

test("真实 DOCX 分段提取的空行不拆散经历，学校与章节仍划分条目", async () => {
  const { value: text } = await mammoth.extractRawText({ buffer: docx([
    "教育经历", "学校：样本大学", "学历：硕士", "开始时间：2026-09", "结束时间：2029-06",
    "学校：另一所大学", "学历：博士", "开始时间：2029-09", "结束时间：2033-06",
    "工作经历", "公司：样本公司", "岗位：研发实习",
  ]) });
  assert.match(text, /学校：样本大学\n\n学历：硕士/);
  const ambiguous: string[] = [];
  const suggestions = parseSuggestions(text, emptyProfile(), (entry) => ambiguous.push(entry));
  const after = applySuggestions(emptyProfile(), suggestions).saved;
  assert.deepEqual(after.education, [
    { school: "样本大学", degree: "硕士", startDate: "2026-09", endDate: "2029-06" },
    { school: "另一所大学", degree: "博士", startDate: "2029-09", endDate: "2033-06" },
  ]);
  assert.deepEqual(after.experience, [{ company: "样本公司", title: "研发实习" }]);
  assert.deepEqual(ambiguous, []);
});

test("同公司不同岗位、同名项目按经历身份匹配", () => {
  const original = emptyProfile();
  original.experience = [
    { company: "样本公司", title: "前端", startDate: "2023-01", endDate: "2023-06" },
    { company: "样本公司", title: "后端", startDate: "2024-01", endDate: "2024-06" },
  ];
  original.projects = [
    { name: "项目", role: "开发", startDate: "2023-01", description: "第一期" },
    { name: "项目", role: "负责人", startDate: "2024-01", description: "第二期" },
  ];
  const suggestions = parseSuggestions(
    "工作经历\n公司：样本公司；岗位：后端；开始时间：2024-01；结束时间：2024-08\n项目经历\n项目名称：项目；项目角色：负责人；开始时间：2024-01；项目介绍：第二期更新",
    original,
  );
  assert.deepEqual(suggestions.map((s) => s.path), ["experience.1.endDate", "projects.1.description"]);
});

test("经历归属不唯一时明确提示，不生成指向首条的建议", () => {
  const original = emptyProfile();
  original.education = [
    { school: "同一大学", degree: "本科", startDate: "2018-09" },
    { school: "同一大学", degree: "硕士", startDate: "2022-09" },
  ];
  for (const details of ["结束时间：2026-06", "学历：博士；开始时间：2025-09"]) {
    const ambiguous: string[] = [];
    const suggestions = parseSuggestions(`教育经历\n学校：同一大学；${details}\n基本信息\n姓名：合成求职者`, original, (entry) => ambiguous.push(entry));
    assert.deepEqual(ambiguous, ["教育经历：同一大学"]);
    assert.deepEqual(suggestions.map((s) => s.path), ["basic.name"]);
    assert.deepEqual(applySuggestions(original, suggestions).saved.education, original.education);
  }
});

test("连续导入时新选择替换同字段临时值，保留其他字段和待确认选择", () => {
  const data = writeField(emptyProfile(), "basic.phone", "13800000000");
  const overrides = { "basic.phone": "13900000000", "basic.email": "once@example.test" };
  const suggestion = parseSuggestions("手机：13700000000", data)[0];
  for (const choice of ["save", "keep", "once", "pending"] as const) {
    const result = applySuggestions(data, [{ ...suggestion, choice }], overrides);
    const preview = materializeSelection(result.saved, result.once);
    assert.equal(preview.basic.phone, { save: "13700000000", keep: "13800000000", once: "13700000000", pending: "13900000000" }[choice]);
    assert.equal(preview.basic.email, "once@example.test");
    assert.equal(result.pending.length, choice === "pending" ? 1 : 0);
    assert.equal(result.saved.basic.phone, choice === "save" ? "13700000000" : "13800000000");
  }
  assert.equal(overrides["basic.phone"], "13900000000");
});

test("缺项可以编辑，非法映射路径拒绝且不能修改原对象", () => {
  const empty = emptyProfile();
  assert.equal(missingGroups(empty).length, 8);
  assert.throws(() => writeField(empty, "__proto__.polluted", "yes"));
  assert.throws(() => writeField(empty, "education.999.school", "bad"));
  const edited = writeField(empty, "answers.0.answer", "仅有回答仍可暂存");
  assert.equal(empty.answers.length, 0);
  assert.equal(edited.answers[0].answer, "仅有回答仍可暂存");
});

test("Rust 字段排序不会误报保存后的档案仍有修改", () => {
  const draft = emptyProfile();
  draft.basic = { phone: "13800000000", name: "样本" };
  const saved = structuredClone(draft);
  saved.basic = { name: "样本", phone: "13800000000" };
  assert.ok(sameProfileData(draft, saved));
  saved.basic.phone = "13900000000";
  assert.ok(!sameProfileData(draft, saved));
});

test("删除经历条目后，仅本次值跟随原条目而不串到另一段经历", () => {
  const overrides = {
    "education.0.startDate": "2021-09",
    "education.1.startDate": "2025-09",
    "basic.phone": "13800000000",
  };
  assert.deepEqual(shiftOverridesAfterRemoval(overrides, "education", 0), {
    "education.0.startDate": "2025-09",
    "basic.phone": "13800000000",
  });
  assert.equal(overrides["education.0.startDate"], "2021-09");
});

test("看板按同一范围筛选；提交事实与阶段独立", () => {
  const a = {
    id: "a",
    jobSnapshotId: "j",
    stage: "interview",
    createdAt: "2026-11-11T01:00:00Z",
    confirmedSubmittedAt: null,
  } as Application;
  const b = {
    ...a,
    id: "b",
    stage: "closed",
    confirmedSubmittedAt: "2026-11-12T01:00:00Z",
  } as Application;
  const state = {
    applications: [a, b],
    jobs: [
      {
        id: "j",
        data: {
          company: "样本公司",
          title: "AI 开发",
          channel: "官网",
          batch: "秋招",
        },
      },
    ],
  } as Snapshot;
  const scope = filterApplications(state, {
    query: "秋招",
    stage: "",
    dateField: "confirmedSubmittedAt",
    from: "2026-11-12",
    to: "2026-11-12",
  });
  assert.deepEqual(
    scope.map((a) => a.id),
    ["b"],
  );
  const counts = stageCounts([a, b]);
  assert.equal(counts.interview, 1);
  assert.equal(counts.closed, 1);
  assert.equal(counts.applied, 0);
});
