/*
 * Discord only mounts a window of messages. A long jump unmounts the rest
 * before they can be read, so Scrollback moves upward in short hops and will
 * not continue unless an anchor message from the previous hop is still mounted.
 * If a hop skips that anchor, it backs up and temporarily shortens the step.
 */
(() => {
  if (globalThis.Scrollback) return;

  const PRESETS = {
    careful: { stepRatio: 0.18, delayMs: 1600, settleMs: 500 },
    slow: { stepRatio: 0.28, delayMs: 900, settleMs: 350 },
    medium: { stepRatio: 0.42, delayMs: 450, settleMs: 220 },
    fast: { stepRatio: 0.58, delayMs: 220, settleMs: 120 },
  };

  const DEFAULT_SETTINGS = {
    preset: "slow",
    stepRatio: PRESETS.slow.stepRatio,
    delayMs: PRESETS.slow.delayMs,
    settleMs: PRESETS.slow.settleMs,
    includeAttachments: true,
    includeEmbeds: true,
    includeReplies: true,
    includeReactions: false,
    compact: false,
    maxMessages: 0,
    autoDownload: true,
  };

  function createSession(hooks = {}) {
    let settings = { ...DEFAULT_SETTINGS };
    let phase = "idle";
    let statusMessage = "Open a channel, set a scroll speed, and start.";
    let runId = 0;
    let selectedIndex = 0;
    let messages = new Map();
    let oldestTs = null;
    let newestTs = null;
    let recoveries = 0;
    let startedAt = null;
    let finishedAt = null;
    let startHref = "";
    let temporaryCap = null;
    let cautiousTicks = 0;
    const listeners = new Set();

    function resolve() {
      return resolveList(selectedIndex);
    }

    function emit() {
      const snap = getState();
      for (const fn of listeners) {
        try {
          fn(snap);
        } catch {
          /* a UI listener must not kill the scroll loop */
        }
      }
    }

    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    function getState() {
      const meta = readMeta();
      return {
        phase,
        statusMessage,
        captured: messages.size,
        oldest: oldestTs,
        newest: newestTs,
        recoveries,
        startedAt,
        finishedAt,
        selectedIndex,
        lists: listChoices(),
        channelName: meta.channelName,
        guildLabel: meta.guildLabel,
        url: meta.url,
        settings: { ...settings },
      };
    }

    function updateSettings(partial) {
      settings = sanitizeSettings({ ...settings, ...partial });
      emit();
      return getState();
    }

    function pause() {
      if (phase !== "running") return getState();
      phase = "paused";
      statusMessage = "Paused. Adjust the throttle, then resume.";
      emit();
      return getState();
    }

    function resume() {
      if (phase !== "paused") return getState();
      phase = "running";
      statusMessage = "Scrolling older history…";
      emit();
      return getState();
    }

    function stop() {
      if (phase !== "running" && phase !== "paused") return getState();
      phase = "done";
      finishedAt = Date.now();
      statusMessage = messages.size
        ? "Stopped. Download what was captured, or start again."
        : "Stopped before any messages were captured.";
      runId += 1;
      emit();
      return getState();
    }

    async function start(options = {}) {
      settings = sanitizeSettings({ ...settings, ...(options.settings || {}) });
      if (typeof options.selectedIndex === "number") selectedIndex = options.selectedIndex;
      else selectedIndex = defaultListIndex();

      const mode = options.mode === "up" ? "up" : "full";
      messages = new Map();
      oldestTs = null;
      newestTs = null;
      recoveries = 0;
      temporaryCap = null;
      cautiousTicks = 0;
      startedAt = Date.now();
      finishedAt = null;
      startHref = location.href;
      phase = "running";
      statusMessage =
        mode === "full"
          ? "Jumping to the newest messages, then scrolling to the beginning…"
          : "Scrolling upward from the current position…";
      const my = ++runId;
      emit();

      const first = resolve();
      if (!first) {
        return fail("No Discord message list is open. Click a text channel, DM, or thread.");
      }
      if (mode === "full") {
        await jumpToLatest(first.scroller);
        if (!alive(my)) return getState();
        await sleep(Math.min(settings.delayMs, 400));
      }
      await loop(my);
      return getState();
    }

    function alive(my) {
      return runId === my && (phase === "running" || phase === "paused");
    }

    function fail(message) {
      phase = "error";
      statusMessage = message;
      finishedAt = Date.now();
      emit();
      return getState();
    }

    function finish(message, download) {
      if (phase === "done" || phase === "error") return;
      phase = "done";
      statusMessage = message;
      finishedAt = Date.now();
      emit();
      if (
        download &&
        messages.size &&
        settings.autoDownload &&
        typeof hooks.onComplete === "function"
      ) {
        try {
          hooks.onComplete(buildText(), makeFilename());
        } catch {
          /* the content script reports download failures */
        }
      }
    }

    async function loop(my) {
      let stuck = 0;
      let stableTop = 0;

      while (alive(my)) {
        if (phase === "paused") {
          await sleep(160);
          continue;
        }
        if (location.href !== startHref) {
          finish(
            "The tab left this channel, so scrolling stopped. Download what was captured, or start again.",
            true
          );
          return;
        }

        const target = resolve();
        if (!target) {
          fail("The message list disappeared. Open the channel again and restart.");
          return;
        }

        capture(target.ol);

        if (settings.maxMessages > 0 && messages.size >= settings.maxMessages) {
          finish(`Stopped after ${messages.size} messages (the newest ones reached).`, true);
          return;
        }

        if (target.scroller.scrollTop <= 8) {
          stuck = 0;
          if (isLoading(target.scroller)) {
            stableTop = 0;
            statusMessage = "At the top, waiting for Discord to load older messages…";
            emit();
            await sleep(Math.max(settings.delayMs, 250));
            continue;
          }
          const sizeBefore = messages.size;
          const heightBefore = target.scroller.scrollHeight;
          await sleep(settings.delayMs);
          if (!alive(my) || phase === "paused") continue;
          const again = resolve();
          if (!again) continue;
          capture(again.ol);
          const stillTop = again.scroller.scrollTop <= 8 && !isLoading(again.scroller);
          const grew = again.scroller.scrollHeight > heightBefore + 24;
          if (stillTop && !grew && messages.size === sizeBefore) {
            stableTop += 1;
            statusMessage =
              stableTop < 3
                ? "At the top. Confirming there is no older history…"
                : "Still at the top…";
            emit();
            if (stableTop >= 4) {
              finish(
                messages.size
                  ? `Reached the beginning. ${messages.size} messages captured.`
                  : "Reached the top, but no messages were found.",
                true
              );
              return;
            }
          } else {
            stableTop = 0;
            statusMessage = `Loading history… ${messages.size} messages captured.`;
            emit();
          }
          continue;
        }

        stableTop = 0;
        const items = visibleItems(target.ol);
        if (!items.length) {
          stuck += 1;
          statusMessage = "Waiting for messages to render…";
          emit();
          if (stuck >= 20) {
            finish("No messages rendered. Scroll the channel once by hand, then try again.", false);
            return;
          }
          await sleep(settings.delayMs);
          continue;
        }

        const anchor = pickAnchor(target.scroller, items);
        const beforeTop = target.scroller.scrollTop;
        const beforeCount = messages.size;
        const beforeHeight = target.scroller.scrollHeight;
        const ratio =
          temporaryCap == null ? settings.stepRatio : Math.min(settings.stepRatio, temporaryCap);
        const step = Math.max(36, Math.round(target.scroller.clientHeight * ratio));

        target.scroller.scrollTop = Math.max(0, beforeTop - step);
        statusMessage = `Scrolling older history… ${messages.size} messages captured.`;
        emit();

        await sleep(settings.delayMs);
        if (!alive(my) || phase === "paused") continue;
        const after = resolve();
        if (!after) continue;
        await waitForSettle(after.ol, settings.settleMs, Math.max(1000, settings.delayMs * 3));
        if (!alive(my) || phase === "paused") continue;

        if (anchor && !document.getElementById(anchor.liId)) {
          recoveries += 1;
          statusMessage = "That hop was too fast and would have skipped messages. Backing up…";
          emit();
          let recovered = false;
          for (let attempt = 0; attempt < 12 && alive(my); attempt++) {
            const cur = resolve();
            if (!cur) break;
            cur.scroller.scrollTop = Math.min(
              cur.scroller.scrollHeight,
              cur.scroller.scrollTop + Math.max(48, Math.round(step * 0.28))
            );
            await sleep(Math.max(80, Math.round(settings.delayMs * 0.5)));
            const settled = resolve();
            if (settled) await waitForSettle(settled.ol, Math.min(settings.settleMs, 180), 700);
            if (document.getElementById(anchor.liId)) {
              recovered = true;
              break;
            }
          }
          if (!recovered) {
            const cur = resolve();
            if (cur) cur.scroller.scrollTop = beforeTop;
            await sleep(settings.delayMs);
          }
          temporaryCap = Math.min(ratio, 0.2);
          cautiousTicks = 6;
          stuck = 0;
          continue;
        }

        if (cautiousTicks > 0) {
          cautiousTicks -= 1;
          if (cautiousTicks === 0) temporaryCap = null;
        }

        const cur = resolve();
        if (cur) capture(cur.ol);
        const curTop = cur ? cur.scroller.scrollTop : beforeTop;
        const curHeight = cur ? cur.scroller.scrollHeight : beforeHeight;
        if (curHeight > beforeHeight + 24 || messages.size > beforeCount || curTop < beforeTop - 4) {
          stuck = 0;
        } else {
          stuck += 1;
          if (stuck === 8 && cur) {
            cur.scroller.scrollTop = Math.max(
              0,
              cur.scroller.scrollTop - Math.round(cur.scroller.clientHeight * 0.12)
            );
          }
          if (stuck >= 20) {
            finish(
              "The scroller stopped moving before the beginning. Download what was captured, or retry on a slower preset.",
              true
            );
            return;
          }
        }
        emit();
      }
    }

    function buildText() {
      const meta = readMeta();
      const ordered = [...messages.values()].sort((a, b) => compareSnowflake(a.id, b.id));
      let carriedAuthor = null;
      for (const message of ordered) {
        if (message.author) carriedAuthor = message.author;
        else if (!message.system && carriedAuthor) message.authorFilled = carriedAuthor;
      }

      const exportedAt = new Date();
      const lines = [
        "Discord channel export",
        `Channel: ${meta.channelName}`,
        meta.guildLabel ? `Server: ${meta.guildLabel}` : null,
        `URL: ${startHref || meta.url}`,
        `Exported: ${formatTimestamp(exportedAt.toISOString())} (${formatOffset(exportedAt)})`,
        `Messages: ${ordered.length}`,
        recoveries ? `Scroll corrections: ${recoveries}` : null,
        "Order: oldest first",
        "",
        "----",
        "",
      ].filter((line) => line !== null);

      for (const message of ordered) {
        const who = message.author || message.authorFilled || (message.system ? "System" : "Unknown");
        const when = formatTimestamp(message.timestamp);
        if (settings.compact) {
          const bits = [`[${when}] ${who}: ${oneLine(message.content)}`];
          if (settings.includeReplies && message.reply) bits.push(`(reply to ${oneLine(message.reply)})`);
          if (settings.includeAttachments) bits.push(...message.attachments);
          if (settings.includeEmbeds) bits.push(...message.embeds.map((embed) => `(embed) ${oneLine(embed)}`));
          if (settings.includeReactions && message.reactions.length) bits.push(`{${message.reactions.join(", ")}}`);
          lines.push(bits.filter(Boolean).join(" "));
        } else {
          lines.push(`[${when}] ${who}${message.system ? " (system)" : ""}`);
          if (settings.includeReplies && message.reply) lines.push(`  reply to ${message.reply}`);
          if (message.content) {
            for (const line of message.content.split("\n")) lines.push(line ? `  ${line}` : "");
          }
          if (settings.includeAttachments) {
            for (const url of message.attachments) lines.push(`  attachment: ${url}`);
          }
          if (settings.includeEmbeds) {
            for (const embed of message.embeds) lines.push(`  embed: ${embed}`);
          }
          if (settings.includeReactions) {
            for (const reaction of message.reactions) lines.push(`  reaction: ${reaction}`);
          }
          lines.push("");
        }
      }

      if (!ordered.length) lines.push("(no messages captured)");
      lines.push("");
      return `\uFEFF${lines.join("\n")}`;
    }

    function makeFilename() {
      const meta = readMeta();
      const stamp = new Date();
      const p = (n) => String(n).padStart(2, "0");
      const when = `${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}-${p(stamp.getHours())}${p(stamp.getMinutes())}`;
      return `Scrollback/${slug(meta.channelName)}-${messages.size}msgs-${when}.txt`;
    }

    function capture(ol) {
      for (const li of ol.querySelectorAll('li[id^="chat-messages-"]')) {
        const parsed = parseMessage(li);
        if (!parsed) continue;
        const prev = messages.get(parsed.id);
        if (!prev) {
          messages.set(parsed.id, parsed);
          noteTime(parsed.timestamp);
        } else {
          mergeMessage(prev, parsed);
          noteTime(parsed.timestamp);
        }
      }
    }

    function noteTime(timestamp) {
      if (!timestamp) return;
      if (!oldestTs || timestamp < oldestTs) oldestTs = timestamp;
      if (!newestTs || timestamp > newestTs) newestTs = timestamp;
    }

    return {
      start,
      pause,
      resume,
      stop,
      updateSettings,
      getState,
      buildText,
      subscribe,
      makeFilename,
    };
  }

  function sanitizeSettings(input) {
    const preset = PRESETS[input.preset] ? input.preset : "custom";
    const stepRatio = clamp(numberOr(input.stepRatio, DEFAULT_SETTINGS.stepRatio), 0.08, 0.75);
    const delayMs = Math.round(clamp(numberOr(input.delayMs, DEFAULT_SETTINGS.delayMs), 100, 8000));
    const settleMs = Math.round(
      clamp(numberOr(input.settleMs, Math.min(700, delayMs * 0.4)), 40, 2000)
    );
    return {
      preset,
      stepRatio,
      delayMs,
      settleMs,
      includeAttachments: Boolean(input.includeAttachments),
      includeEmbeds: Boolean(input.includeEmbeds),
      includeReplies: Boolean(input.includeReplies),
      includeReactions: Boolean(input.includeReactions),
      compact: Boolean(input.compact),
      maxMessages: Math.max(0, Math.round(numberOr(input.maxMessages, 0))),
      autoDownload: input.autoDownload !== false,
    };
  }

  function listChoices() {
    return [...document.querySelectorAll('ol[data-list-id="chat-messages"]')].map((ol, index) => ({
      index,
      label: ol.getAttribute("aria-label") || `Message list ${index + 1}`,
    }));
  }

  function defaultListIndex() {
    const lists = [...document.querySelectorAll('ol[data-list-id="chat-messages"]')];
    let best = 0;
    let bestArea = -1;
    lists.forEach((ol, index) => {
      const rect = ol.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      if (area > bestArea) {
        bestArea = area;
        best = index;
      }
    });
    return best;
  }

  function resolveList(index) {
    const lists = [...document.querySelectorAll('ol[data-list-id="chat-messages"]')];
    if (!lists.length) return null;
    const ol = lists[Math.max(0, Math.min(index, lists.length - 1))];
    const scroller = findScroller(ol);
    if (!scroller) return null;
    return { ol, scroller };
  }

  function findScroller(ol) {
    let el = ol.parentElement;
    let fallback = null;
    while (el && el !== document.body && el !== document.documentElement) {
      const overflowY = getComputedStyle(el).overflowY;
      const canScroll = el.scrollHeight > el.clientHeight + 8;
      if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && canScroll) {
        return el;
      }
      if (!fallback && canScroll) fallback = el;
      el = el.parentElement;
    }
    return fallback || ol.parentElement;
  }

  function visibleItems(ol) {
    const items = [];
    for (const li of ol.querySelectorAll('li[id^="chat-messages-"]')) {
      if (!/^chat-messages-\d+-\d+$/.test(li.id)) continue;
      const rect = li.getBoundingClientRect();
      if (rect.height < 2 || rect.width < 2) continue;
      items.push({ liId: li.id, rect });
    }
    return items;
  }

  function pickAnchor(scroller, items) {
    const box = scroller.getBoundingClientRect();
    const targetY = box.top + scroller.clientHeight * 0.28;
    let best = null;
    let bestDist = Infinity;
    for (const item of items) {
      const dist = Math.abs(item.rect.top - targetY);
      if (dist < bestDist) {
        bestDist = dist;
        best = item;
      }
    }
    return best;
  }

  function isLoading(scroller) {
    const nodes = scroller.querySelectorAll('[aria-busy="true"], [role="status"], [class*="spinner"]');
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= 8 && rect.height >= 8) return true;
    }
    return false;
  }

  async function jumpToLatest(scroller) {
    for (let i = 0; i < 4; i++) {
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(90);
    }
  }

  function waitForSettle(node, quietMs, timeoutMs) {
    if (!node) return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      let timer = 0;
      const done = () => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(timer);
        clearTimeout(cap);
        resolve();
      };
      const bump = () => {
        clearTimeout(timer);
        timer = setTimeout(done, quietMs);
      };
      const observer = new MutationObserver(bump);
      observer.observe(node, { childList: true, subtree: true, characterData: true });
      bump();
      const cap = setTimeout(done, timeoutMs);
    });
  }

  function parseMessage(li) {
    const match = li.id.match(/^chat-messages-(\d+)-(\d+)$/);
    if (!match) return null;
    const article = li.querySelector('[role="article"]') || li;
    const time = article.querySelector("time[datetime]");
    const contentEl = article.querySelector('[id^="message-content-"]');
    const systemEl = article.querySelector('[class*="systemMessage"]');
    let content = contentEl ? extractText(contentEl) : "";
    let system = false;
    if (!content && systemEl) {
      content = extractText(systemEl);
      system = true;
    }
    const author = authorFrom(article);
    const attachments = collectMedia(article);
    const embeds = embedTexts(article);
    const reactions = reactionLabels(article);
    const reply = replyFrom(article);
    if (!content && !attachments.length && !embeds.length && !system && !author) return null;
    return {
      id: match[2],
      channelId: match[1],
      author,
      authorFilled: null,
      content,
      timestamp: time ? time.getAttribute("datetime") : null,
      attachments,
      embeds,
      reactions,
      reply,
      system,
    };
  }

  function mergeMessage(prev, next) {
    if (!prev.author && next.author) prev.author = next.author;
    if ((next.content || "").length > (prev.content || "").length) prev.content = next.content;
    if (!prev.timestamp && next.timestamp) prev.timestamp = next.timestamp;
    prev.attachments = union(prev.attachments, next.attachments);
    prev.embeds = union(prev.embeds, next.embeds);
    prev.reactions = union(prev.reactions, next.reactions);
    if (!prev.reply && next.reply) prev.reply = next.reply;
    if (next.system) prev.system = true;
  }

  function authorFrom(article) {
    const header = article.querySelector("h3");
    const scope = header || article;
    const named = scope.querySelector('[id^="message-username-"], [class*="username"]');
    if (!named) return null;
    if (!header && named.closest('[id^="message-reply-context"], [class*="repliedMessage"]')) return null;
    let name = (named.textContent || "").trim().replace(/\s+/g, " ");
    if (!name) return null;
    const bot = (header || named.parentElement)?.querySelector('[class*="botTag"], [class*="botText"]');
    if (bot) name += " [BOT]";
    return name;
  }

  function replyFrom(article) {
    const bar = article.querySelector('[id^="message-reply-context"], [class*="repliedMessage"]');
    if (!bar) return null;
    const user = bar.querySelector('[id^="message-username-"], [class*="username"]');
    const text = bar.querySelector('[id^="message-content-"], [class*="repliedText"]');
    const userName = (user?.textContent || "someone").trim().replace(/\s+/g, " ");
    const snippet = text ? extractText(text) : "";
    return snippet ? `${userName}: ${snippet}` : userName;
  }

  function collectMedia(article) {
    const urls = [];
    const seen = new Set();
    const scopes = [...article.querySelectorAll('[id^="message-accessories-"]')];
    const roots = scopes.length ? scopes : [article];
    for (const root of roots) {
      root.querySelectorAll("a[href], img[src], video[src], source[src]").forEach((el) => {
        if (el.tagName === "IMG" && /emoji/i.test(classText(el))) return;
        const href = el.getAttribute("href") || el.getAttribute("src");
        if (!href || href.startsWith("data:")) return;
        let abs;
        try {
          abs = new URL(href, location.href).href;
        } catch {
          return;
        }
        if (!/cdn\.discordapp\.com|media\.discordapp\.net/i.test(abs)) return;
        if (/\/avatars\/|\/embed\/avatars\/|\/emojis\/|\/icons\/|\/role-icons\/|\/assets\//i.test(abs)) {
          return;
        }
        if (!/\/attachments\/|\/stickers\/|\/external\/|media\.discordapp\.net/i.test(abs)) return;
        if (seen.has(abs)) return;
        seen.add(abs);
        urls.push(abs);
      });
    }
    return urls;
  }

  function embedTexts(article) {
    const box = article.querySelector('[id^="message-accessories-"]') || article;
    const cards = [...box.querySelectorAll('[class*="embed"]')].filter((el) => {
      return !/Title|Description|Provider|Footer|Field|Author/i.test(classText(el));
    });
    const sources = cards.length ? cards : [box];
    const lines = [];
    for (const card of sources) {
      const parts = [
        ...card.querySelectorAll('[class*="embedTitle"], [class*="embedDescription"], [class*="embedProvider"]'),
      ]
        .map((node) => (node.textContent || "").trim().replace(/\s+/g, " "))
        .filter(Boolean);
      const unique = [...new Set(parts)];
      if (unique.length) lines.push(unique.join(" — "));
    }
    return [...new Set(lines)];
  }

  function reactionLabels(article) {
    const labels = [];
    const seen = new Set();
    article
      .querySelectorAll('[class*="reaction"][aria-label], button[aria-label*="reaction"]')
      .forEach((el) => {
        const label = (el.getAttribute("aria-label") || "").trim();
        if (!label || seen.has(label)) return;
        seen.add(label);
        labels.push(label.replace(/,?\s*press to react$/i, ""));
      });
    return labels;
  }

  function extractText(root) {
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === "IMG") {
        parts.push(node.getAttribute("alt") || "");
        return;
      }
      if (node.tagName === "BR") {
        parts.push("\n");
        return;
      }
      if (node.tagName === "PRE") {
        parts.push(`\n${node.innerText.replace(/\n$/, "")}\n`);
        return;
      }
      if (node.tagName === "BLOCKQUOTE") parts.push("\n> ");
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    return parts
      .join("")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function readMeta() {
    const url = location.href;
    const cleaned = (document.title || "")
      .replace(/^\(\d+\)\s*/, "")
      .split("|")
      .map((part) => part.trim().replace(/\s*-\s*Discord\s*$/i, ""))
      .filter(Boolean);
    let channelName = cleaned[0] || "";
    const guildLabel = cleaned.length > 1 ? cleaned[1] : "";
    const aria = document.querySelector('ol[data-list-id="chat-messages"]')?.getAttribute("aria-label") || "";
    const ariaName = aria.replace(/^messages in\s+/i, "").trim();
    if (ariaName && ariaName.toLowerCase() !== "messages") channelName = ariaName;
    return {
      url,
      channelName: channelName || "discord-channel",
      guildLabel,
    };
  }

  function compareSnowflake(a, b) {
    try {
      const left = BigInt(a);
      const right = BigInt(b);
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    } catch {
      return String(a).localeCompare(String(b));
    }
  }

  function formatTimestamp(iso) {
    if (!iso) return "unknown time";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  }

  function formatOffset(date) {
    const minutes = -date.getTimezoneOffset();
    const sign = minutes >= 0 ? "+" : "-";
    const abs = Math.abs(minutes);
    const p = (n) => String(n).padStart(2, "0");
    return `UTC${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
  }

  function oneLine(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function slug(value) {
    const cleaned = String(value || "channel")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    return cleaned || "channel";
  }

  function union(left, right) {
    return [...new Set([...(left || []), ...(right || [])])];
  }

  function classText(el) {
    if (!el) return "";
    return typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
  }

  function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  globalThis.Scrollback = {
    PRESETS,
    DEFAULT_SETTINGS,
    createSession,
  };
})();
