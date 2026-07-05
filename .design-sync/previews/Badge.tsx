import { Badge } from 'mylibrary-frontend';

const row: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
  alignItems: 'center',
  padding: 24,
};

export const Variants = () => (
  <div style={row}>
    <Badge>To read</Badge>
    <Badge variant="accent">Recommended</Badge>
    <Badge variant="success">Loved</Badge>
    <Badge variant="danger">Did not finish</Badge>
    <Badge variant="warning">Low confidence</Badge>
    <Badge variant="mono">ICDH</Badge>
  </div>
);

export const InContext = () => (
  <div style={{ ...row, gap: 8 }}>
    <Badge variant="mono">Fantasy</Badge>
    <Badge variant="mono">Literary fiction</Badge>
    <Badge variant="mono">Unreliable narrator</Badge>
    <Badge variant="mono">Slow burn</Badge>
  </div>
);
