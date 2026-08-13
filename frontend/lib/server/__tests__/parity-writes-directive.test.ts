import { describe, it } from 'vitest';
import { setupParityEnv } from './helpers/parity';
import { runScenario } from './helpers/write-parity';

describe('write parity: directive', () => {
  setupParityEnv();
  it('directive', () => runScenario('directive'));
});
