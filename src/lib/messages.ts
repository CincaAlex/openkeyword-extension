// Messages from extension pages to the background service worker. All queue mutations go
// through the background so they are serialized in one place.

export type BgMessage =
  | { type: "queueRemove"; id: string }
  | { type: "queueClear" }
  | { type: "flushNow" }
  | { type: "deleteData" };

export type BgReply = { ok: true; detail?: string } | { ok: false; error: string };

export async function sendToBackground(msg: BgMessage): Promise<BgReply> {
  try {
    const reply = (await chrome.runtime.sendMessage(msg)) as BgReply | undefined;
    return reply ?? { ok: false, error: "no_reply" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
