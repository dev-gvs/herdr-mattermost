// Attaching files from a message box: the paperclip (or Ctrl+U, or a drop on the box) picks them, each goes up
// on its own through `POST /files`, and the draft keeps their ids until the post takes them. fetch() sends only
// text, so the upload goes through curl with the token in its private config, detached as the picture's does.
import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, appHome, home, readTextFile } from "herdr";
import { alpha, fileSize, sleep } from "../main.js";
import { FIND_CHOOSER } from "./picture.js";
import { FF_FORMATS } from "./media.js";

const PRIVATE = "data/mattermost/private";
const POLL = 300;
const UPLOAD_SECONDS = 600;
const MAX_FILES = 10;
const DEFAULT_MAX_FILE = 100 * 1024 * 1024;
const remove = (...paths) => exec("rm", ["-f", ...paths]).catch(() => {});
const dropDir = (dir) => exec("rm", ["-rf", dir]).catch(() => {});
// A pasted image is the only file in a private folder of its own.
const folderOf = (path) => path.replace(/\/[^/]*$/, "");
const dropTemp = (path) => dropDir(folderOf(path));
// Folders left by a run that ended with files still in a draft. Only day-old ones go, so another panel's stay.
const SWEEP = `find "$0" -mindepth 1 -maxdepth 1 -type d \\( -name 'paste-*' -o -name 'local-*' \\) -mtime +0 -exec rm -rf {} +`;

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
// The progress bar goes to the error file, which the card reads for its percentage; the pid lets × stop it.
const UPLOAD = `curl -S -# --config "$0" -m ${UPLOAD_SECONDS} -o "$1.body" -w "%{http_code}" -F "$2" -F "$3" "$4" > "$1.part" 2>"$1.err" &
echo "$$ $!" > "$1.pid"
wait $!
mv "$1.part" "$1"`;
// The card's picture of a file from this machine: its first frame, 80px on the short side, which is the card's
// 40px at twice the density. Herdr keeps every decoded picture until it quits, so the original isn't drawn.
// It's read through a pipe so the format is told by the content, not by a name the whitelist can't vouch for.
const THUMB_SIDE = 80;
const PIPE_INPUT = `-protocol_whitelist pipe ${FF_FORMATS}`;
const MAKE_THUMB = `command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || exit 3
size=$(ffprobe -v error ${PIPE_INPUT} -select_streams v:0 -show_entries stream=width,height -of csv=p=0 -i pipe:0 < "$0") || exit 4
mkdir -p -m 700 "$(dirname "$1")" || exit 5
ffmpeg -nostdin -loglevel error -y ${PIPE_INPUT} -i pipe:0 -frames:v 1 -vf "scale='if(lt(iw,ih),min(${THUMB_SIDE},iw),-2)':'if(lt(iw,ih),-2,min(${THUMB_SIDE},ih))'" "$1" < "$0" || exit 6
echo "$size"`;
const COPY_SVG = 'mkdir -p -m 700 "$(dirname "$1")" && cp "$0" "$1"';

// Mattermost's file types (Constants.*_TYPES), checked in its order, and the icon each one gets.
const TYPES = [
  ["text", ["txt", "rtf", "vtt"]],
  ["image", ["jpg", "gif", "bmp", "png", "jpeg", "tiff", "tif", "webp"]],
  ["audio", ["mp3", "wav", "wma", "m4a", "flac", "aac", "ogg", "m4r"]],
  ["video", ["mp4", "avi", "webm", "mkv", "wmv", "mpg", "mov", "flv"]],
  ["spreadsheet", ["xlsx", "csv"]],
  ["code", ["applescript", "as", "atom", "bas", "bash", "boot", "c", "c++", "cake", "cc", "cjsx", "cl2", "clj", "cljc", "cljs", "cljs.hl", "cljscm", "cljx", "_coffee", "coffee", "cpp", "cs", "csharp", "cson", "css", "d", "dart", "delphi", "dfm", "di", "diff", "django", "docker", "dockerfile", "dpr", "erl", "ex", "exs", "f90", "f95", "freepascal", "fs", "fsharp", "gcode", "gemspec", "go", "groovy", "gyp", "h", "h++", "handlebars", "hbs", "hic", "hpp", "hs", "html", "html.handlebars", "html.hbs", "hx", "iced", "irb", "java", "jinja", "jl", "js", "json", "jsp", "jsx", "kt", "ktm", "kts", "lazarus", "less", "lfm", "lisp", "log", "lpr", "lua", "m", "mak", "matlab", "md", "mk", "mkd", "mkdown", "ml", "mm", "nc", "obj-c", "objc", "osascript", "pas", "pascal", "perl", "php", "php3", "php4", "php5", "php6", "pl", "plist", "podspec", "pp", "ps", "ps1", "py", "r", "rb", "rs", "rss", "ruby", "scala", "scm", "scpt", "scss", "sh", "sld", "sql", "st", "styl", "swift", "tex", "thor", "v", "vb", "vbnet", "vbs", "veo", "xhtml", "xml", "xsl", "yaml", "zsh"]],
  ["word", ["doc", "docx"]],
  ["presentation", ["ppt", "pptx"]],
  ["pdf", ["pdf"]],
  ["patch", ["patch"]],
  ["svg", ["svg"]],
];
const ICONS = { text: "text", audio: "audio", video: "video", spreadsheet: "excel", presentation: "ppt", pdf: "pdf", code: "code", word: "word", patch: "patch", image: "image" };
const fileType = (ext) => TYPES.find(([, list]) => list.includes((ext ?? "").toLowerCase()))?.[0] ?? "other";
const fileIcon = (type) => `mods/mattermost/icons/files/${ICONS[type] ?? "generic"}.svg`;
const extensionOf = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");
const svgsOn = (panel) => panel.clientConfig?.EnableSVGs === "true";
// Mattermost's THUMBNAIL_WIDTH and THUMBNAIL_HEIGHT: a picture smaller than both is centred, not pinned top left.
const SMALL_W = 128, SMALL_H = 100;
const CARD_H = 64, PIC = 40;
const detached = (script, ...args) => exec("sh", ["-c", 'nohup sh -c "$0" "$@" >/dev/null 2>&1 &', script, ...args]);

