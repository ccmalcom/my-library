/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { Modal } from '@/components/ui/Modal';

function open(props: Partial<React.ComponentProps<typeof Modal>> = {}) {
  const onClose = jest.fn();
  render(
    <>
      <button type="button">behind</button>
      <Modal labelId="t" onClose={onClose} {...props}>
        <h2 id="t">Edit book</h2>
        <button type="button">Save</button>
      </Modal>
    </>
  );
  return { onClose, backdrop: screen.getByRole('dialog').parentElement! };
}

describe('Modal', () => {
  it('closes on a backdrop click by default', () => {
    const { onClose, backdrop } = open();
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it('ignores a backdrop click when confirmClose returns false', () => {
    const { onClose, backdrop } = open({ confirmClose: () => false });
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still closes on Escape even when confirmClose returns false', () => {
    const { onClose } = open({ confirmClose: () => false });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('locks body scroll while open and restores it on unmount', () => {
    const { unmount } = render(
      <Modal labelId="t" onClose={jest.fn()}>
        <h2 id="t">Edit</h2>
      </Modal>
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});
