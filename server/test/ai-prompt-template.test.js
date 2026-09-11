const assert = require("node:assert/strict");
const test = require("node:test");
const { AI_PROMPT_VERSION, buildAiPrompt } = require("../dist/modules/ai/prompt-template.js");

const styles = ["natural", "cartoon", "minimal"];
const detailLevels = ["low", "medium", "high"];
const backgroundModes = ["keep", "simplify", "remove"];

test("AI prompt template covers every supported option combination", () => {
  const prompts = new Set();
  for (const style of styles) {
    for (const detailLevel of detailLevels) {
      for (const backgroundMode of backgroundModes) {
        const result = buildAiPrompt({ style, detailLevel, backgroundMode });
        prompts.add(result.text);

        assert.equal(result.version, "v2");
        assert.match(result.text, /适合后续转换为拼豆图/);
        assert.match(result.text, /不要生成拼豆网格/);
        assert.match(result.text, /完整的 PNG/);
        assert.ok(result.text.length < 4_500);
      }
    }
  }

  assert.equal(AI_PROMPT_VERSION, "v2");
  assert.equal(prompts.size, 27);
});

test("AI prompt template keeps the three parameter dimensions observable", () => {
  assert.match(buildAiPrompt({ style: "natural", detailLevel: "medium", backgroundMode: "simplify" }).text, /写实视觉风格/);
  assert.match(buildAiPrompt({ style: "cartoon", detailLevel: "medium", backgroundMode: "simplify" }).text, /卡通插画风格/);
  assert.match(buildAiPrompt({ style: "minimal", detailLevel: "medium", backgroundMode: "simplify" }).text, /极简插画风格/);
  assert.match(buildAiPrompt({ style: "natural", detailLevel: "low", backgroundMode: "simplify" }).text, /明显减少细碎纹理/);
  assert.match(buildAiPrompt({ style: "natural", detailLevel: "high", backgroundMode: "simplify" }).text, /尽量保留主体层次/);
  assert.match(buildAiPrompt({ style: "natural", detailLevel: "medium", backgroundMode: "keep" }).text, /保留原有背景构图/);
  assert.match(buildAiPrompt({ style: "natural", detailLevel: "medium", backgroundMode: "remove" }).text, /移除复杂背景/);
});
