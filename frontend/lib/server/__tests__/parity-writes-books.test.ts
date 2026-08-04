import { describe, it } from 'vitest';
import { setupParityEnv } from './helpers/parity';
import { runScenario } from './helpers/write-parity';

describe('write parity: books', () => {
  setupParityEnv();
  it('add-book-basic', () => runScenario('add-book-basic'));
  it('add-book-rated-review', () => runScenario('add-book-rated-review'));
  it('add-book-duplicate', () => runScenario('add-book-duplicate'));
  it('add-book-sibling-subtitle', () => runScenario('add-book-sibling-subtitle'));
  it('add-book-invalid', () => runScenario('add-book-invalid'));
  it('book-feedback', () => runScenario('book-feedback'));
  it('book-feedback-invalid', () => runScenario('book-feedback-invalid'));
  it('book-shelf', () => runScenario('book-shelf'));
});
