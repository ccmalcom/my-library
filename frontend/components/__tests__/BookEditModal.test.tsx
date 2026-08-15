/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import BookEditModal from '@/components/BookEditModal';
import { ToastProvider } from '@/components/ui';
import type { Book } from '@/lib/api';

jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: undefined }),
  mutate: jest.fn(),
}));

const book = {
  id: 1,
  title: 'Piranesi',
  author: 'Susanna Clarke',
  effective_rating: 4,
  app_review: '',
  date_read: null,
  exclude_from_profile: false,
} as unknown as Book;

describe('BookEditModal', () => {
  it('labels the review textarea and the date field', () => {
    render(
      <ToastProvider>
        <BookEditModal book={book} listKey="books-read" onClose={jest.fn()} />
      </ToastProvider>
    );
    expect(screen.getByLabelText('Review')).toBeInTheDocument();
  });
});
