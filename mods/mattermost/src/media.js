// Avatars, custom emoji, attachments and images from messages, downloaded once into the app's data folder.
// fetch() returns only text, so images come down through curl.
import { exec, appHome, readTextFile, writeTextFile } from "herdr";

const DIR = "data/mattermost";
const DEMO = "mods/mattermost/demo/media";
const BATCH = 40;
const JOBS = 4;
const MAX_IMAGE = 50 * 1024 * 1024;
// Herdr keeps every decoded image until it quits, and a small file can decode to gigabytes.
export const MAX_PIXELS = 64_000_000;
const IMAGE_DAYS = 30;
// Enough of most videos for a first frame, so a poster doesn't cost the whole file.
const POSTER_BYTES = 8 * 1024 * 1024 - 1;
const POLL = 500;
const DOWNLOAD_SECONDS = 3600;
// Leaves room for the post id, ".part" and ".failed" in a file name's 255 bytes.
const MAX_NAME = 200;
const WEB_URL = /^https?:\/\//i;
// ffmpeg runs on files from anyone who posts one, with no click, so playlists and the like, which open
// other files and URLs, are refused.
const FF_INPUT = "-protocol_whitelist file -format_whitelist mov,matroska,avi,mpegts,mpeg,flv,ogg,asf,gif,webp,webp_pipe,png_pipe,apng,jpeg_pipe,bmp_pipe,tiff_pipe";

// exec cuts a program off after 30s, so anything that may run longer starts detached.
const FETCH_FILE = `mkdir -p "$(dirname "$2")"
nohup sh -c 'curl -sS -f --config "$0" -m ${DOWNLOAD_SECONDS} -o "$1.part" "$2" && mv "$1.part" "$1" || { rm -f "$1.part"; : > "$1.failed"; }' "$1" "$2" "$3" >/dev/null 2>&1 &`;
// A file that arrived with no usable frame is marked, or it would be fetched again at every start. A failed
// fetch isn't: the next start can try again.
const POSTER = `command -v ffmpeg >/dev/null || exit 0
curl -sS -f --create-dirs --config "$1" -m 20 -r 0-${POSTER_BYTES} -o "$2" "$3"
got=$?
ffmpeg -nostdin -loglevel error -y ${FF_INPUT} -i "$2" -frames:v 1 -vf "scale='min(640,iw)':-2" "$4" || [ "$got" != 0 ] || : > "$4.none"
rm -f "$2"`;
const STILL = `ffmpeg -nostdin -loglevel error -y ${FF_INPUT} -i "$1" -frames:v 1 -vf "scale='min(1280,iw)':-2" "$2"`;
// Servers count frames only for GIFs, so a file's own header is the only sign of an animated WebP or of a GIF
// whose URL doesn't say so. Sizes come from the file too, since what a host serves here may differ from what
// it served the server.
const MARK = `for f; do
  [ -f "$f" ] || continue
  if [ "$(head -c 3 "$f")" = GIF ]; then : > "$f.anim"
  elif [ "$(tail -c +9 "$f" | head -c 8)" = WEBPVP8X ]; then
    flags=$(od -An -tu1 -j20 -N1 "$f")
    [ $((\${flags:-0} & 2)) = 0 ] || : > "$f.anim"
  fi
  size=$(ffprobe -v error ${FF_INPUT} -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$f" 2>/dev/null) || continue
  w=\${size%%,*}
  h=\${size#*,}
  h=\${h%%,*}
  case "$w$h" in ""|*[!0-9]*) continue ;; esac
  [ $((w * h)) -le ${MAX_PIXELS} ] || : > "$f.big"
done`;
const PLAY = `if command -v mpv >/dev/null; then nohup mpv --force-window=immediate --really-quiet "$1" >/dev/null 2>&1 &
else nohup xdg-open "$1" >/dev/null 2>&1 &
fi`;

