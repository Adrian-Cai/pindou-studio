/**
 * 服务端图纸校验：校验小程序上传的 PersistedPattern 结构、尺寸、配色与单元格索引，并算出用量统计。
 *
 * 职责：把未知输入严格校验成 ValidatedPattern（合法 pattern + 总珠数 beadCount + 颜色数 colorCount）；
 *       不写库、不处理图片。所有不合法都抛 invalidArgument，是服务端防脏数据的最后一道闸。
 * 调用方：server work-service（create/update 写入前）。
 * 关键点：网格尺寸只接受 {32,48,64,96,128}；cells 长度必须 == width*height；
 *       每格下标须为 -1（透明）或落在 palette 范围内；色号去重、颜色须为 #RRGGBB。
 */
import { invalidArgument } from "../../shared/app-error";

/** 持久化调色板的一项：色号 + hex 颜色。 */
export interface PersistedPaletteItem {
  readonly code: string;
  readonly color: string;
}

/** 生成模式。 */
export type GenerationMode = "standard" | "ai";

/** 持久化图纸：去重建调色板 + 每格存 palette 下标（透明格=-1）。 */
export interface PersistedPattern {
  readonly schemaVersion: 1;
  readonly generationMode: GenerationMode;
  readonly width: number;
  readonly height: number;
  readonly settings: {
    readonly colorLimit: number;
    readonly brand: string;
  };
  readonly palette: readonly PersistedPaletteItem[];
  readonly cells: readonly number[];
}

/** 校验通过后的结果：合法 pattern + 统计信息。 */
export interface ValidatedPattern {
  readonly pattern: PersistedPattern;
  readonly beadCount: number;
  readonly colorCount: number;
}

// 服务端支持的网格尺寸白名单（拼豆常见规格）
const SUPPORTED_SIZES = new Set([32, 48, 64, 96, 128]);

/**
 * 校验并规整图纸数据。
 * @param value 待校验的未知输入（来自请求体）
 * @returns 合法 pattern + beadCount（非透明格数）+ colorCount（用到的颜色数）
 */
export function validatePersistedPattern(value: unknown): ValidatedPattern {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "generationMode", "width", "height", "settings", "palette", "cells"])) {
    throw invalidArgument("pattern 必须是合法的 PersistedPattern");
  }
  const generationMode = value.generationMode === undefined ? "standard" : value.generationMode;
  if (
    value.schemaVersion !== 1
    || (generationMode !== "standard" && generationMode !== "ai")
    || !SUPPORTED_SIZES.has(value.width as number)
    || !SUPPORTED_SIZES.has(value.height as number)
  ) {
    throw invalidArgument("pattern 的 schemaVersion 或尺寸不受支持");
  }
  if (!isRecord(value.settings) || !hasExactKeys(value.settings, ["colorLimit", "brand"])) {
    throw invalidArgument("pattern.settings 结构不合法");
  }
  const colorLimit = value.settings.colorLimit;
  const brand = value.settings.brand;
  if (!isIntegerInRange(colorLimit, 1, 128) || typeof brand !== "string" || !validText(brand, 40)) {
    throw invalidArgument("pattern.settings 的 colorLimit 或 brand 不合法");
  }
  if (!Array.isArray(value.palette) || value.palette.length > colorLimit || value.palette.length > 128) {
    throw invalidArgument("pattern.palette 数量不合法");
  }
  const palette: PersistedPaletteItem[] = [];
  const codes = new Set<string>();
  for (const item of value.palette) {
    if (!isRecord(item) || !hasExactKeys(item, ["code", "color"]) || typeof item.code !== "string" || typeof item.color !== "string") {
      throw invalidArgument("pattern.palette 项结构不合法");
    }
    const code = item.code.trim();
    const color = item.color.trim();
    // 色号必填且去重；颜色须为 #RRGGBB 六位十六进制
    if (!validText(code, 40) || codes.has(code) || !/^#[0-9a-fA-F]{6}$/u.test(color)) {
      throw invalidArgument("pattern.palette 包含重复色号或非法颜色");
    }
    codes.add(code);
    palette.push({ code, color });
  }
  if (!Array.isArray(value.cells)) throw invalidArgument("pattern.cells 必须是一维数组");
  const width = value.width as number;
  const height = value.height as number;
  // 单元格数必须严格等于网格数，否则图纸损坏
  if (value.cells.length !== width * height) throw invalidArgument("pattern.cells 长度与尺寸不一致");
  const cells: number[] = [];
  const used = new Set<number>();
  let beadCount = 0;
  for (const cell of value.cells) {
    // 每格下标须为 -1（透明）或落在调色板范围内
    if (!Number.isInteger(cell) || cell < -1 || cell >= palette.length) {
      throw invalidArgument("pattern.cells 包含越界颜色索引");
    }
    cells.push(cell);
    if (cell >= 0) {
      beadCount += 1;
      used.add(cell);
    }
  }
  return {
    pattern: {
      schemaVersion: 1,
      generationMode,
      width,
      height,
      settings: { colorLimit, brand: brand.trim() },
      palette,
      cells,
    },
    beadCount,
    colorCount: used.size,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const allowed = new Set(keys);
  return actual.every((key) => allowed.has(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function validText(value: string, maximum: number): boolean {
  const length = Array.from(value.trim()).length;
  return length > 0 && length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}
