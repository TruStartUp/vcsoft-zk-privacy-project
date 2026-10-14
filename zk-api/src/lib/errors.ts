import Boom from "@hapi/boom";

export interface ApiErrorDetails {
  [key: string]: unknown;
}

/// Every error the API returns carries a stable snake_case code the caller can
/// branch on, next to the human message Boom already produces.
function decorate(error: Boom.Boom, code: string, details?: ApiErrorDetails): Boom.Boom {
  const payload = error.output.payload as Record<string, unknown>;
  payload.code = code;
  if (details) payload.details = details;
  return error;
}

export const apiError = {
  badRequest: (code: string, message: string, details?: ApiErrorDetails) =>
    decorate(Boom.badRequest(message), code, details),
  unauthorized: (code: string, message: string, details?: ApiErrorDetails) =>
    decorate(Boom.unauthorized(message), code, details),
  forbidden: (code: string, message: string, details?: ApiErrorDetails) =>
    decorate(Boom.forbidden(message), code, details),
  notFound: (code: string, message: string, details?: ApiErrorDetails) =>
    decorate(Boom.notFound(message), code, details),
  conflict: (code: string, message: string, details?: ApiErrorDetails) =>
    decorate(Boom.conflict(message), code, details),
  unprocessable: (code: string, message: string, details?: ApiErrorDetails) =>
    decorate(Boom.badData(message), code, details),
  tooManyRequests: (code: string, message: string, details?: ApiErrorDetails) =>
    decorate(Boom.tooManyRequests(message), code, details),
  failedDependency: (code: string, message: string, details?: ApiErrorDetails) =>
    decorate(Boom.failedDependency(message), code, details),
  internal: (code: string, message: string, details?: ApiErrorDetails) =>
    decorate(Boom.internal(message), code, details),
  serviceUnavailable: (code: string, message: string, retryAfterSeconds: number, details?: ApiErrorDetails) => {
    const error = decorate(Boom.serverUnavailable(message), code, { ...details, retryAfterSeconds });
    error.output.headers["Retry-After"] = String(retryAfterSeconds);
    return error;
  },
};

export function isApiError(error: unknown): error is Boom.Boom {
  return Boom.isBoom(error);
}
