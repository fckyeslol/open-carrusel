import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // La raíz del workspace, explícita. `render-service/` tiene su propio package.json
  // (es un deployable aparte con sus propias deps) y eso hacía que Turbopack dudara de
  // cuál era la raíz. Fijarla evita que infiera mal y resuelva assets desde otro lugar.
  //
  // Se usa `__dirname` pelado, sin `path.resolve()`: cualquier llamada al filesystem en
  // este archivo dispara el heurístico de Turbopack "se trazó todo el proyecto" y termina
  // metiendo el repo entero en el bundle del server.
  turbopack: { root: __dirname },
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
