import { useEffect } from 'react';
import { ToastProvider, useToast } from 'mylibrary-frontend';

function Demo() {
  const toast = useToast();
  // Fire one of each type on mount so the card shows the real toast visuals.
  useEffect(() => {
    toast.success('Added “Dune” to your shelf');
    toast.error('Couldn’t reach the catalog — try again');
    toast.info('Your taste profile is up to date');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Tall in-flow content so the fixed toast stack anchors bottom-right of a real frame.
  return (
    <div style={{ minHeight: 340, padding: 24 }}>
      <p style={{ margin: 0, fontWeight: 600, color: 'var(--text)' }}>Your library</p>
      <p style={{ marginTop: 8, fontSize: 13, color: 'var(--faint)' }}>
        Toasts appear bottom-right and auto-dismiss.
      </p>
    </div>
  );
}

export const Notifications = () => (
  <ToastProvider>
    <Demo />
  </ToastProvider>
);
