import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCsvRecords, parseGoodreads } from '../import-csv';

/**
 * Goodreads writes ISBN columns Excel-escaped as ="9780441172719". Python's csv
 * module accepts a quote that is not at the start of a field; csv-parse rejects
 * it unless relax_quotes is set. Every expectation below was measured against
 * Python's csv.DictReader, including the two documented divergences.
 */
describe('csv quote tolerance', () => {
  const cell = (text: string): string | null => {
    const { rows } = parseCsvRecords(text);
    return rows[0]?.B as string | null;
  };

  it('accepts the Excel-escaped ISBN that Goodreads exports', () => {
    expect(cell('A,B\n1,="9780441172719"\n')).toBe('="9780441172719"');
  });

  it('accepts a bare quote in the middle of an unquoted field', () => {
    expect(cell('A,B\n1,foo"bar\n')).toBe('foo"bar');
  });

  it('still parses ordinary quoted fields, doubled quotes, and embedded newlines', () => {
    expect(cell('A,B\n1,"hello, world"\n')).toBe('hello, world');
    expect(cell('A,B\n1,"say ""hi"""\n')).toBe('say "hi"');
    expect(cell('A,B\n1,"two\nlines"\n')).toBe('two\nlines');
    expect(cell('A,B\n1,""\n')).toBe('');
  });

  it('DIVERGENCE: keeps the literal quotes where Python drops them', () => {
    // Python's csv yields `hello tail`. Not reachable from a Goodreads or
    // StoryGraph export; asserted so the difference stays measured, not missed.
    expect(cell('A,B\n1,"hello" tail\n')).toBe('"hello" tail');
  });

  it('DIVERGENCE: still throws on an unterminated quote at EOF', () => {
    // Python's csv yields `unclosed\n` for a truncated file.
    expect(() => parseCsvRecords('A,B\n1,"unclosed\n')).toThrow(/Quote Not Closed/);
  });

  it('parses the checked-in Goodreads fixture end to end', () => {
    const text = readFileSync(join(process.cwd(), '..', 'tests', 'sample_goodreads.csv'), 'utf8');
    const parsed = parseGoodreads(text);
    expect(parsed.rows).toHaveLength(6);
    expect(parsed.skipped).toBe(0);
    expect(parsed.rows[0]?.title).toBe('Dune');
    // cleanIsbn strips the ="..." wrapper, exactly as Python's clean_isbn does.
    expect(parsed.rows[0]?.isbn13).toBe('9780441172719');
    expect(parsed.rows.map((row) => row.isbn13)).toEqual([
      '9780441172719',
      '9780765382030',
      '9781524759780',
      '9780385539258',
      '9780593135204',
      '9780756404741',
    ]);
  });
});
