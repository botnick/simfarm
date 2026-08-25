// Where the game will be served from. Everything in here asks for its assets by
// an absolute path, which is right at the root of a domain and wrong anywhere
// else: served under /simfarm/ the bundle, the fonts and the artwork all
// resolve one directory too high and 404, with no error the player can read.
// Left unset it stays '/', which is what a root deploy wants.
//
//   VITE_BASE=/simfarm/ npm run build
const base = process.env.VITE_BASE || '/'

export default {
  base,
  // allowedHosts lets a Cloudflare tunnel hostname reach the dev/preview server;
  // without it Vite rejects the request as an unknown host.
  server: { port: 5180, host: true, allowedHosts: true },
  preview: { port: 4173, host: true, allowedHosts: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
}
