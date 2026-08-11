import { buildImportPreview } from '@/lib/server/import-csv';
import { missingImportFileResponse, readCsvUpload } from '@/lib/server/import-upload';
import { withApi } from '@/lib/server/http';

export const runtime = 'nodejs';

export const POST = withApi('/api/import/preview', async (req) => {
  try {
    const { text } = await readCsvUpload(req);
    return Response.json(buildImportPreview(text));
  } catch (error) {
    const missing = missingImportFileResponse(error);
    if (missing) return missing;
    throw error;
  }
});
