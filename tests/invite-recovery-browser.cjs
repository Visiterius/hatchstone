"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { launch, waitFor, sleep } = require("./browser-helper.cjs");
const root = path.join(__dirname, "..");
// Explicit synthetic capabilities: this suite tests UI state, not public signaling.
const own = "v2." + "a".repeat(24) + "." + "b".repeat(32);
const friend = "v2." + "c".repeat(24) + "." + "d".repeat(32);

async function fixture(browser, mode = "invite", connected = false) {
  const page = await browser.page(400, 800);
  await page.eval(`(() => {
    window.__uiEvents = [];
    const own = ${JSON.stringify(own)};
    const manual = HatchstoneLink.encodeSignal({v:1,type:'offer',room:'host-room-1234567',sdp:'v=0\\r\\n'});
    class FixturePeer {
      constructor(callbacks) { this.callbacks=callbacks; this.connected=false; this.closed=false; }
      async host() { this.role='host'; this.room=${mode === "invite" ? "own.slice(3,27)" : "'host-room-1234567'"}; return ${mode === "invite" ? "own" : "manual"}; }
      async join(code) {
        window.__uiEvents.push({kind:'join',code}); this.role='guest';
        this.room=${mode === "invite" ? "HatchstoneInvite.parseInvite(code).slice(3,27)" : "HatchstoneLink.decodeSignal(code).room"};
        ${mode === "invite" ? "this.connected=true;this.callbacks.onStatus('connected');return;" : "return HatchstoneLink.encodeSignal({v:1,type:'answer',room:this.room,sdp:'v=0\\r\\n'});"}
      }
      close(reason) { if(this.closed)return;this.closed=true;this.connected=false;window.__uiEvents.push({kind:'close',reason});this.callbacks.onClose(reason); }
      send() { return true; }
    }
    ${mode === "invite" ? "HatchstoneInvite" : "HatchstoneLink"}.Peer=FixturePeer;
    return true;
  })()`);
  await page.click("startCoop");
  await page.click(mode === "invite" ? "coopQuickHost" : "coopHost");
  await waitFor("fixture host ready", () => page.eval("!!window.__coop.peer?.room"));
  await page.eval(`window.__keptPeer=window.__coop.peer; window.__keptPeer.connected=${connected}; window.__keptPeer.callbacks.onStatus(${JSON.stringify(connected ? "connected" : "waiting")});true`);
  return page;
}
async function incoming(page, hash) {
  await page.eval("location.hash=" + JSON.stringify(hash));
  await sleep(100);
}
async function press(page, id) {
  const point = await page.eval(`(() => {
    const e=document.getElementById(${JSON.stringify(id)});
    document.getElementById('coopDialog').getAnimations({subtree:true}).forEach(a=>{if(a.effect?.getTiming().iterations!==Infinity)a.finish()});
    e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();
    const x=r.x+r.width/2,y=r.y+r.height/2;
    return {x,y,hit:document.elementFromPoint(x,y)?.closest('button')?.id,disabled:e.disabled};
  })()`);
  assert.equal(point.hit, id, "Recovery control must be visible and pointer reachable");
  assert.equal(point.disabled, false);
  await page.tap(point.x, point.y);
}

