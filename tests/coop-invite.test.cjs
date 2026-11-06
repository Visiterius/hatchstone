const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const inviteApi = require('../coop-invite.js');
const { Peer, parseInvite, inviteUrl, telegramUrl, friendlyError } = inviteApi;

class FakeConnection extends EventEmitter {
  constructor(label, options) {
    super();
    this.label = label;
    this.options = options;
    this.metadata = options.metadata;
    this.serialization = options.serialization;
    const owner = this;
    this.dataChannel = {
      get readyState() { return owner.open ? 'open' : 'closed'; },
      bufferedAmount: 0,
      send(value) { owner.send(value); },
      close() { owner.close(); },
    };
    this.open = false;
    this.bufferedAmount = 0;
    this.sent = [];
    this.peer = null;
    this.closed = false;
  }

  send(value) {
    if (this.closed || !this.open) throw new Error('connection is not open');
    this.sent.push(value);
    setImmediate(() => {
      if (!this.peer.closed) this.peer.emit('data', value);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.emit('close');
  }

  openNow() {
    if (this.closed) return;
    this.open = true;
    this.emit('open');
  }
}

class FakeBroker extends EventEmitter {
  static peers = new Map();
  static instances = [];
  static reset() {
    for (const peer of this.peers.values()) peer.destroy();
    this.peers.clear();
    this.instances.length = 0;
  }

  constructor(id, options) {
    super();
    this.id = id;
    this.options = options;
    this.open = false;
    this.destroyed = false;
    this.disconnected = false;
    FakeBroker.peers.set(id, this);
    FakeBroker.instances.push(this);
    setImmediate(() => {
      if (!this.destroyed) {
        this.open = true;
        this.emit('open', id);
      }
    });
  }

  connect(id, options) {
    const target = FakeBroker.peers.get(id);
    if (!target || target.destroyed) {
      const error = new Error('peer unavailable');
      error.type = 'peer-unavailable';
      throw error;
    }
    const mine = new FakeConnection(options.label, options);
    const theirs = new FakeConnection(options.label, options);
    mine.peer = theirs;
    theirs.peer = mine;
    setImmediate(() => {
      if (!this.destroyed && !target.destroyed) {
        target.emit('connection', theirs);
        mine.openNow();
        theirs.openNow();
      }
    });
    return mine;
  }

  disconnect() {
    this.disconnected = true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.open = false;
    if (FakeBroker.peers.get(this.id) === this) FakeBroker.peers.delete(this.id);
    this.emit('close');
  }
}

function brokerFactory(id, options) {
  return new FakeBroker(id, options);
}

function waitForTick() {
  return new Promise(resolve => setImmediate(resolve));
}

test.beforeEach(() => FakeBroker.reset());
test.afterEach(() => FakeBroker.reset());

test('helpers validate v2 tokens and produce deployment-relative share links', () => {
  const token = 'v2.' + 'a'.repeat(24) + '.' + 'b'.repeat(32);
  assert.equal(parseInvite(token), token);
  const link = inviteUrl('http://localhost:8080/hatchstone/index.html?old=1#old', token);
  assert.equal(link, 'http://localhost:8080/hatchstone/index.html#coop=' + token);
  assert.equal(parseInvite(link), token);
  const share = telegramUrl(link);
  assert.match(share, /^https:\/\/t\.me\/share\/url\?url=/);
  assert.match(share, /text=/);
  for (const bad of [
    'v1.' + 'a'.repeat(24) + '.' + 'b'.repeat(32),
    'v2.' + 'A'.repeat(24) + '.' + 'b'.repeat(32),
    'v2.' + 'a'.repeat(24) + '.' + 'b'.repeat(31),
    'https://user:pass@example.test/#coop=' + token,
    'https://example.test/#wrong=' + token,
    'https://example.test/#coop=' + token + '#extra',
    token + '\n',
  ]) assert.throws(() => parseInvite(bad));
  assert.throws(() => inviteUrl('javascript:alert(1)', token), /URL|http/i);
  assert.match(friendlyError('expired'), /expired/i);
  assert.match(friendlyError('full'), /guest|fresh/i);
  assert.match(friendlyError('offline'), /offline|connection/i);
  assert.match(friendlyError('signaling-error'), /signaling|Advanced/i);
  assert.match(friendlyError('join-timeout'), /another network|no TURN/i);
  assert.match(friendlyError('peer-unavailable'), /fresh link/i);
});

test('import and construction do not create a broker or load a script', () => {
  assert.equal(globalThis.HatchstoneInvite.Peer, Peer);
  const peer = new Peer({ brokerFactory });
  assert.equal(peer.role, null);
  assert.equal(peer.room, null);
  assert.equal(peer.connected, false);
  assert.equal(FakeBroker.instances.length, 0);
  peer.close('unused');
});

test('host and guest authenticate over one invite and use the base room envelope', async () => {
  const hostMessages = [];
  const guestMessages = [];
  const host = new Peer({ brokerFactory, onMessage: value => hostMessages.push(value) });
  const guest = new Peer({ brokerFactory, onMessage: value => guestMessages.push(value) });
  const token = await host.host();
  assert.match(token, /^v2\.[0-9a-f]{24}\.[0-9a-f]{32}$/);
  assert.equal(host.role, 'host');
  assert.equal(host.connected, false);
  const joining = guest.join(token);
  await joining;
  assert.equal(guest.role, 'guest');
  assert.equal(guest.room, host.room);
  assert.equal(host.connected, true);
  assert.equal(guest.connected, true);
  assert.equal(FakeBroker.instances[0].options.host, '0.peerjs.com');
  assert.equal(FakeBroker.instances[0].options.port, 443);
  assert.equal(FakeBroker.instances[0].options.secure, true);
  assert.equal(FakeBroker.instances[0].options.debug, 0);
  assert.deepEqual(FakeBroker.instances[0].options.config, {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  const guestBroker = FakeBroker.instances.find(item => item.id.startsWith('hatchstone2-guest-'));
  assert.ok(guestBroker);
  const guestConnection = guest._guestConnection;
  assert.deepEqual(guestConnection.options, {
    label: 'hatchstone',
    reliable: true,
    serialization: 'raw',
    metadata: { v: 2, room: host.room },
  });
  assert.equal(host.send({ kind: 'host-packet' }), true);
  assert.equal(guest.send({ kind: 'guest-packet' }), true);
  await waitForTick();
  await waitForTick();
  assert.deepEqual(hostMessages, [{ kind: 'guest-packet' }]);
  assert.deepEqual(guestMessages, [{ kind: 'host-packet' }]);
  host.close('done');
  guest.close('done');
});

test('wrong stranger handshake is closed without destroying the waiting host', async () => {
  const host = new Peer({ brokerFactory });
  const token = await host.host();
  const stranger = new FakeBroker('hatchstone2-guest-stranger', {
    host: '0.peerjs.com', port: 443, secure: true, debug: 0,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
  });
  await waitForTick();
  const wrong = stranger.connect('hatchstone2-' + token.slice(3, 27), {
    label: 'hatchstone', reliable: true, serialization: 'raw',
    metadata: { v: 2, room: host.room },
  });
  await waitForTick();
  wrong.send(JSON.stringify({ type: 'hello', v: 2, room: host.room, secret: '0'.repeat(32) }));
  await waitForTick();
  assert.equal(host.connected, false);
  const guest = new Peer({ brokerFactory });
  await guest.join(token);
  assert.equal(host.connected, true);
  host.close('done');
  guest.close('done');
  stranger.destroy();
});

test('authenticated channel rejects malformed, binary, oversized, and backpressured packets', async () => {
  const received = [];
  const host = new Peer({ brokerFactory, onMessage: value => received.push(value) });
  const guest = new Peer({ brokerFactory });
  const token = await host.host();
  await guest.join(token);
  const channel = guest._channel;
  host._broker.emit('data', 'ignored'); // Broker events are never gameplay.
  guest._guestConnection.emit('data', new Uint8Array([1, 2, 3]));
  guest._guestConnection.emit('data', 'x'.repeat(70000));
  guest._guestConnection.emit('data', JSON.stringify({ v: 2, room: host.room, payload: { nope: true } }));
  channel.bufferedAmount = 1024 * 1024 + 1;
  assert.equal(guest.send({ blocked: true }), false);
  channel.bufferedAmount = 0;
  assert.equal(guest.send({ accepted: true }), true);
  await waitForTick();
  assert.deepEqual(received, [{ accepted: true }]);
  host.close('done');
  guest.close('done');
});

test('close cancels registration and ignores late broker callbacks', async () => {
  let broker;
  function delayedFactory(id, options) {
    broker = new EventEmitter();
    broker.id = id;
    broker.options = options;
    broker.open = false;
    broker.destroyed = false;
    broker.destroy = () => { broker.destroyed = true; };
    broker.disconnect = () => {};
    broker.connect = () => { throw new Error('must not connect'); };
    return broker;
  }
  const peer = new Peer({ brokerFactory: delayedFactory });
  const pending = peer.host();
  await waitForTick();
  peer.close('cancelled');
  broker.emit('open', broker.id);
  await assert.rejects(pending, /closed|cancel/i);
  assert.equal(peer.connected, false);
  assert.equal(broker.destroyed, true);
});

test('candidate limits, media rejection, and late rejected handshakes preserve the host', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const host = new Peer({ brokerFactory });
  const token = await host.host();
  const broker = host._broker;
  const candidate = (options = {}) => {
    const c = new FakeConnection('hatchstone', {serialization:'raw', metadata:{v:2,room:host.room}, ...options});
    c.open = true;
    c.peer = {closed:true};
    broker.emit('connection', c);
    return c;
  };
  const wrongLabel = candidate(); // Reject then simulate a stale event carrying the correct secret.
  wrongLabel.emit('data', '{}');
  assert.equal(wrongLabel.closed, true);
  wrongLabel.emit('data', JSON.stringify({type:'hello',v:2,room:host.room,secret:token.slice(28)}));
  assert.equal(host.connected, false);
  const malformed = candidate({metadata:{v:2,room:'wrong'}});
  assert.equal(malformed.closed, true);
  let mediaClosed = false;
  broker.emit('call', {close() { mediaClosed = true; }});
  assert.equal(mediaClosed, true);
  const waiting = [candidate(), candidate(), candidate()];
  assert.equal(candidate().closed, true, 'Fourth pending candidate is rejected');
  t.mock.timers.tick(5001);
  assert.ok(waiting.every(c=>c.closed), 'Unauthenticated channels are bounded by a timer');
  assert.equal(host._pendingCandidates.size, 0);
  const guest = new Peer({brokerFactory});
  await guest.join(token);
  const extra = candidate();
  assert.equal(extra.closed, true, 'Only one authenticated guest');
  const hostBroker = host._broker;
  host.close('done'); guest.close('done');
  assert.equal(hostBroker.destroyed, true);
});

test('waiting invite expires and unexpected signaling close fails once', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const reasons = [];
  const host = new Peer({brokerFactory, onClose: reason => reasons.push(reason)});
  await host.host();
  t.mock.timers.tick(600001);
  assert.deepEqual(reasons, ['expired']);
  assert.equal(host._broker.destroyed, true);
  assert.equal(host._secret, null);
  host.close('again');
  assert.equal(reasons.length, 1);
  const other = new Peer({brokerFactory, onClose: reason => reasons.push(reason)});
  await other.host();
  other._broker.emit('disconnected');
  assert.equal(other._closed, true);
  assert.equal(reasons[1], 'signaling-disconnected');
});

test('close during shared lazy load rejects immediately and never creates a late broker', async () => {
  const oldDocument = globalThis.document, oldPeer = globalThis.Peer;
  let script, creations = 0;
  globalThis.document = {baseURI:'http://localhost/hatchstone/', createElement:()=>({}), head:{appendChild(el) {script=el;}}};
  delete globalThis.Peer;
  const peer = new Peer();
  try {
    const pending = peer.host();
    await waitForTick();
    peer.close('cancelled');
    await assert.rejects(pending, /closed/);
    globalThis.Peer = function () {creations++;};
    script.onload();
    await waitForTick();
    assert.equal(creations, 0);
  } finally {globalThis.document=oldDocument;globalThis.Peer=oldPeer;}
});

test('join rejects unsupported input before any broker is created', async () => {
  const guest = new Peer({ brokerFactory });
  await assert.rejects(() => guest.join('v1.invalid'), /invite|token|version/i);
  assert.equal(FakeBroker.instances.length, 0);
  guest.close('done');
});
