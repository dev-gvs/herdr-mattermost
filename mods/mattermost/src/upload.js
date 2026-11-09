// Attaching files from a message box: the paperclip (or Ctrl+U, or a drop on the box) picks them, each goes up
// on its own through `POST /files`, and the draft keeps their ids until the post takes them. fetch() sends only
// text, so the upload goes through curl with the token in its private config, detached as the picture's does.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, home, readTextFile } from "herdr";
import { alpha, fileSize, sleep } from "../main.js";
import { FIND_CHOOSER } from "./picture.js";

const PRIVATE = "data/mattermost/private";
const POLL = 300;
const UPLOAD_SECONDS = 600;
const MAX_FILES = 10;
const DEFAULT_MAX_FILE = 100 * 1024 * 1024;
const remove = (...paths) => exec("rm", ["-f", ...paths]).catch(() => {});
// A pasted image is the only file in a private folder of its own.
const dropTemp = (path) => exec("rm", ["-rf", path.replace(/\/[^/]*$/, "")]).catch(() => {});

// Pasted images are read off the Wayland clipboard by wl-paste into a private file, which goes up as a picked one would.
const PASTE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const READ_CLIPBOARD = 'wl-paste --no-newline --type "$1" > "$2"';

// exec cuts a program off after 30s and people take longer than that in a file dialog, so it starts detached
// and leaves its answer, one path a line, in a file.
const CHOOSE = `NL='
'
[ -d "$2" ] || set -- "$1" "$HOME"
case "$0" in
  kdialog) kdialog --title "Upload files" --multiple --separate-output --getopenfilename "$2" ;;
  zenity) zenity --file-selection --title="Upload files" --multiple --separator="$NL" --filename="$2/" ;;
esac > "$1.part" 2>/dev/null
mv "$1.part" "$1"`;
const UPLOAD = `curl -sS --config "$0" -m ${UPLOAD_SECONDS} -o "$1.body" -w "%{http_code}" -F "$2" -F "$3" "$4" > "$1.part" 2>"$1.err"
mv "$1.part" "$1"`;
const detached = (script, ...args) => exec("sh", ["-c", 'nohup sh -c "$0" "$@" >/dev/null 2>&1 &', script, ...args]);

// curl reads ; and , in a -F value as its own syntax, unless the value is quoted.
const quoted = (text) => `"${text.replace(/["\\]/g, "\\$&")}"`;
const formFile = (path) => `files=@${quoted(path)};filename=${quoted(path.split("/").pop())}`;

export const canUpload = (config) => config?.EnableFileAttachments === "true";
const maxFileSize = (config) => parseInt(config?.MaxFileSize, 10) || DEFAULT_MAX_FILE;

let clients = 0;

// The edit box shows its own errors under it; the message boxes share the panel's.
function boxError(panel, box, text, cx) {
  if (!box.edit) return panel.showError(text, cx);
  box.error = text;
  cx.notify(box.part);
}

export async function chooseFiles(panel, box, cx) {
  if (box.choosing) return;
  box.choosing = true;
  try {
    const tool = (await exec("sh", ["-c", FIND_CHOOSER]).catch(() => null))?.stdout.trim();
    if (!tool) {
      boxError(panel, box, "Neither kdialog nor zenity is installed, so drop the files on the message box instead.", cx);
      return;
    }
    await exec("mkdir", ["-p", "-m", "700", `${appHome()}/${PRIVATE}`]);
    const out = `${appHome()}/${PRIVATE}/attach-${Date.now()}`;
    await detached(CHOOSE, tool, out, home());
    for (;;) {
      await sleep(cx, POLL);
      const answer = await readTextFile(out).catch(() => null);
      if (answer === null) continue;
      await remove(out);
      const paths = answer.split("\n").map((s) => s.trim()).filter(Boolean);
      if (paths.length) await uploadFiles(panel, box, paths, cx);
      return;
    }
  } finally {
    box.choosing = false;
  }
}

