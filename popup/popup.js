"use strict";

const statusEl = document.getElementById("status");
const tabsEl = document.getElementById("tabs");
const tabDetailsEl = document.getElementById("tab-details");
const summaryEl = document.getElementById("summary");
const detailsEl = document.getElementById("details");
document.getElementById("version").textContent = `v${browser.runtime.getManifest().version}`;

// A tab whose player hasn't fetched a playlist for this long is paused or gone.
const IDLE_MS = 15_000;
// Actions that keep an ad out of the player's view (see blocker.js).
const CLEAN_AD_ACTIONS = new Set(["splice", "drop-ad", "strip-markers"]);

try {
  detailsEl.open = localStorage.getItem("detailsOpen") === "1";
} catch {}
detailsEl.addEventListener("toggle", () => {
  try {
    localStorage.setItem("detailsOpen", detailsEl.open ? "1" : "0");
  } catch {}
});

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

// What the viewer would see in this tab right now: { text, tone } where tone is
// "ok", "ad" or "idle".
function tabState(tab, mode) {
  if (tab.adActive) {
    if (mode === "observe") return { text: "Ad (observe only)", tone: "ad" };
    const action = tab.lastBlock?.action;
    if (CLEAN_AD_ACTIONS.has(action) && !tab.lastBlock.error) {
      return { text: action === "strip-markers" ? "Ad blocked" : "Ad replaced", tone: "ok" };
    }
    if (action === "strip-ad") return { text: "Waiting for live", tone: "ad" };
    return { text: "Ad showing", tone: "ad" };
  }
  if (!tab.lastMediaAt || Date.now() - tab.lastMediaAt > IDLE_MS) return { text: "Idle", tone: "idle" };
  return { text: "Live", tone: "ok" };
}

function describeQuality(quality) {
  if (!quality) return null;
  return /^(hev1|hvc1)/.test(quality.codecs ?? "") ? `${quality.name} HEVC` : quality.name;
}

function renderStatus(state) {
  let text;
  let tone;
  if (state.mode === "observe") {
    text = "Observe only: ads are not blocked";
    tone = "warn";
  } else if (state.tabs.length === 0) {
    text = "Blocking ads. No Twitch streams open.";
    tone = "";
  } else {
    const showing = state.tabs.filter((t) => tabState(t, state.mode).tone === "ad").length;
    text = showing ? `An ad is showing in ${plural(showing, "tab")}` : `Blocking ads · ${plural(state.tabs.length, "stream")}`;
    tone = showing ? "ad" : "ok";
  }
  statusEl.textContent = text;
  statusEl.className = `status ${tone}`;
}

// Most urgent first: an ad the viewer can see, then ads being handled, live, idle.
const TONE_ORDER = { ad: 0, ok: 1, idle: 2 };
// Past this many tabs, cards become one-line rows so the popup stays short.
const MAX_CARDS = 3;

function sortTabs(tabs, mode) {
  const rank = (tab) => {
    const { tone } = tabState(tab, mode);
    return TONE_ORDER[tone] * 2 + (tone === "ok" && !tab.adActive ? 1 : 0);
  };
  return [...tabs].sort((a, b) => rank(a) - rank(b) || (a.channel ?? "").localeCompare(b.channel ?? ""));
}

function renderRow(tab, mode) {
  const { text, tone } = tabState(tab, mode);
  return el("div", { className: `row-item ${tone === "ad" ? "ad" : ""}` }, [
    el("span", { className: `dot ${tone}` }),
    el("strong", { textContent: tab.channel ?? "(unknown channel)" }),
    el("span", { className: "muted small", textContent: describeQuality(tab.quality) ?? "" }),
    el("span", { className: `state ${tone}`, textContent: text }),
  ]);
}

