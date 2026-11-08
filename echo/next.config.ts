import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  webpack: (config, { webpack }) => {
    config.plugins = config.plugins || [];
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /^cloudflare:workers$/,
        path.resolve(process.cwd(), "lib/server/cloudflare-workers-shim.ts")
      ),
      new webpack.NormalModuleReplacementPlugin(
        /playlist-ai\.worker\.ts\?worker&url$/,
        path.resolve(process.cwd(), "app/playlist-ai-worker-url.ts")
      )
    );
    if (Array.isArray(config.externals)) {
      config.externals.push({ "node:sqlite": "commonjs node:sqlite" });
    }
    return config;
  },
};

export default nextConfig;