// Mattermost's limits: ten files to a post, none over the server's MaxFileSize, none empty.
// A temporary file (a pasted image) is removed, with the folder it was written to, once it's up.
export async function uploadFiles(panel, box, paths, cx, { temp = false } = {}) {
  const key = box.key, channel = panel.boxChannel(box);
  if (!key || !channel) {
    if (temp) for (const path of paths) await dropTemp(path);
    return;
  }
  const room = MAX_FILES - (panel.fileIdsOf(key).length) - (panel.uploads.get(key)?.length ?? 0);
  const errors = [];
  if (paths.length > room) errors.push(`Uploads limited to ${MAX_FILES} files maximum. Please use additional posts for more files.`);
  const sized = [];
  for (const path of paths.slice(0, Math.max(0, room))) {
    const r = await exec("sh", ["-c", '[ -f "$1" ] && [ -r "$1" ] && wc -c < "$1"', "sh", path]).catch(() => null);
    const size = Number(r?.stdout.trim());
    if (!r || r.code !== 0) errors.push(`${path.split("/").pop()} can't be read.`);
    else if (size > maxFileSize(panel.clientConfig)) errors.push(`File above ${Math.round(maxFileSize(panel.clientConfig) / 1048576)}MB could not be uploaded: ${path.split("/").pop()}`);
    else if (!size) errors.push(`You are uploading an empty file: ${path.split("/").pop()}`);
    else sized.push({ path, size });
  }
  if (temp) for (const path of paths) if (!sized.some((f) => f.path === path)) await dropTemp(path);
  if (errors.length) boxError(panel, box, errors.join(" "), cx);
  for (const f of sized) {
    const name = f.path.split("/").pop();
    const up = { client: `up-${Date.now()}-${clients++}`, name, size: f.size, extension: name.includes(".") ? name.split(".").pop().toLowerCase() : "" };
    panel.uploads.set(key, [...(panel.uploads.get(key) ?? []), up]);
    cx.spawn(async (cx) => {
      try {
        const info = panel.cfg.demo ? { id: `demo-${up.client}`, name, size: f.size, extension: up.extension } : await send(panel, f.path, channel, cx);
        panel.fileInfos.set(info.id, info);
        panel.attachFile(key, channel, box.thread ? key : "", info.id, cx);
      } catch (e) {
        boxError(panel, box, e?.message ?? String(e), cx);
      } finally {
        if (temp) await dropTemp(f.path);
        panel.uploads.set(key, (panel.uploads.get(key) ?? []).filter((u) => u !== up));
        panel.composerChanged(key, cx);
      }
    });
  }
  panel.composerChanged(key, cx);
}

// Mattermost's name for a pasted file that has none: "Image Pasted at 2026-1-5 09-07.png" (createFileFromClipboardDataItem).
function pastedName(type, now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const ext = `.${type.slice(type.lastIndexOf("/") + 1).toLowerCase()}`;
  return `Image Pasted at ${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${pad(now.getHours())}-${pad(now.getMinutes())}${ext}`;
}

// The local files a text/uri-list names; anything that isn't a file on this machine is left out.
function localFiles(uriList) {
  return uriList.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))
    .map((s) => /^file:\/\/(localhost)?\//i.test(s) ? s.replace(/^file:\/\/(localhost)?/i, "") : null)
    .filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return null; } }).filter(Boolean);
}

// File managers copy files as a text/uri-list and offer the same URLs as text too, so a paste whose text is
// nothing but file URLs is taken as those files, as a drop of them would be.
export function filesAsText(text) {
  const lines = text?.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) ?? [];
  return lines.length > 0 && lines.every((s) => /^file:\/\//i.test(s));
}

