import { Textarea } from 'mylibrary-frontend';

const wrap: React.CSSProperties = { display: 'grid', gap: 12, padding: 24, maxWidth: 380 };

export const Default = () => (
  <div style={wrap}>
    <Textarea rows={4} placeholder="Say it your way — this feeds your recommendations directly." />
  </div>
);

export const Filled = () => (
  <div style={wrap}>
    <Textarea
      rows={4}
      defaultValue="You'll forgive a slow plot if the people feel real — every Le Guin, every Robinson, rated five."
    />
  </div>
);

export const Disabled = () => (
  <div style={wrap}>
    <Textarea rows={3} defaultValue="Review locked until this book is rated." disabled />
  </div>
);
