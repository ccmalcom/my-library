/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      // Open Library covers
      { protocol: "https", hostname: "covers.openlibrary.org" },
      // Google Books thumbnails
      { protocol: "https", hostname: "books.google.com" },
      { protocol: "http",  hostname: "books.google.com" },
      // Allow any https source as fallback (personal tool, no security concern)
      { protocol: "https", hostname: "**" },
    ],
  },
};

export default nextConfig;