// Mattermost attaches what a paste holds only when it has no text: an image, or files copied in a file
// manager. `text` is that file manager's text, pasted as text after all when the clipboard has no files.
export async function pasteFiles(panel, box, cx, text = null) {
  const types = await listClipboard(panel, box, cx);
  if (!types) return text && box.input.replace(text);
  const image = PASTE_TYPES.find((t) => types.includes(t)) ?? types.find((t) => t.startsWith("image/"));
  let paths = [];
  let temp = false;
  if ((image || types.includes("text/uri-list")) && !box.canAttach) {
    if (text) return box.input.replace(text);
    return image && boxError(panel, box, "File attachments are disabled.", cx);
  }
  if (image) {
    const dir = `${appHome()}/${PRIVATE}/paste-${Date.now()}-${clients++}`;
    const path = `${dir}/${pastedName(image)}`;
    const r = await exec("sh", ["-c", `mkdir -p -m 700 "$0" && ${READ_CLIPBOARD}`, dir, image, path]).catch((e) => ({ code: 1, stderr: e?.message ?? String(e) }));
    if (r.code !== 0) {
      await dropTemp(path);
      return boxError(panel, box, `Couldn't read the image from the clipboard: ${r.stderr.trim() || `wl-paste exited with ${r.code}`}`, cx);
    }
    paths = [path];
    temp = true;
  } else if (types.includes("text/uri-list")) {
    const r = await exec("wl-paste", ["--no-newline", "--type", "text/uri-list"]).catch(() => null);
    paths = r?.code === 0 ? localFiles(r.stdout) : [];
  }
  if (paths.length) return uploadFiles(panel, box, paths, cx, { temp });
  if (text) box.input.replace(text);
}

async function listClipboard(panel, box, cx) {
  if (!(await exec("sh", ["-c", "command -v wl-paste"]).catch(() => null))?.stdout.trim()) {
    boxError(panel, box, "Pasting images needs wl-paste from wl-clipboard, which isn't installed.", cx);
    return null;
  }
  const r = await exec("wl-paste", ["--list-types"]).catch(() => null);
  return r?.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : null;
}

async function send(panel, path, channel, cx) {
  const cfg = panel.cfg;
  const auth = await panel.media.auth(cfg);
  const out = `${appHome()}/${PRIVATE}/attach-up-${Date.now()}-${clients++}`;
  await detached(UPLOAD, auth, out, formFile(path), `channel_id=${channel}`, `${cfg.url}/api/v4/files`);
  const deadline = Date.now() + (UPLOAD_SECONDS + 60) * 1000;
  try {
    while (Date.now() < deadline) {
      await sleep(cx, POLL);
      const code = await readTextFile(out).catch(() => null);
      if (code === null) continue;
      const body = await readTextFile(`${out}.body`).catch(() => null);
      let json = null;
      try { json = JSON.parse(body ?? "null"); } catch {}
      if (code.trim() === "201" && json?.file_infos?.[0]) return json.file_infos[0];
      const failed = json?.message ?? (await readTextFile(`${out}.err`).catch(() => null))?.trim();
      throw new Error(failed || `Upload failed (HTTP ${code.trim()})`);
    }
    throw new Error("The upload timed out.");
  } finally {
    await remove(out, `${out}.body`, `${out}.err`);
  }
}

// Mattermost's FilePreview: a card per file under the text, with its type and size, or how the upload goes.
export function filePreviews(panel, box, t) {
  const ids = panel.fileIdsOf(box.key);
  const ups = panel.uploads.get(box.key) ?? [];
  if (!ids.length && !ups.length) return null;
  const card = (key, name, sub, onRemove) => h_flex().id(`fp-${key}`).relative().w(240).max_w_full().h(56).px(12).gap(12).items_center()
    .rounded(4).border_1().border_color(alpha(t.foreground, 0.16)).bg(t.background)
    .child(svg("mods/mattermost/icons/file-doc.svg").size(24).flex_none().text_color(t.muted))
    .child(v_flex().min_w(0).flex_1()
      .child(div().truncate().text_size(14).font_semibold().child(name))
      .child(div().truncate().text_size(12).text_color(alpha(t.foreground, 0.64)).child(sub)))
    .when(Boolean(onRemove), (el) => el.child(div().id(`fp-x-${key}`).absolute().top(-8).right(-8).size(20).flex().items_center().justify_center()
      .rounded_full().cursor_pointer().bg(t.foreground).text_color(t.background).text_size(14).tooltip("Remove")
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); onRemove(cx); })
      .child("×")));
  return h_flex().flex_wrap().gap(12).px(16).pt(4).pb(8)
    .children(ids.map((id) => {
      const f = panel.fileInfo(id);
      return card(id, f?.name ?? "File", f ? `${(f.extension ?? "").toUpperCase()} ${fileSize(f.size ?? 0)}`.trim() : "", box.keepFiles ? null : (cx) => panel.detachFile(box.key, id, cx));
    }))
    .children(ups.map((u) => card(u.client, u.name, "Uploading…", null)));
}