// Two mixes, because a plain base-31 hash has collisions anyone can type ("Aa" and "BB"), and a collision
// shows one URL's picture in place of another's.
function hash(text) {
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

export const openExternally = (path) => exec("sh", ["-c", 'nohup xdg-open "$1" >/dev/null 2>&1 &', "sh", path]);
export const playExternally = (path) => exec("sh", ["-c", PLAY, "sh", path]);

export class Media {
  constructor() {
    this.have = new Set();
    this.failed = new Set();
    this.queue = new Map();
    this.jobs = new Map();
    this.busy = false;
  }

  // Whoever posts a link decides what lands in images/, so it can't be left to pile up. Called before the
  // first scan, so nothing known to be here is gone.
  async prune() {
    await exec("find", [`${appHome()}/${DIR}/images`, "-type", "f", "-mtime", `+${IMAGE_DAYS}`, "-delete"]).catch(() => {});
  }

  async scan() {
    for (const sub of ["avatars", "emoji", "files", "images"]) {
      try {
        const r = await exec("ls", ["-1", `${appHome()}/${DIR}/${sub}`]);
        for (const name of r.stdout.split("\n")) if (name) this.have.add(`${DIR}/${sub}/${name}`);
      } catch {}
    }
  }

  // `url` is a server path, fetched with the token, or a full URL, fetched without it:
  // webhook icons live on other hosts, which must never see the Mattermost token.
  path(rel, url) {
    if (this.have.has(rel)) return rel;
    if (!this.failed.has(rel)) this.queue.set(rel, url);
    return null;
  }

  external(url) {
    if (!url) return null;
    if (url.startsWith("/")) return this.path(`${DIR}/avatars/x-${hash(url)}`, url.replace(/^\/api\/v4/, ""));
    return WEB_URL.test(url) ? this.path(`${DIR}/avatars/x-${hash(url)}`, url) : null;
  }

  avatar(user) {
    if (!user?.id) return null;
    if (this.demo) return `mods/mattermost/demo/avatars/${user.id}.png`;
    return this.path(`${DIR}/avatars/${user.id}-${user.last_picture_update ?? 0}.png`, `/users/${user.id}/image?_=${user.last_picture_update ?? 0}`);
  }

  // Mattermost draws standard emoji from its own images rather than the system font, named by codepoint.
  standard(server, char) {
    const hex = [...char].map((c) => c.codePointAt(0).toString(16)).join("-");
    return this.path(`${DIR}/emoji/u-${hex}.png`, `${server}/static/emoji/${hex}.png`);
  }

  thumb(fileId) {
    if (this.demo) return `${DEMO}/${fileId}.jpg`;
    return this.path(`${DIR}/files/${fileId}.jpg`, `/files/${fileId}/thumbnail`);
  }

  preview(fileId) {
    if (this.demo) return `${DEMO}/${fileId}.jpg`;
    return this.path(`${DIR}/files/${fileId}-preview.jpg`, `/files/${fileId}/preview`);
  }

  // An image from a message or a link preview. Whoever wrote the message chose the URL.
  remote(url) {
    // Anything else would read as a server path below, and go out with the token.
    if (!WEB_URL.test(url)) return null;
    if (this.demo) return `${DEMO}/${url.split("/").pop()}`;
    return this.path(`${DIR}/images/${hash(url)}`, url);
  }

  animated(rel) {
    return this.have.has(`${rel}.anim`);
  }

  oversized(rel) {
    return this.have.has(`${rel}.big`);
  }

  // A video's first frame. Servers make no preview of a video, so it comes from the start of the file.
  poster(fileId) {
    if (this.demo) return `${DEMO}/${fileId}.jpg`;
    const rel = `${DIR}/files/${fileId}-poster.jpg`;
    if (this.have.has(rel)) return rel;
    if (!this.failed.has(rel) && !this.have.has(`${rel}.none`)) this.jobs.set(rel, { fileId });
    return null;
  }

  // The first frame of an animation already downloaded, shown until it's asked to play.
  still(rel) {
    if (this.demo) return rel.replace(/\.[^.]+$/, ".jpg");
    const out = `${DIR}/images/${rel.split("/").pop()}-still.png`;
    if (this.have.has(out)) return out;
    if (!this.failed.has(out)) this.jobs.set(out, { from: rel });
    return null;
  }

  emoji(id) {
    if (this.demo && id) return `${DEMO}/${id}.png`;
    return id ? this.path(`${DIR}/emoji/${id}`, `/emoji/${id}/image`) : null;
  }

  pending() {
    return (this.queue.size > 0 || this.jobs.size > 0) && !this.busy;
  }

  // The token stays out of curl's arguments, where any process on the machine could read it. The file
  // sits in a folder only you can enter, so it's never readable, even before its own mode is set.
  async auth(cfg) {
    const file = `${appHome()}/${DIR}/private/curl.conf`;
    if (this.authed === cfg.token) return file;
    await exec("mkdir", ["-p", "-m", "700", `${appHome()}/${DIR}/private`]);
    const text = `header = "Authorization: Bearer ${cfg.token}"\n`;
    const old = await readTextFile(file).catch(() => null);
    if (old !== text) await writeTextFile(file, text, old);
    await exec("chmod", ["600", file]);
    this.authed = cfg.token;
    return file;
  }

  // Resolves true when something new landed, so the caller knows to redraw.
  async flush(cfg) {
    if (!this.pending() || cfg.demo) return false;
    this.busy = true;
    const batch = [...this.queue].slice(0, BATCH);
    for (const [rel] of batch) this.queue.delete(rel);
    const jobs = [...this.jobs].slice(0, JOBS);
    for (const [rel] of jobs) this.jobs.delete(rel);
    const auth = await this.auth(cfg).catch(() => null);
    // URLs come from messages, so curl mustn't read [ and { in them as ranges to expand.
    const base = ["-sS", "-f", "-g", "-m", "25", "-Z", "--create-dirs", "--max-filesize", String(MAX_IMAGE)];
    // Only outside hosts get redirects followed, so the token never travels with one.
    const server = [...base, "--config", auth];
    const outside = [...base, "-L", "--proto", "=http,https"];
    for (const [rel, url] of batch) {
      const out = `${appHome()}/${rel}`;
      // The server's image proxy rewrites URLs in messages and wants a session. No other full URL gets the
      // token, even one on this host, since whoever wrote the message chose it.
      if (url.startsWith(`${cfg.url}/api/v4/image?url=`)) server.push(url, "-o", out);
      else if (WEB_URL.test(url)) outside.push(url, "-o", out);
      else server.push(`${cfg.url}/api/v4${url}`, "-o", out);
    }
    for (const args of [server, outside]) {
      if (!args.includes("-o") || (args === server && !auth)) continue;
      try {
        // A cut-off file would pass for a finished one at the next scan. curl before 7.83 refuses the flag
        // outright (exit 2), and is still better than no images.
        if ((await exec("curl", [...args, "--remove-on-error"])).code === 2) await exec("curl", args);
      } catch {}
    }
    const landed = batch.map(([rel]) => rel).filter((rel) => rel.startsWith(`${DIR}/images/`));
    if (landed.length) await exec("sh", ["-c", MARK, "sh", ...landed.map((rel) => `${appHome()}/${rel}`)]).catch(() => {});
    for (const [rel, job] of jobs) {
      const out = `${appHome()}/${rel}`;
      try {
        if (job.from) await exec("sh", ["-c", STILL, "sh", `${appHome()}/${job.from}`, out]);
        else if (auth) await exec("sh", ["-c", POSTER, "sh", auth, `${out}.part`, `${cfg.url}/api/v4/files/${job.fileId}`, out]);
      } catch {}
    }
    const before = this.have.size;
    await this.scan();
    for (const [rel] of [...batch, ...jobs]) if (!this.have.has(rel)) this.failed.add(rel);
    this.busy = false;
    return this.have.size > before;
  }

  // A whole attachment, for playing or opening. Resolves to its path under the app's folder, or null if the
  // download failed. Kept for two weeks, so opening it again is instant and the folder doesn't grow forever.
  async download(cfg, file, wait) {
    const name = `${file.id}-${(file.name ?? "file").replace(/[^\w.\-]+/g, "_").slice(-MAX_NAME)}`;
    if (cfg.demo) return `${DEMO}/${file.id}.${file.extension}`;
    const rel = `${DIR}/downloads/${name}`, out = `${appHome()}/${rel}`;
    const exists = async (path) => (await exec("test", ["-e", path])).code === 0;
    if (await exists(out)) return rel;
    await exec("rm", ["-f", `${out}.failed`]);
    await exec("find", [`${appHome()}/${DIR}/downloads`, "-type", "f", "-mtime", "+14", "-delete"]).catch(() => {});
    await exec("sh", ["-c", FETCH_FILE, "sh", await this.auth(cfg), out, `${cfg.url}/api/v4/files/${file.id}`]);
    // curl gives up by itself, but it can't report back if something kills it first.
    const deadline = Date.now() + (DOWNLOAD_SECONDS + 60) * 1000;
    while (Date.now() < deadline) {
      await wait(POLL);
      if (await exists(out)) return rel;
      if (await exists(`${out}.failed`)) return null;
    }
    return null;
  }

  // What an animation costs once decoded: every frame is held in memory for as long as Herdr runs.
  async animationBytes(rel) {
    const r = await exec("ffprobe", ["-v", "error", ...FF_INPUT.split(" "), "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=width,height,nb_read_packets", "-of", "csv=p=0", `${appHome()}/${rel}`]).catch(() => null);
    const [w, h, frames] = (r?.stdout ?? "").trim().split(",").map(Number);
    return w * h * frames * 4 || null;
  }
}
