// Avatars and custom emoji, downloaded once into the app's data folder.
// fetch() returns only text, so images come down through curl.
import { exec, appHome } from "herdr";

const DIR = "data/mattermost";
const BATCH = 40;

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export class Media {
  constructor() {
    this.have = new Set();
    this.failed = new Set();
    this.queue = new Map();
    this.busy = false;
  }

  async scan() {
    for (const sub of ["avatars", "emoji", "files"]) {
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
    return this.path(`${DIR}/files/${fileId}.jpg`, `/files/${fileId}/thumbnail`);
  }

  emoji(id) {
    return id ? this.path(`${DIR}/emoji/${id}`, `/emoji/${id}/image`) : null;
  }

  pending() {
    return this.queue.size > 0 && !this.busy;
  }

  // Resolves true when something new landed, so the caller knows to redraw.
  async flush(cfg) {
    if (!this.pending() || cfg.demo) return false;
    this.busy = true;
    const batch = [...this.queue].slice(0, BATCH);
    for (const [rel] of batch) this.queue.delete(rel);
    const base = ["-sS", "-f", "-m", "60", "--create-dirs"];
    // Only outside hosts get redirects followed, so the token never travels with one.
    const server = [...base, "-H", `Authorization: Bearer ${cfg.token}`];
    const outside = [...base, "-L"];
    for (const [rel, url] of batch) {
      if (/^https?:\/\//.test(url)) outside.push(url, "-o", `${appHome()}/${rel}`);
      else server.push(`${cfg.url}/api/v4${url}`, "-o", `${appHome()}/${rel}`);
    }
    for (const args of [server, outside]) {
      if (!args.includes("-o")) continue;
      try {
        await exec("curl", args);
      } catch {}
    }
    const before = this.have.size;
    await this.scan();
    for (const [rel] of batch) if (!this.have.has(rel)) this.failed.add(rel);
    this.busy = false;
    return this.have.size > before;
  }
}
