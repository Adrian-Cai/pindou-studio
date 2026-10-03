export interface ErrorDetails {
  readonly [key: string]: unknown;
}

export class AppError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details: ErrorDetails = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function invalidArgument(message: string, details: ErrorDetails = {}): AppError {
  return new AppError(400, "INVALID_ARGUMENT", message, details);
}

export function unauthorized(message = "请先登录"): AppError {
  return new AppError(401, "UNAUTHORIZED", message);
}

export function forbidden(message = "无权访问该资源"): AppError {
  return new AppError(403, "FORBIDDEN", message);
}

export function notFound(message = "资源不存在"): AppError {
  return new AppError(404, "NOT_FOUND", message);
}

export function idempotencyConflict(message = "幂等键已用于另一份请求"): AppError {
  return new AppError(409, "IDEMPOTENCY_CONFLICT", message);
}

export function quotaInsufficient(message = "下载额度不足"): AppError {
  return new AppError(402, "QUOTA_INSUFFICIENT", message);
}

export function aiQuotaInsufficient(message = "AI 生成额度不足"): AppError {
  return new AppError(402, "USER_AI_QUOTA_EXHAUSTED", message);
}