test("incoming invitations recover explicitly from an existing room without losing saves", {timeout:60000}, async t => {
  const browser = await launch(root, process.env.HATCHSTONE_BASELINE === "1");
  async function stage(name, fn) {
    let passed=false;
    await t.test(name, async () => {await fn();passed=true;});
    if(!passed) throw new Error("Stopped after failed recovery stage: " + name);
  }
  try {
    const page = await fixture(browser);
    const before = await page.eval("JSON.stringify(localStorage)");
    await stage("a host opening a friend's link sees an explicit switch instead of disabled Join", async () => {
      await page.eval("window.__keptPeer=window.__coop.peer;document.getElementById('coopDialog').classList.add('hidden');true");
      await incoming(page, "#coop="+friend);
      assert.equal(await page.eval("!!document.getElementById('coopSwitchJoin')"),true,"Incoming-room switch control missing");
      assert.equal(await page.eval("!document.getElementById('coopDialog').classList.contains('hidden')"),true,"Incoming invite must reopen the room dialog");
      assert.equal(await page.eval("window.__coop.peer===window.__keptPeer && !window.__keptPeer.closed"),true,"Opening a link must not end the current room");
      assert.equal(await page.eval("window.__uiEvents.filter(e=>e.kind==='join').length"),0,"No connection without explicit consent");
      assert.equal(await page.eval("typeof window.Peer"),"undefined","UI fixtures must not start public signaling");
    });
    await stage("keep current room rejects only the incoming invite", async () => {
      await press(page,"coopKeepRoom");
      assert.equal(await page.eval("location.hash"),"");
      assert.equal(await page.eval("window.__coop.peer===window.__keptPeer && !window.__keptPeer.closed"),true);
      assert.equal(await page.eval("JSON.stringify(localStorage)"),before);
      assert.equal(await page.eval("document.getElementById('coopSwitchJoin').getClientRects().length"),0);
    });
    await stage("self and malformed invites cannot destroy or replace the current room", async () => {
      await incoming(page,"#coop="+own);
      assert.match(await page.eval("document.getElementById('coopError').textContent"),/own invite/i);
      assert.equal(await page.eval("document.getElementById('coopSwitchJoin').getClientRects().length"),0);
      await incoming(page,"#coop=invalid");
      assert.ok(await page.eval("document.getElementById('coopError').textContent"));
      assert.equal(await page.eval("window.__coop.peer===window.__keptPeer && !window.__keptPeer.closed"),true);
      assert.equal(await page.eval("document.getElementById('coopSwitchJoin').getClientRects().length"),0);
    });
    await stage("one explicit switch cancels the old room and joins the requested friend", async () => {
      await incoming(page,"#coop="+friend);
      await press(page,"coopSwitchJoin");
      await waitFor("fixture guest connected",()=>page.eval("window.__coop.peer?.role==='guest' && window.__coop.peer.connected"));
      assert.equal(await page.eval("window.__keptPeer.closed"),true);
      assert.deepEqual(await page.eval("window.__uiEvents.filter(e=>e.kind==='join').map(e=>e.code)"),[friend]);
      assert.equal(await page.eval("location.hash"),"");
      assert.equal(await page.eval("JSON.stringify(localStorage)"),before);
    });
    await stage("a connected guest can decline or close an incoming invitation without disconnecting", async () => {
      await page.eval("window.__keptPeer=window.__coop.peer;true");
      await incoming(page,"#coop="+own);
      await page.click("coopClose");
      assert.equal(await page.eval("window.__coop.peer===window.__keptPeer && !window.__keptPeer.closed"),true);
      assert.equal(await page.eval("location.hash"),"");
      await page.click("coopRoom");
      assert.equal(await page.eval("document.getElementById('coopSwitchJoin').getClientRects().length"),0,"Dismissed invitation must not return");
    });
    await stage("legacy manual invite links use the same explicit switch protection", async () => {
      const manualPage = await fixture(browser,"manual",true);
      const code = await manualPage.eval("HatchstoneLink.encodeSignal({v:1,type:'offer',room:'friend-room-12345',sdp:'v=0\\r\\n'})");
      await incoming(manualPage,"#join="+code);
      assert.equal(await manualPage.eval("window.__coop.peer===window.__keptPeer && !window.__keptPeer.closed"),true);
      await press(manualPage,"coopSwitchJoin");
      await waitFor("manual reply generated",()=>manualPage.eval("!!document.getElementById('coopReply').value"));
      assert.equal(await manualPage.eval("window.__keptPeer.closed && window.__coop.peer.role==='guest'"),true);
      assert.deepEqual(await manualPage.eval("window.__uiEvents.filter(e=>e.kind==='join').map(e=>e.code)"),[code]);
    });
    assert.deepEqual(browser.cdp.errors,[]);
  } finally {await browser.close();}
});
