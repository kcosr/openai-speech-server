export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: string,
    public readonly code: string,
    message: string,
    public readonly param?: string,
    public readonly retryAfter?: number,
  ) { super(message); }
}

export function errorBody(error: ApiError, requestId: string) {
  return { error: { type: error.type, code: error.code, message: error.message, param: error.param ?? null, request_id: requestId } };
}

export const invalid = (code: string, message: string, param?: string) => new ApiError(400, "invalid_request_error", code, message, param);