// curl reads ; and , in a -F value as its own syntax, unless the value is quoted.
const quoted = (text) => `"${text.replace(/["\\]/g, "\\$&")}"`;
const formFile = (path) => `files=@${quoted(path)};filename=${quoted(path.split("/").pop())}`;

export const canUpload = (config) => config?.EnableFileAttachments === "true";
const maxFileSize = (config) => parseInt(config?.MaxFileSize, 10) || DEFAULT_MAX_FILE;

let clients = 0;
let swept = false;

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
  if (!swept) {
    swept = true;
    exec("sh", ["-c", SWEEP, `${appHome()}/${PRIVATE}`]).catch(() => {});
  }
  for (const f of sized) {
    const name = f.path.split("/").pop();
    const up = { client: `up-${Date.now()}-${clients++}`, key, name, size: f.size, extension: extensionOf(name), percent: 0 };
    panel.uploads.set(key, [...(panel.uploads.get(key) ?? []), up]);
    localThumb(panel, up, f.path, temp, cx);
    cx.spawn(async (cx) => {
      try {
        const info = panel.cfg.demo ? { id: `demo-${up.client}`, name, size: f.size, extension: up.extension } : await send(panel, f.path, channel, up, cx);
        if (up.cancelled) return;
        panel.fileInfos.set(info.id, info);
        const local = panel.localThumbs.get(up.client);
        if (local) {
          panel.localThumbs.delete(up.client);
          panel.localThumbs.set(info.id, local);
          local.key = info.id;
        }
        panel.attachFile(key, channel, box.thread ? key : "", info.id, cx);
      } catch (e) {
        if (!up.cancelled) boxError(panel, box, e?.message ?? String(e), cx);
      } finally {
        panel.uploads.set(key, (panel.uploads.get(key) ?? []).filter((u) => u !== up));
        panel.composerChanged(key, cx);
      }
    });
  }
  panel.composerChanged(key, cx);
}

// The card shows a file from this machine as it is, during the upload and after, until the draft is sent or the
// card removed; pruneLocal then deletes the folder, with a pasted image's own file in it.
function localThumb(panel, up, path, temp, cx) {
  const type = fileType(up.extension);
  const picture = type === "image" || (type === "svg" && svgsOn(panel));
  if (!picture && !temp) return;
  const dir = temp ? folderOf(path) : `${appHome()}/${PRIVATE}/local-${Date.now()}-${clients++}`;
  const local = { key: up.client, dir, rel: null, w: 0, h: 0 };
  panel.localThumbs.set(up.client, local);
  if (!picture) return;
  const out = `${dir}/${type === "svg" ? `preview-${clients++}.svg` : `thumb-${clients++}.png`}`;
  cx.spawn(async (cx) => {
    const r = await exec("sh", ["-c", type === "svg" ? COPY_SVG : MAKE_THUMB, path, out]).catch(() => null);
    if (r?.code !== 0 || panel.localThumbs.get(local.key) !== local) return;
    const [w, h] = r.stdout.trim().split(/[,\s]+/).map(Number);
    Object.assign(local, { rel: out.slice(appHome().length + 1), w: w || 0, h: h || 0 });
    panel.redraw(cx);
  });
}