function renderCard(tab, mode) {
  const { text, tone } = tabState(tab, mode);
  const line = [describeQuality(tab.quality), tab.adBreaks ? plural(tab.adBreaks, "ad break") : null].filter(Boolean).join(" · ");
  return el("section", { className: `card ${tone === "ad" ? "ad" : ""}` }, [
    el("div", { className: "card-head" }, [
      el("span", { className: `dot ${tone}` }),
      el("strong", { textContent: tab.channel ?? "(unknown channel)" }),
      el("span", { className: `state ${tone}`, textContent: text }),
    ]),
    ...(line ? [el("div", { className: "muted", textContent: line })] : []),
  ]);
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
  const fields = [
    ["Player type", tab.playerType ?? "?"],
    ["Rendition", tab.quality ? `${tab.quality.name} (${tab.quality.codecs})` : "?"],
    ["Top rendition", tab.topVariant ? `${tab.topVariant.name} (${tab.topVariant.codecs})` : "?"],
    ["Playlists", `${tab.mediaResponses} (last ${ago(tab.lastMediaAt)})`],
    ["Request types", tab.requestTypes.join(", ") || "?"],
    ["Ad breaks", String(tab.adBreaks)],
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
  return el("section", { className: "tab-detail" }, [
    el("h2", {}, [el("span", { textContent: tab.channel ?? "(unknown)" }), el("span", { className: "muted small", textContent: `tab ${tab.tabId}` })]),
    el("dl", {}, fields.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })])),
    ...(tab.lastProbe ? [probeTable(tab.lastProbe)] : []),
  ]);
}

function renderMode(mode) {
  for (const name of ["block", "observe"]) {
    document.getElementById(`mode-${name}`).setAttribute("aria-checked", String(mode === name));
  }
}

for (const name of ["block", "observe"]) {
  document.getElementById(`mode-${name}`).addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "setMode", mode: name });
    refresh();
  });
}

const logModeEl = document.getElementById("log-mode");
const logNoteEl = document.getElementById("log-note");
logModeEl.addEventListener("change", async () => {
  await browser.runtime.sendMessage({ type: "setLogMode", logMode: logModeEl.value });
  refresh();
});

function logNote(state) {
  if (state.logMode === "off") return "Nothing is recorded.";
  if (state.logMode === "always") return "Recording every capture to extension storage.";
  const last = state.lastDump;
  const lastText = !last ? "" : last.error ? ` Last save failed: ${last.error}` : ` Last file: ${ago(last.at)} (${last.reasons.join(", ")}).`;
  return `Watching in memory (${state.ring.count} entries). A file goes to Downloads/twitch-block-delta/ if something goes wrong.${lastText}`;
}

async function refresh() {
  const state = await browser.runtime.sendMessage({ type: "state" });
  renderStatus(state);
  const sorted = sortTabs(state.tabs, state.mode);
  const compact = sorted.length > MAX_CARDS;
  tabsEl.classList.toggle("compact", compact);
  tabsEl.replaceChildren(...sorted.map((tab) => (compact ? renderRow : renderCard)(tab, state.mode)));

  renderMode(state.mode);
  if (logModeEl.value !== state.logMode) logModeEl.value = state.logMode;
  logNoteEl.textContent = logNote(state);
  tabDetailsEl.replaceChildren(...state.tabs.map(renderTabDetail));
  // Stored captures only exist after "Always" logging; the in-memory buffer only
  // fills in "Problems only".
  const hasCaptures = state.logMode === "always" || state.captures > 0;
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  summaryEl.hidden = !hasCaptures;
  summaryEl.textContent = `${state.captures} captures · ${mb(state.storage.bytes)} of ${mb(state.storage.maxBytes)} MB`;
  document.getElementById("export").hidden = !hasCaptures;
  document.getElementById("clear").hidden = !hasCaptures;
  document.getElementById("dump").hidden = state.logMode !== "problems";
  document.querySelector(".actions").hidden = !hasCaptures && state.logMode !== "problems";
}

document.getElementById("export").addEventListener("click", async () => {
  const { exported } = await browser.runtime.sendMessage({ type: "export" });
  summaryEl.textContent = `Exported ${exported} captures.`;
});

document.getElementById("dump").addEventListener("click", async () => {
  const { entries } = await browser.runtime.sendMessage({ type: "dumpNow" });
  logNoteEl.textContent = `Saved the last ${entries} recent entries.`;
});

document.getElementById("clear").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "clear" });
  refresh();
});

refresh();
setInterval(refresh, 2000);
