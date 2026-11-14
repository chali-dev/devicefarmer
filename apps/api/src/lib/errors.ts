/** Interpolation values for a message code (rendered by the web UI's `errors.<code>` translation). */
export type ErrorParams = Record<string, string | number>;

/**
 * `message` stays the (Chinese/English) text sent as `error` for backward compatibility;
 * `code` is a stable id such as 'auth.wrong_password' that clients may translate with `params`.
 */
export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code?: string, readonly params?: ErrorParams) { super(message); }
}

export const badRequest = (msg: string, code?: string, params?: ErrorParams) => new HttpError(400, msg, code, params);
export const unauthorized = (msg = 'Unauthorized', code?: string, params?: ErrorParams) => new HttpError(401, msg, code, params);
export const forbidden = (msg = 'Forbidden', code?: string, params?: ErrorParams) => new HttpError(403, msg, code, params);
export const notFound = (msg = 'Not found', code?: string, params?: ErrorParams) => new HttpError(404, msg, code, params);
export const conflict = (msg: string, code?: string, params?: ErrorParams) => new HttpError(409, msg, code, params);
