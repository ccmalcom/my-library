import { Card, Badge } from 'mylibrary-frontend';

const wrap: React.CSSProperties = { display: 'grid', gap: 16, padding: 24, maxWidth: 420 };

export const Default = () => (
  <div style={wrap}>
    <Card>
      <p style={{ fontWeight: 600, color: 'var(--text)', margin: 0 }}>The Left Hand of Darkness</p>
      <p style={{ color: 'var(--muted)', fontSize: 14, margin: '4px 0 0' }}>Ursula K. Le Guin · 1969</p>
    </Card>
  </div>
);

export const Elevated = () => (
  <div style={wrap}>
    <Card elevated>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p style={{ fontWeight: 600, color: 'var(--text)', margin: 0 }}>Piranesi</p>
        <Badge variant="success">Loved</Badge>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 14, margin: '8px 0 0' }}>
        A labyrinth, an innocent narrator, and a slow, luminous unravelling.
      </p>
    </Card>
  </div>
);
