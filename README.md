# Scrollback

A Chrome extension that exports a Discord channel to a text file by scrolling the official web app at a speed you control.

Discord only keeps a slice of a channel on the page. Scrollback walks upward in short hops, writes down every message it sees, and backs up if a hop would skip messages that Discord has not painted yet. Slower settings are there so a long history can load without gaps.

It does not use a bot, and it does not read your Discord login token. Messages stay in the tab until you download the file.

## Install

1. Download this repository (Code → Download ZIP) and unzip it, or clone it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the unzipped folder (the one that contains `manifest.json`).
5. Pin **Scrollback**.

Edge and other Chromium browsers use the same steps from their extensions page.

## Export a channel

1. Open [discord.com](https://discord.com) in the browser and click the text channel, DM, or thread you want.
2. Click the Scrollback icon.
3. Pick a throttle. **Slow** is the right default for a long channel. **Careful** is slower still. **Fast** is only comfortable for short channels.
4. Choose **Export full history** (jumps to the newest message, then scrolls to the beginning) or **From here upward** (keeps your current position and only collects older messages).
5. Leave the tab in the foreground. You can close the popup. A small panel on the Discord page lets you pause, stop, or change the speed while it runs.
6. The `.txt` file is saved to your Downloads folder, under `Scrollback/`, when the beginning of the channel is reached. You can also press **Download .txt** early and keep what has been captured so far.

Switching channels mid-export stops the scroll so two channels are not mixed into one file.

## Throttle

| Control | What it does |
| --- | --- |
| Step | Fraction of the visible message list moved on each hop. Shorter steps overlap more, which is what keeps virtualized messages from being skipped. |
| Pause | How long to wait after each hop so Discord can fetch and paint older history. |
| Presets | Careful, Slow, Medium, and Fast set both controls together. Moving a slider switches you to a custom speed. |
| Stop after | `0` means the whole channel. Any other number keeps the newest messages, because the walk starts at the bottom. |

If a hop is too aggressive, the status line says it is backing up and the **slowdowns** counter increases. The next hops get shorter until the overlap is safe again. That correction is automatic. You can still drag the sliders down yourself at any time; the new speed is used on the next hop.

The on-page panel can be dragged and hidden. **Show on-page controls** in the popup brings it back.

## Text file

Messages are oldest first.

```
[2024-03-01 12:00:01] Ada
  reply to Lin: the earlier note
  hello
  attachment: https://cdn.discordapp.com/attachments/...
```

Turn on **One line per message** for a compact log. Attachments, embeds, reply quotes, and reactions can each be left out. Custom emoji are written as their `:shortcode:` or alt text. A grouped burst of messages from the same person does not repeat their name on every bubble in Discord; Scrollback fills those in from the message that started the burst.

The file starts with a UTF-8 BOM so Notepad reads accents correctly.

## Limits

- You can only export channels the logged-in account can already read. This does not bypass permissions.
- The Discord tab has to stay open on that channel. Navigating away stops the export.
- Very large channels take a while on purpose. Careful mode on a busy channel can run for a long time.
- Discord changes its page markup without notice. If a channel comes back empty, reload Discord and try again. The selectors are based on stable ids (`chat-messages-…`, `message-content-…`, `time[datetime]`), not on the hashed class names.
- Threads are a second message list. When both the channel and a thread are open, pick which list to export before you start.
- This is an archive of what the web app rendered: text, links, embed titles, and attachment URLs. It does not download media files, and CDN links can expire.

## Privacy

Scrollback’s permissions are `storage` (your throttle settings), `downloads` (the text file), and `scripting` (attach to a Discord tab that was already open). Host access is limited to `discord.com`. There is no account, no analytics, and no server.

## Development

The scroll engine is `src/engine.js`. `test/virtual-list.html` is a stand-in channel that only mounts visible rows and prepends older history when you reach the top, which is the behavior that makes a naive “scroll to the top and copy” export drop messages.

```bash
node scripts/make-icons.mjs
node test/virtual-list.test.mjs
```

The test needs [Playwright](https://playwright.dev/) and Chromium.

## License

MIT. Not affiliated with Discord.
