// CONTRACT: The real proxy.conf.mjs is written by `make env-file` and
// gitignored — Floci mints a new <api-id> on every apply. This documents the
// shape only; nothing reads it. A module and not JSON because /geocode/
// appends an API key that must never be written to disk, and only a module can
// read one at request time. See [[2026-09-06-address-geocoding-proxy-design]]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The key comes from the same .env.local.web CUSTOM box nginx reads, so
// `ng serve` and the container never disagree about which key is in play.
function geoapifyKey() {
  if (process.env.GEOAPIFY_API_KEY) return process.env.GEOAPIFY_API_KEY;
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local.web');
  try {
    const line = readFileSync(envPath, 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith('GEOAPIFY_API_KEY='));
    return line ? line.slice('GEOAPIFY_API_KEY='.length).trim() : '';
  } catch {
    return '';
  }
}

export default {
  // target is localhost:4566 — the HOST port mapping, which is what `ng serve`
  // (running outside Docker) can reach. The container-side equivalent lives in
  // apps/web/nginx.conf and addresses Floci as `floci:4566` instead.
  //
  // The $default stage segment is a LITERAL here. Vite's rewrite performs no
  // expansion, unlike nginx.conf, which must percent-encode it as %24.
  '/v1': {
    target: 'http://localhost:4566',
    secure: false,
    changeOrigin: false,
    rewrite: (path) => path.replace(/^\/v1/, '/restapis/<api-id>/$default/_user_request_/v1'),
  },
  // The `ng serve` twin of nginx.conf's `location /geocode/`.
  '/geocode/': {
    target: 'https://api.geoapify.com',
    secure: true,
    changeOrigin: true,
    // Fail CLOSED on an empty key, answering from here: a keyless call answers
    // 401 AND still burns a request off the free tier. Ending the response
    // inside `bypass` is what stops Vite from proxying it.
    bypass: (req, res) => {
      if (geoapifyKey()) return undefined;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'geocoding_disabled',
          detail:
            'Set GEOAPIFY_API_KEY in the CUSTOM box of .env.local.web, then restart `pnpm dev`',
        }),
      );
      return true;
    },
    rewrite: (path) => {
      const [, query = ''] = path.split('?');
      return `/v1/geocode/autocomplete?${query}&apiKey=${geoapifyKey()}`;
    },
  },
};
