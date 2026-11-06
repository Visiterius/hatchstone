# Vendored co-op client

- **Package:** `peerjs@1.5.5` ([upstream tag](https://github.com/peers/peerjs/tree/v1.5.5))
- **File:** `peerjs-1.5.5.min.js` — 86,948 bytes, unmodified
- **Source:** https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js
- **SHA-256:** `7604d8c31bec4f134b0d15c2d80b1d095ea18af005354f439f14291fcd7b4168`
- **License:** MIT; retained in `peerjs-LICENSE.txt` from
  https://raw.githubusercontent.com/peers/peerjs/v1.5.5/LICENSE

The game serves these bytes from its own origin. There is no runtime CDN request,
package installation, build step, postinstall hook or private credential. The
bundle's optional source map is not included. The service worker caches the client
for offline reload; caching a file is not the same as starting a broker connection.
`coop-invite.js` loads this script only after an explicit host/join action. Solo
play and manual-code co-op do not execute it.

The adapter explicitly configures PeerJS Cloud at `0.peerjs.com:443` and a single
Google STUN URL. It overrides the library's ICE defaults: no bundled/public TURN
credential is used, and no relay availability is promised.

To update, review the new version and license, fetch the exact pinned browser
artifact, record its byte count and SHA-256, update the lazy-loader path and cache
manifest/version, and run the unit, manual-browser and live-invite browser suites.
Do not replace this file with a floating CDN link or silently enable default TURN.
