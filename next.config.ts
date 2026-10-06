import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // `standalone` produces a self-contained server bundle, which is what the
  // cPanel "Setup Node.js App" deployment path uses. Harmless on Vercel.
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // This app renders no images, so the built-in optimizer (and its native
  // image dependencies) are never invoked.
  images: {
    unoptimized: true,
  },
  serverExternalPackages: ['postgres'],
  eslint: {
    dirs: ['src'],
  },
};

export default nextConfig;