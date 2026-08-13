import { importRows } from '@/lib/server/import-books';
import { parseImport, SOURCE_FOR } from '@/lib/server/import-csv';
import { getDb } from '@/lib/server/db';
import { missingImportFileResponse, readCsvUpload } from '@/lib/server/import-upload';
import { ApiError, withApi } from '@/lib/server/http';

export const runtime = 'nodejs';

function parseMappingField(value: FormDataEntryValue | null): Record<string, string> | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ApiError(422, 'mapping must be a JSON object of string keys and values.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ApiError(422, 'mapping must be valid JSON.');
  }
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== 'object' ||
    Object.entries(parsed).some(
      ([key, item]) => typeof key !== 'string' || typeof item !== 'string'
    )
  ) {
    throw new ApiError(422, 'mapping must be a JSON object of string keys and values.');
  }
  return parsed as Record<string, string>;
}

export const POST = withApi('/api/import', async (req, ctx) => {
  try {
    const { text, form } = await readCsvUpload(req);
    const format = String(form.get('format') ?? 'auto');
    const mapping = parseMappingField(form.get('mapping'));
    let parsed;
    try {
      parsed = parseImport(text, format, mapping);
    } catch (error) {
      throw new ApiError(422, error instanceof Error ? error.message : String(error));
    }
    const db = getDb();
    const counts = await db.transaction((tx) =>
      importRows(tx, ctx.user.userId, SOURCE_FOR[parsed.format], parsed.rows)
    );
    ctx.timer.mark('db');
    return Response.json({
      format: parsed.format,
      total_rows: parsed.totalRows,
      skipped: parsed.skipped,
      inserted: counts.inserted,
      updated: counts.updated,
      rated: counts.rated,
    });
  } catch (error) {
    const missing = missingImportFileResponse(error);
    if (missing) return missing;
    throw error;
  }
});
