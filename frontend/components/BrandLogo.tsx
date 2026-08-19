import Image from 'next/image';

interface BrandLogoProps {
  alt?: string;
  className?: string;
  priority?: boolean;
  sizes?: string;
}

export default function BrandLogo({
  alt = 'ShelfSprite',
  className = '',
  priority = false,
  sizes = '160px',
}: BrandLogoProps) {
  return (
    <Image
      src="/shelfsprite-logo-kit/shelfsprite-logo-dark.svg"
      alt={alt}
      width={1440}
      height={352}
      priority={priority}
      sizes={sizes}
      className={className}
    />
  );
}
