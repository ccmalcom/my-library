import { Modal, Button } from 'mylibrary-frontend';

const panel: React.CSSProperties = {
  width: 420,
  maxWidth: '90vw',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  padding: 24,
};

export const ConfirmDialog = () => (
  <Modal labelId="modal-title" onClose={() => {}}>
    {/* Top padding keeps the panel (and its title) clear of the card's top edge. */}
    <div style={{ paddingTop: 72 }}>
      <div style={panel}>
        <h2 id="modal-title" style={{ margin: 0, color: 'var(--text)', fontSize: 18, fontWeight: 700 }}>
          Remove this book?
        </h2>
        <p style={{ color: 'var(--muted)', fontSize: 14, margin: '8px 0 20px' }}>
          “Piranesi” will be permanently deleted from your library. This can’t be undone.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger">Remove</Button>
        </div>
      </div>
    </div>
  </Modal>
);
