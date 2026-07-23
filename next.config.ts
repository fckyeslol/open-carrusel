import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "sharp",
    "archiver",
    "puppeteer",
    // Quitar fondo: modelo ONNX + binarios nativos — no se pueden bundlear
    "@imgly/background-removal-node",
    "onnxruntime-node",
  ],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "img-src 'self' data: blob: https:",
              "frame-src 'self' blob:",
              "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
