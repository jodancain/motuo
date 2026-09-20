import { test } from "node:test";
import assert from "node:assert/strict";
import { manualEvidenceBoundary, quoteFrom, rankManualPages } from "../src/manuals.js";

test("a parameter near the end of a long page remains inside a contiguous source quote", () => {
  const label = "发动机机油加油量\n发动机大修[标准值]:2875 ml";
  const text = "机油检查\n" + "无关前文。".repeat(350) + "\n" + label + "\n核对油位。";
  const quote = quoteFrom(text, ["发动", "动机", "大修", "机油"], "发动机大修后的机油加注标准量是多少？");
  assert.ok(quote.includes(label));
  assert.ok(text.includes(quote));
  assert.ok(quote.length <= 1200);
});

test("unit context cannot borrow component names from distant text", () => {
  const unrelated = { page: 1, matches: 4, text: "发动机冷却液\n" + "接线检查。".repeat(60) + "\n专用工具油杯：500 ml" };
  const relevant = { page: 2, matches: 3, text: "发动机冷却液容量\n[标准值]:1675 ml" };
  assert.equal(rankManualPages([unrelated, relevant], "发动机冷却液总量是多少？")[0]?.page, 2);
});

test("static specification questions remain available while current measurements are bounded", () => {
  assert.equal(manualEvidenceBoundary("手册推荐的冷态胎压是多少？"), null);
  assert.equal(manualEvidenceBoundary("挡位开关输入电压标准是多少？"), null);
  assert.match(manualEvidenceBoundary("现在的实时胎压是多少？")!, /实测数据/);
});

test("capacity uses battery charge units and an oil bolt torque is not an oil volume query", () => {
  const volume = { page: 1, matches: 5, text: "容量\n发动机油 | 1675 ml" };
  const battery = { page: 2, matches: 3, text: "蓄电池型号和容量\n蓄电池 | TEST-B | 9 Ah" };
  assert.equal(rankManualPages([volume, battery], "蓄电池型号和容量是什么？")[0]?.page, 2);
  const input = [battery, volume];
  assert.deepEqual(rankManualPages(input, "机油放油螺塞的规定扭矩是多少？"), input);
});

test("natural tyre-pressure wording ranks measured pressure fields above ABS prose and shows the value early", () => {
  const abs = { page: 1, matches: 5, text: "ABS 故障码。前后轮胎气压是多少，应检查前后轮的轮速信号。" };
  const pressure = { page: 2, matches: 3, text: "TEST规格\n" + "前减震器参数。\n".repeat(150) + "轮胎冷态气压 | 前轮 | 245 kPa\n| 后轮 | 255 kPa" };
  for (const question of ["前后轮胎气压是多少？ ", "冷胎胎压是多少？", "轮胎应该打多少气？"]) {
    assert.equal(rankManualPages([abs, pressure], question)[0]?.page, 2);
    const quote = quoteFrom(pressure.text, ["轮胎", "气压", "胎气"], question);
    assert.ok(quote.includes("245 kPa"));
    assert.ok(quote.includes("255 kPa"));
    assert.ok(quote.startsWith("轮胎冷态气压"));
    assert.ok(quote.indexOf("245 kPa") < 150);
    assert.ok(pressure.text.includes(quote));
  }
});
