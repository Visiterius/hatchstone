# Hatchstone

A tiny ASMR game for the browser and phones: crack open glossy stone eggs and find
what's glowing inside. 🎧 Best with headphones.

- Trace the faint glowing lines to crack the stone; tap to knock little chips off
- 24 levels in four caves (plus endless Wander): more cracks, knots to tap and hard
  stone to trace twice; 1–3 stars for staying on the line and for speed
- 17 real geodes (amethyst, celestite, agate, malachite, labradorite, lapis lazuli…),
  each drawn the way the mineral looks, with a real fact on the card
- Every geode holds a glowling: 26 species built from wings, ears, horns, tails and
  patterns, each with its own lore, voice and favorite snack, plus rare shiny ones
- The nest: feed, pet, play a sparkle-catch mini-game and put them to sleep; needs drift
  in real time (nobody ever dies), and glowlings level up to 20 and grow Baby → Young →
  Grown → Radiant
- Knock on the stone to find its hollow spot, and polish each opened geode to a shine
- The nest is a little cave room where all your glowlings roam, nap, dance, visit each
  other and come when you call; decorate it with shards (lamp, mushrooms, cloud cushion,
  starry rug, geode shelf, moon spring, moon swing, fairy lights) and each kind of
  glowling has favorites it goes to play with
- Breeding: two happy glowlings at level 5+ can lay a mixed egg in the incubator; it
  hatches in about 3 real hours (stroke it to keep it warm), and the baby mixes their
  parts, colors and names, sometimes with a surprise trait
- The Glowpedia collects every glowling, geode and hybrid you've found
- Canvas and the Web Audio API, with small local modules for optional online
  co-op; every sound (crackles, the stone "tok", crystal chimes and grotto ambience)
  is synthesized live. One-link invites lazily load a locally vendored PeerJS client;
  solo play and the advanced manual connection do not load it.

## Play locally

```sh
python3 -m http.server 8000
```

then visit http://localhost:8000.

## Online co-op (two devices)

Choose **Play together** on the title screen or open the co-op control in the grotto.
Both devices need the same game version, served over HTTPS or localhost.

1. The host chooses **Create invite link**, then **Send via Telegram** (or **Copy
   link** for any private messenger). Keep the hosting tab open.
2. The guest opens the link and taps **Join friend**. That is the entire exchange:
   no generated reply, account, bot, Telegram login or room-code typing. Opening
   a link only displays the invitation; it does not connect until that tap.
3. When **Friend joined** appears, the host chooses a difficulty and **Start shared
   egg**. Both tabs must stay open; switching apps or locking a phone can suspend
   browser connections. If Telegram's in-app browser lacks WebRTC, open the link
   in Chrome or Safari instead.
4. Either player can trace, tap knots, open the shell or polish. Both see the same
   egg and glowling. Each receives the hatch in their **own existing local nest**;
   neither save is sent to the other device. Co-op does not unlock campaign levels
   or replace moon-egg progress.
5. The host can start another shared egg. **Leave**, returning to the grotto/nest,
   or losing the connection ends the session. Unfinished eggs grant no reward;
   completed hatchlings remain saved. Reconnect with a **fresh** invite. Links are
   for one guest and expire after 10 minutes of waiting or when the host leaves.

