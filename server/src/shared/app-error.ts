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
