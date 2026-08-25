export default {
  // allowedHosts lets a Cloudflare tunnel hostname reach the dev/preview server;
  // without it Vite rejects the request as an unknown host.
  server: { port: 5180, host: true, allowedHosts: true },
  preview: { port: 4173, host: true, allowedHosts: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
}
