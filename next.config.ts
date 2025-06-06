import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**',
      },
    ],
  },
  // Attempt to fix module not found errors for Node.js modules in Server Components
  experimental: {
    // Ensure necessary Node.js modules used by server-side functions are externalized
    serverComponentsExternalPackages: ['socks-proxy-agent', 'node-fetch-native'],
  },
};

export default nextConfig;
