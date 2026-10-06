export class AppError extends Error {
  constructor(code, message, status = 400, details) {
    super(message); this.name = 'AppError'; this.code = code; this.status = status; this.details = details;
  }
}
/** @returns {never} */
export const fail = (code, message, status = 400, details) => { throw new AppError(code, message, status, details); };
export function json(data, status = 200, headers = {}) {
  return Response.json({ status: 'success', data }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
export function errorResponse(error, publicShare = false) {
  const known = typeof error.code === 'string' && Number.isInteger(error.status);
  return Response.json({
    status: 'failed',
    error: {
      code: known ? error.code : 'INTERNAL_SERVER_ERROR',
      type: known ? 'RequestError' : 'InternalServerError',
      message: known ? error.message : '服务暂时不可用，请重试',
      ...(known && error.details && !publicShare ? { details: error.details } : {}),
    },
  }, { status: known ? error.status : 500, headers: { 'Cache-Control': 'no-store' } });
}

