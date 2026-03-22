import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  serverExternalPackages: ['tavori'],
  // Explicitly set workspace root to suppress lockfile detection warning
  outputFileTracingRoot: path.join(__dirname, '../'),
};

export default nextConfig;
