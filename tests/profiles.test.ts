import test from "node:test";
import assert from "node:assert/strict";
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
