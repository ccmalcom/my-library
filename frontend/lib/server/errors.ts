/** FastAPI-shaped errors: every non-2xx body is {"detail": "..."}. */

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string
  ) {
    super(detail);
  }
}

export function errorResponse(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}
