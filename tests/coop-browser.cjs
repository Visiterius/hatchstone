"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { launch, waitFor, sleep } = require("./browser-helper.cjs");
const root = path.join(__dirname, "..");
const quickInvites = process.env.HATCHSTONE_INVITES === "1";

const connected = p => p.eval("!!window.__coop?.peer?.connected");
const phase = p => p.eval("window.__game.egg?.state");
const progress = p => p.eval("JSON.stringify(window.__game.egg?.cracks.map(c => [c.cov,c.pass,c.done,c.knots.map(k=>k.broken)]))");
const saved = p => p.eval("JSON.parse(localStorage.getItem('hatchstone.save'))");
// The impact web in egg-relative coordinates, and which of its short rays and hoops have appeared.
const web = p => p.eval(`(() => { const e = window.__game.egg, n = pt => HatchstoneCoopState.normalisePoint(pt[0], pt[1], L).map(v => v.toFixed(3));
  return JSON.stringify({ impact: n(e.impact), rays: e.rays.map(r => r.crack ? "crack" : r.drawn), hoops: e.hoops.map(h => [h.a, h.b, h.drawn, n(h.pts[1])]) }); })()`);

async function seed(page, name, id, shards) {
  await page.eval(`(() => {
    const s = window.__game.save, sp = SPECIES[0].id;
    s.creatures.push({id:${id},sp,name:${JSON.stringify(name)},shiny:false,level:1,xp:0,tummy:70,joy:80,energy:80,sleeping:false,last:Date.now(),born:Date.now()});
    s.nextId=${id + 1}; s.shards=${shards}; s.stars={1:3}; s.seen[sp]={count:1}; persist(); return true;
  })()`);
}
async function observeWire(page) {
  await page.eval(`(() => {
    const peer=window.__coop.peer, send=peer.send.bind(peer);
    peer.send=function(packet) { if(packet.type==='state') window.__testLastState=structuredClone(packet); return send(packet); };
    return true;
  })()`);
}
async function press(page, id) {
  await waitFor("visible stable dialog",()=>page.eval("getComputedStyle(document.getElementById('coopDialog')).opacity==='1' && !document.getElementById('coopDialog').getAnimations({subtree:true}).some(a=>a.playState==='running')"));
  const point = await page.eval(`(() => { const el=document.getElementById(${JSON.stringify(id)}); el.scrollIntoView({block:'center',behavior:'instant'}); const r=el.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]; })()`);
  const hit = await page.eval(`document.elementFromPoint(${point[0]},${point[1]})?.closest('button')?.id`);
  assert.equal(hit, id, "Primary setup control is reachable by real pointer input");
  await page.tap(...point); // Real hit-testing, not HTMLElement.click().
}
async function connect(host, guest, browser) {
  let link = null;
  await host.click("startCoop");
  if (quickInvites) {
    await press(host, "coopQuickHost");
    const invite = await waitFor("one-link invite generation", () => host.eval("document.getElementById('coopLinkOut').value"), 20000);
    link = invite;
    const u = new URL(invite);
    assert.equal(u.pathname, "/hatchstone/", "Invite preserves deployment prefix");
    assert.ok(invite.length < 200, "Invitation is a small link, not an encoded SDP blob");
    assert.match(u.hash, /^#coop=v2\.[a-f0-9]{24}\.[a-f0-9]{32}$/);
    assert.equal(await host.eval("document.getElementById('coopInvite').value"), "", "No manual host code");
    // Verify the real Telegram button without sending anything to a Telegram account.
    await host.eval("window.__realOpen=window.open;window.open=(url,target,features)=>{window.__share={url,target,features};return null}");
    await host.click("coopTelegram");
    const share = await host.eval("window.__share");
    await host.eval("window.open=window.__realOpen;delete window.__realOpen;true");
    assert.equal(new URL(share.url).origin, "https://t.me");
    assert.equal(new URL(share.url).pathname, "/share/url");
    assert.equal(new URL(share.url).searchParams.get("url"), invite, "Telegram preserves the complete fragment");
    assert.equal(share.features, "noopener,noreferrer");
    const previous = await guest.eval("window.__testLoadToken");
    await browser.cdp.send("Page.navigate", {url:"about:blank"}, guest.id);
    await browser.cdp.send("Page.navigate", {url:invite}, guest.id);
    await waitFor("guest invitation landing", () => guest.eval("!!window.__game && window.__testLoadToken!=="+JSON.stringify(previous)+" && !document.getElementById('coopDialog').classList.contains('hidden')"));
    assert.equal(await guest.eval("window.__coop.peer===null && typeof window.Peer==='undefined'"), true, "Landing does not join automatically");
    await press(guest, "coopJoinLink");
    assert.equal(await guest.eval("location.hash"), "", "Accepted invitation removed from the address bar");
  } else {
    await host.click("coopHost");
    const invite = await waitFor("host invite generation", () => host.eval("document.getElementById('coopInvite').value"), 25000);
    await guest.click("startCoop");
    await guest.fill("coopInviteIn", invite);
    await guest.click("coopJoin");
    const reply = await waitFor("guest reply generation", () => guest.eval("document.getElementById('coopReply').value"), 25000);
    await host.fill("coopReplyIn", reply);
    await host.click("coopAccept");
  }
  await waitFor("real WebRTC data channel on both devices", async () => await connected(host) && await connected(guest), 35000);
  if (quickInvites) {
    assert.equal(await guest.eval("document.getElementById('coopReply').value"), "", "No guest reply code");
    assert.equal(await host.eval("document.getElementById('coopTelegram').disabled"), true, "Connected invite is consumed");
  }
  await observeWire(host);
  return link;
}
async function traceNext(page) {
  const crack = await page.eval(`(() => {
    const e=window.__game.egg, c=e.cracks.find(c=>!c.done);
    return c ? {pts:c.pts,knots:c.knots.filter(k=>!k.broken).map(k=>c.pts[k.i])} : null;
  })()`);
  if (!crack) return;
  for (const p of crack.knots) { await page.tap(...p); await sleep(100); }
  await page.stroke(crack.pts);
  await sleep(180);
}
async function rubPatch(page, end = false) {
  const points = await page.eval(`(() => {
    const m=window.__game.egg.matte, cells=${end ? "m.cells.slice(-18,-10)" : "m.cells.slice(10,18)"};
    return cells.map(c=>[c.x,c.y]);
  })()`);
  assert.ok(points.length, "Polish cells exist");
  await page.stroke([...points, ...points.slice().reverse(), ...points]);
  await sleep(250);
}

// HATCHSTONE_BASELINE=1 serves the unchanged HEAD index and must fail at the entry-point assertion.
test("two isolated devices share a real WebRTC egg without replacing solo saves", { timeout: 240000 }, async t => {
  const baseline = process.env.HATCHSTONE_BASELINE === "1";
  const browser = await launch(root, baseline);
  async function stage(name, fn) {
    let passed = false;
    await t.test(name, async () => { await fn(); passed = true; });
    if (!passed) throw new Error(`Stopped after failed stage: ${name}`);
  }
  try {
    const host = await browser.page(400, 800), guest = await browser.page(600, 920);
    assert.equal(await host.eval("!!document.getElementById('startCoop')"), true, "Co-op entry point missing");
    if (quickInvites) assert.equal(await host.eval("!!document.getElementById('coopQuickHost')"), true, "One-link host control missing");
    if (baseline) assert.fail("Baseline unexpectedly implements the new feature");
    await seed(host, "Host keepsake", 901, 29);
    await seed(guest, "Guest keepsake", 902, 41);
    const beforeHost = await saved(host), beforeGuest = await saved(guest);
    let firstInvite;
    assert.notDeepEqual(beforeHost, beforeGuest, "Independent local storage fixtures");

    await stage("bad invites remain actionable and cancelled setup cannot reopen a room", async () => {
      await guest.click("startCoop"); await guest.fill("coopInviteIn", "not-a-hatchstone-invite"); await guest.click("coopJoin");
      await waitFor("visible invite error", () => guest.eval("!document.getElementById('coopDialog').classList.contains('hidden') && !!document.getElementById('coopError').textContent"));
      assert.equal(await connected(guest), false); await guest.click("coopClose");
      await host.click("startCoop"); await host.click(quickInvites ? "coopQuickHost" : "coopHost"); await host.click("coopClose");
      await sleep(180);
      assert.equal(await host.eval("window.__coop.peer===null && document.getElementById('coopDialog').classList.contains('hidden')"), true);
    });

    await stage(quickInvites ? "one shared link opens an authenticated data channel without reply codes" : "explicit invite/reply handshake opens a data channel", async () => {
      firstInvite = await connect(host, guest, browser);
      assert.equal(await host.eval("window.__coop.peer.role"), "host");
      assert.equal(await guest.eval("window.__coop.peer.role"), "guest");
      await host.fill("coopDifficulty", "8");
      await host.click("coopBegin");
      await waitFor("same shared round", async () => {
        const a=await host.eval("window.__coop.round?.id"), b=await guest.eval("window.__coop.round?.id");
        return a && a===b;
      });
      await waitFor("both eggs cracking", async () => await phase(host)==="cracking" && await phase(guest)==="cracking");
      assert.deepEqual(await host.eval("window.__coop.round"), await guest.eval("window.__coop.round"));
      assert.equal(await web(host), await web(guest), "Shared impact web");
    });

    await stage("inactive navigation and backup controls cannot steal a shared round", async () => {
      assert.equal(await guest.eval("document.getElementById('topbar').inert && document.getElementById('tabs').inert"),true);
      await guest.eval("document.getElementById('backupBtn').focus()");
      assert.equal(await guest.eval("document.activeElement.id==='backupBtn'"),false);
      await guest.click("backupBtn"); await guest.eval("document.querySelector('#tabs [data-tab=nest]').click()");
      assert.equal(await guest.eval("window.__game.scene"),"crack");
      assert.equal(await guest.eval("document.getElementById('backup').classList.contains('hidden')"),true);
      assert.equal(await connected(guest),true);
    });

    await stage("invalid, stale and wrong-role messages cannot modify the host", async () => {
      const old=await progress(host);
      await guest.eval(`(() => {
        const p=window.__coop.peer, id=window.__coop.round.id;
        p.send({type:'input',input:{round:'old-round-123456',seq:999,kind:'down',point:[0.5,0.5]}});
        p.send({type:'input',input:{round:id,seq:1000,kind:'move',point:[1e20,null]}});
        p.send({type:'state',state:{round:id,seq:1001,phase:'open'}});
        p.send({type:'restoreFromCode',save:{shards:999999}}); return true;
      })()`);
      await sleep(250);
      assert.equal(await progress(host), old);
      assert.equal((await saved(host)).shards, beforeHost.shards);
    });

    await stage("simultaneous gestures have independent pointers and cancel releases only the guest", async () => {
      const a=await host.eval("window.__game.egg.cracks[0].pts[0]"), b=await guest.eval("window.__game.egg.cracks[0].pts[0]");
      await host.mouse("mousePressed",...a); await guest.mouse("mousePressed",...b);
      await waitFor("independent active pointers", () => host.eval("!!pointer && !!game.coop.remotePointer && pointer!==game.coop.remotePointer"));
      await guest.eval("document.getElementById('c').dispatchEvent(new PointerEvent('pointercancel',{pointerId:1}))");
      await waitFor("guest cancel retained local pointer", () => host.eval("!!pointer && game.coop.remotePointer===null"));
      await guest.mouse("mouseReleased",...b); await host.mouse("mouseReleased",...a);
    });

    await stage("both trace, tap knots and complete multi-pass cracks across viewport sizes", async () => {
      await traceNext(host);
      await waitFor("first stroke shared", async () => await progress(host)===await progress(guest));
      const beforeResize=await host.eval("JSON.stringify(window.__coop.round)");
      const oldProgress=await progress(host);
      await host.resize(430, 850); await guest.resize(520, 880);
      assert.equal(await host.eval("JSON.stringify(window.__coop.round)"), beforeResize, "Host resize must not reroll");
      assert.equal(await guest.eval("JSON.stringify(window.__coop.round)"), beforeResize, "Guest resize must not reroll");
      assert.equal(await progress(host), oldProgress, "Resize preserves shared coverage");
      for (let i=0;i<20 && await phase(host)==="cracking";i++) {
        await traceNext(i%2===0 ? guest : host);
      }
      await waitFor("both eggs ready to open", async () => await phase(host)==="ready" && await phase(guest)==="ready", 15000);
      assert.equal(await host.eval("window.__game.egg.cracks.every(c=>c.done)"), true);
      assert.equal(await guest.eval("window.__game.egg.cracks.every(c=>c.done)"), true);
      assert.equal(await progress(host), await progress(guest));
      assert.equal(await web(host), await web(guest), "Both players see the same crack web");
      assert.equal(await guest.eval("window.__game.egg.hoops.length > 0 && window.__game.egg.hoops.every(h => h.drawn)"), true, "Every hoop appears once its rays are traced");
    });

    await stage("guest can open the shell and both polish the same face", async () => {
      const center=await guest.eval("[L.ecx,L.ecy]");
      await guest.tap(...center);
      await waitFor("both polishing", async () => await phase(host)==="polish" && await phase(guest)==="polish", 15000);
      const start=await host.eval("window.__game.egg.matte.done");
      await rubPatch(host);
      const fromHost=await waitFor("host polish contributes", () => host.eval(`window.__game.egg.matte.done > ${start} && window.__game.egg.matte.done`));
      await rubPatch(guest, true);
      await waitFor("guest polish contributes", () => host.eval(`window.__game.egg.matte.done > ${fromHost}`));
      const polishRound=await host.eval("window.__coop.round.id");
      const polished=await host.eval("JSON.stringify(window.__game.egg.matte.cells.map(c=>c.hits || 0))");
      await host.resize(410,820); await guest.resize(550,900);
      assert.equal(await host.eval("window.__coop.round.id"),polishRound);
      assert.equal(await guest.eval("window.__coop.round.id"),polishRound);
      assert.equal(await host.eval("JSON.stringify(window.__game.egg.matte.cells.map(c=>c.hits || 0))"),polished,"Resize preserves polish cells");
      await waitFor("polish progress shared", async () => {
        const a=await host.eval("JSON.stringify(window.__game.egg.matte.cells.map(c=>c.hits || 0))");
        const b=await guest.eval("JSON.stringify(window.__game.egg.matte.cells.map(c=>c.hits || 0))");
        return a===b;
      });
      await guest.click("polishDone");
      await waitFor("both hatch result cards", async () => {
        return await host.eval("!document.getElementById('found').classList.contains('hidden')") &&
          await guest.eval("!document.getElementById('found').classList.contains('hidden')");
      }, 15000);
      assert.deepEqual(await host.eval("[window.__game.egg.species.id,window.__game.egg.shiny]"),
        await guest.eval("[window.__game.egg.species.id,window.__game.egg.shiny]"));
      assert.equal(await host.eval("document.getElementById('foundName').textContent"),
        await guest.eval("document.getElementById('foundName').textContent"));
      if(process.env.HATCHSTONE_ARTIFACT_DIR) {
        fs.mkdirSync(process.env.HATCHSTONE_ARTIFACT_DIR,{recursive:true});
        const shot=await browser.cdp.send("Page.captureScreenshot",{format:"png"},host.id);
        fs.writeFileSync(path.join(process.env.HATCHSTONE_ARTIFACT_DIR,"shared-hatch.png"),Buffer.from(shot.data,"base64"));
      }
    });

    const afterHost=await saved(host), afterGuest=await saved(guest);
    await stage("each local save keeps earlier creatures, earns once, and does not advance campaign", async () => {
      assert.equal(afterHost.creatures.find(c=>c.id===901)?.name,"Host keepsake");
      assert.equal(afterGuest.creatures.find(c=>c.id===902)?.name,"Guest keepsake");
      assert.ok(afterHost.shards>beforeHost.shards); assert.ok(afterGuest.shards>beforeGuest.shards);
      assert.deepEqual(afterHost.stars,beforeHost.stars); assert.deepEqual(afterGuest.stars,beforeGuest.stars);
      const sp=await host.eval("window.__game.egg.species.id");
      assert.equal(afterHost.seen[sp].count,(beforeHost.seen[sp]?.count || 0)+1);
      assert.equal(afterGuest.seen[sp].count,(beforeGuest.seen[sp]?.count || 0)+1);
      await host.eval("window.__coop.peer.send(window.__testLastState)");
      await sleep(250);
      assert.deepEqual(await saved(host),afterHost); assert.deepEqual(await saved(guest),afterGuest);
    });

    await stage("next round rejects previous-round inputs, and leaving aborts without another reward", async () => {
      const previous=await host.eval("window.__coop.round.id");
      await host.click("nextLvl");
      await waitFor("next shared egg", async () => {
        const a=await host.eval("window.__coop.round?.id"),b=await guest.eval("window.__coop.round?.id");
        return a && a!==previous && a===b;
      });
      const initial=await progress(host);
      await guest.eval(`window.__coop.peer.send({type:'input',input:{round:${JSON.stringify(previous)},seq:99999,kind:'down',point:[0.5,0.5]}})`);
      await sleep(200); assert.equal(await progress(host),initial);
      await host.click("coopRoom"); await host.click("coopLeave");
      await waitFor("both peers disconnected", async () => !await connected(host) && !await connected(guest));
      assert.deepEqual(await saved(host),afterHost); assert.deepEqual(await saved(guest),afterGuest);
    });

    if (quickInvites) await stage("used link is rejected and a fresh link reconnects without changing rewards or progress", async () => {
      const stranger = await browser.page(420, 860);
      await stranger.click("startCoop"); await stranger.fill("coopLinkIn", firstInvite); await stranger.click("coopJoinLink");
      await waitFor("used room unavailable",()=>stranger.eval("window.__coop.peer===null && !!document.getElementById('coopError').textContent"),35000);
      assert.match(await stranger.eval("document.getElementById('coopError').textContent"), /fresh|available|network|signaling/i);
      const nextInvite = await connect(host, guest, browser);
      assert.notEqual(nextInvite, firstInvite);
      await host.click("coopLeave");
      await waitFor("fresh session cleanly closed",async()=>!await connected(host) && !await connected(guest));
      assert.deepEqual(await saved(host), afterHost);
      // A normal document reload increments the save revision; it must not grant/rewrite progress.
      const reloadedGuest = await saved(guest);
      assert.ok(reloadedGuest.rev >= afterGuest.rev);
      assert.deepEqual({...reloadedGuest, rev:afterGuest.rev}, afterGuest);
    });

    await stage("latest upstream interactive nest decorations still respond to real pointer input", async () => {
      const spot=await host.eval(`(() => {
        save.decor.lamp={on:true}; save.backupAt=Date.now(); persist(); setScene('nest');
        const [x,y]=decorSpot('lamp'); return [x,y-N.base*.75];
      })()`);
      await host.tap(...spot);
      assert.equal(await host.eval("save.decor.lamp.off"),true);
      await host.tap(...spot);
      assert.equal(await host.eval("save.decor.lamp.off"),false);
    });

    await stage("solo play still works and the new local scripts are cached for offline reload", async () => {
      await host.eval("setScene('map'); startLevel(1)");
      await waitFor("solo egg", () => host.eval("window.__game.scene==='crack' && !window.__game.egg.conf.coop && window.__game.egg.state==='cracking'"));
      await traceNext(host);
      assert.equal(await host.eval("window.__game.egg.cracks.some(c=>c.cov.some(Boolean))"),true);
      await waitFor("service worker active", () => host.eval("navigator.serviceWorker.getRegistration().then(r=>!!r?.active)"));
      for (const file of ["coop-link.js","coop-invite.js","coop-state.js","vendor/peerjs-1.5.5.min.js"]) {
        assert.equal(await host.eval(`caches.match(new URL(${JSON.stringify(file)},location.href)).then(r=>!!r&&r.status===200)`),true);
      }
      const oldToken=await host.eval("window.__testLoadToken");
      await browser.cdp.send("Network.enable",{},host.id);
      await browser.cdp.send("Network.emulateNetworkConditions",{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0},host.id);
      await browser.cdp.send("Page.reload",{},host.id);
      await waitFor("fresh offline document including co-op scripts", () => host.eval(`window.__testLoadToken!==${JSON.stringify(oldToken)} && !!window.__game && !!window.HatchstoneLink && !!window.HatchstoneCoopState`));
      assert.equal((await saved(host)).creatures.find(c=>c.id===901)?.name,"Host keepsake");
      await host.eval("window.RTCPeerConnection=undefined"); await host.click("startCoop");
      assert.equal(await host.eval("document.getElementById('coopHost').disabled && document.getElementById('coopJoin').disabled && !!document.getElementById('coopError').textContent"),true);
      await host.click("coopClose"); await host.eval("show('start',false); startLevel(1)");
      await waitFor("offline solo without WebRTC", () => host.eval("window.__game.egg?.state==='cracking'"));
      await traceNext(host);
      assert.equal(await host.eval("window.__game.egg.cracks.some(c=>c.cov.some(Boolean))"),true);
      await browser.cdp.send("Network.emulateNetworkConditions",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1},host.id);
    });
    assert.deepEqual(browser.cdp.errors,[],"No unhandled browser exceptions");
    if(process.env.HATCHSTONE_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.HATCHSTONE_ARTIFACT_DIR,{recursive:true});
      fs.writeFileSync(path.join(process.env.HATCHSTONE_ARTIFACT_DIR,"browser-verification.json"),
        JSON.stringify({realWebRTC:true,isolatedStorage:true,differentViewports:true,sharedHatch:true,offlineReload:true,exceptionCount:browser.cdp.errors.length},null,2));
    }
  } finally { await browser.close(); }
});
