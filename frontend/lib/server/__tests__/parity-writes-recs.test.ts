import { describe, it } from 'vitest';
import { setupParityEnv } from './helpers/parity';
import { runScenario } from './helpers/write-parity';

describe('write parity: recommendations', () => {
  setupParityEnv();
  it('rec-feedback-accept', () => runScenario('rec-feedback-accept'));
  it('rec-feedback-already-read', () => runScenario('rec-feedback-already-read'));
  it('rec-feedback-note-on-accepted', () => runScenario('rec-feedback-note-on-accepted'));
  it('rec-feedback-reject-reasons', () => runScenario('rec-feedback-reject-reasons'));
  it('rec-feedback-invalid', () => runScenario('rec-feedback-invalid'));
});
