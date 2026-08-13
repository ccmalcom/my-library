import { describe, expect, it } from 'vitest';
import { maskVolatile, maskVolatileHeader } from './helpers/write-parity';

describe('write parity volatile masking', () => {
  it('normalizes valid exported_at timestamps across UTC dates', () => {
    const first = '{"exported_at": "2026-08-11T23:59:59.123456+00:00"}';
    const second = '{"exported_at": "2026-08-12T00:00:01.654321+00:00"}';

    expect(maskVolatile(first)).toEqual(maskVolatile(second));
  });

  it('leaves an exported_at timestamp with the wrong format unmasked', () => {
    const valid = '{"exported_at": "2026-08-11T23:59:59.123456+00:00"}';
    const threeFractionalDigits = '{"exported_at": "2026-08-12T00:00:01.654+00:00"}';

    expect(maskVolatile(valid)).not.toEqual(maskVolatile(threeFractionalDigits));
    expect(maskVolatile(threeFractionalDigits)).toBe(threeFractionalDigits);
  });

  it('normalizes created_at timestamps with zero to six fractional digits', () => {
    const noFraction = '{"created_at": "2026-08-11T05:47:02"}';
    const threeFractionalDigits = '{"created_at": "2026-08-12T06:48:03.511"}';
    const sixFractionalDigits = '{"created_at": "2026-08-13T07:49:04.123456"}';

    expect(maskVolatile(noFraction)).toEqual(maskVolatile(threeFractionalDigits));
    expect(maskVolatile(threeFractionalDigits)).toEqual(maskVolatile(sixFractionalDigits));
  });

  it('normalizes every created_at occurrence in a string', () => {
    const twoTimestamps =
      '{"first":{"created_at": "2026-08-11T05:47:02"},"second":{"created_at": "2026-08-12T06:48:03.511"}}';

    expect(maskVolatile(twoTimestamps)).toBe(
      '{"first":{"created_at": "2000-01-01T00:00:00"},"second":{"created_at": "2000-01-01T00:00:00"}}'
    );
  });

  it('leaves timezone-qualified created_at timestamps unmasked', () => {
    const zSuffix = '{"created_at": "2026-08-11T05:47:02Z"}';
    const utcOffset = '{"created_at": "2026-08-11T05:47:02+00:00"}';

    expect(maskVolatile(zSuffix)).toBe(zSuffix);
    expect(maskVolatile(utcOffset)).toBe(utcOffset);
  });

  it('normalizes only the date stamp in otherwise exact export headers', () => {
    const first = 'attachment; filename="mylibrary-backup-20260811.csv"';
    const second = 'attachment; filename="mylibrary-backup-20260812.csv"';

    expect(maskVolatileHeader(first)).toEqual(maskVolatileHeader(second));
    expect(maskVolatileHeader(first)).toBe('attachment; filename="mylibrary-backup-<date>.csv"');
  });
});
