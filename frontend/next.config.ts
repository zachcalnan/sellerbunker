import type { NextConfig } from "next";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  async rewrites() {
    // Only proxy /api/amazon/* to the backend; /api/checkout and /api/contact stay on frontend
    return [{ source: "/api/amazon/:path*", destination: `${apiUrl}/api/amazon/:path*` }];
  },
};

export default nextConfig;
