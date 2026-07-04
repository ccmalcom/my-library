import { Input } from 'mylibrary-frontend';

const wrap: React.CSSProperties = { display: 'grid', gap: 12, padding: 24, maxWidth: 360 };

export const Default = () => (
  <div style={wrap}>
    <Input placeholder="Search your library…" />
  </div>
);

export const Filled = () => (
  <div style={wrap}>
    <Input defaultValue="Le Guin" />
  </div>
);

export const Invalid = () => (
  <div style={wrap}>
    <Input defaultValue="not-a-year" aria-invalid />
  </div>
);

export const Disabled = () => (
  <div style={wrap}>
    <Input defaultValue="Locked field" disabled />
  </div>
);
