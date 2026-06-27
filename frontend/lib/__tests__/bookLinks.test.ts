import { bookLinks } from '../bookLinks';

const withIsbn = { title: 'Dune', author: 'Frank Herbert', isbn13: '9780441013593' };
const noIsbn   = { title: 'Dune', author: 'Frank Herbert', isbn13: null };

describe('bookLinks', () => {
  it('returns three links', () => {
    expect(bookLinks(withIsbn)).toHaveLength(3);
  });

  it('uses ISBN in Amazon URL when present', () => {
    const links = bookLinks(withIsbn);
    const amazon = links.find((l) => l.label === 'Amazon')!;
    expect(amazon.href).toContain('9780441013593');
    expect(amazon.href).toContain('amazon.com');
  });

  it('falls back to title+author search on Amazon when no ISBN', () => {
    const links = bookLinks(noIsbn);
    const amazon = links.find((l) => l.label === 'Amazon')!;
    expect(amazon.href).toContain('Dune');
    expect(amazon.href).toContain('Frank');
  });

  it('uses ISBN direct URL on Bookshop when present', () => {
    const links = bookLinks(withIsbn);
    const shop = links.find((l) => l.label === 'Bookshop.org')!;
    expect(shop.href).toBe('https://bookshop.org/book/9780441013593');
  });

  it('uses search URL on Bookshop when no ISBN', () => {
    const links = bookLinks(noIsbn);
    const shop = links.find((l) => l.label === 'Bookshop.org')!;
    expect(shop.href).toContain('bookshop.org/search');
  });

  it('includes WorldCat link', () => {
    const links = bookLinks(withIsbn);
    const lib = links.find((l) => l.label === 'Library')!;
    expect(lib.href).toContain('worldcat.org');
    expect(lib.href).toContain('9780441013593');
  });
});
