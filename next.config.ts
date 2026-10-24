import type { NextConfig } from "next";

const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
];

const nextConfig: NextConfig = {
  // Clear for vinext/Cloudflare builds; keep standalone for Next/Docker.
  output: process.env.VINEXT_BUILD === '1' ? undefined : 'standalone',
  // This app uses lucide-react SVG icons and no <Image>/<img> assets, so skip image optimization overhead.
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: __dirname,
  },
  async headers() {
    return [
      {
        source: '/((?!api/).*)',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
