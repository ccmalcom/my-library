/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';

describe('reject-reason modal copy', () => {
  it('does not offer two buttons that do the same thing', () => {
    // Guard at the source level: the modal must not render a "Skip" button that
    // shares its handler with the submit button.
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../(main)/swipe/page.tsx'),
      'utf8'
    );
    const submitHandlers = src.match(/onClick=\{submitReject\}/g) ?? [];
    expect(submitHandlers).toHaveLength(1);
  });
});
