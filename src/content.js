(() => {
  if (globalThis.__scrollbackInstalled) return;
  globalThis.__scrollbackInstalled = true;

  const session = Scrollback.createSession({
    onComplete(text, filename) {
      downloadText(text, filename).then((saved) => {
        dock.setSaved(saved ? "Saved to your Downloads folder." : "Download was blocked. Use Download in the popup.");
      });
    },
  });

  const dock = createDock(session);
  let lastSaved = "";
  const ready = chrome.storage.local.get("scrollbackSettings").then((stored) => {
    if (stored && stored.scrollbackSettings) {
      lastSaved = JSON.stringify(stored.scrollbackSettings);
      session.updateSettings(stored.scrollbackSettings);
    }
  });

  session.subscribe((state) => {
    dock.render(state);
    const encoded = JSON.stringify(state.settings);
    if (encoded === lastSaved) return;
    lastSaved = encoded;
    chrome.storage.local.set({ scrollbackSettings: state.settings });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string" || !message.type.startsWith("scrollback:")) {
      return;
    }
    ready.then(() => handle(message)).then(
      (state) => sendResponse({ ok: true, state }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  });

  function handle(message) {
    if (message.type === "scrollback:ping" || message.type === "scrollback:get-state") {
      return session.getState();
    }
    if (message.type === "scrollback:update-settings") {
      return session.updateSettings(message.settings || {});
    }
    if (message.type === "scrollback:start") {
      dock.show();
      session.start({
        mode: message.mode,
        selectedIndex: message.selectedIndex,
        settings: message.settings,
      });
      return session.getState();
    }
    if (message.type === "scrollback:pause") return session.pause();
    if (message.type === "scrollback:resume") {
      dock.show();
      return session.resume();
    }
    if (message.type === "scrollback:stop") return session.stop();
    if (message.type === "scrollback:show-dock") {
      dock.show();
      return session.getState();
    }
    if (message.type === "scrollback:download") {
      const state = session.getState();
      if (!state.captured) return state;
      downloadText(session.buildText(), session.makeFilename()).then((saved) => {
        dock.setSaved(saved ? "Saved to your Downloads folder." : "Could not start the download.");
      });
      dock.show();
      return state;
    }
    return session.getState();
  }

  async function downloadText(text, filename) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "scrollback:download",
        text,
        filename,
      });
      if (response && response.ok) return true;
    } catch {
      /* popup/background may be asleep; fall back to a page download */
    }
    try {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename.split("/").pop() || "discord-export.txt";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return true;
    } catch {
      return false;
    }
  }

  function createDock(controller) {
    const host = document.createElement("div");
    host.id = "scrollback-dock-host";
    host.style.cssText = "position:fixed;z-index:2147483000;top:0;left:0;width:0;height:0;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .dock {
          position: fixed;
          right: 16px;
          bottom: 16px;
          width: 300px;
          padding: 12px 12px 10px;
          border-radius: 14px;
          background: #1c1712;
          color: #f4efe6;
          border: 1px solid #4a3b2a;
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
          font: 13px/1.4 ui-sans-serif, "Segoe UI", sans-serif;
        }
        .dock[hidden] { display: none; }
        header {
          display: flex;
          align-items: center;
          gap: 8px;
          cursor: grab;
          margin-bottom: 6px;
        }
        header strong { font-size: 13px; letter-spacing: 0.02em; }
        .phase {
          margin-left: auto;
          color: #e2b07a;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        button.icon {
          border: 0;
          background: transparent;
          color: #b5a792;
          cursor: pointer;
          font-size: 16px;
          line-height: 1;
          padding: 0 2px;
        }
        .status { margin: 0 0 4px; color: #f4efe6; }
        .meta { margin: 0 0 8px; color: #b5a792; font-size: 12px; }
        label { display: grid; grid-template-columns: 52px 1fr auto; gap: 6px; align-items: center; margin: 6px 0; color: #d9cbb8; font-size: 12px; }
        output { color: #f4efe6; font-variant-numeric: tabular-nums; }
        input[type="range"] { width: 100%; accent-color: #e08a3c; }
        .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .row button, .warn {
          border: 1px solid #5c4a38;
          background: #2a231c;
          color: #f4efe6;
          border-radius: 999px;
          padding: 5px 10px;
          cursor: pointer;
          font: inherit;
        }
        .row button.primary { background: #e08a3c; color: #2a1608; border-color: #e08a3c; font-weight: 650; }
        .saved { min-height: 1.2em; margin: 8px 0 0; color: #c6d3a4; font-size: 12px; }
      </style>
      <section class="dock" hidden>
        <header>
          <strong>Scrollback</strong>
          <span class="phase"></span>
          <button class="icon" type="button" title="Hide panel" aria-label="Hide panel">×</button>
        </header>
        <p class="status"></p>
        <p class="meta"></p>
        <label>Step <input class="step" type="range" min="8" max="75" step="1" /> <output class="step-out"></output></label>
        <label>Pause <input class="delay" type="range" min="100" max="4000" step="50" /> <output class="delay-out"></output></label>
        <div class="row">
          <button type="button" data-act="pause">Pause</button>
          <button type="button" data-button="resume" data-act="resume" class="primary">Resume</button>
          <button type="button" data-act="stop">Stop</button>
          <button type="button" data-act="download">Download</button>
        </div>
        <p class="saved"></p>
      </section>
    `;

    const root = shadow.querySelector(".dock");
    const phaseEl = shadow.querySelector(".phase");
    const statusEl = shadow.querySelector(".status");
    const metaEl = shadow.querySelector(".meta");
    const savedEl = shadow.querySelector(".saved");
    const step = shadow.querySelector(".step");
    const delay = shadow.querySelector(".delay");
    const stepOut = shadow.querySelector(".step-out");
    const delayOut = shadow.querySelector(".delay-out");
    let draggingSlider = false;
    let savedNote = "";

    const mount = () => {
      if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    };
    mount();
    const remount = new MutationObserver(mount);
    remount.observe(document.documentElement, { childList: true });

    shadow.querySelector(".icon").addEventListener("click", () => {
      open = false;
      root.hidden = true;
    });
    for (const input of [step, delay]) {
      input.addEventListener("pointerdown", () => {
        draggingSlider = true;
      });
      input.addEventListener("pointerup", () => {
        draggingSlider = false;
      });
      input.addEventListener("input", () => {
        const stepRatio = Number(step.value) / 100;
        const delayMs = Number(delay.value);
        stepOut.textContent = `${step.value}%`;
        delayOut.textContent = `${delayMs}ms`;
        controller.updateSettings({
          preset: "custom",
          stepRatio,
          delayMs,
          settleMs: Math.round(Math.min(700, Math.max(80, delayMs * 0.4))),
        });
      });
    }
    shadow.querySelector(".row").addEventListener("click", (event) => {
      const act = event.target?.dataset?.act;
      if (act === "pause") controller.pause();
      if (act === "resume") controller.resume();
      if (act === "stop") controller.stop();
      if (act === "download") {
        if (!controller.getState().captured) return;
        downloadText(controller.buildText(), controller.makeFilename()).then((saved) => {
          savedNote = saved ? "Saved to your Downloads folder." : "Could not start the download.";
          savedEl.textContent = savedNote;
        });
      }
    });

    const header = shadow.querySelector("header");
    let drag = null;
    let open = false;
    header.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      const rect = root.getBoundingClientRect();
      drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener("pointermove", (event) => {
      if (!drag) return;
      root.style.left = `${Math.max(8, event.clientX - drag.dx)}px`;
      root.style.top = `${Math.max(8, event.clientY - drag.dy)}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    });
    header.addEventListener("pointerup", () => {
      drag = null;
    });

    return {
      show() {
        mount();
        open = true;
        root.hidden = false;
      },
      setSaved(text) {
        savedNote = text;
        savedEl.textContent = text;
      },
      render(state) {
        if (!open || state.phase === "idle") return;
        mount();
        root.hidden = false;
        phaseEl.textContent = state.phase;
        statusEl.textContent = state.statusMessage;
        const oldest = state.oldest ? state.oldest.replace("T", " ").replace(/\.\d+Z$/, " UTC") : "—";
        metaEl.textContent = `${state.captured} messages · oldest ${oldest} · ${state.recoveries} slowdowns`;
        if (!draggingSlider) {
          step.value = String(Math.round(state.settings.stepRatio * 100));
          delay.value = String(state.settings.delayMs);
          stepOut.textContent = `${step.value}%`;
          delayOut.textContent = `${state.settings.delayMs}ms`;
        }
        shadow.querySelector('[data-act="pause"]').hidden = state.phase !== "running";
        shadow.querySelector('[data-act="resume"]').hidden = state.phase !== "paused";
        shadow.querySelector('[data-act="stop"]').hidden = state.phase !== "running" && state.phase !== "paused";
        shadow.querySelector('[data-act="download"]').hidden = !state.captured;
        savedEl.textContent = savedNote;
      },
    };
  }
})();
