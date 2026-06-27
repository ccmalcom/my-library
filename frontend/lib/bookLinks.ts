export interface BookLinkInput {
  title: string;
  author: string | null;
  isbn13: string | null;
}

export interface BookLink {
  label: string;
  href: string;
}

export function bookLinks(book: BookLinkInput): BookLink[] {
  const { title, author, isbn13 } = book;
  const query = encodeURIComponent(isbn13 ?? `${title} ${author ?? ''}`);
  const titleAuthorQuery = encodeURIComponent(`${title} ${author ?? ''}`);

  const amazon: BookLink = {
    label: 'Amazon',
    href: isbn13
      ? `https://www.amazon.com/s?k=${encodeURIComponent(isbn13)}&i=stripbooks`
      : `https://www.amazon.com/s?k=${titleAuthorQuery}&i=stripbooks`,
  };

  const bookshop: BookLink = isbn13
    ? { label: 'Bookshop.org', href: `https://bookshop.org/book/${isbn13}` }
    : { label: 'Bookshop.org', href: `https://bookshop.org/search?keywords=${titleAuthorQuery}` };

  const worldcat: BookLink = {
    label: 'Library',
    href: `https://search.worldcat.org/search?q=${query}`,
  };

  return [amazon, bookshop, worldcat];
}
