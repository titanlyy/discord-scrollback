const PRESETS = {
  careful: { stepRatio: 0.18, delayMs: 1600, settleMs: 500 },
  slow: { stepRatio: 0.28, delayMs: 900, settleMs: 350 },
  medium: { stepRatio: 0.42, delayMs: 450, settleMs: 220 },
  fast: { stepRatio: 0.58, delayMs: 220, settleMs: 120 },
};

const gate = document.querySelector("#gate");
const app = document.querySelector("#app");
const channelEl = document.querySelector("#channel");
const listField = document.querySelector("#list-field");
const listSelect = document.querySelector("#list");
const statusEl = document.querySelector("#status");
const countEl = document.querySelector("#count");
const oldestEl = document.querySelector("#oldest");
const fixesEl = document.querySelector("#fixes");
const stepInput = document.querySelector("#step");
const delayInput = document.querySelector("#delay");
const stepOut = document.querySelector("#step-out");
const delayOut = document.querySelector("#delay-out");
const speedHint = document.querySelector("#speed-hint");
const note = document.querySelector("#note");

const fields = {
  compact: document.querySelector("#compact"),
  attachments: document.querySelector("#attachments"),
  embeds: document.querySelector("#embeds"),
  replies: document.querySelector("#replies"),
  reactions: document.querySelector("#reactions"),
  autodownload: document.querySelector("#autodownload"),
  max: document.querySelector("#max"),
  endHold: document.querySelector("#end-hold"),
};

let tabId = null;
let settingsHydrated = false;
let renderedLists = "";

document.querySelectorAll('input[type="range"], #max').forEach((input) => {
  input.addEventListener("pointerdown", () => {
    settingsHydrated = true;
  });
});

stepInput.addEventListener("input", () => {
  setPresetPressed("custom");
  paintSpeed();
  pushSettings();
});
delayInput.addEventListener("input", () => {
  setPresetPressed("custom");
  paintSpeed();
  pushSettings();
});

document.querySelector("#presets").addEventListener("click", (event) => {
  const preset = event.target?.dataset?.preset;
  if (!PRESETS[preset]) return;
  applyPreset(preset);
  pushSettings();
});

for (const input of Object.values(fields)) {
  input.addEventListener("change", pushSettings);
}

document.querySelector("#start").addEventListener("click", () => sendStart("full"));
document.querySelector("#from-here").addEventListener("click", () => sendStart("up"));
document.querySelector("#pause").addEventListener("click", () => send("scrollback:pause"));
document.querySelector("#resume").addEventListener("click", () => send("scrollback:resume"));
document.querySelector("#stop").addEventListener("click", () => send("scrollback:stop"));
document.querySelector("#download").addEventListener("click", () => send("scrollback:download"));
document.querySelector("#show-dock").addEventListener("click", () => send("scrollback:show-dock"));

applyPreset("slow");
init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";
  if (!tab?.id || !/^https:\/\/([a-z0-9-]+\.)?discord\.com\//i.test(url)) {
    gate.hidden = false;
    app.hidden = true;
    return;
  }
  tabId = tab.id;
  gate.hidden = true;
  app.hidden = false;
  await refresh();
  setInterval(refresh, 500);
}

async function refresh() {
  if (!tabId) return;
  try {
    const response = await sendRaw({ type: "scrollback:get-state" });
    if (response?.state) paint(response.state);
  } catch (error) {
    statusEl.textContent = "Could not reach Discord on this tab. Reload the channel and try again.";
    note.textContent = error instanceof Error ? error.message : "";
  }
}

