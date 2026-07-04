import { Spinner } from 'mylibrary-frontend';

const row: React.CSSProperties = {
  display: 'flex',
  gap: 24,
  alignItems: 'center',
  padding: 32,
};

export const Sizes = () => (
  <div style={row}>
    <Spinner size="sm" />
    <Spinner size="md" />
    <Spinner size="lg" />
  </div>
);

export const InlineWithLabel = () => (
  <div style={{ ...row, gap: 10 }}>
    <Spinner size="sm" />
    <span style={{ color: 'var(--muted)', fontSize: 14 }}>Reading between your lines…</span>
  </div>
);
