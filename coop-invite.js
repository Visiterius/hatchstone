/* HatchstoneInvite: one-link PeerJS data-channel transport. */
(function (root) {
  'use strict';

  const base = typeof module === 'object' && module.exports
    ? require('./coop-link.js')
    : root && root.HatchstoneLink;
  const api = makeApi(root, base);
  if (root) root.HatchstoneInvite = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

function makeApi(root, base) {
  'use strict';

  if (!base || typeof base.Peer !== 'function') throw new Error('HatchstoneLink.Peer is required');
  const BasePeer = base.Peer;
  const TOKEN_RE = /^v2\.([0-9a-f]{24})\.([0-9a-f]{32})$/;
  const MAX_INPUT_CHARS = 2048;
  const MAX_HANDSHAKE_BYTES = 1024;
  const REGISTRATION_TIMEOUT_MS = 12000;
  const JOIN_TIMEOUT_MS = 30000;
  const HANDSHAKE_TIMEOUT_MS = 5000;
  const INVITE_TTL_MS = 10 * 60 * 1000;
  const MAX_PENDING = 3;
  const BROKER_OPTIONS = Object.freeze({
    host: '0.peerjs.com',
    port: 443,
    secure: true,
    debug: 0,
    config: Object.freeze({ iceServers: Object.freeze([{ urls: 'stun:stun.l.google.com:19302' }]) }),
  });
  const SHARE_TEXT = 'Join me in Hatchstone co-op';

  let peerScriptPromise = null;

  function fail(message) { throw new Error(message); }

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function ownKeysEqual(value, expected) {
    if (!isPlainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const wanted = expected.slice().sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
    if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(text, 'utf8'));
    const encoded = unescape(encodeURIComponent(text));
    const bytes = new Uint8Array(encoded.length);
    for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i);
    return bytes;
  }

  function hasControlCharacters(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
  }

  function validateToken(token) {
    if (typeof token !== 'string' || token.length > MAX_INPUT_CHARS || !TOKEN_RE.test(token)) {
      fail('Invalid co-op invite token');
    }
    return token;
  }

  function randomHex(byteLength) {
    const bytes = new Uint8Array(byteLength);
    if (root && root.crypto && typeof root.crypto.getRandomValues === 'function') {
      root.crypto.getRandomValues(bytes);
    } else if (typeof require === 'function') {
      let crypto;
      try { crypto = require('crypto'); } catch (_) { crypto = null; }
      if (!crypto || typeof crypto.randomBytes !== 'function') fail('Secure randomness is unavailable');
      bytes.set(crypto.randomBytes(byteLength));
    } else {
      fail('Secure randomness is unavailable');
    }
    let result = '';
    for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
    return result;
  }

  function makeToken() {
    return 'v2.' + randomHex(12) + '.' + randomHex(16);
  }

  function parseInvite(input) {
    if (typeof input !== 'string' || input.length === 0 || input.length > MAX_INPUT_CHARS || hasControlCharacters(input)) {
      fail('Invalid co-op invite');
    }
    if (TOKEN_RE.test(input)) return input;
    let url;
    try { url = new URL(input); } catch (_) { fail('Invalid co-op invite URL'); }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.origin === 'null') {
      fail('Unsupported co-op invite URL');
    }
    const fragment = url.hash;
    if (!fragment.startsWith('#coop=')) fail('Co-op invite fragment is missing');
    const token = fragment.slice('#coop='.length);
    if (fragment !== '#coop=' + token) fail('Invalid co-op invite fragment');
    return validateToken(token);
  }

  function parseHttpUrl(input, message) {
    if (typeof input !== 'string' || input.length === 0 || input.length > MAX_INPUT_CHARS || hasControlCharacters(input)) {
      fail(message);
    }
    let url;
    try { url = new URL(input); } catch (_) { fail(message); }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.origin === 'null') {
      fail(message);
    }
    return url;
  }

  function inviteUrl(baseUrl, token) {
    validateToken(token);
    const url = parseHttpUrl(baseUrl, 'Invalid co-op base URL');
    url.search = '';
    url.hash = '#coop=' + token;
    return url.toString();
  }

  function telegramUrl(link) {
    const url = parseHttpUrl(link, 'Invalid co-op invite URL');
    const value = url.toString();
    return 'https://t.me/share/url?url=' + encodeURIComponent(value) + '&text=' + encodeURIComponent(SHARE_TEXT);
  }

  function friendlyError(reason) {
    const value = String(reason && (reason.code || reason.type || reason.message) || reason || '').toLowerCase();
    if (value.includes('expired')) return 'This invite has expired. Ask your friend to create a fresh link and keep their game tab open.';
    if (value.includes('full') || value.includes('duplicate')) return 'This invite already has a guest. Ask your friend for a fresh link.';
    if (value.includes('peer-unavailable') || value.includes('invalid-handshake')) return 'That invite is no longer available. Ask for a fresh link and keep both game tabs open.';
    if (value.includes('join-timeout') || value.includes('channel') || value.includes('webrtc')) return 'The direct connection failed. Try another network and a fresh invite; this game has no TURN relay.';
    if (value.includes('offline')) return 'You appear to be offline. Check your connection, then create a fresh invite.';
    return 'Could not reach the signaling service. Try again or use Advanced manual codes; some networks need a relay this game does not provide.';
  }

  function brokerOptions() {
    return {
      host: BROKER_OPTIONS.host,
      port: BROKER_OPTIONS.port,
      secure: BROKER_OPTIONS.secure,
      debug: BROKER_OPTIONS.debug,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
    };
  }

  function onEvent(target, name, handler) {
    if (!target || typeof target.on !== 'function') fail('PeerJS connection is invalid');
    target.on(name, handler);
  }

  function closeConnection(connection) {
    try { if (connection && typeof connection.close === 'function') connection.close(); } catch (_) {}
  }

  function validHello(data, room, secret) {
    if (typeof data !== 'string' || data.length > MAX_HANDSHAKE_BYTES || utf8Bytes(data).length > MAX_HANDSHAKE_BYTES) return false;
    let message;
    try { message = JSON.parse(data); } catch (_) { return false; }
    return ownKeysEqual(message, ['type', 'v', 'room', 'secret']) &&
      message.type === 'hello' && message.v === 2 && message.room === room && message.secret === secret;
  }

  function validHelloOk(data, room) {
    if (typeof data !== 'string' || data.length > MAX_HANDSHAKE_BYTES || utf8Bytes(data).length > MAX_HANDSHAKE_BYTES) return false;
    let message;
    try { message = JSON.parse(data); } catch (_) { return false; }
    return ownKeysEqual(message, ['type', 'v', 'room']) &&
      message.type === 'hello-ok' && message.v === 2 && message.room === room;
  }

  function loadPeerJs() {
    if (root && typeof root.Peer === 'function') return Promise.resolve(root.Peer);
    const document = root && root.document;
    if (!document || typeof document.createElement !== 'function') {
      return Promise.reject(new Error('PeerJS is unavailable'));
    }
    if (peerScriptPromise) return peerScriptPromise;
    peerScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let timer = setTimeout(() => finish(new Error('PeerJS failed to load')), REGISTRATION_TIMEOUT_MS);
      let done = false;
      const finish = error => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (error) {
          try { if (script.parentNode) script.parentNode.removeChild(script); } catch (_) {}
          reject(error);
        } else if (root && typeof root.Peer === 'function') {
          resolve(root.Peer);
        } else {
          try { if (script.parentNode) script.parentNode.removeChild(script); } catch (_) {}
          reject(new Error('PeerJS did not expose Peer'));
        }
      };
      script.async = true;
      script.src = new URL('vendor/peerjs-1.5.5.min.js', document.baseURI || (root.location && root.location.href) || 'http://localhost/').href;
      script.onload = () => finish();
      script.onerror = () => finish(new Error('PeerJS failed to load'));
      const parent = document.head || document.documentElement;
      if (!parent || typeof parent.appendChild !== 'function') finish(new Error('Cannot load PeerJS'));
      else parent.appendChild(script);
    }).catch(error => {
      peerScriptPromise = null;
      throw error;
    });
    return peerScriptPromise;
  }

  class Peer extends BasePeer {
    constructor(options = {}) {
      if (!isPlainObject(options)) fail('Peer options must be an object');
      super(options);
      this._brokerFactory = options.brokerFactory || null;
      this._broker = null;
      this._brokerDetached = false;
      this._brokerDestroyed = false;
      this._pendingReject = null;
      this._pendingResolve = null;
      this._registrationTimer = null;
      this._joinTimer = null;
      this._expiryTimer = null;
      this._pendingCandidates = new Map();
      this._secret = null;
      this._token = null;
      this._guestConnection = null;
    }

    _assertInviteAlive(generation) {
      if (this._closed || generation !== this._generation) fail('Peer is closed');
    }

    _clearTimer(name) {
      if (this[name]) {
        clearTimeout(this[name]);
        this[name] = null;
      }
    }

    _setPendingReject(reject) {
      this._pendingReject = reject;
    }

    _clearPendingReject(error) {
      const reject = this._pendingReject;
      this._pendingReject = null;
      if (reject) reject(error || new Error('Peer is closed'));
    }

    async _createBroker(id, generation) {
      let Constructor;
      if (!this._brokerFactory) {
        // Closing during the shared lazy load cancels this caller immediately.
        // The script itself does not create a connection and may be reused on retry.
        Constructor = await new Promise((resolve, reject) => {
          const finish = (error, value) => {
            if (this._pendingReject === cancel) this._pendingReject = null;
            if (error) reject(error); else resolve(value);
          };
          const cancel = error => finish(error);
          this._pendingReject = cancel;
          loadPeerJs().then(value => finish(null, value), finish);
        });
      }
      this._assertInviteAlive(generation);
      const broker = this._brokerFactory ? this._brokerFactory(id, brokerOptions()) : new Constructor(id, brokerOptions());
      if (!broker || typeof broker.on !== 'function') fail('PeerJS broker is invalid');
      this._broker = broker;
      this._brokerDetached = false;
      onEvent(broker, 'error', error => {
        if (this._closed || generation !== this._generation || this._brokerDetached) return;
        const reason = error && (error.type || error.code || error.message) || 'signaling-error';
        this._fail(reason);
      });
      onEvent(broker, 'call', call => closeConnection(call)); // Data only: never answer/capture media.
      onEvent(broker, 'disconnected', () => {
        if (!this._closed && !this._brokerDetached && generation === this._generation) this._fail('signaling-disconnected');
      });
      onEvent(broker, 'close', () => {
        if (!this._closed && !this._brokerDetached && generation === this._generation) this._fail('signaling-closed');
      });
      if (this.role === 'host') {
        onEvent(broker, 'connection', connection => this._receiveCandidate(connection, generation));
      }
      return broker;
    }

    _waitForBrokerOpen(broker, generation) {
      return new Promise((resolve, reject) => {
        let done = false;
        const pendingReject = error => finish(error || new Error('Peer is closed'));
        const finish = (error, value) => {
          if (done) return;
          done = true;
          this._clearTimer('_registrationTimer');
          if (this._pendingReject === pendingReject) this._pendingReject = null;
          if (error) reject(error); else resolve(value);
        };
        this._setPendingReject(pendingReject);
        const onOpen = id => {
          if (this._closed || generation !== this._generation) return;
          finish(null, id);
        };
        const onError = error => finish(new Error(String(error && (error.type || error.message) || 'Peer registration failed')));
        onEvent(broker, 'open', onOpen);
        onEvent(broker, 'error', onError);
        this._registrationTimer = setTimeout(() => finish(new Error('Peer registration timed out')), REGISTRATION_TIMEOUT_MS);
        if (broker.open === true) queueMicrotask(() => onOpen(broker.id));
      });
    }

    async host() {
      if (this._closed) fail('Peer is closed');
      if (this.role !== null) fail('Peer already has a role');
      const token = makeToken();
      this.role = 'host';
      this.room = token.slice(3, 27);
      this._secret = token.slice(28);
      this._token = token;
      const generation = ++this._generation;
      this._setStatus('connecting');
      try {
        const broker = await this._createBroker('hatchstone2-' + this.room, generation);
        await this._waitForBrokerOpen(broker, generation);
        this._assertInviteAlive(generation);
        this._expiryTimer = setTimeout(() => {
          if (!this._closed && !this.connected) this._fail('expired');
        }, INVITE_TTL_MS);
        return token;
      } catch (error) {
        if (this._closed) throw new Error('Peer is closed');
        this._fail('signaling-error');
        throw error;
      }
    }

    async join(input) {
      if (this._closed) fail('Peer is closed');
      if (this.role !== null) fail('Peer already has a role');
      const token = parseInvite(input);
      this.role = 'guest';
      this.room = token.slice(3, 27);
      this._secret = token.slice(28);
      this._token = token;
      const generation = ++this._generation;
      this._setStatus('connecting');
      this._joinTimer = setTimeout(() => {
        if (!this._closed && !this.connected) this._fail('join-timeout');
      }, JOIN_TIMEOUT_MS);
      try {
        const broker = await this._createBroker('hatchstone2-guest-' + randomHex(12), generation);
        await this._waitForBrokerOpen(broker, generation);
        this._assertInviteAlive(generation);
        if (!broker || typeof broker.connect !== 'function') fail('PeerJS broker cannot connect');
        const connection = broker.connect('hatchstone2-' + this.room, {
          label: 'hatchstone',
          reliable: true,
          serialization: 'raw',
          metadata: { v: 2, room: this.room },
        });
        this._attachGuestConnection(connection, generation);
        await this._waitForGuestAuth(generation);
        this._assertInviteAlive(generation);
      } catch (error) {
        if (this._closed) throw new Error('Peer is closed');
        this._fail(error && error.message === 'Peer registration timed out' ? 'offline' : 'signaling-error');
        throw error;
      }
    }

    _receiveCandidate(connection, generation) {
      if (!connection || this._closed || generation !== this._generation || this._accepted) {
        closeConnection(connection);
        return;
      }
      if (this._pendingCandidates.size >= MAX_PENDING || connection.label !== 'hatchstone' ||
          connection.serialization !== 'raw' || !ownKeysEqual(connection.metadata, ['v', 'room']) ||
          connection.metadata.v !== 2 || connection.metadata.room !== this.room) {
        closeConnection(connection);
        return;
      }
      const state = { connection, authenticated: false, timer: null };
      this._pendingCandidates.set(connection, state);
      const rejectCandidate = reason => {
        if (!this._pendingCandidates.has(connection)) return;
        this._pendingCandidates.delete(connection);
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        closeConnection(connection);
        return reason;
      };
      const onData = data => {
        if (this._closed || generation !== this._generation) return;
        if (state.authenticated) {
          if (this._channel === connection.dataChannel) this._receive(data);
          return;
        }
        if (!this._pendingCandidates.has(connection)) return; // A rejected candidate cannot authenticate via a late callback.
        if (!validHello(data, this.room, this._secret) || this._accepted || !connection.dataChannel ||
            connection.dataChannel.readyState !== 'open') return rejectCandidate('invalid-handshake');
        state.authenticated = true;
        this._pendingCandidates.delete(connection);
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        let sent = true;
        try { connection.send(JSON.stringify({ type: 'hello-ok', v: 2, room: this.room })); } catch (_) { sent = false; }
        if (!sent) {
          state.authenticated = false;
          closeConnection(connection);
          return;
        }
        this._accepted = true;
        this._channel = connection.dataChannel;
        this.connected = true;
        this._setStatus('connected');
        this._clearTimer('_expiryTimer');
        for (const candidate of this._pendingCandidates.values()) {
          if (candidate.timer) clearTimeout(candidate.timer);
          candidate.timer = null;
          closeConnection(candidate.connection);
        }
        this._pendingCandidates.clear();
        this._disconnectBroker();
      };
      const onClose = () => {
        if (this._closed) return;
        if (state.authenticated && this._channel === connection.dataChannel) this._fail('channel-closed');
        else rejectCandidate('candidate-closed');
      };
      const onError = () => {
        if (this._closed) return;
        if (state.authenticated && this._channel === connection.dataChannel) this._fail('channel-error');
        else rejectCandidate('candidate-error');
      };
      try {
        onEvent(connection, 'data', onData);
        onEvent(connection, 'close', onClose);
        onEvent(connection, 'error', onError);
      } catch (_) {
        rejectCandidate('invalid-connection');
        return;
      }
      state.timer = setTimeout(() => rejectCandidate('handshake-timeout'), HANDSHAKE_TIMEOUT_MS);
    }

    _attachGuestConnection(connection, generation) {
      if (!connection) fail('PeerJS returned no connection');
      this._guestConnection = connection;
      const state = { authenticated: false };
      const onOpen = () => {
        if (this._closed || generation !== this._generation || state.authenticated) return;
        try {
          connection.send(JSON.stringify({ type: 'hello', v: 2, room: this.room, secret: this._secret }));
        } catch (_) {
          this._fail('channel-error');
        }
      };
      const onData = data => {
        if (this._closed || generation !== this._generation) return;
        if (state.authenticated) return this._receive(data);
        if (!validHelloOk(data, this.room) || !connection.dataChannel || connection.dataChannel.readyState !== 'open') {
          closeConnection(connection);
          this._fail('invalid-handshake');
          return;
        }
        state.authenticated = true;
        this._channel = connection.dataChannel;
        this.connected = true;
        this._setStatus('connected');
        this._clearTimer('_joinTimer');
        this._disconnectBroker();
        if (this._pendingReject) {
          const resolve = this._pendingResolve;
          this._pendingReject = null;
          this._pendingResolve = null;
          if (resolve) resolve();
        }
      };
      const onClose = () => {
        if (!this._closed && state.authenticated) this._fail('channel-closed');
        else if (!this._closed) this._fail('channel-closed');
      };
      const onError = () => { if (!this._closed) this._fail('channel-error'); };
      onEvent(connection, 'open', onOpen);
      onEvent(connection, 'data', onData);
      onEvent(connection, 'close', onClose);
      onEvent(connection, 'error', onError);
      if (connection.open === true) queueMicrotask(onOpen);
    }

    _waitForGuestAuth(generation) {
      return new Promise((resolve, reject) => {
        if (this._closed || generation !== this._generation) return reject(new Error('Peer is closed'));
        if (this.connected) return resolve();
        this._pendingResolve = resolve;
        this._setPendingReject(error => {
          this._pendingResolve = null;
          reject(error || new Error('Peer is closed'));
        });
      });
    }

    _disconnectBroker() {
      if (!this._broker || this._brokerDetached) return;
      this._brokerDetached = true;
      try { if (typeof this._broker.disconnect === 'function') this._broker.disconnect(); } catch (_) {}
    }

    _destroyBroker() {
      if (!this._broker || this._brokerDestroyed) return;
      this._brokerDetached = true;
      this._brokerDestroyed = true;
      try {
        if (typeof this._broker.destroy === 'function') this._broker.destroy();
        else if (typeof this._broker.disconnect === 'function') this._broker.disconnect();
      } catch (_) {}
    }

    close(reason = 'closed') {
      if (this._closed) return;
      // Mark the base closed before PeerJS emits synchronous cleanup callbacks.
      super.close(reason);
      this._clearTimer('_registrationTimer');
      this._clearTimer('_joinTimer');
      this._clearTimer('_expiryTimer');
      this._clearPendingReject(new Error('Peer is closed'));
      for (const state of this._pendingCandidates.values()) {
        if (state.timer) clearTimeout(state.timer);
        closeConnection(state.connection);
      }
      this._pendingCandidates.clear();
      closeConnection(this._guestConnection);
      this._guestConnection = null;
      this._secret = this._token = null;
      this._destroyBroker();
    }
  }

  return { Peer, parseInvite, inviteUrl, telegramUrl, friendlyError };
}
