/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { Button } from '@/components/ui/Button';

describe('Button ink', () => {
  it('uses dark ink on the accent fill, not white', () => {
    render(<Button variant="primary">Find my next books</Button>);
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('bg-accent');
    expect(cls).toContain('text-[color:var(--bg)]');
    expect(cls).not.toContain('text-white');
  });

  it('uses dark ink on the danger fill, not white', () => {
    render(<Button variant="danger">Delete</Button>);
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('bg-danger');
    expect(cls).not.toContain('text-white');
  });

  it('still marks itself busy and disabled while loading', () => {
    render(<Button loading>Saving</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toBeDisabled();
  });
});