function paint(state) {
  const where = [state.channelName, state.guildLabel].filter(Boolean).join(" · ");
  channelEl.textContent = where || "Discord channel";
  statusEl.textContent = state.statusMessage;
  countEl.textContent = String(state.captured);
  oldestEl.textContent = state.oldest
    ? state.oldest.replace("T", " ").replace(/\.\d+Z$/, "")
    : "—";
  fixesEl.textContent = String(state.recoveries);
  note.textContent =
    state.phase === "running" || state.phase === "paused"
      ? "You can close this popup. The on-page panel keeps the throttle."
      : "Nothing leaves your browser. Scrollback does not read your Discord token.";

  const listKey = JSON.stringify(state.lists);
  if (listKey !== renderedLists) {
    renderedLists = listKey;
    listSelect.innerHTML = "";
    for (const list of state.lists) {
      const option = document.createElement("option");
      option.value = String(list.index);
      option.textContent = list.label;
      listSelect.appendChild(option);
    }
  }
  listField.hidden = state.lists.length < 2;
  if (listSelect.options.length && ![...listSelect.options].some((option) => option.value === listSelect.value)) {
    listSelect.value = String(state.selectedIndex);
  }

  const busy = state.phase === "running" || state.phase === "paused";
  listSelect.disabled = busy;
  if (!settingsHydrated && state.settings) {
    fillSettings(state.settings);
    settingsHydrated = true;
  }

  document.querySelector("#start").hidden = busy;
  document.querySelector("#from-here").hidden = busy;
  document.querySelector("#pause").hidden = state.phase !== "running";
  document.querySelector("#resume").hidden = state.phase !== "paused";
  document.querySelector("#stop").hidden = !busy;
  document.querySelector("#download").hidden = !state.captured;
}

let appliedKey = "";

function fillSettings(settings) {
  const key = JSON.stringify(settings);
  if (key === appliedKey) return;
  appliedKey = key;
  stepInput.value = String(Math.round(settings.stepRatio * 100));
  delayInput.value = String(settings.delayMs);
  fields.compact.checked = settings.compact;
  fields.attachments.checked = settings.includeAttachments;
  fields.embeds.checked = settings.includeEmbeds;
  fields.replies.checked = settings.includeReplies;
  fields.reactions.checked = settings.includeReactions;
  fields.autodownload.checked = settings.autoDownload;
  fields.max.value = String(settings.maxMessages || 0);
  fields.endHold.value = String(Math.round((settings.endHoldMs || 15000) / 1000));
  setPresetPressed(settings.preset);
  paintSpeed();
}

function applyPreset(preset) {
  const values = PRESETS[preset];
  stepInput.value = String(Math.round(values.stepRatio * 100));
  delayInput.value = String(values.delayMs);
  setPresetPressed(preset);
  paintSpeed();
}

function setPresetPressed(preset) {
  for (const button of document.querySelectorAll("#presets button")) {
    button.setAttribute("aria-pressed", String(button.dataset.preset === preset));
  }
}

function paintSpeed() {
  const stepRatio = Number(stepInput.value) / 100;
  const delayMs = Number(delayInput.value);
  stepOut.textContent = `${stepInput.value}% of the screen`;
  delayOut.textContent = `${delayMs} ms`;
  const hopsPerMin = 60000 / Math.max(delayMs, 1);
  const screens = (hopsPerMin * stepRatio).toFixed(1);
  speedHint.textContent = `About ${screens} screens per minute, waiting ${delayMs} ms so older messages can load. Slow is the safe default for long channels.`;
}

function currentSettings() {
  const pressed = document.querySelector('#presets button[aria-pressed="true"]');
  const delayMs = Number(delayInput.value);
  return {
    preset: pressed?.dataset.preset || "custom",
    stepRatio: Number(stepInput.value) / 100,
    delayMs,
    settleMs: Math.round(Math.min(700, Math.max(80, delayMs * 0.4))),
    compact: fields.compact.checked,
    includeAttachments: fields.attachments.checked,
    includeEmbeds: fields.embeds.checked,
    includeReplies: fields.replies.checked,
    includeReactions: fields.reactions.checked,
    autoDownload: fields.autodownload.checked,
    maxMessages: Number(fields.max.value) || 0,
    endHoldMs: Math.round(Math.min(180, Math.max(2, Number(fields.endHold.value) || 15)) * 1000),
  };
}

function pushSettings() {
  settingsHydrated = true;
  send("scrollback:update-settings", { settings: currentSettings() });
}

function sendStart(mode) {
  send("scrollback:start", {
    mode,
    selectedIndex: Number(listSelect.value) || 0,
    settings: currentSettings(),
  });
}

function send(type, extra) {
  sendRaw({ type, ...extra }).then((response) => {
    if (response?.state) paint(response.state);
  });
}

async function sendRaw(message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/engine.js", "src/content.js"],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}
