"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { launch, waitFor } = require("./browser-helper.cjs");
const root = path.join(__dirname, "..");

// Run the complete shared-egg regression through the new link flow as well.
process.env.HATCHSTONE_INVITES = "1";
require("./coop-browser.cjs");

test("invite landing is explicit, accessible, private until Join, and fails actionably", {timeout: 65000}, async () => {
  const browser = await launch(root, process.env.HATCHSTONE_BASELINE === "1");
  try {
    const page = await browser.page(400, 800);
    assert.equal(await page.eval("!!document.getElementById('coopQuickHost')"), true, "One-link host control missing");
    assert.equal(await page.eval("typeof window.Peer"), "undefined", "Solo load does not even load the optional broker client");
    await page.click("startCoop");
    assert.equal(await page.eval("document.getElementById('coopAdvanced').open"), false, "Manual codes are hidden behind Advanced");
    assert.equal(await page.eval("document.getElementById('coopQuickHost').disabled"), false);
    const token = "v2." + "a".repeat(24) + "." + "b".repeat(32); // Synthetic fixture, not a live invitation.
    const url = browser.url + "#coop=" + token;
    const previous = await page.eval("window.__testLoadToken");
    await browser.cdp.send("Page.navigate", {url:"about:blank"}, page.id);
    await browser.cdp.send("Page.navigate", {url}, page.id);
    await waitFor("fresh document with invitation", async () => await page.eval("!!window.__game && window.__testLoadToken!=="+JSON.stringify(previous)+" && !document.getElementById('coopDialog').classList.contains('hidden')"));
    assert.equal(await page.eval("document.getElementById('coopLinkIn').value"), url);
    assert.equal(await page.eval("window.__coop.peer===null && typeof window.Peer==='undefined'"), true, "Opening a link does not register or connect");
    await page.eval("document.querySelectorAll('#coopDialog *').forEach(el=>el.getAnimations().forEach(a=>a.finish()))");
    assert.equal(await page.eval("document.getElementById('coopJoinLink').getClientRects().length>0"), true);
    assert.equal(await page.eval("document.getElementById('coopAdvanced').open"), false);
    await page.click("coopClose");
    assert.equal(await page.eval("location.hash"), "", "Declined bearer link is removed from this tab's history entry");
    await page.eval("location.hash="+JSON.stringify('#coop='+token));
    await waitFor("same-document invitation opens the join dialog",()=>page.eval("!document.getElementById('coopDialog').classList.contains('hidden') && !!document.getElementById('coopLinkIn').value"));
    assert.equal(await page.eval("window.__coop.peer"), null);
    await page.click("coopClose");
    await page.click("startCoop");
    await page.fill("coopLinkIn", "https://example.invalid/#coop=bad"); await page.click("coopJoinLink");
    assert.equal(await page.eval("!!document.getElementById('coopError').textContent && window.__coop.peer===null"), true);
    assert.equal(await page.eval("document.getElementById('coopQuickHost').disabled"), false, "Bad input never strands disabled controls");
    await page.fill("coopLinkIn", "");
    await browser.cdp.send("Network.enable", {}, page.id);
    await browser.cdp.send("Network.emulateNetworkConditions", {offline:true,latency:0,downloadThroughput:0,uploadThroughput:0}, page.id);
    await page.click("coopQuickHost");
    await waitFor("blocked broker shows a retry/fallback error", () => page.eval("!!document.getElementById('coopError').textContent && !document.getElementById('coopQuickHost').disabled && window.__coop.peer===null"), 20000);
    assert.match(await page.eval("document.getElementById('coopError').textContent"), /invite|signal|network|connect|offline/i);
    await page.click("coopClose");
    assert.equal(await page.eval("window.__coop.peer===null"), true);
    assert.deepEqual(browser.cdp.errors, []);
  } finally { await browser.close(); }
});

test("two live hosts can keep their own invite or explicitly switch into one shared egg", {timeout:75000}, async () => {
  const browser = await launch(root);
  async function press(page, id) {
    await waitFor("stable recovery dialog",()=>page.eval("getComputedStyle(document.getElementById('coopDialog')).opacity==='1' && !document.getElementById('coopDialog').getAnimations({subtree:true}).some(a=>a.playState==='running')"));
    const point=await page.eval(`(() => {const e=document.getElementById(${JSON.stringify(id)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
    assert.equal(await page.eval(`document.elementFromPoint(${point[0]},${point[1]})?.closest('button')?.id`),id);
    await page.tap(...point);
  }
  try {
    const host=await browser.page(400,800), guest=await browser.page(600,920);
    const saves=await Promise.all([host.eval("localStorage.getItem('hatchstone.save')"),guest.eval("localStorage.getItem('hatchstone.save')")]);
    for (const page of [host,guest]) {
      await page.click("startCoop");await page.click("coopQuickHost");
      await waitFor("live host registered and invitation ready",()=>page.eval("document.getElementById('coopLinkOut').value"),20000);
    }
    const invite=await host.eval("document.getElementById('coopLinkOut').value");
    await guest.eval("window.__oldInvitePeer=window.__coop.peer;true");
    const hash=JSON.stringify(new URL(invite).hash);
    await guest.eval("location.hash="+hash);
    await waitFor("incoming invitation switch",()=>guest.eval("document.getElementById('coopSwitchJoin').getClientRects().length>0"));
    assert.equal(await guest.eval("window.__coop.peer===window.__oldInvitePeer && !window.__oldInvitePeer._closed"),true);
    assert.equal(await host.eval("window.__coop.peer.connected"),false,"Opening does not connect");
    await press(guest,"coopKeepRoom");
    assert.equal(await guest.eval("window.__coop.peer===window.__oldInvitePeer && !window.__oldInvitePeer._closed"),true);
    await guest.eval("location.hash="+hash);
    await waitFor("incoming invitation offered again",()=>guest.eval("document.getElementById('coopSwitchJoin').getClientRects().length>0"));
    await press(guest,"coopSwitchJoin");
    await waitFor("both real peers connected after switching",async()=>await host.eval("!!window.__coop.peer?.connected") && await guest.eval("!!window.__coop.peer?.connected"),35000);
    assert.equal(await guest.eval("window.__oldInvitePeer._closed"),true);
    assert.equal(await guest.eval("window.__coop.peer.role"),"guest");
    assert.equal(await guest.eval("location.hash"),"");
    await press(host,"coopBegin");
    await waitFor("same real shared egg after switching",async()=>{
      const a=await host.eval("window.__coop.round?.id"),b=await guest.eval("window.__coop.round?.id");return a&&a===b;
    });
    assert.deepEqual(await Promise.all([host.eval("localStorage.getItem('hatchstone.save')"),guest.eval("localStorage.getItem('hatchstone.save')")]),saves);
    assert.deepEqual(browser.cdp.errors,[]);
  } finally {await browser.close();}
});
