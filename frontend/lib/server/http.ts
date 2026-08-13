/**
 * withApi: the route-handler wrapper every /api route uses.
 * Auth (Supabase JWT or local mode) -> handler -> FastAPI-shaped errors,
 * one structured log line per request, Server-Timing headers in debug mode.
 */
import { verifyRequestUser, AuthError, type AuthUser } from './auth';
import { getDb } from './db';
import { isDebugMode } from './config';
import { logRequest, makeTimer, newRequestId, serverTimingHeader } from './log';
import { ApiError, errorResponse } from './errors';

export { ApiError, errorResponse };

export interface ApiCtx {
  user: AuthUser;
  requestId: string;
  timer: ReturnType<typeof makeTimer>;
  debug: boolean;
  params: Record<string, string>;
}

export interface WithApiOpts {
  requireAuth?: boolean;
  requireAdmin?: boolean;
}

async function resolveDebug(): Promise<boolean> {
  try {
    return await isDebugMode(getDb());
  } catch {
    return false; // no DATABASE_URL (e.g. healthz in local dev) — never fail a request over debug
  }
}

export function withApi(
  route: string,
  handler: (req: Request, ctx: ApiCtx) => Promise<Response>,
  opts: WithApiOpts = {}
): (
  req: Request,
  routeCtx?: { params?: Promise<Record<string, string>> | Record<string, string> }
) => Promise<Response> {
  const requireAuth = opts.requireAuth ?? true;

  return async (
    req: Request,
    routeCtx?: { params?: Promise<Record<string, string>> | Record<string, string> }
  ): Promise<Response> => {
    const requestId = newRequestId();
    const timer = makeTimer();
    let user: AuthUser | undefined;
    let response: Response;
    let errorForLog: string | undefined;

    const debug = await resolveDebug();

    try {
      if (requireAuth || opts.requireAdmin) {
        user = await verifyRequestUser(req.headers.get('authorization'));
        timer.mark('auth');
        if (opts.requireAdmin && !user.isAdmin) {
          throw new ApiError(403, 'Admin access required');
        }
      }
      const params = (await routeCtx?.params) ?? {};
      response = await handler(req, {
        user: user ?? { userId: 'anonymous', email: null, isAdmin: false },
        requestId,
        timer,
        debug,
        params,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        response = errorResponse(401, err.message);
      } else if (err instanceof ApiError) {
        response = errorResponse(err.status, err.detail);
      } else {
        errorForLog = err instanceof Error ? (err.stack ?? err.message) : String(err);
        response = errorResponse(500, 'Internal Server Error');
      }
    }

    const durationMs = timer.totalMs();
    if (debug) {
      const spans = [...timer.spans(), { name: 'total', durationMs }];
      response.headers.set('Server-Timing', serverTimingHeader(spans));
      response.headers.set('X-Request-Id', requestId);
    }
    logRequest({
      requestId,
      route,
      method: req.method,
      status: response.status,
      durationMs,
      userId: user?.userId,
      error: errorForLog,
    });
    return response;
  };
}
