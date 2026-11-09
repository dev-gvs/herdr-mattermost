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

export async function chooseFiles(panel, box, cx) {
  if (box.choosing) return;
  box.choosing = true;
  try {
    const tool = (await exec("sh", ["-c", FIND_CHOOSER]).catch(() => null))?.stdout.trim();
    if (!tool) {
      panel.showError("Neither kdialog nor zenity is installed, so drop the files on the message box instead.", cx);
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
export async function uploadFiles(panel, box, paths, cx) {
  const key = box.key, channel = panel.boxChannel(box);
  if (!key || !channel) return;
  const room = MAX_FILES - (panel.drafts.get(key)?.file_ids?.length ?? 0) - (panel.uploads.get(key)?.length ?? 0);
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
  if (errors.length) panel.showError(errors.join(" "), cx);
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
        panel.showError(e?.message ?? String(e), cx);
      } finally {
        panel.uploads.set(key, (panel.uploads.get(key) ?? []).filter((u) => u !== up));
        panel.composerChanged(key, cx);
      }
    });
  }
  panel.composerChanged(key, cx);
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
  const ids = panel.drafts.get(box.key)?.file_ids ?? [];
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
      return card(id, f?.name ?? "File", f ? `${(f.extension ?? "").toUpperCase()} ${fileSize(f.size ?? 0)}`.trim() : "", (cx) => panel.detachFile(box.key, id, cx));
    }))
    .children(ups.map((u) => card(u.client, u.name, "Uploading…", null)));
}
