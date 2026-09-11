import type {
  AiGenerationBackgroundMode,
  AiGenerationDetailLevel,
  AiGenerationStyle,
} from "./ai-generation-service";

export const AI_PROMPT_VERSION = "v2" as const;

export interface AiPromptInput {
  readonly style: AiGenerationStyle;
  readonly detailLevel: AiGenerationDetailLevel;
  readonly backgroundMode: AiGenerationBackgroundMode;
}

export interface AiPrompt {
  readonly version: typeof AI_PROMPT_VERSION;
  readonly text: string;
}

const BASE_PROMPT = [
  "请基于输入图片生成一张适合后续转换为拼豆图的高质量中间图。",
  "保留输入图片中的主要主体、人物身份、姿态、主体比例和核心构图。",
  "不要改变主体的关键识别特征，不要添加新的主体或人物。",
  "请减少细碎纹理、无关小物体和复杂噪声。",
  "强化主体轮廓、明暗关系以及主体和背景之间的色块对比。",
  "减少过度细密的渐变，使主要区域边界清晰，便于后续图像量化。",
].join("\n");

const STYLE_PROMPTS: Readonly<Record<AiGenerationStyle, string>> = {
  natural: "使用自然、柔和、干净的写实视觉风格。",
  cartoon: "转换为轮廓清楚、色彩明确的精致卡通插画风格。",
  minimal: "转换为色块明确、边缘清晰、细节克制的极简插画风格。",
};

const DETAIL_PROMPTS: Readonly<Record<AiGenerationDetailLevel, string>> = {
  low: "明显减少细碎纹理、小物件和复杂渐变，只保留主要结构。",
  medium: "保留主体和主要纹理，合并不重要的小细节和细微渐变。",
  high: "尽量保留主体层次、关键纹理和重要细节，同时保持轮廓清晰。",
};

const BACKGROUND_PROMPTS: Readonly<Record<AiGenerationBackgroundMode, string>> = {
  keep: "保留原有背景构图，但降低背景细节和纹理干扰。",
  simplify: "简化背景，只保留有助于识别场景的主要元素。",
  remove: "移除复杂背景，使用干净、浅色、低干扰的背景。",
};

const OUTPUT_CONSTRAINTS = [
  "不要生成拼豆网格、方格、材料标记、施工图、边框、Logo、水印或额外文字。",
  "输出一张完整的 PNG 图片。",
].join("\n");

export function buildAiPrompt(input: AiPromptInput): AiPrompt {
  return {
    version: AI_PROMPT_VERSION,
    text: [
      BASE_PROMPT,
      STYLE_PROMPTS[input.style],
      DETAIL_PROMPTS[input.detailLevel],
      BACKGROUND_PROMPTS[input.backgroundMode],
      OUTPUT_CONSTRAINTS,
    ].join("\n"),
  };
}
