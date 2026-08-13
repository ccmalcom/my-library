/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { StarRating } from '@/components/ui/StarRating';

function halfClick(el: Element, fraction: number) {
  jest.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    width: 20,
    right: 20,
    top: 0,
    bottom: 20,
    height: 20,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  fireEvent.click(el, { clientX: 20 * fraction });
}

describe('StarRating', () => {
  it('reports 3.5 when clicking the left side of the fourth star', () => {
    const onChange = jest.fn();
    render(<StarRating value={0} onChange={onChange} allowHalf />);

    halfClick(screen.getAllByRole('radio')[3], 0.25);

    expect(onChange).toHaveBeenCalledWith(3.5);
  });

  it('reports 4 when clicking the right side of the fourth star', () => {
    const onChange = jest.fn();
    render(<StarRating value={0} onChange={onChange} allowHalf />);

    halfClick(screen.getAllByRole('radio')[3], 0.75);

    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('steps by half with arrow keys when half stars are allowed', () => {
    const onChange = jest.fn();
    render(<StarRating value={3} onChange={onChange} allowHalf />);

    fireEvent.keyDown(screen.getAllByRole('radio')[2], { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledWith(3.5);
  });

  it('steps by a whole star with arrow keys when half stars are not allowed', () => {
    const onChange = jest.fn();
    render(<StarRating value={3} onChange={onChange} />);

    fireEvent.keyDown(screen.getAllByRole('radio')[2], { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('never goes below half a star', () => {
    const onChange = jest.fn();
    render(<StarRating value={0.5} onChange={onChange} allowHalf />);

    fireEvent.keyDown(screen.getAllByRole('radio')[0], { key: 'ArrowLeft' });

    expect(onChange).toHaveBeenCalledWith(0.5);
  });

  it('never goes above the maximum', () => {
    const onChange = jest.fn();
    render(<StarRating value={5} onChange={onChange} allowHalf />);

    fireEvent.keyDown(screen.getAllByRole('radio')[4], { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledWith(5);
  });

  it('announces a read-only rating accessibly', () => {
    render(<StarRating value={3.5} readOnly allowHalf label="Your rating" />);

    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Your rating: 3.5 of 5');
  });

  it('renders no buttons when read-only', () => {
    render(<StarRating value={3.5} readOnly allowHalf label="Your rating" />);

    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('renders exactly one clipped star for a half value', () => {
    const { container } = render(<StarRating value={3.5} readOnly allowHalf />);

    expect(container.querySelectorAll('path[clip-path]')).toHaveLength(1);
  });

  it('uses unique clipPath ids across StarRating instances', () => {
    const { container } = render(
      <>
        <StarRating value={3.5} readOnly allowHalf />
        <StarRating value={3.5} readOnly allowHalf />
      </>
    );
    const ids = Array.from(container.querySelectorAll('clipPath'), (element) => element.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
