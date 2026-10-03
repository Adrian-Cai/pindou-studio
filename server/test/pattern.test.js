const assert = require("node:assert/strict");
const test = require("node:test");
const { validatePersistedPattern } = require("../dist/modules/works/pattern.js");

function pattern(cells = []) {
  return {
    schemaVersion: 1,
    width: 32,
    height: 32,
    settings: { colorLimit: 2, brand: "MARD" },
    palette: [{ code: "C01", color: "#f4d7bf" }, { code: "C02", color: "#000000" }],
    cells: cells.concat(Array(1024 - cells.length).fill(-1)),
  };
}

test("pattern validation derives bead and used-color counts", () => {
  const result = validatePersistedPattern(pattern([0, 0, -1, 1]));
  assert.equal(result.beadCount, 3);
  assert.equal(result.colorCount, 2);
  assert.equal(result.pattern.generationMode, "standard");
  assert.equal(result.pattern.palette[0].color, "#f4d7bf");
});

test("pattern validation preserves the selected generation mode", () => {
  const result = validatePersistedPattern({ ...pattern(), generationMode: "ai" });
  assert.equal(result.pattern.generationMode, "ai");
  assert.throws(() => validatePersistedPattern({ ...pattern(), generationMode: "unknown" }), /schemaVersion/u);
});

test("pattern validation rejects mismatched shape and indexes", () => {
  assert.throws(() => validatePersistedPattern({ ...pattern(), cells: [0] }), /长度/);
  assert.throws(() => validatePersistedPattern(pattern([2])), /越界/);
  assert.throws(() => validatePersistedPattern({ ...pattern(), beadCount: 1 }), /PersistedPattern/);
});
