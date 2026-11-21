import test from "node:test";
import assert from "node:assert/strict";
import { evidenceTimingLabel, type Turn } from "../src/s3-types.ts";

const turn = (id: string, mainNumber: number, text: string | null, evidenceIds: string[], followUp = 0): Turn => ({
  id, mainNumber, followUp, question: "问题文字不能冒充回答", evidenceIds, closed: true,
  answer: text === null ? null : { id: `answer-${id}`, text, disposition: "answer", savedAt: "2026-11-20T00:00:00Z" },
});
const finalReport = { mainNumber: null };
const emptyQuote = { answerQuote: "" };

test("显式题标识逐段区分随题材料和补充材料，不借另一题的材料", () => {
  const turns = [turn("first", 1, "读取", ["shown"]), turn("second", 2, "比较", ["supplement"])];
  const point = { turnId: "first", answerQuote: "读取" };
  assert.equal(evidenceTimingLabel(turns, finalReport, point, "shown"), "答题时已给的材料");
  assert.equal(evidenceTimingLabel(turns, finalReport, point, "supplement"), "补充材料（本题作答时未提供）");
});

test("旧报告按题组范围或唯一实际原话定位，未作答的单题仍可标明材料", () => {
  const turns = [turn("first", 1, "先保存输入", ["shown"]), turn("second", 2, "比较票据", ["other"])];
  assert.equal(evidenceTimingLabel(turns, { mainNumber: 1 }, emptyQuote, "other"), "补充材料（本题作答时未提供）");
  assert.equal(evidenceTimingLabel(turns, finalReport, { answerQuote: "比较票据" }, "other"), "答题时已给的材料");
  assert.equal(evidenceTimingLabel([turn("unanswered", 1, null, ["shown"])], finalReport, emptyQuote, "shown"), "答题时已给的材料");
  assert.equal(evidenceTimingLabel(turns, finalReport, { answerQuote: "问题文字不能冒充回答" }, "shown"), "具体题目未定位，无法确认是否随题提供");
});

test("多题重复原话不猜题；仅在所有候选提供情况一致时给出确定标识", () => {
  const turns = [turn("first", 1, "我会核对", ["all", "mixed"]), turn("second", 2, "我会核对", ["all"])];
  for (const point of [emptyQuote, { answerQuote: "我会核对" }]) {
    assert.equal(evidenceTimingLabel(turns, finalReport, point, "all"), "答题时已给的材料（所有可能题均提供）");
    assert.equal(evidenceTimingLabel(turns, finalReport, point, "neither"), "补充材料（所有可能题作答时均未提供）");
    assert.equal(evidenceTimingLabel(turns, finalReport, point, "mixed"), "具体题目未定位（仅部分可能题提供过此材料）");
  }
});

test("同题组主问与追问仍按具体问题定位，不能把整个题组视为同一次提供", () => {
  const turns = [turn("main", 1, "首次回答", ["main-source"]), turn("follow", 1, "追问回答", ["follow-source"], 1)];
  assert.equal(evidenceTimingLabel(turns, { mainNumber: 1 }, emptyQuote, "main-source"), "具体题目未定位（仅部分可能题提供过此材料）");
  assert.equal(evidenceTimingLabel(turns, { mainNumber: 1 }, { answerQuote: "追问回答" }, "main-source"), "补充材料（本题作答时未提供）");
  assert.equal(evidenceTimingLabel(turns, { mainNumber: 1 }, { turnId: "main", answerQuote: "" }, "main-source"), "答题时已给的材料");
});

test("显式题标识不存在、超出题组或与原话不符时不回退猜测", () => {
  const turns = [turn("first", 1, "读取", ["shown"]), turn("second", 2, "比较", ["other"])];
  for (const point of [
    { turnId: "missing", answerQuote: "读取" },
    { turnId: "", answerQuote: "读取" },
    { turnId: "second", answerQuote: "" },
    { turnId: "first", answerQuote: "比较" },
  ]) {
    assert.equal(evidenceTimingLabel(turns, { mainNumber: 1 }, point, "shown"), "具体题目未定位，无法确认是否随题提供");
  }
  assert.equal(evidenceTimingLabel([], finalReport, emptyQuote, "shown"), "具体题目未定位，无法确认是否随题提供");
});

test("人工更正按实际替换后的引用标识，不按评价类别、关键词或旧引用猜测，且不改历史", () => {
  const turns = [turn("first", 1, "只看到了读取", ["shown"])];
  const point = { category: "material_gap", answerQuote: "", evidenceIds: ["shown"], observation: "后来补充" };
  const correction = { evidenceIds: ["supplement", "shown"] };
  const before = structuredClone({ turns, point, correction });
  assert.deepEqual(correction.evidenceIds.map((id) => evidenceTimingLabel(turns, finalReport, point, id)), [
    "补充材料（本题作答时未提供）", "答题时已给的材料",
  ]);
  const positivePoint = { ...point, category: "strength" };
  assert.equal(evidenceTimingLabel(turns, finalReport, positivePoint, "supplement"), "补充材料（本题作答时未提供）");
  assert.deepEqual({ turns, point, correction }, before);
});