// Once nothing holds a file any more (sent, taken off, its upload stopped or failed, its edit closed), its
// picture and the folder it lives in go.
export function pruneLocal(panel) {
  const thumbs = panel.localThumbs;
  if (!thumbs?.size) return;
  const live = new Set();
  for (const d of panel.drafts.values()) for (const id of d.file_ids ?? []) live.add(id);
  if (panel.editBox?.key) for (const id of panel.editBox.fileIds) live.add(id);
  for (const ups of panel.uploads.values()) for (const u of ups) live.add(u.client);
  for (const [id, local] of thumbs) {
    if (live.has(id)) continue;
    thumbs.delete(id);
    dropDir(local.dir);
  }
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

// curl's progress bar is "###   42.5%" lines joined by carriage returns; its own errors start with "curl:".
const lastPercent = (err) => Number([...(err ?? "").matchAll(/(\d+(?:\.\d+)?)%/g)].pop()?.[1] ?? 0);
const curlError = (err) => (err ?? "").split(/[\r\n]+/).filter((l) => l.startsWith("curl:")).join(" ").trim();

async function send(panel, path, channel, up, cx) {
  const cfg = panel.cfg;
  const auth = await panel.media.auth(cfg);
  const out = `${appHome()}/${PRIVATE}/attach-up-${Date.now()}-${clients++}`;
  await detached(UPLOAD, auth, out, formFile(path), `channel_id=${channel}`, `${cfg.url}/api/v4/files`);
  const deadline = Date.now() + (UPLOAD_SECONDS + 60) * 1000;
  try {
    while (Date.now() < deadline) {
      await sleep(cx, POLL);
      if (up.cancelled) {
        const pids = (await readTextFile(`${out}.pid`).catch(() => ""))?.trim().split(" ").filter((x) => /^\d+$/.test(x)) ?? [];
        if (pids.length) await exec("kill", pids).catch(() => {});
        throw new Error("cancelled");
      }
      const code = await readTextFile(out).catch(() => null);
      const err = await readTextFile(`${out}.err`).catch(() => null);
      if (code === null) {
        const percent = Math.min(100, lastPercent(err));
        if (percent !== up.percent) {
          up.percent = percent;
          panel.composerChanged(up.key, cx);
        }
        continue;
      }
      const body = await readTextFile(`${out}.body`).catch(() => null);
      let json = null;
      try { json = JSON.parse(body ?? "null"); } catch {}
      if (code.trim() === "201" && json?.file_infos?.[0]) return json.file_infos[0];
      const failed = json?.message ?? curlError(err);
      throw new Error(failed || `Upload failed (HTTP ${code.trim()})`);
    }
    throw new Error("The upload timed out.");
  } finally {
    await remove(out, `${out}.body`, `${out}.err`, `${out}.pid`, `${out}.part`);
  }
}

// Mattermost's FilePreview under the text: a 320×64 card per file, its picture or its type's icon in the first 63px,
// then the name, the type and size, or how the upload goes, and a × in the corner.
export function filePreviews(panel, box, t) {
  const ids = panel.fileIdsOf(box.key);
  const ups = panel.uploads.get(box.key) ?? [];
  if (!ids.length && !ups.length) return null;
  const files = ids.map((id) => {
    const f = panel.fileInfo(id);
    const remove = box.keepFiles ? null : (cx) => panel.detachFile(box.key, id, cx);
    return card(t, id, thumbnail(panel, id, f), [
      div().truncate().max_w(151).mb(3).font_semibold().child(f?.name ?? ""),
      h_flex().min_w(0).text_color(alpha(t.foreground, 0.73))
        .when(Boolean(f?.extension), (el) => el.child(div().flex_none().max_w(134).truncate().child(f.extension.toUpperCase())))
        .when(Boolean(f), (el) => el.child(div().ml(4).truncate().child(fileSize(f.size ?? 0)))),
    ], remove, box.keepFiles ? "Post attachments cannot be edited" : null);
  });
  const uploading = ups.map((u) => {
    const local = panel.localThumbs.get(u.client);
    const pic = local?.rel ? localPicture(local) : picFrame(image(fileIcon(fileType(u.extension))).w(32).h(40), false);
    const status = u.percent >= 100 ? "Processing..." : `Uploading... (${Math.round(u.percent)}%)`;
    return card(t, u.client, pic, [
      div().truncate().max_w(151).mb(3).font_semibold().child(u.name),
      div().truncate().text_color(alpha(t.foreground, 0.75)).child(status),
    ], (cx) => cancelUpload(panel, box.key, u, cx), null, u.percent > 0 && u.percent < 100 ? u.percent : null);
  });
  return h_flex().id(`fp-${box.name}`).w_full().h(80).flex_none().pl(8).items_center().overflow_x_scroll()
    .children(files).children(uploading);
}

// × on an upload stops it, as Mattermost's cancelUpload does; the server never hears of the file.
function cancelUpload(panel, key, up, cx) {
  up.cancelled = true;
  panel.uploads.set(key, (panel.uploads.get(key) ?? []).filter((u) => u !== up));
  panel.composerChanged(key, cx);
}

function card(t, key, picture, lines, onRemove, disabledTip, percent = null) {
  return h_flex().id(`fp-${key}`).relative().flex_none().w(320).min_w(204).max_w_full().h(CARD_H).mr(10).items_center()
    .rounded(4).border_1().border_color(alpha(t.foreground, 0.16)).bg(t.background).text_color(t.foreground)
    .hover((s) => s.shadow_sm())
    .child(div().w(63).h_full().flex_none().flex().items_center().justify_center().child(picture))
    .child(h_flex().relative().flex_1().min_w(0).h_full().items_center().pr(32).text_size(12)
      .child(div().flex_1().min_w(0).h(36).overflow_hidden().line_height("16px").children(lines))
      .when(Boolean(onRemove) || Boolean(disabledTip), (el) => el.child(removeButton(t, key, onRemove, disabledTip)))
      .when(percent !== null, (el) => el.child(div().absolute().left(0).right(0).bottom(0).h(4).bg(alpha(t.accent, 0.16))
        .child(div().h_full().w(`${Math.round(percent)}%`).bg(t.accent)))));
}

function removeButton(t, key, onRemove, disabledTip) {
  const el = div().id(`fp-x-${key}`).absolute().top(4).right(4).size(28).flex().items_center().justify_center().rounded(4)
    .text_color(alpha(t.foreground, 0.75)).child(svg("mods/mattermost/icons/compass/close.svg").size(14));
  if (!onRemove) return el.opacity(0.5).tooltip(disabledTip);
  return el.cursor_pointer().hover((s) => s.bg(alpha(t.foreground, 0.08)))
    .active((s) => s.bg(alpha(t.accent, 0.08)).text_color(t.accent))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onRemove(cx); });
}

