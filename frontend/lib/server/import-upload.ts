import { ApiError } from './http';

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

const TOO_LARGE = 'Uploaded CSV exceeds the 10 MiB limit.';

export class MissingImportFileError extends Error {
  override name = 'MissingImportFileError';
}

export function missingImportFileResponse(error: unknown): Response | null {
  if (!(error instanceof MissingImportFileError)) return null;
  return Response.json(
    {
      detail: [{ type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null }],
    },
    { status: 422 }
  );
}

export async function readCsvUpload(
  request: Request
): Promise<{ text: string; filename: string; form: FormData }> {
  const contentLength = request.headers.get('content-length');
  if (/^\d+$/.test(contentLength ?? '') && Number(contentLength) > MAX_IMPORT_BYTES) {
    // Intentional Node-only bound for in-memory serverless uploads. Python has no
    // counterpart, so this behavior cannot be covered by a parity fixture.
    throw new ApiError(413, TOO_LARGE);
  }

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new MissingImportFileError();
  if (!file.name.toLowerCase().endsWith('.csv')) {
    throw new ApiError(422, 'Uploaded file must be a .csv');
  }
  if (file.size > MAX_IMPORT_BYTES) throw new ApiError(413, TOO_LARGE);

  let bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  }
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      filename: file.name,
      form,
    };
  } catch {
    throw new ApiError(422, 'File must be UTF-8 encoded CSV.');
  }
}
