chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "scrollback:download") return;

  const filename = sanitizeFilename(message.filename || "Scrollback/discord-export.txt");
  const text = typeof message.text === "string" ? message.text : "";
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download(
    {
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify",
    },
    (downloadId) => {
      const error = chrome.runtime.lastError;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      sendResponse(
        error
          ? { ok: false, error: error.message }
          : { ok: true, downloadId }
      );
    }
  );

  return true;
});

function sanitizeFilename(name) {
  const cleaned = String(name)
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^\w.\- ()[\]]+/g, "-").replace(/^\.+/, ""))
    .filter(Boolean)
    .join("/");
  return cleaned || "Scrollback/discord-export.txt";
}
