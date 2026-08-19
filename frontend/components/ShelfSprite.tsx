import Image from 'next/image';

const spriteSources = {
  analyze: '/shelfsprite-analyze.png',
  discover: '/shelfsprite-discover.png',
  sleep: '/shelfsprite-sleep.png',
  success: '/shelfsprite-success.png',
} as const;

export type ShelfSpriteVariant = keyof typeof spriteSources;

interface ShelfSpriteProps {
  variant: ShelfSpriteVariant;
  className?: string;
  priority?: boolean;
  sizes?: string;
}

/** Brand illustrations are decorative; the adjacent UI copy names the state. */
export default function ShelfSprite({
  variant,
  className = '',
  priority = false,
  sizes = '144px',
}: ShelfSpriteProps) {
  return (
    <Image
      src={spriteSources[variant]}
      alt=""
      aria-hidden="true"
      width={512}
      height={512}
      priority={priority}
      sizes={sizes}
      className={className}
    />
  );
}
