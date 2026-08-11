import { describe, it } from 'vitest';
import { setupParityEnv } from './helpers/parity';
import { runScenario } from './helpers/write-parity';

describe('write parity: import/export', () => {
  setupParityEnv();

  it('StoryGraph preview', () => runScenario('import-preview-storygraph'));
  it('missing preview file', () => runScenario('import-preview-missing-file'));
  it('generic mapped import', () => runScenario('import-generic-mapped'));
  it('auto-detection import failure', () => runScenario('import-auto-detection-failure'));
  it('invalid mapping import failure', () => runScenario('import-invalid-mapping-failure'));
  it('CSV export', () => runScenario('export-csv'));
  it('JSON export', () => runScenario('export-json'));
  it('JSON export with taste signals', () => runScenario('export-json-with-signals'));
  it('invalid export format', () => runScenario('export-invalid-format'));
});
