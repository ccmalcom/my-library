import { describe, it } from 'vitest';
import { setupParityEnv } from './helpers/parity';
import { runScenario } from './helpers/write-parity';

describe('write parity: feedback + taste-signal', () => {
  setupParityEnv();
  it('feedback-flow', () => runScenario('feedback-flow'));
  it('feedback-invalid', () => runScenario('feedback-invalid'));
  it('taste-signal', () => runScenario('taste-signal'));
});
