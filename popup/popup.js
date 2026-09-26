"use strict";

const summaryEl = document.getElementById("summary");
const tabsEl = document.getElementById("tabs");
document.getElementById("version").textContent = `v${browser.runtime.getManifest().version}`;

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

function probeTable(probe) {
  const rows = probe.results.flatMap((r) => {
    const renditions = r.error ? [{ error: r.error }] : r.renditions;
    return renditions.map((x) => {
      const verdict = x.error ? `error: ${x.error}` : x.isAd ? `ads (${x.adKind})` : "clean";
      const cls = x.error ? "muted" : x.isAd ? "state-ad" : "state-ok";
      return el("tr", {}, [
        el("td", { textContent: `${r.playerType} (${r.auth})` }),
        el("td", { textContent: x.variant ?? x.wanted ?? "" }),
        el("td", { className: cls, textContent: verdict }),
      ]);
    });
  });
  return el("div", {}, [
    el("div", { className: "muted", textContent: `Probe round ${probe.round}, ${ago(probe.at)}` }),
    el("table", {}, rows),
  ]);
}

function renderTab(tab) {
  const state = tab.adActive
    ? el("span", { className: "state-ad", textContent: tab.adKind === "client" ? "CLIENT AD MARKER" : "STITCHED AD" })
    : el("span", { className: "state-ok", textContent: "live" });
  const fields = [
    ["Player type", tab.playerType ?? "?"],
    ["Last fetched rendition", tab.quality ? `${tab.quality.name} (${tab.quality.codecs})` : "?"],
    ["Top rendition", tab.topVariant ? `${tab.topVariant.name} (${tab.topVariant.codecs})` : "?"],
    ["Playlists", `${tab.mediaResponses} (last ${ago(tab.lastMediaAt)})`],
    ["Request types", tab.requestTypes.join(", ") || "?"],
    ["Ad breaks", String(tab.adBreaks)],
  ];
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
  return el("section", { className: "tab" }, [
    el("h2", {}, [`${tab.channel ?? "(unknown)"} · tab ${tab.tabId} · `, state]),
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
    renderMode((await browser.runtime.sendMessage({ type: "setMode", mode: name })).mode);
  });
}

async function refresh() {
  const state = await browser.runtime.sendMessage({ type: "state" });
  renderMode(state.mode);
  summaryEl.textContent = `${state.captures} captures stored · ${state.tabs.length} tab(s) observed`;
  tabsEl.replaceChildren(...state.tabs.map(renderTab));
}

document.getElementById("export").addEventListener("click", async () => {
  const { exported } = await browser.runtime.sendMessage({ type: "export" });
  summaryEl.textContent = `Exported ${exported} captures.`;
});

document.getElementById("clear").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "clear" });
  refresh();
});

refresh();
setInterval(refresh, 2000);
