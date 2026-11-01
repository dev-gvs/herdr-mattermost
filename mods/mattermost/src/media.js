// Avatars, custom emoji, attachments and images from messages, downloaded once into the app's data folder.
// fetch() returns only text, so images come down through curl.
import { exec, appHome, readTextFile, writeTextFile } from "herdr";

const DIR = "data/mattermost";
const DEMO = "mods/mattermost/demo/media";
const BATCH = 40;
const JOBS = 4;
const MAX_IMAGE = 50 * 1024 * 1024;
// Enough of most videos for a first frame, so a poster doesn't cost the whole file.
const POSTER_BYTES = 8 * 1024 * 1024 - 1;
const POLL = 500;

// exec cuts a program off after 30s, so anything that may run longer starts detached.
const FETCH_FILE = `mkdir -p "$(dirname "$2")"
nohup sh -c 'curl -sS -f --config "$0" -m 3600 -o "$1.part" "$2" && mv "$1.part" "$1" || { rm -f "$1.part"; : > "$1.failed"; }' "$1" "$2" "$3" >/dev/null 2>&1 &`;
const POSTER = `curl -sS -f --create-dirs --config "$1" -m 20 -r 0-${POSTER_BYTES} -o "$2" "$3"
ffmpeg -nostdin -loglevel error -y -i "$2" -frames:v 1 -vf "scale='min(640,iw)':-2" "$4"
rm -f "$2"`;
const STILL = `ffmpeg -nostdin -loglevel error -y -i "$1" -frames:v 1 "$2"`;
const PLAY = `if command -v mpv >/dev/null; then nohup mpv --force-window=immediate --really-quiet "$1" >/dev/null 2>&1 &
else nohup xdg-open "$1" >/dev/null 2>&1 &
fi`;

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`;
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
    return /^https?:\/\//.test(url) ? this.path(`${DIR}/avatars/x-${hash(url)}`, url) : null;
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

  // An image from a message or a link preview: on another host, so never with the token.
  remote(url) {
    // Anything else would read as a server path below, and go out with the token.
    if (!/^https?:\/\//i.test(url)) return null;
    if (this.demo) return `${DEMO}/${url.split("/").pop()}`;
    return this.path(`${DIR}/images/${hash(url)}`, url);
  }

  // A video's first frame. Servers make no preview of a video, so it comes from the start of the file.
  poster(fileId) {
    if (this.demo) return `${DEMO}/${fileId}.jpg`;
    const rel = `${DIR}/files/${fileId}-poster.jpg`;
    if (this.have.has(rel)) return rel;
    if (!this.failed.has(rel)) this.jobs.set(rel, { fileId });
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
    const base = ["-sS", "-f", "-m", "25", "-Z", "--create-dirs", "--max-filesize", String(MAX_IMAGE)];
    // Only outside hosts get redirects followed, so the token never travels with one.
    const server = [...base, "--config", auth];
    const outside = [...base, "-L", "--proto", "=http,https"];
    for (const [rel, url] of batch) {
      if (/^https?:\/\//.test(url)) outside.push(url, "-o", `${appHome()}/${rel}`);
      else server.push(`${cfg.url}/api/v4${url}`, "-o", `${appHome()}/${rel}`);
    }
    for (const args of [server, outside]) {
      if (!args.includes("-o") || (args === server && !auth)) continue;
      try {
        await exec("curl", args);
      } catch {}
    }
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
    const name = `${file.id}-${(file.name ?? "file").replace(/[^\w.\-]+/g, "_")}`;
    if (cfg.demo) return `${DEMO}/${file.id}.${file.extension}`;
    const rel = `${DIR}/downloads/${name}`, out = `${appHome()}/${rel}`;
    const exists = async (path) => (await exec("test", ["-e", path])).code === 0;
    if (await exists(out)) return rel;
    await exec("rm", ["-f", `${out}.failed`]);
    await exec("find", [`${appHome()}/${DIR}/downloads`, "-type", "f", "-mtime", "+14", "-delete"]).catch(() => {});
    await exec("sh", ["-c", FETCH_FILE, "sh", await this.auth(cfg), out, `${cfg.url}/api/v4/files/${file.id}`]);
    for (;;) {
      await wait(POLL);
      if (await exists(out)) return rel;
      if (await exists(`${out}.failed`)) return null;
    }
  }

  // What an animation costs once decoded: every frame is held in memory for as long as Herdr runs.
  async animationBytes(rel) {
    const r = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=width,height,nb_read_packets", "-of", "csv=p=0", `${appHome()}/${rel}`]).catch(() => null);
    const [w, h, frames] = (r?.stdout ?? "").trim().split(",").map(Number);
    return w * h * frames * 4 || null;
  }
}
