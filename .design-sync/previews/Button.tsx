import { Button } from 'mylibrary-frontend';

const row: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  flexWrap: 'wrap',
  alignItems: 'center',
  padding: 24,
};

export const Variants = () => (
  <div style={row}>
    <Button variant="primary">Get recommendations</Button>
    <Button variant="secondary">Edit profile</Button>
    <Button variant="ghost">Skip for now</Button>
    <Button variant="danger">Remove book</Button>
  </div>
);

export const Sizes = () => (
  <div style={row}>
    <Button size="sm">Small</Button>
    <Button size="md">Medium</Button>
    <Button size="lg">Large</Button>
  </div>
);

export const States = () => (
  <div style={row}>
    <Button loading>Saving…</Button>
    <Button disabled>Unavailable</Button>
    <Button variant="secondary" disabled>
      Locked
    </Button>
  </div>
);