**Why a signaling service?** Browser connection details cannot simply be replaced
with a tiny code on a static site: something must exchange the offer and answer.
One-link invites use the free, shared [PeerJS Cloud](https://peerjs.com/server/cloud)
service at `0.peerjs.com:443` for that exchange; there is no app-owned backend,
paid account, credential or deployment to configure. It is an external dependency,
not a guaranteed-uptime service. Telegram's [share helper](https://core.telegram.org/widgets/share)
only delivers the invitation; it is **not** the signaling server or a game relay.
The pinned MIT PeerJS client is served locally, not from a CDN at runtime (see
[`vendor/README.md`](vendor/README.md)). Solo play never opens a signaling connection.

**Advanced / no signaling service:** The previous two-way code method remains in
**Advanced**. The host chooses **Host with manual codes** and sends the invite code;
the guest chooses **Join with manual code** and returns the reply; the host pastes
it and chooses **Accept guest**, then **Start shared egg**. Both players must use
the same method. This fallback bypasses PeerJS, not WebRTC's network restrictions.

**Privacy and connectivity:** Gameplay uses an encrypted, data-only WebRTC channel;
there is no camera or microphone capture. Hosting/joining contacts Google's public
STUN server (`stun.l.google.com:19302`) to discover connectivity candidates. PeerJS
Cloud sees signaling metadata (peer IDs, SDP and ICE network candidates), not just
an anonymous short code; your connected peer may learn your network addresses.
Treat the link as a temporary bearer invitation and send it privately. It has a
random room ID and a separate random secret checked over the data channel before
any gameplay is accepted. The secret is not in signaling metadata. The fragment
is not sent in the page's HTTP request and is removed from this tab's URL on Join
or Close; messengers and anyone you share it with still receive the full link.
Invites are not saved in localStorage and contain no nest or player identity. This
is not account authentication or protection from a compromised signaling service.

There is **no relay/TURN service**. Restrictive firewalls and some mobile/symmetric
NAT combinations can still prevent a connection; automatic signaling does not fix
that. Try another network if it fails. Solo play still works without WebRTC or
internet once cached; online co-op requires connectivity.

## Verification

Tests need **Node.js 22 or newer**; there are no npm dependencies to install:

```sh
npm test
npm run check
```

The browser smoke additionally needs an **already installed** Chrome, Chromium or
Edge. It launches a separate temporary headless profile, never your normal browser
profile, and drives two isolated storage contexts using CDP:

```sh
npm run test:e2e     # Manual exchange; no external signaling broker
npm run test:invites # One-link flow; requires live public PeerJS signaling
```

The invite suite reuses the complete gameplay regression with a fresh guest
navigation through the invite link. It also checks explicit-Join consent, the
Telegram share URL (without sending any Telegram message), malformed invitations,
no-broker startup, cancellation and actionable offline failure. It is intentionally
separate: public signaling availability must not be confused with deterministic
unit/manual-path regressions. To demonstrate the feature test fails on the pinned
pre-change page, run (an expected assertion failure, not a normal quality gate):

```sh
HATCHSTONE_BASELINE=1 HATCHSTONE_BASE_REF=a3fa775 npm run test:invites
```

The Telegram phone-client picker/send and two physical devices on different
networks still need a manual check. Browser share-URL assertions are not evidence
that a Telegram message was sent.

Set `CHROME_PATH` to the browser executable if automatic detection fails. The test
serves a loopback `/hatchstone/` path, like GitHub Pages, and exercises actual WebRTC
signaling/data channels, shared input and hatching, independent saves, resize and
disconnect behavior, solo play and offline reload. It does **not** certify
cross-network/NAT compatibility or replace testing on two physical devices. No
browser or model is downloaded; no backend is deployed.

## Install on a phone

Hatchstone is a small web app: open it in Safari (iPhone) or Chrome (Android) and choose
**Share → Add to Home Screen** / **Install app**. It opens full screen and works offline.
Your nest, glowlings and progress are saved on the device. Tap 💾 for a backup code
(copy, share or save as a file) and paste it on any device to bring your nest back.

## Hosting on GitHub Pages

Everything Pages needs is here: `index.html`, `coop-link.js`, `coop-state.js`,
`manifest.webmanifest`, `sw.js`, `icons/`,
`og-image.jpg` (the share preview) and `.nojekyll`. With the repository public:
Settings → Pages → Deploy from a branch → `main`, `/ (root)`. The game then lives at
`https://helavika.github.io/hatchstone/`; the share tags in `index.html` point there.
Bump `CACHE` in `sw.js` when cached JavaScript or icons change.
