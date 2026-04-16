import type { NextConfig } from "next";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  async rewrites() {
    // Proxy API paths to Nest; otherwise client-side fetches to the same origin would 404 on Next.
    return [
      { source: "/api/amazon/:path*", destination: `${apiUrl}/api/amazon/:path*` },
      { source: "/api/repricer/:path*", destination: `${apiUrl}/api/repricer/:path*` },
    ];
  },
};

export default nextConfig;
