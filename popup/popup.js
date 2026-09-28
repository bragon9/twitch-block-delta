"use strict";

const statusEl = document.getElementById("status");
const streamEl = document.getElementById("stream");
const tabDetailEl = document.getElementById("tab-detail");
document.getElementById("version").textContent = `v${browser.runtime.getManifest().version}`;

// A tab whose player hasn't fetched a playlist for this long is paused or gone.
const IDLE_MS = 15_000;

let tabId = null;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function ago(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// What the viewer sees in this tab right now: { text, tone } where tone is
// "ok", "ad", "warn" or "idle".
function streamState(tab, mode) {
  if (!tab.lastMediaAt || Date.now() - tab.lastMediaAt > IDLE_MS) return { text: "Paused", tone: "idle" };
  if (tab.adActive) {
    if (mode === "observe") return { text: "Ad (Observe only)", tone: "ad" };
    if (tab.loadedAllowed) return { text: "Ad playing (allowed)", tone: "idle" };
    const action = tab.lastBlock?.action;
    if (action === "fallback-native") return { text: "Ad showing", tone: "ad" };
    if (action === "strip-ad") return { text: "Waiting for live", tone: "warn" };
    return { text: "Ad blocked", tone: "ok" };
  }
  if (mode === "observe") return { text: "Observe only", tone: "idle" };
  if (tab.loadedAllowed) return { text: "Ads allowed", tone: "idle" };
  return { text: "Blocking ads", tone: "ok" };
}

function sessionLine(s) {
  const percent = s.watchedMs > 0 ? Math.round((s.adMs / s.watchedMs) * 100) : 0;
  return `This session: ${duration(s.watchedMs)} · Ads ${duration(s.adMs)} (${percent}%)`;
}

function breaksLine(s) {
  if (s.breaks === 0) return [el("span", { textContent: "No ads yet" })];
  if (s.blocked === s.breaks) return [el("span", { textContent: `${plural(s.breaks, "ad break")}, all blocked` })];
  if (s.shown === s.breaks) return [el("span", { textContent: `${plural(s.breaks, "ad break")}, all allowed` })];
  const parts = [
    s.blocked && el("span", { textContent: `${s.blocked} blocked` }),
    s.leaked && el("span", { className: "state ad", textContent: `${s.leaked} got through` }),
    s.shown && el("span", { textContent: `${s.shown} allowed` }),
  ].filter(Boolean);
  return [`${plural(s.breaks, "ad break")}: `, ...parts.flatMap((p, i) => (i ? [", ", p] : [p]))];
}

function allowToggle(state) {
  const { channel, loadedAllowed } = state.tab;
  const allowed = state.allowedChannels.includes(channel);
  const box = el("input", { type: "checkbox", checked: allowed });
  box.addEventListener("change", async () => {
    box.disabled = true;
    await browser.runtime.sendMessage({ type: "setAllowed", channel, allowed: box.checked });
    // Blocking is decided when the stream loads, so reload it to apply.
    await browser.tabs.reload(tabId);
    window.close();
  });
  const children = [el("label", { className: "toggle" }, [box, " Don't block ads on this channel"])];
  if (allowed !== loadedAllowed) children.push(el("p", { className: "muted small", textContent: "Applies when the page reloads." }));
  return children;
}

// Only shown when blocking is off everywhere; everything else is on the card.
function renderStatus(state) {
  statusEl.hidden = state.mode !== "observe";
  statusEl.textContent = "Ad blocking is off (Observe only in Settings)";
  statusEl.className = "status warn";
}

function renderStream(state) {
  const tab = state.tab;
  if (!tab?.channel || !tab.lastMediaAt) {
    streamEl.className = "card";
    streamEl.replaceChildren(el("p", { className: "muted", textContent: "No Twitch stream playing in this tab." }));
    return;
  }
  const { text, tone } = streamState(tab, state.mode);
  const s = tab.session;
  const children = [
    el("div", { className: "card-head" }, [
      el("span", { className: `dot ${tone}` }),
      el("strong", { textContent: tab.channel }),
      el("span", { className: `state ${tone}`, textContent: text }),
    ]),
    el("div", { className: "stats" }, [el("div", { textContent: sessionLine(s) }), el("div", {}, breaksLine(s))]),
  ];
  if (s.leaked > 0) children.push(el("button", { className: "report", textContent: "Report a problem", onclick: report }));
  children.push(...allowToggle(state));
  streamEl.className = `card ${tone === "ad" ? "ad" : ""}`;
  streamEl.replaceChildren(...children);
}

function probeTable(probe) {
  const rows = probe.results.flatMap((r) => {
    const renditions = r.error ? [{ error: r.error }] : r.renditions;
    return renditions.map((x) => {
      const verdict = x.error ? `error: ${x.error}` : x.isAd ? `ads (${x.adKind})` : "clean";
      const cls = x.error ? "muted" : x.isAd ? "state ad" : "state ok";
      return el("tr", {}, [
        el("td", { textContent: `${r.playerType} (${r.auth})` }),
        el("td", { textContent: x.variant ?? x.wanted ?? "" }),
        el("td", { className: cls, textContent: verdict }),
      ]);
    });
  });
  return el("div", {}, [
    el("div", { className: "muted small", textContent: `Probe round ${probe.round}, ${ago(probe.at)}` }),
    el("table", {}, rows),
  ]);
}

function renderTabDetail(tab) {
  if (!tab) return [el("p", { className: "muted small", textContent: "Nothing recorded for this tab." })];
  const fields = [
    ["Tab", String(tab.tabId)],
    ["Player type", tab.playerType ?? "?"],
    ["Rendition", tab.quality ? `${tab.quality.name} (${tab.quality.codecs})` : "?"],
    ["Top rendition", tab.topVariant ? `${tab.topVariant.name} (${tab.topVariant.codecs})` : "?"],
    ["Playlists", `${tab.mediaResponses} (last ${ago(tab.lastMediaAt)})`],
    ["Request types", tab.requestTypes.join(", ") || "?"],
  ];
  if (tab.adActive) fields.push(["Ad kind", tab.adKind]);
  if (tab.lastAdReasons.length) fields.push(["Last ad signal", tab.lastAdReasons.join("; ")]);
  const counts = Object.entries(tab.actionCounts).map(([k, v]) => `${k} ${v}`).join(", ");
  if (counts) fields.push(["Rewrites", counts]);
  if (tab.lastBlock) {
    const s = tab.lastBlock.stats;
    const detail = s ? ` · live ${s.window?.join("–") ?? "?"} · ${s.fromBackup} backup / ${s.fromNative} page` : "";
    fields.push(["Last rewrite", `${tab.lastBlock.action}${detail} (${ago(tab.lastBlock.at)})`]);
    fields.push(["Rewrite delay", `last ${tab.lastBlock.rewriteMs} ms · max ${tab.maxRewriteMs} ms`]);
    if (tab.lastBlock.error) fields.push(["Last problem", tab.lastBlock.error]);
  }
  return [
    el("dl", {}, fields.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })])),
    ...(tab.lastProbe ? [probeTable(tab.lastProbe)] : []),
  ];
}

async function report() {
  await browser.runtime.sendMessage({ type: "report", tabId });
  window.close();
}

document.getElementById("report").addEventListener("click", report);
document.getElementById("settings").addEventListener("click", async () => {
  await browser.runtime.openOptionsPage();
  window.close();
});

async function refresh() {
  const state = await browser.runtime.sendMessage({ type: "state", tabId });
  renderStatus(state);
  renderStream(state);
  tabDetailEl.replaceChildren(...renderTabDetail(state.tab));
}

browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  tabId = tab?.id ?? null;
  refresh();
  setInterval(refresh, 2000);
});
