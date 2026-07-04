import { Field, Input } from 'mylibrary-frontend';

const wrap: React.CSSProperties = { display: 'grid', gap: 20, padding: 24, maxWidth: 380 };

export const WithHint = () => (
  <div style={wrap}>
    <Field label="Display name" hint="Just for the greeting. Change it anytime.">
      {(p) => <Input placeholder="e.g. Alex" {...p} />}
    </Field>
  </div>
);

export const Required = () => (
  <div style={wrap}>
    <Field label="Anthropic API key" required hint="Encrypted on the server, never shown again.">
      {(p) => <Input type="password" placeholder="sk-ant-…" {...p} />}
    </Field>
  </div>
);

export const WithError = () => (
  <div style={wrap}>
    <Field label="Publication year" error="Enter a four-digit year.">
      {(p) => <Input defaultValue="19x9" {...p} />}
    </Field>
  </div>
);
