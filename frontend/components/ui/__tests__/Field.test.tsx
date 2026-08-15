/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';

describe('Field', () => {
  it('associates the label with the control', () => {
    render(<Field label="Current password">{(p) => <Input type="password" {...p} />}</Field>);
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  });

  it('gives two Fields on the same screen distinct ids', () => {
    render(
      <>
        <Field label="New password">{(p) => <Input type="password" {...p} />}</Field>
        <Field label="Confirm new password">{(p) => <Input type="password" {...p} />}</Field>
      </>
    );
    const a = screen.getByLabelText('New password');
    const b = screen.getByLabelText('Confirm new password');
    expect(a.id).not.toBe(b.id);
  });

  it('announces the error and marks the control invalid', () => {
    render(
      <Field label="Email" error="That address is already invited.">
        {(p) => <Input type="email" {...p} />}
      </Field>
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('That address is already invited.');
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  });

  it('uses a legible label style, not the mono uppercase eyebrow', () => {
    render(<Field label="Your name">{(p) => <Input {...p} />}</Field>);
    const label = screen.getByText('Your name');
    expect(label.className).not.toContain('uppercase');
    expect(label.className).not.toContain('font-mono');
  });

  it('draws control borders at the strengthened token', () => {
    render(<Field label="Your name">{(p) => <Input {...p} />}</Field>);
    expect(screen.getByLabelText('Your name').className).toContain('border-border-strong');
  });
});