// Mattermost's .post-image: a 40px square with the picture as a cover background, pinned top left unless the
// picture is smaller than a thumbnail both ways, which centres it. Herdr's image() only fits, so the cover is
// worked out here and the frame clips it.
function picFrame(content, framed) {
  return framed ? div().relative().size(PIC).flex_none().rounded(4).overflow_hidden().bg("#ffffff").child(content) : content;
}

function cover(rel, w, h, small) {
  if (!(w > 0 && h > 0)) return picFrame(image(rel).size(PIC), true);
  const scale = Math.max(PIC / w, PIC / h);
  const dw = w * scale, dh = h * scale;
  const pic = image(rel).absolute().w(dw).h(dh).left(small ? (PIC - dw) / 2 : 0).top(small ? (PIC - dh) / 2 : 0);
  return picFrame(pic, true);
}

const isSmall = (w, h) => w > 0 && h > 0 && w < SMALL_W && h < SMALL_H;
const localPicture = (local) => (local.rel.endsWith(".svg") ? picFrame(image(local.rel).size(PIC), true) : cover(local.rel, local.w, local.h, isSmall(local.w, local.h)));

function thumbnail(panel, id, f) {
  const type = fileType(f?.extension);
  const local = panel.localThumbs.get(id);
  if (local?.rel && (type === "image" || type === "svg")) {
    const w = f?.width || local.w, h = f?.height || local.h;
    return local.rel.endsWith(".svg") ? picFrame(image(local.rel).size(PIC), true) : cover(local.rel, w, h, isSmall(w, h));
  }
  if (type === "svg" && svgsOn(panel)) {
    const rel = panel.cfg?.demo ? null : panel.media.path(`data/mattermost/files/${id}.svg`, `/files/${id}`);
    return picFrame(rel ? image(rel).size(PIC) : div(), true);
  }
  if (type === "image" && f) {
    // A file uploaded in the demo has no picture of its own on "the server".
    const rel = panel.cfg?.demo && id.startsWith("demo-up-") ? null : panel.media.thumb(id);
    return rel ? cover(rel, f.width, f.height, isSmall(f.width, f.height)) : picFrame(div(), true);
  }
  return picFrame(image(fileIcon(type === "svg" ? "other" : type)).w(32).h(40), false);
}
