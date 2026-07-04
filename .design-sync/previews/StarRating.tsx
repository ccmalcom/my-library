import { StarRating } from 'mylibrary-frontend';

const wrap: React.CSSProperties = { display: 'grid', gap: 16, padding: 28 };

export const Ratings = () => (
  <div style={wrap}>
    <StarRating value={5} readOnly />
    <StarRating value={4} readOnly />
    <StarRating value={2} readOnly />
  </div>
);

export const Interactive = () => (
  <div style={wrap}>
    <StarRating value={4} size={28} />
  </div>
);

export const Larger = () => (
  <div style={wrap}>
    <StarRating value={3} max={5} size={32} readOnly />
  </div>
);
