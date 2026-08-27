const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function dateParts(date: Date): DateParts {
  const parts = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function shanghaiDate(date: Date): string {
  const parts = dateParts(date);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function nextShanghaiMidnight(date: Date): string {
  const parts = dateParts(date);
  const nextLocalDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const year = nextLocalDate.getUTCFullYear();
  const month = nextLocalDate.getUTCMonth() + 1;
  const day = nextLocalDate.getUTCDate();
  const utcInstant = new Date(Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS);
  const isoDate = `${year}-${pad(month)}-${pad(day)}`;
  if (!Number.isFinite(utcInstant.getTime())) throw new Error("无法计算额度重置时间");
  return `${isoDate}T00:00:00+08:00`;
}
