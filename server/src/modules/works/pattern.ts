import { invalidArgument } from "../../shared/app-error";

export interface PersistedPaletteItem {
  readonly code: string;
  readonly color: string;
}

export interface PersistedPattern {
  readonly schemaVersion: 1;
  readonly width: number;
  readonly height: number;
  readonly settings: {
    readonly colorLimit: number;
    readonly brand: string;
  };
  readonly palette: readonly PersistedPaletteItem[];
  readonly cells: readonly number[];
}

export interface ValidatedPattern {
  readonly pattern: PersistedPattern;
  readonly beadCount: number;
  readonly colorCount: number;
}

const SUPPORTED_SIZES = new Set([32, 48, 64, 96, 128]);

export function validatePersistedPattern(value: unknown): ValidatedPattern {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "width", "height", "settings", "palette", "cells"])) {
    throw invalidArgument("pattern 必须是合法的 PersistedPattern");
  }
  if (value.schemaVersion !== 1 || !SUPPORTED_SIZES.has(value.width as number) || !SUPPORTED_SIZES.has(value.height as number)) {
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
    if (!validText(code, 40) || codes.has(code) || !/^#[0-9a-fA-F]{6}$/u.test(color)) {
      throw invalidArgument("pattern.palette 包含重复色号或非法颜色");
    }
    codes.add(code);
    palette.push({ code, color });
  }
  if (!Array.isArray(value.cells)) throw invalidArgument("pattern.cells 必须是一维数组");
  const width = value.width as number;
  const height = value.height as number;
  if (value.cells.length !== width * height) throw invalidArgument("pattern.cells 长度与尺寸不一致");
  const cells: number[] = [];
  const used = new Set<number>();
  let beadCount = 0;
  for (const cell of value.cells) {
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

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function validText(value: string, maximum: number): boolean {
  const length = Array.from(value.trim()).length;
  return length > 0 && length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}
