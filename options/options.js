"use strict";

const allowedEl = document.getElementById("allowed");
const addForm = document.getElementById("add");
const addName = document.getElementById("add-name");
const addError = document.getElementById("add-error");
const logModeEl = document.getElementById("log-mode");
const logNoteEl = document.getElementById("log-note");
const summaryEl = document.getElementById("summary");

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

// Accepts a name, "@name" or a channel URL like twitch.tv/name.
function channelFrom(input) {
  const name = input.trim().replace(/\/+$/, "").split("/").pop().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(name) ? name : null;
}

async function setAllowed(channel, allowed) {
  await browser.runtime.sendMessage({ type: "setAllowed", channel, allowed });
  refresh();
}

function renderAllowed(channels) {
  allowedEl.replaceChildren(
    ...channels.map((channel) =>
      el("li", {}, [el("span", { textContent: channel }), el("button", { textContent: "Remove", onclick: () => setAllowed(channel, false) })]),
    ),
  );
}

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const channel = channelFrom(addName.value);
  addError.hidden = Boolean(channel);
  addError.textContent = "That doesn't look like a Twitch channel name.";
  if (!channel) return;
  addName.value = "";
  await setAllowed(channel, true);
});

for (const name of ["block", "observe"]) {
  document.getElementById(`mode-${name}`).addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "setMode", mode: name });
    refresh();
  });
}

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
  renderAllowed(state.allowedChannels);
  for (const name of ["block", "observe"]) {
    document.getElementById(`mode-${name}`).setAttribute("aria-checked", String(state.mode === name));
  }
  if (logModeEl.value !== state.logMode) logModeEl.value = state.logMode;
  logNoteEl.textContent = logNote(state);
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
