import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView, h_resizable, resizable_panel } from "gpui-base";
import { appHome, home, exec, readTextFile, writeTextFile, theme, props, shared, setShared, openOverlay, closeOverlay, settings } from "herdr";
import { WebSocket } from "websocket";
import { Media, openExternally, playExternally } from "./src/media.js";
import { postFiles, postAttachments, postEmbeds, remoteImage } from "./src/attach.js";
import { Menu } from "./src/menu.js";
import { EmojiPicker, PICKER_W, PICKER_H } from "./src/picker.js";
import { Switcher, SWITCHER_W, SWITCHER_H } from "./src/switcher.js";
import { EditDialog, StatusCard, Lightbox } from "./src/dialog.js";
import { SPECIAL, prepare, segments, jumbo, mentionNames } from "./src/content.js";
import { demoApi, DEMO } from "./demo/demo.js";

const PAGE = 60;
const THREAD_PAGE = 30;
const WIDE = 620;
const GROUP_GAP = 5 * 60e3;
// Mattermost's default for how many direct and group messages the sidebar lists.
const DM_LIMIT = 40;
const THREAD_LIST_W = 420;
const ATTEMPTS = 3;
const TIMEOUT = 15e3;
// Posts drawn at once; more are drawn as the timeline is scrolled up.
const WINDOW = 30;
// A row's height before it has been drawn once, so a fresh channel builds only what is near the screen.
const EST_ROW = 60;
const PARSED = 800;
// How long a part may spend building message rows before leaving the rest for the next render.
const ROW_BUDGET = 35;
const THREADS = "threads";
// Decoded frames of the animations played so far. Herdr keeps them until it quits, so past this they open in a player.
const ANIMATION_BUDGET = 512 * 1024 * 1024;
const UNKNOWN_ANIMATION = 64 * 1024 * 1024;
// Every sidebar icon sits in a 16px slot centered 17px from the pane edge, under the header's logo:
// ROW_PAD + ICON_SLOT / 2 = 17. Rows run edge to edge, as in Mattermost.
const ROW_PAD = 9;
const ICON_SLOT = 16;
// Shared state outlives the app, so a tab button can't tell a panel running now from one that ran last time
// unless the panel keeps restamping it.
const ALIVE_EVERY = 15e3;

const TOKEN_DOCS = "https://docs.mattermost.com/developers/integrate/reference/personal-access-token";

// The server and token live in the Herdr home, outside the mod folder, so sharing the mod can't take them along.
const loginPath = () => `${appHome()}/mattermost.json`;

// Null without a login, so the panel asks for one.
async function config() {
  if (props()?.demo) return DEMO;
  const own = JSON.parse((await readTextFile(loginPath()).catch(() => null)) ?? "null");
  if (!own?.url || !own?.token) return null;
  return { url: own.url.replace(/\/+$/, ""), token: own.token, team: own.team };
}

// People paste whatever is in the browser's address bar, often a channel's page.
const serverUrl = (text) => {
  const url = text.trim().replace(/\/+$/, "");
  if (!url) return "";
  return (/^https?:\/\//i.test(url) ? url : `https://${url}`).replace(/\/[^/]+\/(channels|messages|threads|pl)\/.*$/, "");
};

const sleep = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
// A stalled TLS handshake otherwise leaves a request pending forever.
const timed = (cx, promise) => Promise.race([promise, sleep(cx, TIMEOUT).then(() => { throw new Error("timed out"); })]);
const pad = (n) => String(n).padStart(2, "0");
const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Mattermost tints with rgba(center-channel-color, a); theme colors here are #rrggbb.
// Popups ask the panel for things through shared state; a demo panel listens on its own key, so a real
// one beside it doesn't act on made-up ids.
export const requestKey = () => (props()?.demo ? "mattermost.demo-request" : "mattermost.request");
// Links come from whoever wrote the message, so only web and mail addresses go to the system's opener.
export const openLink = (url) => { if (/^(https?|mailto):/i.test(url)) exec("xdg-open", [url]); };
export const alpha = (color, a) => (/^#[0-9a-f]{6}$/i.test(color) ? `${color}${pad(Math.round(a * 255).toString(16))}` : color);
// The panel assumes collapsed reply threads, so the sidebar orders and counts by root posts, as Mattermost does then.
const lastPost = (c) => c.last_root_post_at || c.last_post_at || c.create_at;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const replies = (n) => plural(n, "reply", "replies");
const SHORTCODES = /:([a-z0-9_+\-]+):/gi;

// The panel keeps only what it draws: the API's full objects are several times larger, and this
// runtime slows down sharply as its heap grows.
const CACHED = 10;
// How long a click on a channel whose posts aren't loaded keeps the previous one on screen.
const OPEN_WAIT = 500;
// Mattermost's .post: 1.5em of 14px plus the content's 5px, then a 53px avatar column whose 32px avatar sits 9px in.
const POST_PAD = 26;
const AVATAR_COL = 53;
const AVATAR_INSET = 9;
// Half the date label's height: the label is centered on the line between two posts.
const DATE_HALF = 13;
// A category's channels start their icon under its name's first letter, so it reads which group they
// belong to: the name follows the chevron's slot and a 6px gap, and a 14px icon sits 1px into its slot.
const INDENT = ICON_SLOT + 6 - 1;
const RHS_W = 360;
const STATUS = { online: ["online", "#3db887"], away: ["away", "#f5ab00"], dnd: ["dnd", "#d24b4e"] };
const RHS_MIN = 280;
const RHS_MAX = 640;
const SIDE_W = 260;
const SIDE_MIN = 180;
const SIDE_MAX = 480;
// The side view sits beside the messages while they keep this much width; narrower, it takes their place.
const MESSAGES_MIN = 420;
// Mattermost's own UI font, so text and weights match the desktop app.
export const FONT = "Open Sans";
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const CHANNEL_KEYS = ["id", "type", "name", "display_name", "purpose", "header", "create_at", "delete_at",
  "last_post_at", "last_root_post_at", "total_msg_count", "total_msg_count_root"];
const slimChannel = (c) => pick(c, CHANNEL_KEYS);
const slimMember = (m) => ({
  ...pick(m, ["channel_id", "msg_count", "msg_count_root", "mention_count", "mention_count_root", "last_viewed_at"]),
  notify_props: { mark_unread: m.notify_props?.mark_unread },
});
const slimUser = (u) => ({ ...pick(u, ["id", "username", "first_name", "last_name", "nickname", "position", "last_picture_update", "is_bot"]), custom: customStatus(u.props?.customStatus) });

// A user's custom status (`props.customStatus` is JSON text), or null when unset or broken.
function customStatus(raw) {
  try {
    const s = raw && JSON.parse(raw);
    return s?.emoji || s?.text ? { emoji: s.emoji ?? "", text: s.text ?? "", duration: s.duration ?? "", expires: Date.parse(s.expires_at ?? "") } : null;
  } catch {
    return null;
  }
}
// Mattermost's sortChannelsByRecencyAndTypeAndDisplayName: viewed ones newest first, then by type
// (public, private, direct, group) and name.
const TYPE_ORDER = { O: 0, P: 1, D: 2, G: 3 };
export function byRecency(a, b) {
  if (a.viewed && b.viewed) return b.viewed - a.viewed;
  if (a.viewed || b.viewed) return a.viewed ? -1 : 1;
  return (TYPE_ORDER[a.type] ?? 4) - (TYPE_ORDER[b.type] ?? 4) || a.display.localeCompare(b.display);
}

// Join and leave posts, which Mattermost hides unless the person (or the server's default) shows them.
const JOIN_LEAVE = new Set([
  "system_join_channel", "system_leave_channel", "system_add_to_channel", "system_remove_from_channel",
  "system_join_team", "system_leave_team", "system_add_to_team", "system_remove_from_team", "system_join_leave", "system_add_remove",
]);
const fromWebhook = (p) => p.props?.from_webhook === "true";
// Webhooks and plugins give their posts types of their own, such as slack_attachment, and those are ordinary posts.
const isSystem = (p) => Boolean(p.type?.startsWith("system_"));

// Keeps a Map to the most recently set entries.
function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHED) map.delete(map.keys().next().value);
}

function day(ms) {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === new Date(now.getTime() - 86400e3).toDateString()) return "Yesterday";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}

function dateLabel(ms) {
  const d = new Date(ms), label = day(ms);
  if (label === "Today" || label === "Yesterday") return label;
  return `${FULL_MONTHS[d.getMonth()]} ${pad(d.getDate())}${d.getFullYear() === new Date().getFullYear() ? "" : `, ${d.getFullYear()}`}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function fileSize(n) {
  if (n < 1024) return `${n}B`;
  return n < 1024 ** 2 ? `${Math.round(n / 1024)}KB` : `${(n / 1024 ** 2).toFixed(1)}MB`;
}

// As Mattermost's file list words it: "Wednesday at 14:24", "October 19 at 15:54".
function fileTime(ms) {
  const label = day(ms);
  const near = label === "Today" || label === "Yesterday" ? label : Date.now() - ms < 7 * 86400e3 ? WEEKDAYS[new Date(ms).getDay()] : dateLabel(ms);
  return `${near} at ${clock(ms)}`;
}

// Mattermost clears a timed status at expires_at; "dont_clear" keeps a placeholder date in year 1.
function liveStatus(custom) {
  if (!custom) return null;
  return !custom.duration || custom.duration === "dont_clear" || !(custom.expires < Date.now()) ? custom : null;
}

function until(custom) {
  if (!custom.duration || custom.duration === "dont_clear" || !Number.isFinite(custom.expires)) return "";
  const d = new Date(custom.expires);
  return day(custom.expires) === "Today" ? `Until ${clock(custom.expires)}` : `Until ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function ago(ms) {
  const min = Math.floor((Date.now() - ms) / 60e3);
  if (min < 1) return "just now";
  if (min < 60) return `${plural(min, "minute", "minutes")} ago`;
  if (min < 24 * 60) return `${plural(Math.floor(min / 60), "hour", "hours")} ago`;
  return day(ms);
}

function stamp(ms) {
  const d = day(ms);
  return d === "Today" ? clock(ms) : `${d.toLowerCase()} ${clock(ms)}`;
}

// Herdr re-renders a mod's root view on every change to its live data (agents, panes, focus), many
// times a second while agents work, and a render over 50 ms is cut off. Retained children are rebuilt
// only when notified, so the sidebar and the messages live in them and the root is a cheap frame.
const OWNERS = new Map();

class Part extends View {
  init(props) {
    this.owner = OWNERS.get(props.owner);
    this.part = props.part;
  }

  render(cx) {
    return this.owner.renderPart(this.part, cx);
  }
}

export default class Mattermost extends View {
  init(_props, cx) {
    if (props()?.statusCard) {
      this.popup = new StatusCard();
      return;
    }
    if (props()?.lightbox) {
      this.popup = new Lightbox();
      return;
    }
    if (props()?.edit) {
      this.cfgReady = config().then((cfg) => { this.cfg = cfg; });
      this.popup = new EditDialog(this);
      return;
    }
    if (props()?.menu) {
      this.cfgReady = config().then((cfg) => { this.cfg = cfg; });
      this.popup = new Menu(this);
      return;
    }
    if (props()?.switcher) {
      this.cfgReady = config().then((cfg) => { this.cfg = cfg; });
      this.popup = new Switcher(this, cx);
      return;
    }
    if (props()?.picker) {
      this.cfgReady = config().then((cfg) => { this.cfg = cfg; });
      this.popup = new EmojiPicker(this, cx);
      return;
    }
    this.ownerKey = OWNERS.size ? Math.max(...OWNERS.keys()) + 1 : 1;
    OWNERS.set(this.ownerKey, this);
    this.sidePart = cx.new(Part, { owner: this.ownerKey, part: "side" });
    this.mainPart = cx.new(Part, { owner: this.ownerKey, part: "main" });
    this.channels = new Map();
    this.members = new Map();
    this.users = new Map();
    this.posts = new Map();
    this.threadPosts = new Map();
    this.categories = [];
    this.threads = { all: null, unread: null };
    this.threadTab = "all";
    this.threadTotals = { total_unread_threads: 0, total_unread_mentions: 0 };
    this.selected = localStorage.getItem("selected");
    this.thread = null;
    this.live = false;
    this.busy = 0;
    this.unreadMemo = new Map();
    this.error = null;
    this.width = 0;
    this.offset = 0;
    this.shown = WINDOW;
    this.viewH = 0;
    this.viewW = 0;
    this.contentH = 0;
    this.heights = new Map();
    this.exhausted = new Set();
    this.media = new Media();
    this.fileState = new Map();
    this.playing = null;
    this.animationCost = new Map();
    this.emoji = {};
    this.customEmoji = new Map();
    this.missingEmoji = new Set();
    this.byUsername = new Map();
    this.unfinished = new Set();
    this.following = new Map();
    this.statuses = new Map();
    this.gmMembers = new Map();
    this.authors = new Set();
    this.saved = new Set();
    this.hoverPost = null;
    this.keepHover = null;
    this.rhsThread = null;
    this.rhsScroll = { offset: 0, viewH: 0, viewW: 0, contentH: 0, heights: new Map() };
    // Shared state outlives a restart, so a request already there is old news.
    this.seenRequest = shared(requestKey())?.id;
    this.rhs = null;
    this.rhsFrom = null;
    this.sideW = Number(localStorage.getItem("sideW")) || SIDE_W;
    this.rhsW = Number(localStorage.getItem("rhsW")) || RHS_W;
    this.editHover = null;
    this.stats = new Map();
    this.rhsData = { members: new Map(), pinned: new Map(), files: new Map() };
    this.textRev = 0;
    this.parsedCache = new Map();
    this.text = {
      emoji: this.emoji,
      custom: (name) => this.customEmoji.has(name),
      mention: (name) => this.mentionLabel(name),
      // Your own name and the mentions that reach everyone, as Mattermost highlights them.
      mine: (name) => { const n = name.toLowerCase(); return n === this.me?.username || n === "channel" || n === "all" || n === "here"; },
      highlight: () => this.mentionBg,
    };
    // Indigo's mention highlight, until the person's Mattermost theme says otherwise.
    this.mentionBg = "#133a91";

    this.input = InputState.new({ placeholder: "Message" });
    this.replyInput = InputState.new({ placeholder: "Reply to this thread..." });
    this.threadInput = InputState.new({ placeholder: "Reply to this thread..." });
    // One edit box, reused for whichever post is being edited. Herdr's textarea inserts the newline
    // before reporting Enter, so a plain Enter saves the text as it was just before; Shift+Enter keeps it.
    this.editInput = TextareaState.new({ placeholder: "Edit the post..." });
    this.editInput.set_auto_grow(1, 14);
    this.editInput.on("change", () => { this.editPrev = this.editNow; this.editNow = this.editInput.value(); });
    this.editInput.on("submit", (e, cx) => {
      if (e.shift || !this.editing) return;
      this.editInput.set_value(this.editPrev ?? "");
      this.saveEdit(cx);
    });
    // The side panel has no pane frame, so the mod draws one; its border follows the keyboard like a pane's.
    this.frame = Boolean(props()?.frame);
    this.focus = cx.focus_handle();
    for (const input of [this.input, this.replyInput, this.threadInput]) {
      input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
      input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    }
    this.input.on("submit", (_e, cx) => this.send(cx));
    this.urlInput = InputState.new({ placeholder: "https://chat.example.com" });
    this.tokenInput = InputState.new({ placeholder: "Paste the token" });
    this.tokenInput.set_masked(true);
    this.urlInput.on("submit", () => this.tokenInput.focus());
    this.tokenInput.on("submit", (_e, cx) => this.connectLogin(cx));
    this.replyInput.on("submit", (_e, cx) => this.send(cx, this.replyInput, this.rhsThread));
    this.threadInput.on("submit", (_e, cx) => this.send(cx, this.threadInput, this.thread));

    cx.timer.every(60e3, (cx) => cx.spawn(async (cx) => {
      if (!this.me) return;
      await this.loadStatuses(cx);
      cx.notify(this.sidePart);
    }));

    // A part whose render was cut off shows Herdr's error over its last frame until it renders again.
    cx.timer.every(200, (cx) => {
      if (!this.unfinished.size) return;
      this.warm();
      for (const part of this.unfinished) cx.notify(part === "side" ? this.sidePart : this.mainPart);
      this.unfinished.clear();
    });

    // Downloads run outside render; this picks up whatever the last render asked for.
    cx.timer.every(1000, (cx) => {
      const t = theme(), look = `${t.background}${t.foreground}${t.accent}${t.border}`;
      this.publishBadge();
      if (look !== this.look) {
        if (this.look) this.redraw(cx);
        this.look = look;
      }
      if (this.cfg && this.media.pending()) cx.spawn(async (cx) => { if (await this.media.flush(this.cfg)) this.redraw(cx); });
    });

    if (!props()?.demo) {
      cx.timer.after(0, () => setShared("mattermost.alive", Date.now()));
      cx.timer.every(ALIVE_EVERY, () => setShared("mattermost.alive", Date.now()));
    }

    cx.spawn(async (cx) => {
      try {
        this.cfg = await config();
        this.media.demo = Boolean(this.cfg?.demo);
        Object.assign(this.emoji, JSON.parse(await readTextFile(`${appHome()}/mods/mattermost/emoji/emoji.json`) ?? "{}"));
        await this.media.prune();
        await this.media.scan();
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.redraw(cx);
        return;
      }
      if (!this.cfg) {
        this.setup = { step: "login" };
        this.redraw(cx);
        return;
      }
      await this.start(cx);
    });
  }

  async start(cx) {
    this.connect(cx);
    // A failed first load would otherwise leave the panel empty until the websocket reconnects.
    for (let delay = 5000; ; delay = Math.min(delay * 2, 60e3)) {
      try {
        await this.load(cx);
        return;
      } catch (e) {
        this.error = `${String(e?.message ?? e)} · retrying in ${delay / 1000}s`;
        this.redraw(cx);
        await sleep(cx, delay);
      }
    }
  }

  // Checks the login against the server before saving it, so a typo shows here and not as a failing panel.
  async connectLogin(cx) {
    if (this.setup.busy) return;
    const url = serverUrl(this.urlInput.value()), token = this.tokenInput.value().trim();
    if (!url || !token) {
      this.setup = { step: "login", error: "Fill in the server and the token." };
      return cx.notify();
    }
    this.setup = { step: "login", busy: true };
    cx.notify();
    const get = async (path) => {
      let res;
      try {
        res = await timed(cx, fetch(`${url}/api/v4${path}`, { headers: { Authorization: `Bearer ${token}` } }));
      } catch (e) {
        throw new Error(`Couldn't reach the server: ${e?.message ?? e}`);
      }
      if (res.status === 401) throw new Error("The server didn't accept this token.");
      if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}. Is it the address you open Mattermost at?`);
      try {
        return await res.json();
      } catch {
        throw new Error(`No Mattermost server answered at ${url}.`);
      }
    };
    try {
      await get("/users/me");
      const teams = (await get("/users/me/teams")).filter((t) => !t.delete_at);
      if (!teams.length) throw new Error("This account isn't in a team yet. Join one in Mattermost first.");
      if (teams.length === 1) return await this.saveLogin({ url, token, team: teams[0] }, cx);
      this.setup = { step: "team", url, token, teams: teams.sort((a, b) => a.display_name.localeCompare(b.display_name)) };
    } catch (e) {
      this.setup = { step: "login", error: String(e?.message ?? e) };
    }
    cx.notify();
  }

  async saveLogin({ url, token, team }, cx) {
    const path = loginPath();
    try {
      const old = await readTextFile(path).catch(() => null);
      await writeTextFile(path, `${JSON.stringify({ url, token, team: team.name }, null, 2)}\n`, old);
      // The token is a password to the person's whole account.
      await exec("chmod", ["600", path]).catch(() => {});
    } catch (e) {
      this.setup = { ...this.setup, busy: false, error: `Couldn't save ${path}: ${e?.message ?? e}` };
      return cx.notify();
    }
    this.cfg = { url, token, team: team.name };
    this.team = team;
    this.setup = null;
    this.tokenInput.set_value("");
    this.redraw(cx);
    await this.start(cx);
  }

  // Redraws the frame and both parts, since a part is only rebuilt when it is notified.
  redraw(cx) {
    cx.notify();
    if (this.sidePart) {
      this.warm();
      cx.notify(this.sidePart);
      cx.notify(this.mainPart);
    }
  }

  async close() {
    if (this.popup) {
      if (shared("mattermost.popup") === props().overlay) setShared("mattermost.popup", null);
      return;
    }
    OWNERS.delete(this.ownerKey);
    if (!props()?.demo && ![...OWNERS.values()].some((o) => !o.cfg?.demo)) setShared("mattermost.alive", null);
    await this.ws?.close();
  }

  async api(cx, path, { method = "GET", body } = {}) {
    if (this.cfg.demo) return demoApi(path, method, body);
    let res;
    // Some routes to a server drop TLS handshakes now and then; a fresh attempt usually gets through.
    for (let attempt = 1; ; attempt++) {
      try {
        res = await timed(cx, fetch(`${this.cfg.url}/api/v4${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.cfg.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body && JSON.stringify(body),
        }));
        break;
      } catch (e) {
        if (attempt >= ATTEMPTS) throw new Error(`${method} ${path.split("?")[0]}: ${e?.message ?? e}`);
      }
    }
    if (!res.ok) throw Object.assign(new Error(`${method} ${path.split("?")[0]}: HTTP ${res.status}`), { status: res.status });
    return res.json();
  }

  // The demo leaves the shared header and badge to a real panel running beside it.
  publishHeader() {
    if (this.cfg?.demo) return;
    const team = this.team?.display_name || this.team?.name || "";
    const reconnecting = !this.live && Boolean(this.wsError);
    const head = { name: "Mattermost", detail: reconnecting ? `${team} · reconnecting` : team, icon: "mods/mattermost/icons/logo.svg", tint: true, loading: !this.live || this.busy > 0 };
    // Shared state re-renders every mod, so publish only real changes. Compare with what is stored,
    // not with this copy's last write: a closed pane or an old build may have written since.
    if (JSON.stringify(head) === JSON.stringify(shared("pane-header:mattermost"))) return;
    setShared("pane-header:mattermost", head);
  }

  // What the tab bar's Mattermost button shows, like the desktop app's badge: mentions as a count, else a
  // dot when channels that aren't muted, or followed threads, have unread messages.
  publishBadge() {
    if (!this.me || this.cfg?.demo) return;
    let mentions = this.threadTotals.total_unread_mentions ?? 0;
    let unread = (this.threadTotals.total_unread_threads ?? 0) > 0;
    for (const cat of this.categories) {
      for (const id of cat.channel_ids) {
        const c = this.channels.get(id), m = this.members.get(id);
        if (!c || !m) continue;
        mentions += m.mention_count_root ?? m.mention_count ?? 0;
        if (!cat.muted && !this.muted(c) && c.total_msg_count_root > m.msg_count_root) unread = true;
      }
    }
    const badge = { mentions, unread };
    if (JSON.stringify(badge) === JSON.stringify(shared("mattermost.badge"))) return;
    setShared("mattermost.badge", badge);
  }

  async working(fn) {
    this.busy++;
    this.publishHeader();
    try {
      return await fn();
    } finally {
      this.busy--;
      this.publishHeader();
    }
  }

  async load(cx) {
    return this.working(() => this.loadNow(cx));
  }

  async loadNow(cx) {
    this.me ??= await this.api(cx, "/users/me");
    if (!this.team) {
      const teams = await this.api(cx, "/users/me/teams");
      this.team = teams.find((t) => t.name === this.cfg.team) ?? teams[0];
    }
    this.publishHeader();
    try {
      this.clientConfig ??= await this.api(cx, "/config/client?format=old");
    } catch {}
    await this.loadSidebar(cx);
    try {
      const flagged = await this.api(cx, "/users/me/preferences/flagged_post");
      this.saved = new Set(flagged.filter((x) => x.value === "true").map((x) => x.name));
    } catch {}
    const wanted = props()?.channel;
    if (wanted && !this.selected) this.selected = wanted === THREADS ? THREADS : [...this.channels.values()].find((c) => c.name === wanted || c.display_name === wanted)?.id ?? null;
    if (props()?.thread && !this.thread) await this.openThread(props().thread, cx);
    if (this.selected === THREADS) await this.loadThreads(cx);
    else if (this.selected && this.channels.has(this.selected)) await this.open(this.selected, cx);
  }

  async loadSidebar(cx) {
    const base = `/users/me/teams/${this.team.id}/channels`;
    const [channels, members, categories, prefs] = await Promise.all([
      this.api(cx, base), this.api(cx, `${base}/members`), this.api(cx, `${base}/categories`), this.api(cx, "/users/me/preferences"),
    ]);
    // Closed conversations stay members of their channel; Mattermost hides them by preference.
    const joinLeave = prefs.find((x) => x.category === "advanced_settings" && x.name === "join_leave")?.value;
    this.showJoinLeave = (joinLeave ?? this.clientConfig?.EnableJoinLeaveMessageByDefault ?? "true") === "true";
    this.dmLimit = Number(prefs.find((x) => x.category === "sidebar_settings" && x.name === "limit_visible_dms_gms")?.value) || DM_LIMIT;
    // Mattermost's switcher takes a channel's last view as the latest of the member's last_viewed_at
    // and these two preferences, since the server moves last_viewed_at only when posts arrive.
    try {
      const bg = JSON.parse(prefs.find((x) => x.category === "theme" && !x.name)?.value ?? "{}").mentionHighlightBg;
      if (/^#[0-9a-f]{6}$/i.test(bg ?? "") && bg !== this.mentionBg) { this.mentionBg = bg; this.textRev++; }
    } catch {}
    this.viewTimes = new Map();
    for (const x of prefs) {
      if (x.category !== "channel_open_time" && x.category !== "channel_approximate_view_time") continue;
      this.viewTimes.set(x.name, Math.max(this.viewTimes.get(x.name) ?? 0, Number(x.value) || 0));
    }
    const closed = new Set(prefs.filter((x) => (x.category === "direct_channel_show" || x.category === "group_channel_show") && x.value === "false").map((x) => x.name));
    this.channels = new Map(channels.filter((c) => !c.delete_at && !(c.type === "D" ? closed.has(this.dmPeer(c)) : c.type === "G" && closed.has(c.id))).map((c) => [c.id, slimChannel(c)]));
    this.members = new Map(members.map((m) => [m.channel_id, slimMember(m)]));
    this.categories = categories.order.map((id) => categories.categories.find((c) => c.id === id)).filter(Boolean);
    await this.fetchUsers(cx, [...this.channels.values()].filter((c) => c.type === "D").map((c) => this.dmPeer(c)));
    await this.loadGroups(cx);
    await this.loadStatuses(cx);
    await this.loadThreadTotals(cx);
    this.rows = null;
    this.error = null;
    this.redraw(cx);
  }

  // A group conversation is named after its members' full names; the channel itself only knows usernames.
  async loadGroups(cx) {
    await Promise.all([...this.channels.values()].filter((c) => c.type === "G").map(async (c) => {
      try {
        const users = await this.api(cx, `/users?in_channel=${c.id}&per_page=20`);
        users.forEach((u) => this.addUser(u));
        this.gmMembers.set(c.id, users.sort((a, b) => a.username.localeCompare(b.username)).map((u) => u.id));
      } catch {}
    }));
  }

  // Mattermost's own client polls the statuses it shows each minute besides taking status_change events.
  async loadStatuses(cx, only) {
    const ids = only ?? [...new Set([...this.channels.values()].filter((c) => c.type === "D").map((c) => this.dmPeer(c)).concat([...this.authors]))];
    if (!ids.length) return;
    try {
      for (const st of await this.api(cx, "/users/status/ids", { method: "POST", body: ids })) this.statuses.set(st.user_id, st.status);
      for (const id of ids) {
        const emoji = liveStatus(this.users.get(id)?.custom)?.emoji;
        if (emoji) await this.ensureEmoji(cx, emoji);
      }
    } catch {}
  }

  async loadCategories(cx) {
    const categories = await this.api(cx, `/users/me/teams/${this.team.id}/channels/categories`);
    this.categories = categories.order.map((id) => categories.categories.find((c) => c.id === id)).filter(Boolean);
  }

  threadsPath(query) {
    return `/users/${this.me.id}/teams/${this.team.id}/threads?${query}`;
  }

  async loadThreadTotals(cx) {
    this.threadTotals = await this.api(cx, this.threadsPath("totalsOnly=true"));
  }

  async loadThreads(cx) {
    return this.working(() => this.loadThreadsNow(cx));
  }

  async loadThreadsNow(cx) {
    const tab = this.threadTab;
    try {
      const page = await this.api(cx, this.threadsPath(`per_page=${THREAD_PAGE}&extended=true${tab === "unread" ? "&unread=true" : ""}`));
      for (const th of page.threads) for (const u of th.participants ?? []) if (u?.id) this.addUser(u);
      await this.ingest(cx, page.threads.map((th) => th.post));
      this.threads[tab] = page.threads;
      this.threadTotals = page;
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
    this.redraw(cx);
  }

  async fetchUsers(cx, ids) {
    const missing = [...new Set(ids)].filter((id) => id && !this.users.has(id));
    if (!missing.length) return;
    for (const u of await this.api(cx, "/users/ids", { method: "POST", body: missing })) this.addUser(u);
  }

  addUser(u) {
    u = slimUser(u);
    this.users.set(u.id, u);
    this.byUsername.set(u.username.toLowerCase(), u);
    this.textRev++;
  }

  mentionLabel(name) {
    const n = name.toLowerCase();
    if (SPECIAL.has(n)) return n;
    const u = this.byUsername.get(n);
    return u ? this.userName(u.id) : null;
  }

  // Everything a batch of posts needs drawn: authors, reacting users, mentioned users, custom emoji.
  async ingest(cx, posts) {
    const ids = [], names = new Set();
    for (const p of posts) {
      ids.push(p.user_id);
      if (!fromWebhook(p) && !this.authors.has(p.user_id)) {
        // Bounded so a long session doesn't poll every author it ever scrolled past.
        if (this.authors.size >= 300) this.authors.delete(this.authors.values().next().value);
        this.authors.add(p.user_id);
      }
      for (const r of p.metadata?.reactions ?? []) ids.push(r.user_id);
      for (const u of p.participants ?? []) if (u?.id) ids.push(u.id);
      for (const e of p.metadata?.emojis ?? []) this.customEmoji.set(e.name, e.id);
      const quoted = (p.metadata?.embeds ?? []).map((e) => e.data?.post).filter(Boolean);
      for (const q of quoted) ids.push(q.user_id);
      this.textRev++;
      for (const text of [p.message ?? "", ...quoted.map((q) => q.message ?? "")]) {
        for (const n of mentionNames(text)) if (!this.byUsername.has(n)) names.add(n);
        for (const [, n] of text.matchAll(SHORTCODES)) await this.ensureEmoji(cx, n.toLowerCase());
      }
    }
    await this.fetchUsers(cx, ids);
    if (names.size) {
      try {
        for (const u of await this.api(cx, "/users/usernames", { method: "POST", body: [...names] })) this.addUser(u);
      } catch {}
    }
  }

  async ensureEmoji(cx, name) {
    if (this.emoji[name] || this.customEmoji.has(name) || this.missingEmoji.has(name)) return;
    try {
      this.customEmoji.set(name, (await this.api(cx, `/emoji/name/${encodeURIComponent(name)}`)).id);
      this.textRev++;
    } catch {
      this.missingEmoji.add(name);
    }
  }

  dmPeer(c) {
    const [a, b] = c.name.split("__");
    return a === this.me?.id ? b : a;
  }

  userName(id) {
    const u = this.users.get(id);
    if (!u) return "…";
    const full = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();
    return full || u.username;
  }

  channelName(c) {
    if (!c) return "";
    if (c.type === "D") return this.dmPeer(c) === this.me?.id ? `${this.userName(this.me.id)} (you)` : this.userName(this.dmPeer(c));
    if (c.type === "G" && this.gmMembers.has(c.id)) return this.gmMembers.get(c.id).filter((id) => id !== this.me?.id).map((id) => this.userName(id)).join(", ");
    return c.display_name || c.name;
  }

  muted(c) {
    return this.members.get(c.id)?.notify_props?.mark_unread === "mention";
  }

  unread(c) {
    let u = this.unreadMemo.get(c.id);
    if (u) return u;
    const m = this.members.get(c.id);
    u = !m ? { count: 0, mentions: 0 } : {
      count: this.muted(c) ? 0 : Math.max(0, c.total_msg_count_root - m.msg_count_root),
      mentions: m.mention_count_root ?? m.mention_count,
    };
    this.unreadMemo.set(c.id, u);
    return u;
  }

  sidebar() {
    return this.categories.map((cat) => {
      let chans = cat.channel_ids.map((id) => this.channels.get(id)).filter(Boolean);
      if (cat.sorting === "alpha") chans.sort((a, b) => this.channelName(a).localeCompare(this.channelName(b)));
      else if (cat.sorting !== "manual") chans.sort((a, b) => lastPost(b) - lastPost(a));
      const wanted = (c) => c.id === this.selected || this.unread(c).count > 0 || this.unread(c).mentions > 0;
      if (cat.type === "direct_messages") chans = chans.filter((c, i) => i < this.dmLimit || wanted(c));
      return { cat, chans: cat.collapsed ? chans.filter(wanted) : chans };
    });
  }

  select(id) {
    this.selected = id;
    this.thread = null;
    this.rows = null;
    this.resetScroll();
    localStorage.setItem("selected", id);
  }

  resetScroll() {
    this.offset = 0;
    this.shown = WINDOW;
    this.heights.clear();
  }

  // A channel whose posts aren't here yet leaves the one on screen up for a moment while they load, so
  // the messages don't blink out in between; the sidebar marks the new one at once.
  async open(id, cx) {
    const loading = this.working(() => this.fetchChannel(id, cx));
    if (!this.posts.has(id)) {
      this.opening = id;
      this.redraw(cx);
      await Promise.race([loading, sleep(cx, OPEN_WAIT)]);
      if (this.opening !== id) return;
    }
    this.opening = null;
    this.select(id);
    this.input.focus();
    this.redraw(cx);
    this.loadStats(cx, id);
    if (this.rhs) this.loadRhs(cx);
    await loading;
    this.redraw(cx);
  }

  loadStats(cx, id) {
    cx.spawn(async (cx) => {
      try {
        this.stats.set(id, await this.api(cx, `/channels/${id}/stats`));
        this.redraw(cx);
      } catch {}
    });
  }

  // `from` is the view that led here (Info's rows), which the side view's back button returns to.
  openRhs(kind, cx, from = null) {
    this.rhs = this.rhs === kind && !from ? null : kind;
    this.rhsFrom = this.rhs ? from : null;
    this.redraw(cx);
    if (this.rhs) this.loadRhs(cx);
  }

  loadRhs(cx) {
    const id = this.selected, kind = this.rhs, c = this.channels.get(id);
    if (!c || kind === "info" || kind === "thread") return;
    cx.spawn(async (cx) => {
      try {
        if (kind === "members") {
          const users = await this.api(cx, `/users?in_channel=${id}&active=true&per_page=200`);
          users.forEach((u) => this.addUser(u));
          remember(this.rhsData.members, id, users.map((u) => u.id));
        } else if (kind === "pinned") {
          const page = await this.api(cx, `/channels/${id}/pinned`);
          const posts = page.order.map((pid) => page.posts[pid]).sort((a, b) => b.create_at - a.create_at);
          await this.ingest(cx, posts);
          remember(this.rhsData.pinned, id, posts);
        } else if (kind === "files") {
          // Mattermost's own Files view is a file search scoped to the channel.
          const where = c.type === "D" ? `@${this.users.get(this.dmPeer(c))?.username ?? ""}` : c.name;
          const res = await this.api(cx, `/teams/${this.team.id}/files/search`, { method: "POST", body: { terms: `in:${where}`, is_or_search: false, page: 0, per_page: 50 } });
          remember(this.rhsData.files, id, res.order.map((fid) => pick(res.file_infos[fid], ["id", "name", "size", "create_at", "extension", "has_preview_image", "post_id"])));
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.redraw(cx);
    });
  }

  // Channel posts don't say whether you follow their thread; the thread itself exists for you only if you do.
  loadFollowing(cx, posts) {
    const roots = posts.filter((p) => p.reply_count > 0 && !this.following.has(p.id));
    if (!roots.length) return;
    cx.spawn(async (cx) => {
      for (const p of roots) {
        try {
          const th = await this.api(cx, `/users/${this.me.id}/teams/${this.team.id}/threads/${p.id}`);
          this.following.set(p.id, th.is_following !== false);
        } catch (e) {
          if (String(e?.message).includes("HTTP 404")) this.following.set(p.id, false);
        }
      }
      this.redraw(cx);
    });
  }

  toggleFollow(p, cx) {
    const follow = !this.following.get(p.id);
    this.following.set(p.id, follow);
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        await this.api(cx, `/users/${this.me.id}/teams/${this.team.id}/threads/${p.id}/following`, { method: follow ? "PUT" : "DELETE" });
      } catch (e) {
        this.following.set(p.id, !follow);
        this.error = String(e?.message ?? e);
        this.redraw(cx);
      }
    });
  }

  editChannel(c, field) {
    openOverlay({
      mod: "mattermost", kind: "dialog", width: 640, height: 370,
      props: { demo: this.cfg?.demo, edit: { field, value: c[field] ?? "", channel: { id: c.id, type: c.type, display: this.channelName(c) } } },
    });
  }

  toggleMute(c, cx) {
    const member = this.members.get(c.id);
    if (!member) return;
    const mark = this.muted(c) ? "all" : "mention";
    member.notify_props = { ...member.notify_props, mark_unread: mark };
    this.rows = null;
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        await this.api(cx, `/channels/${c.id}/members/${this.me.id}/notify_props`, { method: "PUT", body: { channel_id: c.id, user_id: this.me.id, mark_unread: mark } });
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.redraw(cx);
      }
    });
  }

  toggleFavorite(c, cx) {
    const from = this.categoryOf(c.id), favorites = this.categories.find((x) => x.type === "favorites");
    const to = from === favorites ? this.categories.find((x) => x.type === (c.type === "D" || c.type === "G" ? "direct_messages" : "channels")) : favorites;
    if (!from || !to) return;
    const changed = [
      { ...from, channel_ids: from.channel_ids.filter((id) => id !== c.id) },
      { ...to, channel_ids: [c.id, ...to.channel_ids.filter((id) => id !== c.id)] },
    ];
    this.categories = this.categories.map((x) => changed.find((u) => u.id === x.id) ?? x);
    this.rows = null;
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        await this.api(cx, `/users/${this.me.id}/teams/${this.team.id}/channels/categories`, { method: "PUT", body: changed });
      } catch (e) {
        this.error = String(e?.message ?? e);
        await this.loadCategories(cx);
        this.redraw(cx);
      }
    });
  }

  async fetchChannel(id, cx) {
    try {
      const page = await this.api(cx, `/channels/${id}/posts?per_page=${PAGE}&collapsedThreads=true`);
      const fetched = page.order.map((pid) => page.posts[pid]).reverse();
      await this.ingest(cx, fetched);
      remember(this.posts, id, fetched);
      this.loadFollowing(cx, fetched);
      const unknown = [...new Set(fetched.map((p) => p.user_id))].filter((u) => !this.statuses.has(u) && this.authors.has(u));
      if (unknown.length) await this.loadStatuses(cx, unknown);
      await this.markRead(cx, id);
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
  }

  openThreads(cx) {
    this.select(THREADS);
    this.redraw(cx);
    cx.spawn(async (cx) => this.loadThreads(cx));
  }

  async openThread(id, cx) {
    this.thread = id;
    this.resetScroll();
    this.redraw(cx);
    await this.working(() => this.fetchThread(id, cx));
    this.loadFollowing(cx, this.threadPosts.get(id)?.slice(0, 1) ?? []);
    this.redraw(cx);
    this.threadInput.focus();
  }

  async fetchThread(id, cx) {
    try {
      const page = await this.api(cx, `/posts/${id}/thread?collapsedThreads=true`);
      const posts = Object.values(page.posts).sort((a, b) => a.create_at - b.create_at);
      await this.ingest(cx, posts);
      remember(this.threadPosts, id, posts);
      await this.markThreadRead(cx, id);
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
  }

  async markThreadRead(cx, id) {
    for (const list of Object.values(this.threads)) {
      const th = list?.find((x) => x.id === id);
      if (th) Object.assign(th, { unread_replies: 0, unread_mentions: 0, last_viewed_at: Date.now() });
    }
    try {
      await this.api(cx, `/users/${this.me.id}/teams/${this.team.id}/threads/${id}/read/${Date.now()}`, { method: "PUT" });
    } catch (e) {
      // A thread you never replied to or followed has no membership, so there is no read state to move.
      if (e.status === 404) return;
      throw e;
    }
    await this.loadThreadTotals(cx);
  }

  // Reply opens the thread beside the channel, as Mattermost's right-hand side does.
  openReply(id, cx) {
    this.rhs = "thread";
    this.rhsFrom = null;
    this.rhsThread = id;
    this.rhsScroll.offset = 0;
    this.rhsScroll.heights.clear();
    this.redraw(cx);
    cx.spawn(async (cx) => {
      await this.fetchThread(id, cx);
      this.loadFollowing(cx, this.threadPosts.get(id)?.slice(0, 1) ?? []);
      this.redraw(cx);
      this.replyInput.focus();
    });
  }

  async onRequest(req, cx) {
    if (req.action === "reply") this.openReply(req.post, cx);
    else if (req.action === "threads") this.openThreads(cx);
    else if (req.action === "info" && this.rhs !== "info") this.openRhs("info", cx);
    else if (req.action === "edit") this.startEdit(req.post, cx);
    else if (req.action === "openFile") this.openFile(req.file, cx);
    else if (req.action === "open") {
      // A conversation opened from a menu may be new to the sidebar.
      if (!this.channels.has(req.channel)) { await this.loadSidebar(cx); this.rows = null; }
      if (this.channels.has(req.channel)) await this.open(req.channel, cx);
    }
  }

  openLightbox(spec) {
    openOverlay({ mod: "mattermost", kind: "dialog", frame: "none", width: 0.92, height: 0.92, props: { demo: this.cfg?.demo, lightbox: spec } });
  }

  // Attachments open outside the panel: Herdr has no video element, and other files need their own apps.
  openFile(f, cx) {
    if (this.fileState.get(f.id) === "Downloading…") return;
    this.fileState.set(f.id, "Downloading…");
    this.redraw(cx);
    cx.spawn(async (cx) => {
      const rel = await this.media.download(this.cfg, f, (ms) => sleep(cx, ms)).catch(() => null);
      if (rel) {
        this.fileState.delete(f.id);
        const path = `${appHome()}/${rel}`;
        await (/^(video|audio)\//.test(f.mime_type ?? "") ? playExternally(path) : openExternally(path)).catch(() => {});
      } else this.fileState.set(f.id, "Download failed");
      this.redraw(cx);
    });
  }

  playFileAnimation(f, cx) {
    if (this.playing?.key === f.id) return this.stopAnimation(cx);
    if (this.fileState.get(f.id) === "Downloading…") return;
    this.fileState.set(f.id, "Downloading…");
    this.redraw(cx);
    cx.spawn(async (cx) => {
      const rel = await this.media.download(this.cfg, f, (ms) => sleep(cx, ms)).catch(() => null);
      if (rel) {
        this.fileState.delete(f.id);
        await this.playAnimation(f.id, rel, cx);
      } else this.fileState.set(f.id, "Download failed");
      this.redraw(cx);
    });
  }

  playRemoteAnimation(key, rel, cx) {
    if (this.playing?.key === key) return this.stopAnimation(cx);
    cx.spawn(async (cx) => { await this.playAnimation(key, rel, cx); this.redraw(cx); });
  }

  stopAnimation(cx) {
    this.playing = null;
    this.redraw(cx);
  }

  // One at a time: each playing animation redraws the window on every frame.
  async playAnimation(key, rel, cx) {
    if (!this.animationCost.has(rel)) {
      const cost = (await this.media.animationBytes(rel)) ?? UNKNOWN_ANIMATION;
      const spent = [...this.animationCost.values()].reduce((a, b) => a + b, 0);
      if (spent + cost > ANIMATION_BUDGET) {
        await playExternally(`${appHome()}/${rel}`).catch(() => {});
        return;
      }
      this.animationCost.set(rel, cost);
    }
    this.playing = { key, rel };
  }

  // The room for an image in a post.
  contentWidth(scope) {
    // Pinned posts aren't in a timeline, so nothing measures them, but their panel has a known width.
    const room = scope === "c" || scope === "t" ? this.viewW : scope === "r" ? this.rhsScroll.viewW : this.rhsW;
    return Math.max(120, (room || 480) - AVATAR_COL - POST_PAD - 15);
  }

  // Mattermost edits in place: the message becomes a text box until saved or cancelled.
  startEdit(id, cx) {
    const p = this.findAnyPost(id);
    if (!p) return;
    this.editing = id;
    this.editInput.set_value(p.message ?? "");
    this.editPrev = this.editNow = p.message ?? "";
    this.redraw(cx);
    this.editInput.focus();
  }

  findAnyPost(id) {
    for (const list of [...this.posts.values(), ...this.threadPosts.values()]) {
      const p = list?.find((x) => x.id === id);
      if (p) return p;
    }
    return null;
  }

  cancelEdit(cx) {
    this.editing = null;
    this.redraw(cx);
  }

  saveEdit(cx) {
    const id = this.editing, message = this.editInput?.value().trim();
    const p = this.findAnyPost(id);
    if (!p || !message) return;
    if (message === p.message) return this.cancelEdit(cx);
    const before = p.message;
    p.message = message;
    this.cancelEdit(cx);
    cx.spawn(async (cx) => {
      try {
        await this.api(cx, `/posts/${id}/patch`, { method: "PUT", body: { message } });
      } catch (e) {
        p.message = before;
        this.error = String(e?.message ?? e);
        this.redraw(cx);
      }
    });
  }

  editBox(p, t) {
    const button = (id, label, primary, onClick) => div().id(id).h(32).px(16).flex().flex_none().items_center().rounded(4).cursor_pointer()
      .text_size(12).font_semibold()
      .bg(primary ? t.accent : alpha(t.accent, 0.08)).text_color(primary ? t.accent_foreground : t.accent)
      .hover((s) => s.bg(primary ? t.accent : alpha(t.accent, 0.12)))
      .on_click(onClick).child(label);
    const text = this.editInput.value();
    return v_flex().pt(8).gap(0)
      .on_key_down((e, cx) => { if (e.keystroke === "escape") this.cancelEdit(cx); })
      .child(div().id("edit-box").px(16).pt(13).pb(12).rounded(4).border_1().border_color(t.input).bg(t.background)
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.editInput.focus(); })
        .child(Textarea.new(this.editInput).w_full().text_size(14)))
      .when(text.includes("@"), (el) => el.child(h_flex().pt(6).gap(4).items_center().text_size(12).text_color(alpha(t.foreground, 0.75))
        .child(svg("mods/mattermost/icons/info.svg").size(12)).child("Editing this message with an '@mention' will not notify the recipient.")))
      .child(h_flex().my(8).gap(8).items_center().text_size(12).text_color(alpha(t.foreground, 0.75))
        .child(button("edit-save", "Save", true, (_e, cx) => this.saveEdit(cx)))
        .child(button("edit-cancel", "Cancel", false, (_e, cx) => this.cancelEdit(cx)))
        .child(div().font_bold().child("ENTER")).child(div().ml(-4).child("to Save,"))
        .child(div().font_bold().child("ESC")).child(div().ml(-4).child("to Cancel")));
  }

  closeThread() {
    this.thread = null;
    this.resetScroll();
  }

  // Parsing a message is the costliest part of drawing it, and a render past Herdr's 50 ms is cut off,
  // so the messages about to be drawn are parsed before a redraw is asked for rather than during it.
  warm() {
    const posts = this.shownPosts() ?? [];
    for (const p of this.thread ? posts : posts.slice(-this.shown)) if (!isSystem(p)) this.parsed(p.id, p.message ?? "");
    for (const p of (this.rhsThread && this.threadPosts.get(this.rhsThread)) ?? []) if (!isSystem(p)) this.parsed(p.id, p.message ?? "");
  }

  shownPosts() {
    return this.thread ? this.threadPosts.get(this.thread) : this.posts.get(this.selected);
  }

  // A channel is bottom-anchored, because GPUI's scroll areas start at the top and the newest
  // post belongs at the bottom; a thread reads from its first message down.
  // `sc` is the scroll state: the panel's own fields for the messages, rhsScroll for a thread beside them.
  scrollBy(dy, cx, sc = this, top = Boolean(this.thread)) {
    const posts = this.shownPosts() ?? [];
    const max = Math.max(0, sc.contentH - sc.viewH);
    sc.offset = Math.min(max, Math.max(0, sc.offset + (top ? -dy : dy)));
    if (sc === this && this.offset >= max - 200) {
      if (this.shown < posts.length) this.shown += WINDOW;
      else if (dy > 0 && !this.thread) this.loadOlder(cx);
    }
    // Only the messages move; the wheel handler's cx is the messages part's own.
    cx.notify();
  }

  loadOlder(cx) {
    const id = this.selected, posts = this.posts.get(id);
    if (!posts?.length || this.loadingOlder || this.exhausted.has(id)) return;
    this.loadingOlder = true;
    cx.spawn(async (cx) => {
      try {
        const page = await this.api(cx, `/channels/${id}/posts?per_page=${PAGE}&before=${posts[0].id}&collapsedThreads=true`);
        const older = page.order.map((pid) => page.posts[pid]).reverse();
        if (older.length < PAGE) this.exhausted.add(id);
        await this.ingest(cx, older);
        this.posts.set(id, [...older, ...this.posts.get(id)]);
        if (id === this.selected) this.shown += older.length;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loadingOlder = false;
      this.redraw(cx);
    });
  }

  findPost(id, channelId) {
    const lists = [this.posts.get(channelId), ...this.threadPosts.values()];
    for (const list of lists) {
      const p = list?.find((x) => x.id === id);
      if (p) return p;
    }
    return null;
  }

  applyReaction(r, added) {
    const p = this.findPost(r.post_id, r.channel_id);
    if (!p) return;
    p.metadata ??= {};
    const list = (p.metadata.reactions ?? []).filter((x) => !(x.user_id === r.user_id && x.emoji_name === r.emoji_name));
    p.metadata.reactions = added ? [...list, r] : list;
  }

  toggleReaction(p, name, mine, cx) {
    const r = { user_id: this.me.id, post_id: p.id, emoji_name: name, channel_id: p.channel_id };
    this.applyReaction(r, !mine);
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        if (mine) await this.api(cx, `/users/${this.me.id}/posts/${p.id}/reactions/${encodeURIComponent(name)}`, { method: "DELETE" });
        else await this.api(cx, "/reactions", { method: "POST", body: { user_id: r.user_id, post_id: r.post_id, emoji_name: name } });
      } catch (e) {
        this.applyReaction(r, mine);
        this.error = String(e?.message ?? e);
        this.redraw(cx);
      }
    });
  }

  async markRead(cx, id) {
    const c = this.channels.get(id), m = this.members.get(id);
    if (m && c) Object.assign(m, { msg_count: c.total_msg_count, msg_count_root: c.total_msg_count_root, mention_count: 0, mention_count_root: 0, last_viewed_at: Date.now() });
    this.rows = null;
    await this.api(cx, "/channels/members/me/view", { method: "POST", body: { channel_id: id } });
  }

  send(cx, input = this.input, rootId = this.thread) {
    const message = input.value().trim();
    const root = rootId ? this.threadPosts.get(rootId)?.[0] : null;
    const channel_id = root?.channel_id ?? this.selected;
    if (!message || !channel_id || channel_id === THREADS) return;
    input.set_value("");
    cx.spawn(async (cx) => {
      try {
        await this.api(cx, "/posts", { method: "POST", body: { channel_id, message, ...(root ? { root_id: root.id } : {}) } });
      } catch (e) {
        input.set_value(message);
        this.error = String(e?.message ?? e);
        this.redraw(cx);
      }
    });
  }

  connect(cx) {
    if (this.cfg.demo) {
      this.live = true;
      return;
    }
    cx.spawn(async (cx) => {
      for (let delay = 2000; ; delay = Math.min(delay * 2, 60e3)) {
        try {
          this.ws = await timed(cx, WebSocket.connect(`${this.cfg.url.replace(/^http/, "ws")}/api/v4/websocket`));
          await this.ws.write(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token: this.cfg.token } }));
          for (;;) {
            const msg = await this.ws.read();
            if (typeof msg !== "string") continue;
            const ev = JSON.parse(msg);
            if (ev.event === "hello") {
              // Events missed while disconnected are gone; reload to catch up.
              if (!this.live && (delay > 2000 || !this.team)) await this.load(cx);
              this.live = true;
              this.wsError = null;
              this.publishHeader();
              delay = 2000;
            }
            if (await this.onEvent(ev, cx)) {
              this.rows = null;
              this.redraw(cx);
            }
          }
        } catch (e) {
          this.wsError = String(e?.message ?? e);
        }
        this.live = false;
        this.publishHeader();
        this.redraw(cx);
        await sleep(cx, delay);
      }
    });
  }

  async onEvent(ev, cx) {
    const data = ev.data ?? {};
    const channelId = ev.broadcast?.channel_id || data.channel_id;
    switch (ev.event) {
      case "posted": {
        const post = JSON.parse(data.post);
        const c = this.channels.get(post.channel_id);
        if (!c) return this.loadSidebar(cx).then(() => true);
        const root = !post.root_id;
        c.last_post_at = post.create_at;
        c.total_msg_count++;
        if (root) {
          c.last_root_post_at = post.create_at;
          c.total_msg_count_root++;
        }
        await this.ingest(cx, [post]);
        if (root) {
          this.posts.get(c.id)?.push(post);
        } else {
          const parent = this.posts.get(c.id)?.find((p) => p.id === post.root_id);
          if (parent) parent.reply_count = (parent.reply_count ?? 0) + 1;
          const thread = this.threadPosts.get(post.root_id);
          if (thread) {
            thread.push(post);
            if (thread[0]) thread[0].reply_count = (thread[0].reply_count ?? 0) + 1;
            const open = this.thread === post.root_id || (this.rhs === "thread" && this.rhsThread === post.root_id);
            if (open && post.user_id !== this.me.id) await this.markThreadRead(cx, post.root_id);
          }
        }
        const m = this.members.get(c.id);
        if (post.user_id === this.me.id || c.id === this.selected) {
          if (m) Object.assign(m, { msg_count: c.total_msg_count, msg_count_root: c.total_msg_count_root });
          if (c.id === this.selected && post.user_id !== this.me.id) await this.markRead(cx, c.id);
        } else if (m && root && (c.type === "D" || JSON.parse(data.mentions ?? "[]").includes(this.me.id))) {
          m.mention_count++;
          m.mention_count_root = (m.mention_count_root ?? 0) + 1;
        }
        return true;
      }
      case "post_edited": {
        const post = JSON.parse(data.post);
        for (const posts of [this.posts.get(post.channel_id), this.threadPosts.get(post.root_id || post.id)]) {
          const i = posts?.findIndex((p) => p.id === post.id) ?? -1;
          if (i >= 0) posts[i] = { ...posts[i], ...post };
        }
        return true;
      }
      case "post_deleted": {
        const post = JSON.parse(data.post);
        const posts = this.posts.get(post.channel_id);
        if (posts) this.posts.set(post.channel_id, posts.filter((p) => p.id !== post.id));
        const thread = this.threadPosts.get(post.root_id);
        if (thread) this.threadPosts.set(post.root_id, thread.filter((p) => p.id !== post.id));
        return true;
      }
      case "reaction_added":
      case "reaction_removed": {
        const r = JSON.parse(data.reaction);
        await this.ensureEmoji(cx, r.emoji_name);
        await this.fetchUsers(cx, [r.user_id]);
        this.applyReaction(r, ev.event === "reaction_added");
        return true;
      }
      case "channel_viewed": {
        const c = this.channels.get(channelId), m = this.members.get(channelId);
        if (c && m) Object.assign(m, { msg_count: c.total_msg_count, msg_count_root: c.total_msg_count_root, mention_count: 0, mention_count_root: 0, last_viewed_at: Date.now() });
        return true;
      }
      case "multiple_channels_viewed":
        for (const id of Object.keys(data.channel_times ?? {})) await this.onEvent({ event: "channel_viewed", data: { channel_id: id } }, cx);
        return true;
      case "channel_member_updated": {
        const m = JSON.parse(data.channelMember ?? "null");
        if (m?.channel_id) this.members.set(m.channel_id, slimMember(m));
        return true;
      }
      case "thread_updated":
      case "thread_read_changed":
      case "thread_follow_changed":
        // Only a follow change says whether you follow; the others carry no state.
        if (ev.event === "thread_follow_changed") this.following.set(data.thread_id, Boolean(data.state));
        if (this.selected === THREADS && !this.thread) await this.loadThreads(cx);
        else await this.loadThreadTotals(cx);
        return true;
      case "channel_created":
      case "direct_added":
      case "group_added":
      case "user_added":
      case "channel_updated":
      case "sidebar_category_updated": {
        // The event carries the categories as saved, which spares a full sidebar reload per click.
        const updated = JSON.parse(data.updatedCategories ?? "[]");
        if (!updated.length) await this.loadCategories(cx);
        for (const cat of updated) {
          const i = this.categories.findIndex((c) => c.id === cat.id);
          if (i >= 0) this.categories[i] = cat;
        }
        return true;
      }
      case "status_change":
        this.statuses.set(data.user_id, data.status);
        return true;
      case "user_updated":
        if (data.user?.id) this.addUser(data.user);
        if (liveStatus(this.users.get(data.user?.id)?.custom)?.emoji) await this.ensureEmoji(cx, liveStatus(this.users.get(data.user.id).custom).emoji);
        return true;
      case "sidebar_category_created":
      case "sidebar_category_deleted":
      case "sidebar_category_order_updated":
        await this.loadCategories(cx);
        return true;
      case "preferences_changed":
      case "preferences_deleted": {
        const prefs = JSON.parse(data.preferences ?? "[]");
        const flagged = prefs.filter((x) => x.category === "flagged_post");
        for (const x of flagged) {
          if (ev.event === "preferences_changed" && x.value === "true") this.saved.add(x.name);
          else this.saved.delete(x.name);
        }
        if (flagged.length < prefs.length) await this.loadSidebar(cx);
        return true;
      }
      case "post_unread":
      case "user_removed":
        await this.loadSidebar(cx);
        return true;
    }
    return false;
  }

  toggle(cat, cx) {
    cat.collapsed = !cat.collapsed;
    this.rows = null;
    this.redraw(cx);
    // Saved to the server, as the official app does, so both stay in step.
    cx.spawn(async (cx) => {
      try {
        await this.api(cx, `/users/${this.me.id}/teams/${this.team.id}/channels/categories/${cat.id}`, { method: "PUT", body: cat });
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.redraw(cx);
      }
    });
  }

  sidebarRows() {
    if (this.rows) return this.rows;
    this.unreadMemo = new Map();
    const rows = [];
    for (const { cat, chans } of this.sidebar()) {
      rows.push({ key: `cat:${cat.id}`, cat, first: !rows.length });
      chans.forEach((c) => rows.push({ key: `ch:${c.id}`, c, catMuted: cat.muted, grouped: true }));
    }
    return (this.rows = rows);
  }

  // An overlay's `at` and the pointer's bounds are window pixels, but its width and height grow with the
  // app's zoom, so placement works with the zoomed size.
  zoom() {
    return Number(settings()?.zoom) || 1;
  }

  // Your conversations for Find Channels, as Mattermost's switcher lists them (switch_channel_provider.tsx):
  // up to 5 unread unmuted ones (Threads first when it has unread threads), then the 20 most recently
  // viewed; the channel you're in is left out. Search ranks all of them, so all of them go along.
  openSwitcher() {
    const items = [...this.channels.values()].filter((c) => c.id !== this.selected).map((c) => {
      const viewed = Math.max(this.members.get(c.id)?.last_viewed_at ?? 0, this.viewTimes?.get(c.id) ?? 0);
      if (c.type === "D") {
        const peer = this.dmPeer(c), u = this.users.get(peer);
        const custom = liveStatus(u?.custom);
        const tok = custom?.emoji ? this.emojiToken(custom.emoji) : null;
        const emoji = tok && { path: tok.custom ? this.media.emoji(this.customEmoji.get(tok.custom)) : this.cfg ? this.media.standard(this.cfg.url, tok.emoji ?? "") : null, char: tok.emoji ?? "" };
        const name = this.channelName(c) + (u?.nickname ? ` (${u.nickname})` : "");
        return { kind: "channel", id: c.id, type: "D", peer, display: name, name: u?.username ?? "", sub: u ? `@${u.username}` : "", viewed,
          avatar: this.media.avatar(u), status: u?.is_bot ? null : this.statuses.get(peer) ?? "offline", bot: Boolean(u?.is_bot), emoji };
      }
      const count = c.type === "G" ? this.gmMembers.get(c.id)?.filter((id) => id !== this.me?.id).length : null;
      return { kind: "channel", id: c.id, type: c.type, display: this.channelName(c), name: c.type === "G" ? "" : c.name, sub: c.type === "G" ? "" : `~${c.name}`, viewed, count,
        unread: !this.muted(c) && this.unread(c).count > 0, last: lastPost(c) };
    });
    const unread = items.filter((it) => it.unread).sort((a, b) => b.last - a.last).slice(0, 5);
    if (this.threadTotals.total_unread_threads > 0) unread.unshift({ kind: "threads", id: THREADS, type: "threads", display: "Threads", name: "", sub: "", viewed: Date.now() });
    const shown = new Set(unread.map((it) => it.id));
    const recent = items.filter((it) => !shown.has(it.id)).sort(byRecency).slice(0, 20);
    openOverlay({
      mod: "mattermost", kind: "dialog", width: SWITCHER_W, height: SWITCHER_H,
      props: { demo: this.cfg?.demo, switcher: { items, unread: unread.slice(0, 5), recent, me: this.me.id, team: { id: this.team.id, name: this.team.name } } },
    });
  }

  // Where a popup `height` window pixels tall goes next to an anchor: `prefer` side first, then the other, else as low
  // as the panel allows. The panel's bottom stands in for the window's, which a mod can't see.
  place(box, height, prefer) {
    const bottom = this.box ? this.box.y + this.box.height : Infinity;
    const below = box.y + box.height + 4, above = box.y - height - 4;
    const fitsBelow = below + height <= bottom, fitsAbove = above >= 4;
    if (prefer === "above" ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove) return fitsAbove ? above : Math.max(4, bottom - height);
    return fitsBelow ? below : Math.max(4, bottom - height);
  }

  // `box` is the anchor: the menu opens under it, or over it when the panel has no room below.
  openMenu(spec, box = null) {
    const menu = { ...spec, me: this.me.id, team: { id: this.team.id, name: this.team.name }, categories: this.categories, dmLimit: this.dmLimit ?? DM_LIMIT };
    const { width, height } = Menu.size(menu);
    const z = this.zoom();
    let at = null;
    if (box) {
      // Right-aligned menus keep their own card's right edge on the button's and open submenus leftward.
      const x = spec.alignRight ? box.x + box.width - width * z : box.x;
      const y = this.place(box, height * z, "below");
      at = { x: Math.max(4, x), y };
      menu.layout = { up: y < box.y, flip: Boolean(spec.alignRight) };
    }
    this.popupOpened(openOverlay({ mod: "mattermost", kind: "popup", frame: "none", width, height, ...(at ? { at } : {}), props: { menu, demo: this.cfg?.demo } }));
  }

  // The popup closes in its own copy of the mod, which says so here: a post keeps its hover bar only
  // while its popup is open.
  popupOpened(id) {
    this.keepHover = this.hoverPost;
    setShared("mattermost.popup", id);
  }

  openPicker(p, box) {
    const z = this.zoom();
    const room = this.box ? (this.box.height - 8) / z : PICKER_H;
    const height = Math.min(PICKER_H, room);
    this.popupOpened(openOverlay({
      mod: "mattermost", kind: "popup", frame: "none", width: PICKER_W, height,
      at: box ? { x: Math.max(4, box.x + box.width - PICKER_W * z), y: this.place(box, height * z, "above") } : "pointer",
      props: { demo: this.cfg?.demo, picker: { post: p.id, me: this.me.id, team: this.team.name, height } },
    }));
  }

  postLink(id) {
    return `${this.cfg.url}/${this.team.name}/pl/${id}`;
  }

  toggleSave(p, cx) {
    const saved = this.saved.has(p.id);
    if (saved) this.saved.delete(p.id);
    else this.saved.add(p.id);
    this.redraw(cx);
    const pref = [{ user_id: this.me.id, category: "flagged_post", name: p.id, value: "true" }];
    cx.spawn(async (cx) => {
      try {
        if (saved) await this.api(cx, `/users/${this.me.id}/preferences/delete`, { method: "POST", body: pref });
        else await this.api(cx, `/users/${this.me.id}/preferences`, { method: "PUT", body: pref });
      } catch (e) {
        if (saved) this.saved.add(p.id);
        else this.saved.delete(p.id);
        this.error = String(e?.message ?? e);
        this.redraw(cx);
      }
    });
  }

  postMenu(p, box) {
    this.openMenu({
      kind: "post", alignRight: true,
      post: pick(p, ["id", "root_id", "channel_id", "message", "is_pinned", "user_id"]),
      saved: this.saved.has(p.id),
      following: this.following.get(p.root_id || p.id),
      link: this.postLink(p.id),
      own: p.user_id === this.me.id,
    }, box);
  }

  // The post under the pointer, tracked in script: its action bar, add-reaction button and last-reply
  // time all show on hover, and GPUI has no group hover to reveal them natively. Every move over the panel
  // decides it afresh, so a leave event that never came can't leave a bar behind. A post whose popup is
  // open keeps its bar until the pointer reaches another post.
  setHover(key, cx) {
    if (key === this.hoverPost) return;
    if (!key && this.keepHover && this.keepHover === this.hoverPost && shared("mattermost.popup")) return;
    this.hoverPost = key;
    this.keepHover = null;
    cx.notify(this.mainPart);
  }

  categoryOf(channelId) {
    return this.categories.find((c) => c.channel_ids.includes(channelId));
  }

  link(c) {
    const base = `${this.cfg.url}/${this.team.name}`;
    if (c.type === "D") return `${base}/messages/@${this.users.get(this.dmPeer(c))?.username ?? ""}`;
    if (c.type === "G") return `${base}/messages/${c.name}`;
    return `${base}/channels/${c.name}`;
  }

  // A layer over the row that shows on hover: the row's own hover can't reach a child, and
  // tracking the pointer in script would redraw the whole panel on every row crossed.
  // An invisible layer over the whole row, so hovering anywhere on it shows ⋮; tracking the pointer
  // in script instead would redraw the panel on every row crossed.
  hoverDots(id, t, onClick, bg) {
    return h_flex().absolute().inset_0().justify_end().opacity(0).hover((s) => s.opacity(1))
      .child(h_flex().id(id).w(30).h_full().pr(8).justify_end().items_center().bg(bg).text_color(t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); onClick(e, cx); })
        .child(svg("mods/mattermost/icons/dots.svg").size(14)));
  }

  // The frame holds both parts at all times: an event in a part can notify the parts but not the frame,
  // so which of them shows is decided inside them.
  render(cx) {
    if (this.popup) return this.popup.render();
    const t = theme();
    // Requests are seen here but handled from a timer: render can't create state such as the edit box.
    const req = shared(requestKey());
    if (req?.id && req.id !== this.seenRequest) {
      this.seenRequest = req.id;
      cx.timer.after(0, (cx) => cx.spawn(async (cx) => this.onRequest(req, cx)));
    }
    return h_flex().id("root").size_full().font_family(FONT).text_color(t.foreground).text_size(13)
      // The panel's place in the window, for placing popups; stored only, so moving the pointer redraws nothing.
      .on_mouse_move((e, cx) => {
        if (e.bounds) this.box = e.bounds;
        const on = this.moveOn ?? null;
        this.moveOn = null;
        this.setHover(on, cx);
      })
      .on_hover((on, cx) => { if (!on) this.setHover(null, cx); })
      .when(this.frame, (el) => el.rounded(10).overflow_hidden().bg(t.background).border_1()
        .border_color(this.typing ? t.accent : t.border).track_focus(this.focus).focus((s) => s.border_color(t.accent))
        // A press that reaches the frame focuses the panel, as a pane takes the keyboard when clicked;
        // text boxes stop their presses so they keep it, and a message box that has the keyboard keeps it,
        // as in Mattermost. The press stops here: the block around the panel takes the keyboard on a press
        // that reaches it, which blinked the panel's border off until the click gave it back.
        .on_mouse_down("left", (_e, cx) => {
          if (!this.typing) this.focus.focus();
          cx.stop_propagation();
        }))
      .on_size_change((size, cx) => {
        const was = this.width >= WIDE;
        this.width = size.width;
        this.height = size.height;
        if (was !== this.width >= WIDE) this.redraw(cx);
      })
      .when(Boolean(this.setup), (el) => el.child(this.setupView(t)))
      .when(!this.setup && this.width >= WIDE, (el) => el.child(h_resizable("mm-sidebar").size_full()
        // The window keeps a dragged width only while it runs; the last one is stored so it survives a restart.
        .on_resize((sizes, cx) => {
          this.sideW = Math.round(sizes[0]);
          localStorage.setItem("sideW", String(this.sideW));
          this.redraw(cx);
        })
        .child(resizable_panel().size(this.sideW).size_range(SIDE_MIN, SIDE_MAX).child(this.sidePart))
        .child(resizable_panel().child(this.mainPart))))
      .when(!this.setup && this.width < WIDE, (el) => el.child(this.sidePart).child(this.mainPart));
  }

  setupView(t) {
    const s = this.setup;
    const link = (id, label, url) => h_flex().child(div().id(id).cursor_pointer().text_color(t.accent).hover((st) => st.underline())
      .on_click(() => exec("xdg-open", [url])).child(label));
    const field = (id, label, input, ...hint) => v_flex().gap(6)
      .child(div().text_size(12).font_semibold().child(label))
      .child(div().id(id).on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); input.focus(); })
        .child(Input.new(input).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13)))
      .child(v_flex().gap(2).text_size(12).text_color(t.muted).children(hint));
    const button = (id, label, primary, onClick) => div().id(id).h(34).px(16).flex().flex_none().items_center().justify_center().rounded(4)
      .cursor_pointer().text_size(13).font_semibold()
      .bg(primary ? t.accent : alpha(t.accent, 0.08)).text_color(primary ? t.accent_foreground : t.accent)
      .hover((st) => st.bg(primary ? t.accent : alpha(t.accent, 0.12)))
      .on_click(onClick).child(label);
    const form = s.step === "team"
      ? v_flex().gap(8)
        .child(div().text_color(t.muted).child(`Your account is in ${s.teams.length} teams. Which one should the panel show?`))
        .children(s.teams.map((team) => h_flex().id(`team-${team.id}`).h(36).px(12).gap(8).items_center().rounded(6).cursor_pointer()
          .border_1().border_color(t.border).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => this.saveLogin({ url: s.url, token: s.token, team }, cx))
          .child(div().flex_1().truncate().child(team.display_name)).child(div().text_color(t.dim).child(team.name))))
        .child(h_flex().pt(4).child(button("setup-back", "Back", false, (_e, cx) => { this.setup = { step: "login" }; cx.notify(); })))
      : v_flex().gap(16)
        .child(field("setup-url", "Server URL", this.urlInput, "The address you open Mattermost at in a browser."))
        .child(field("setup-token", "Personal access token", this.tokenInput,
          "In Mattermost: Profile → Security → Personal Access Tokens → Create Token.", link("setup-docs", "How to create one", TOKEN_DOCS)))
        .child(div().text_size(12).text_color(t.dim).child("No Personal Access Tokens section? An admin has to turn them on in System Console → Integrations → Integration Management and allow your account to create them."))
        .child(v_flex().gap(8).items_start()
          .child(button("setup-connect", s.busy ? "Connecting…" : "Connect", true, (_e, cx) => this.connectLogin(cx)))
          .child(div().text_size(12).text_color(t.dim).child(`Saved to ${loginPath().replace(home(), "~")}, readable only by you.`)));
    return v_flex().id("setup").size_full().overflow_y_scrollbar().items_center().p(24)
      .child(v_flex().w_full().max_w(420).my_auto().gap(20)
        .child(h_flex().gap(10).items_center()
          .child(image("mods/mattermost/icons/logo.svg").size(28))
          .child(div().text_size(18).font_semibold().child("Connect to Mattermost")))
        .child(form)
        .when(Boolean(s.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(s.error))));
  }

  mainKind() {
    if (this.thread) return "thread";
    if (this.selected === THREADS) return "threads";
    return this.selected && this.channels.has(this.selected) ? "chat" : null;
  }

  // A render cut off at the time limit leaves a part on its last good frame until something notifies
  // it, and a part is notified far less often than the root; the timer retries parts left unfinished.
  // Rows cost about a millisecond each, more while the script is cold or collecting garbage, so a render
  // that runs long leaves the furthest rows out and asks for another; a few short ones in a row and the
  // next builds everything, so a slow machine can't loop.
  renderPart(part, cx) {
    this.unfinished.add(part);
    this.renderStart = Date.now();
    this.shortened = false;
    this.rowBudget = (this.shortRuns ?? 0) < 4;
    const el = this.buildPart(part);
    this.unfinished.delete(part);
    this.shortRuns = this.shortened ? (this.shortRuns ?? 0) + 1 : 0;
    if (this.shortened) cx.timer.after(16, (cx) => cx.notify());
    return el;
  }

  buildPart(part) {
    const t = theme();
    const wide = this.width >= WIDE;
    const kind = this.mainKind();
    if (part === "side") return wide || !kind ? this.channelList(t, wide) : div();
    if (kind === "thread") {
      // Mattermost's Threads keeps the list on the left while a thread is open on the right.
      const room = this.width - (wide ? this.sideW : 0);
      if (this.selected === THREADS && room >= THREAD_LIST_W + MESSAGES_MIN) {
        return h_flex().size_full()
          .child(v_flex().w(THREAD_LIST_W).flex_none().h_full().border_r(1).border_color(t.border).child(this.threadsView(t, wide)))
          .child(this.threadView(t, wide, false));
      }
      return this.threadView(t, wide, true);
    }
    if (kind === "threads") return this.threadsView(t, wide);
    if (kind === "chat") return this.chat(t, wide);
    return !wide ? div() : v_flex().flex_1().h_full().items_center().justify_center().text_color(t.dim)
      .child(this.error ?? (this.channels.size ? "Pick a channel" : ""));
  }

  channelList(t, wide) {
    const rows = this.sidebarRows();
    const { total_unread_threads: unreadThreads, total_unread_mentions: threadMentions } = this.threadTotals;
    const active = !this.opening && this.selected === THREADS;
    return v_flex().h_full().min_h(0).when(wide, (el) => el.size_full()).when(!wide, (el) => el.flex_1())
      // Same height as the main side's top bar, so the search box and the tabs share a center line.
      // A flat bar like the main side's top bar, sharing its height and bottom divider.
      // Mattermost's Find channel is a button for the Find Channels dialog, not a filter.
      // The whole bar is the button. GPUI clips children to a rectangle, so in the framed panel the bar
      // rounds its own corner to the frame's inner curve (10px less the 1px border).
      .child(h_flex().id("search").h(36).flex_none().pl(ROW_PAD).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
        .when(this.frame, (el) => el.rounded_tl(9)).cursor_pointer().text_size(12.5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => this.openSwitcher())
        .child(this.slot(svg("mods/mattermost/icons/search.svg").size(14)))
        .child(div().flex_1().child("Find channel")))
      .child(div().pt(4).pb(2).flex_none().child(h_flex().id("threads").relative().h(30).pl(ROW_PAD).pr(8).gap(8).items_center().cursor_pointer()
        .when(active, (el) => el.bg(t.selected).child(this.activeBar(t))).hover((s) => s.bg(active ? t.selected : t.hover))
        .on_click((_e, cx) => this.openThreads(cx))
        .child(this.slot(svg("mods/mattermost/icons/threads.svg").size(14).text_color(active || unreadThreads ? t.foreground : t.muted)))
        .child(div().flex_1().text_color(active || unreadThreads ? t.foreground : t.muted).when(unreadThreads > 0, (el) => el.font_semibold()).child("Threads"))
        .when(threadMentions > 0, (el) => el.child(this.badge(threadMentions, t)))))
      .when(Boolean(this.error) && !this.channels.size, (el) => el.child(div().p(12).text_color(t.blocked).child(this.error)))
      .child(v_flex().id("channels").flex_1().min_h(0).overflow_y_scrollbar().pb(6)
        .children(rows.map((r) => (r.cat ? this.categoryRow(r, t) : this.channelRow(r.c, t, r.catMuted, r.grouped)))));
  }

  badge(n, t) {
    return div().px(6).rounded(8).bg(t.accent).text_color(t.accent_foreground).text_size(11).font_semibold().child(String(n));
  }

  categoryRow({ cat, first }, t) {
    const unreadIds = cat.channel_ids.filter((id) => { const c = this.channels.get(id); return c && (this.unread(c).count > 0 || this.unread(c).mentions > 0); });
    // An svg keeps its own color when the row's hover changes the text color, so the hovered
    // category is tracked to light its chevron with the name.
    const hovered = this.hoverCat === cat.id;
    return div().pt(first ? 2 : 10).child(h_flex().id(`cat-${cat.id}`).relative().h(26).pl(ROW_PAD).pr(4).gap(6).items_center().cursor_pointer()
      .text_size(11).font_semibold().text_color(t.dim).hover((s) => s.text_color(t.foreground))
      .on_hover((on, cx) => {
        if (on) this.hoverCat = cat.id;
        else if (this.hoverCat === cat.id) this.hoverCat = null;
        else return;
        cx.notify();
      })
      .on_click((_e, cx) => this.toggle(cat, cx))
      .child(this.slot(svg(`mods/mattermost/icons/chevron-${cat.collapsed ? "right" : "down"}.svg`).size(12).text_color(hovered ? t.foreground : t.dim)))
      .child(div().flex_1().truncate().child(cat.display_name.toUpperCase()))
      .child(this.hoverDots(`catm-${cat.id}`, t, () => this.openMenu({ kind: "category", cat, unreadIds }), t.background)));
  }

  channelIcon(c, color, t) {
    if (c.type === "D") {
      const peer = this.dmPeer(c);
      // Bots, System among them, have no presence, and Mattermost shows none for them.
      // Mattermost's DM avatar is 20px with a 13px status ring at (10, 10) (.DirectChannel__status-icon).
      return this.withStatus(peer, this.avatar(peer, 20, t), 20, 13, 10, 10, t);
    }
    // A group DM's icon is its member count (without you) on a .status--group square. Open Sans digits
    // sit low in their line box, so 1px off the bottom centers the glyph rather than the box.
    const others = c.type === "G" ? this.gmMembers.get(c.id)?.filter((id) => id !== this.me?.id) : null;
    if (others) {
      return div().size(18).flex_none().flex().items_center().justify_center().pb(1).rounded(2).bg(alpha(t.foreground, 0.16))
        .text_size(12).line_height("16px").font_semibold().text_color(color).child(String(others.length));
    }
    const name = c.type === "G" ? "users" : c.type === "P" ? "lock" : "globe";
    return svg(`mods/mattermost/icons/${name}.svg`).size(14).text_color(color);
  }

  // Mattermost's status icons and its dark themes' colors; offline is the same in every theme.
  statusMark(status, size = 10) {
    const [icon, color] = STATUS[status] ?? ["offline", "#afb3c0bf"];
    return svg(`mods/mattermost/icons/status-${icon}.svg`).size(size).flex_none().text_color(color);
  }

  // An avatar with its status ring cut out of the background; bots, System among them, have no presence.
  withStatus(id, avatar, size, ring, icon, at, t) {
    return div().relative().size(size).flex_none().child(avatar)
      .when(!this.users.get(id)?.is_bot, (el) => el.child(div().absolute().left(at).top(at).size(ring).flex().items_center().justify_center()
        .rounded_full().bg(t.background).child(this.statusMark(this.statuses.get(id), icon))));
  }

  statusEmoji(id, custom, size, t) {
    return div().id(id).flex_none()
      .on_mouse_move((e) => this.showStatus(custom, e.bounds ?? { ...e.position, width: 0, height: 0 }))
      .on_hover((hovered) => { if (!hovered) this.hideStatus(); })
      .child(custom.emoji ? this.emojiEl(this.emojiToken(custom.emoji), size, t) : div());
  }

  // Herdr's tooltip takes only text, so the custom status card, with its large emoji, is a popup of its own.
  showStatus(custom, box) {
    if (this.statusCard) return;
    const tok = this.emojiToken(custom.emoji);
    const path = tok.custom ? this.media.emoji(this.customEmoji.get(tok.custom)) : tok.emoji && this.cfg ? this.media.standard(this.cfg.url, tok.emoji) : null;
    // Text can't be measured from here, so the popup is a generous transparent box and the card sizes
    // itself inside it, pinned to the side facing the emoji.
    const lines = [custom.text, until(custom)].filter(Boolean).reduce((n, l) => n + Math.ceil([...l].length / 24), 0);
    const width = 260, height = 16 + 42 + lines * 18 + 24;
    const z = this.zoom();
    const above = box.y - height * z - 6 >= 0;
    this.statusCard = openOverlay({
      mod: "mattermost", kind: "popup", frame: "none", width, height,
      at: { x: Math.max(4, box.x + box.width / 2 - (width * z) / 2), y: above ? box.y - height * z - 6 : box.y + box.height + 6 },
      props: { statusCard: { image: path, char: tok.emoji ?? "", text: custom.text, until: until(custom), above } },
    });
  }

  hideStatus() {
    if (!this.statusCard) return;
    closeOverlay(this.statusCard);
    this.statusCard = null;
  }

  activeBar(t) {
    return div().absolute().left(0).top(0).bottom(0).w(3).bg(t.accent);
  }

  slot(icon) {
    return div().w(ICON_SLOT).flex_none().flex().items_center().justify_center().child(icon);
  }

  channelMenu(c, box = null) {
    const { count, mentions } = this.unread(c);
    this.openMenu({
      kind: box ? "header" : "channel",
      channel: { id: c.id, type: c.type, name: c.name, display: this.channelName(c), header: c.header ?? "", purpose: c.purpose ?? "" },
      cat: this.categoryOf(c.id) ?? this.categories[0],
      muted: this.muted(c),
      unread: count > 0 || mentions > 0,
      link: this.link(c),
      peer: c.type === "D" ? this.dmPeer(c) : null,
    }, box);
  }

  channelRow(c, t, catMuted = false, grouped = false) {
    const { count, mentions } = this.unread(c);
    const active = c.id === (this.opening ?? this.selected);
    const muted = catMuted || this.muted(c);
    // Mattermost's sidebar: read text is the text color at 64% (theme "muted"); the active label and
    // unread rows are full; muted rows dim label, icon and badge to 40% on top of that.
    const label = active || count > 0 ? t.foreground : t.muted;
    const iconColor = count > 0 ? t.foreground : t.muted;
    const menu = () => this.channelMenu(c);
    const custom = c.type === "D" ? liveStatus(this.users.get(this.dmPeer(c))?.custom) : null;
    return h_flex().id(`ch-${c.id}`).relative().h(28).pl(grouped ? ROW_PAD + INDENT : ROW_PAD).pr(8).gap(8).items_center().cursor_pointer()
      .when(active, (el) => el.bg(t.selected).child(this.activeBar(t))).hover((s) => s.bg(active ? t.selected : t.hover))
      .on_click((_e, cx) => cx.spawn(async (cx) => this.open(c.id, cx)))
      // Muted dims the icon, name and badge only, so a selected muted row keeps its full highlight and bar.
      .child(this.slot(this.channelIcon(c, iconColor, t)).when(muted, (el) => el.opacity(0.4)))
      .child(div().min_w(0).truncate().text_color(label).when(muted, (el) => el.opacity(0.4)).when(count > 0, (el) => el.font_semibold()).child(this.channelName(c)))
      .children(custom ? [this.statusEmoji(`cs-${c.id}`, custom, 14, t).when(muted, (el) => el.opacity(0.4))] : [])
      .child(div().flex_1())
      .when(mentions > 0, (el) => el.child(this.badge(mentions, t).when(muted, (b) => b.opacity(0.4))))
      .child(this.hoverDots(`chm-${c.id}`, t, menu, active ? t.selected : t.hover));
  }

  topBar(t, wide, back, ...children) {
    return h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .when(Boolean(back), (el) => el.child(div().id("back").px(6).rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { back(); this.redraw(cx); }).child("‹")))
      .children(children);
  }

  composer(t, input = this.input) {
    return v_flex().flex_none()
      .when(Boolean(this.error), (el) => el.child(div().px(14).pb(4).text_size(12).text_color(t.blocked).child(this.error)))
      .child(div().id("composer").px(10).pb(10).pt(2)
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); input.focus(); })
        .child(Input.new(input).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(13)));
  }

  // Rows are [key, build]. Every row scrolled past stays in the timeline, and building them all made
  // renders slow enough to be interrupted, so rows away from the screen are spacers of their last
  // measured height (or EST_ROW before their first draw), walked from the anchored edge. Sizes arrive in
  // window pixels and spacers are drawn in layout units: left unconverted, a row leaving the screen became a
  // taller spacer, and the view jumped against the wheel.
  timeline(key, rows, t, top, sc = this) {
    const view = sc.viewH || 1000;
    // Each row built costs about a millisecond, so little beyond the view is: scrolling renders again anyway.
    const near = (from, h) => from + h > sc.offset - view / 4 && from < sc.offset + 1.25 * view;
    const out = [];
    let from = 0, gap = 0, built = 0;
    for (const [rowKey, build] of top ? rows : [...rows].reverse()) {
      const h = sc.heights.get(rowKey) ?? EST_ROW;
      if (!near(from, h)) gap += h;
      else if (built && this.rowBudget && Date.now() - this.renderStart > ROW_BUDGET) {
        gap += h;
        this.shortened = true;
      } else {
        built++;
        if (gap) out.push(div().h(gap).flex_none());
        gap = 0;
        out.push(div().id(`row-${rowKey}`).on_size_change((size) => { sc.heights.set(rowKey, size.height / this.zoom()); }).child(build()));
      }
      from += h;
    }
    if (gap) out.push(div().h(gap).flex_none());
    const content = v_flex().id(`content-${key}`).absolute().left(0).right(0).pb(8)
      .on_size_change((size) => { sc.contentH = size.height / this.zoom(); })
      .children(top ? out : out.reverse());
    return div().id(`viewport-${key}`).relative().flex_1().min_h(0).overflow_hidden()
      .on_size_change((size, cx) => {
        // Images are sized from the width, so they have to be drawn again. Known heights stay: a drawn row
        // whose size didn't change never reports it again, and would fall back to the estimate.
        const width = size.width / this.zoom();
        const resized = width !== sc.viewW;
        sc.viewW = width;
        sc.viewH = size.height / this.zoom();
        if (resized) cx.notify(this.mainPart);
      })
      .on_scroll_wheel((e, cx) => this.scrollBy(e.delta.y, cx, sc, top))
      .child(top ? content.top(-sc.offset) : content.bottom(-sc.offset));
  }

  separator(label, t) {
    const line = () => div().h(1).flex_1().bg(alpha(t.foreground, 0.12));
    return h_flex().pt(8).h(26).items_center()
      .child(line()).child(div().px(13).h(18).flex().items_center().text_size(13).font_bold().text_color(t.foreground).child(label)).child(line());
  }

  // Webhook posts show the name and icon they were sent with, as Mattermost does, not the account that posted them.
  authorName(p) {
    return (fromWebhook(p) && p.props.override_username) || this.userName(p.user_id);
  }

  isBot(p) {
    return fromWebhook(p) || p.props?.from_bot === "true" || Boolean(this.users.get(p.user_id)?.is_bot);
  }

  authorKey(p) {
    return fromWebhook(p) ? `hook:${p.props.override_username ?? ""}:${p.props.override_icon_url ?? ""}` : p.user_id;
  }

  postAvatar(p, size, t) {
    if (fromWebhook(p) && p.props.override_icon_url) {
      const path = this.media.external(p.props.override_icon_url);
      if (path) return image(path).size(size).flex_none().rounded_full();
    }
    if (fromWebhook(p) && p.props.override_username) {
      return div().size(size).flex_none().rounded_full().bg(t.raised).flex().items_center().justify_center()
        .text_size(Math.round(size * 0.4)).text_color(t.muted).child(p.props.override_username.slice(0, 2).toUpperCase());
    }
    return this.avatar(p.user_id, size, t);
  }

  grouped(p, prev) {
    return Boolean(prev) && !isSystem(prev) && !isSystem(p) && this.authorKey(prev) === this.authorKey(p) && p.create_at - prev.create_at < GROUP_GAP;
  }

  // Posts about you being added or removed stay, as in Mattermost.
  hiddenPost(p) {
    const me = this.me?.username;
    return !this.showJoinLeave && JOIN_LEAVE.has(p.type) && p.props?.addedUsername !== me && p.props?.removedUsername !== me;
  }

  channelRows(c, all, t) {
    const posts = this.showJoinLeave ? all : all.filter((p) => !this.hiddenPost(p));
    const rows = [];
    const from = Math.max(0, posts.length - this.shown);
    if (this.exhausted.has(c.id) && from === 0) rows.push(["start", () => div().px(POST_PAD).pt(10).text_size(12).text_color(t.dim).child("Start of channel")]);
    for (let i = from; i < posts.length; i++) {
      const p = posts[i], prev = posts[i - 1];
      const next = posts[i + 1];
      const newDay = !prev || day(prev.create_at) !== day(p.create_at);
      const beforeDate = Boolean(next) && day(next.create_at) !== day(p.create_at);
      const grouped = !newDay && this.grouped(p, prev);
      const date = newDay ? dateLabel(p.create_at) : null;
      rows.push([`${p.id}-${grouped}-${newDay}-${beforeDate}`, () => this.postRow(p, grouped, t, false, { date, beforeDate, scope: "c" })]);
    }
    return rows;
  }

  chat(t, wide) {
    const c = this.channels.get(this.selected);
    const room = this.width - (wide ? this.sideW : 0);
    const beside = room - this.rhsW >= MESSAGES_MIN;
    if (this.rhs && !beside) return this.rhsView(t, c, true);
    const messages = v_flex().flex_1().min_w(0).h_full()
      .child(this.channelHeader(t, wide, c))
      .child(this.posts.get(c.id) ? this.timeline(c.id, this.channelRows(c, this.posts.get(c.id), t), t, false) : div().flex_1())
      .child(this.composer(t));
    if (!this.rhs) return messages;
    return h_resizable("mm-rhs").flex_1().min_w(0).h_full()
      .on_resize((sizes, cx) => {
        this.rhsW = Math.round(sizes[1]);
        localStorage.setItem("rhsW", String(this.rhsW));
        this.redraw(cx);
      })
      .child(resizable_panel().child(messages))
      .child(resizable_panel().size(this.rhsW).size_range(RHS_MIN, RHS_MAX).child(this.rhsView(t, c, false)));
  }

  headerButton(id, t, on, tip, onClick, ...children) {
    return h_flex().id(id).h(26).px(5).gap(4).flex_none().items_center().rounded(4).cursor_pointer().text_size(12)
      .text_color(on ? t.accent : t.muted).when(on, (el) => el.bg(alpha(t.accent, 0.08)))
      .hover((s) => s.bg(on ? alpha(t.accent, 0.12) : t.hover).text_color(on ? t.accent : t.foreground))
      .tooltip(tip).on_click(onClick).children(children);
  }

  channelHeader(t, wide, c) {
    const stats = this.stats.get(c.id);
    const custom = c.type === "D" ? liveStatus(this.users.get(this.dmPeer(c))?.custom) : null;
    const favorite = this.categoryOf(c.id)?.type === "favorites";
    const icon = (name) => svg(`mods/mattermost/icons/${name}.svg`).size(14);
    // While Info is open, the top bar's buttons lead on from it, as its own rows do, so back returns to Info.
    const from = (kind) => (this.rhs === "info" ? "info" : this.rhs !== kind ? this.rhsFrom : null);
    const tool = (kind, name, count, tip) => this.headerButton(`hd-${kind}`, t, this.rhs === kind, tip, (_e, cx) => this.openRhs(kind, cx, from(kind)),
      icon(name), ...(count != null ? [div().child(String(count))] : []));
    const info = this.rhs === "info";
    return h_flex().h(36).flex_none().pl(wide ? 10 : 4).pr(8).gap(2).items_center().border_b(1).border_color(t.border)
      .when(!wide, (el) => el.child(this.headerButton("back", t, false, "Back", (_e, cx) => {
        this.selected = null;
        localStorage.removeItem("selected");
        this.redraw(cx);
      }, div().text_size(16).child("‹"))))
      .child(this.headerButton("hd-star", t, false, favorite ? "Remove from Favorites" : "Add to Favorites", (_e, cx) => this.toggleFavorite(c, cx),
        icon(favorite ? "star-filled" : "star").when(favorite, (el) => el.text_color(t.accent))))
      .child(h_flex().id("hd-name").min_w(0).h(28).px(4).gap(4).items_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (e) => this.channelMenu(c, e.bounds ?? { ...e.position, width: 0, height: 0 }))
        .when(c.type === "D", (el) => el.child(this.channelIcon(c, t.muted, t)))
        .child(div().min_w(0).truncate().text_size(15).font_semibold().child(this.channelName(c)))
        .child(svg("mods/mattermost/icons/chevron-down.svg").size(12).flex_none().text_color(t.muted)))
      .when(c.type !== "D", (el) => el.child(tool("members", "account", stats?.member_count, "Members")))
      // Mattermost leaves the pin out until something is pinned; Info still lists Pinned messages.
      .when(stats?.pinnedpost_count > 0, (el) => el.child(tool("pinned", "pin", stats.pinnedpost_count, "Pinned messages")))
      .child(tool("files", "file-doc", null, "Channel files"))
      // Only the emoji opens the status card, as in Mattermost; the text beside it already says it.
      .when(Boolean(custom), (el) => el.child(h_flex().min_w(0).ml(4).gap(6).items_center().text_size(12).text_color(t.muted)
        .when(Boolean(custom.emoji), (el) => el.child(this.statusEmoji("hd-status", custom, 14, t)))
        .child(div().min_w(0).truncate().child(custom.text))))
      .child(div().flex_1())
      .child(div().id("hd-info").size(28).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
        .bg(info ? t.accent : t.background).text_color(info ? t.accent_foreground : t.muted)
        .hover((s) => s.bg(info ? t.accent : t.hover).text_color(info ? t.accent_foreground : t.foreground))
        .tooltip("View Info").on_click((_e, cx) => this.openRhs("info", cx)).child(icon("info")));
  }

  rhsView(t, c, replacing) {
    const titles = { info: "Info", members: "Members", pinned: "Pinned messages", files: "Files", thread: "Thread" };
    const thread = this.rhs === "thread" ? this.threadPosts.get(this.rhsThread) : null;
    if (this.rhs === "thread") c = this.channels.get(thread?.[0]?.channel_id) ?? c;
    const following = this.rhs === "thread" ? this.following.get(this.rhsThread) : undefined;
    const close = (_e, cx) => { this.rhs = null; this.rhsFrom = null; this.redraw(cx); };
    const back = this.rhsFrom ? (_e, cx) => { this.rhs = this.rhsFrom; this.rhsFrom = null; this.redraw(cx); } : replacing ? close : null;
    return v_flex().h_full().min_h(0).when(replacing, (el) => el.flex_1().min_w(0)).when(!replacing, (el) => el.size_full())
      .child(h_flex().h(36).flex_none().pl(back ? 6 : 14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(back), (el) => el.child(this.headerButton("rhs-back", t, false, "Back", back, svg("mods/mattermost/icons/chevron-left.svg").size(16))))
        .child(div().flex_none().text_size(14).font_semibold().child(titles[this.rhs]))
        .child(div().w(1).h(16).flex_none().bg(t.border))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.channelName(c)))
        .when(following !== undefined && Boolean(thread?.length), (el) => el.child(this.followButton(thread[0], following, t, "rhs-follow")))
        .child(this.headerButton("rhs-close", t, false, "Close", close, svg("mods/mattermost/icons/x.svg").size(14))))
      .when(this.rhs === "thread", (el) => el
        .child(thread?.length ? this.timeline(`rhs-${this.rhsThread}`, this.threadRows(thread, t, "r", Infinity), t, false, this.rhsScroll) : div().flex_1())
        .child(this.composer(t, this.replyInput)))
      .when(this.rhs !== "thread", (el) => el.child(v_flex().id(`rhs-${this.rhs}`).flex_1().min_h(0).overflow_y_scrollbar().pb(8).children(this.rhsBody(t, c))));
  }

  followButton(p, following, t, id) {
    return div().id(id).h(24).px(8).flex().flex_none().items_center().rounded(4).cursor_pointer().text_size(12).font_semibold()
      .text_color(following ? t.accent : t.muted).when(following, (d) => d.bg(alpha(t.accent, 0.08)))
      .hover((s) => s.bg(alpha(following ? t.accent : t.foreground, 0.12)))
      .on_click((_e, cx) => this.toggleFollow(p, cx))
      .child(following ? "Following" : "Follow");
  }

  rhsBody(t, c) {
    const stats = this.stats.get(c.id);
    const note = (text) => [div().p(16).text_size(13).text_color(t.dim).child(text)];
    const heading = (text) => div().px(16).pt(14).pb(6).text_size(11).font_semibold().text_color(t.dim).child(text.toUpperCase());
    if (this.rhs === "info") {
      const favorite = this.categoryOf(c.id)?.type === "favorites", muted = this.muted(c);
      const tile = (id, icon, label, on, onClick) => v_flex().id(`info-${id}`).flex_1().h(66).gap(6).items_center().justify_center().rounded(4).cursor_pointer()
        .bg(on ? alpha(t.accent, 0.08) : alpha(t.foreground, 0.08)).text_color(on ? t.accent : t.foreground)
        .hover((s) => s.bg(on ? alpha(t.accent, 0.12) : alpha(t.foreground, 0.12))).on_click(onClick)
        .child(svg(`mods/mattermost/icons/${icon}.svg`).size(20)).child(div().text_size(12).font_semibold().child(label));
      const section = (title) => div().pt(16).pb(4).text_size(12).font_bold().text_color(alpha(t.foreground, 0.75)).child(title.toUpperCase());
      const md = (id, text) => TextView.markdown(id, prepare(text, this.text)).selectable(true)
        .on_link_click((url) => openLink(url));
      // Mattermost shows a pencil while the pointer is over the field; an empty field is itself the way to add one.
      const editable = (field) => {
        const pencil = this.editHover === field ? [svg("mods/mattermost/icons/pencil.svg").size(14).flex_none().mt(3).text_color(t.muted)] : [];
        const hover = (hovered, cx) => {
          const next = hovered ? field : this.editHover === field ? null : this.editHover;
          if (next !== this.editHover) { this.editHover = next; cx.notify(); }
        };
        if (!c[field]) {
          return h_flex().id(`info-${field}`).gap(6).items_start().cursor_pointer().text_color(t.muted).on_hover(hover)
            .on_click(() => this.editChannel(c, field)).child(div().child(`Add a channel ${field}`)).children(pencil);
        }
        return h_flex().id(`info-${field}`).gap(6).items_start().on_hover(hover)
          .child(div().flex_1().min_w(0).child(md(`info-${field}-${c.id}`, c[field])))
          .children(pencil.map((p) => div().id(`info-${field}-edit`).cursor_pointer().on_click(() => this.editChannel(c, field)).child(p)));
      };
      const row = (kind, icon, label, count) => h_flex().id(`info-${kind}`).h(40).px(20).gap(12).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.openRhs(kind, cx, "info"))
        .child(svg(`mods/mattermost/icons/${icon}.svg`).size(16).text_color(t.muted)).child(div().flex_1().text_size(14).child(label))
        .child(div().text_size(12).text_color(t.muted).child(count == null ? "" : String(count)))
        .child(svg("mods/mattermost/icons/chevron-right.svg").size(14).text_color(t.muted));
      const dm = c.type === "D", peer = dm ? this.dmPeer(c) : null;
      return [
        h_flex().px(24).pt(24).gap(8)
          .child(tile("favorite", favorite ? "star-filled" : "star", favorite ? "Favorited" : "Favorite", favorite, (_e, cx) => this.toggleFavorite(c, cx)))
          .child(tile("mute", muted ? "bell-off" : "bell", muted ? "Muted" : "Mute", muted, (_e, cx) => this.toggleMute(c, cx)))
          .when(!dm, (el) => el.child(tile("link", "link", "Copy Link", false, () => exec("wl-copy", [this.link(c)])))),
        dm
          ? v_flex().px(24).text_size(14)
            .child(h_flex().pt(24).pb(20).gap(12).items_center()
              .child(this.withStatus(peer, this.avatar(peer, 50, t), 50, 18, 14, 36, t))
              .child(v_flex().min_w(0).gap(2)
                .child(div().truncate().text_size(18).font_semibold().child(this.userName(peer)))
                .when(Boolean(this.users.get(peer)?.position), (el) => el.child(div().truncate().child(this.users.get(peer).position)))))
            .child(editable("header"))
          : v_flex().px(24).text_size(14)
          .child(section("Channel purpose"))
          .child(editable("purpose"))
          .child(section("Channel header"))
          .child(editable("header"))
          .child(div().pt(10).text_size(11).text_color(t.muted).child(TextView.markdown(`info-id-${c.id}`, `ID: ${c.id}`).selectable(true))),
        div().mx(24).my(16).h(1).bg(t.border),
        ...(c.type !== "D" ? [row("members", "account", "Members", stats?.member_count)] : []),
        row("pinned", "pin", "Pinned messages", stats?.pinnedpost_count),
        row("files", "file-doc", "Files", stats?.files_count),
      ];
    }
    if (this.rhs === "members") {
      const ids = this.rhsData.members.get(c.id);
      if (!ids) return note("Loading…");
      return [
        div().px(16).pt(14).text_size(14).font_semibold().child(`${ids.length} ${ids.length === 1 ? "member" : "members"}`),
        heading("Members"),
        ...ids.map((id) => h_flex().id(`member-${id}`).h(40).px(16).gap(10).items_center().hover((s) => s.bg(t.hover))
          .child(this.avatar(id, 24, t))
          .child(div().min_w(0).truncate().text_size(13).child(this.userName(id)))
          .child(div().flex_none().text_size(12).text_color(t.dim).child(`@${this.users.get(id)?.username ?? ""}`))),
      ];
    }
    if (this.rhs === "pinned") {
      const posts = this.rhsData.pinned.get(c.id);
      if (!posts) return note("Loading…");
      if (!posts.length) return note("No pinned messages yet");
      return posts.flatMap((p, i) => [
        ...(i === 0 || day(posts[i - 1].create_at) !== day(p.create_at) ? [this.separator(dateLabel(p.create_at), t)] : []),
        this.postRow(p, false, t, true, { scope: "p" }),
      ]);
    }
    const files = this.rhsData.files.get(c.id);
    if (!files) return note("Loading…");
    if (!files.length) return note("No files yet");
    return [
      div().px(16).pt(14).pb(6).text_size(14).font_semibold().child("Recent files"),
      ...files.map((f) => {
        const thumb = f.has_preview_image && this.media.thumb(f.id);
        return h_flex().id(`file-${f.id}`).mx(12).my(4).px(12).py(10).gap(12).items_center().rounded(6).border_1().border_color(t.border)
          .cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => exec("xdg-open", [`${this.cfg.url}/${this.team.name}/pl/${f.post_id}`]))
          .child(thumb ? image(thumb).size(40).flex_none().rounded(4)
            : div().size(40).flex_none().rounded(4).bg(t.raised).flex().items_center().justify_center().text_size(10).font_semibold().text_color(t.muted).child((f.extension || "file").toUpperCase().slice(0, 4)))
          .child(v_flex().min_w(0).gap(2)
            .child(div().truncate().text_size(13).font_semibold().child(f.name))
            .child(div().text_size(12).text_color(t.dim).child(`${fileSize(f.size)} • ${fileTime(f.create_at)}`)));
      }),
    ];
  }

  markAllRead(cx) {
    this.confirmMarkAll = false;
    for (const list of Object.values(this.threads)) for (const th of list ?? []) Object.assign(th, { unread_replies: 0, unread_mentions: 0 });
    this.threads.unread = [];
    this.threadTotals = { ...this.threadTotals, total_unread_threads: 0, total_unread_mentions: 0 };
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        await this.api(cx, `/users/${this.me.id}/teams/${this.team.id}/threads/read`, { method: "PUT" });
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      await this.loadThreads(cx);
    });
  }

  threadsView(t, wide) {
    const list = this.threads[this.threadTab];
    const unreadCount = this.threadTotals.total_unread_threads;
    const tab = (id, label, dot) => {
      const on = this.threadTab === id;
      return h_flex().id(`tab-${id}`).h(28).px(10).gap(6).items_center().rounded(6).cursor_pointer().font_semibold()
        .text_color(on ? t.accent : t.muted).when(on, (el) => el.bg(t.selected)).hover((s) => s.text_color(on ? t.accent : t.foreground))
        .on_click((_e, cx) => { this.threadTab = id; this.confirmMarkAll = false; this.redraw(cx); cx.spawn(async (cx) => this.loadThreads(cx)); })
        .child(label)
        .when(dot, (el) => el.child(div().size(6).rounded(3).bg(t.accent)));
    };
    const small = (id, label, primary, onClick) => div().id(id).px(8).py(3).rounded(6).cursor_pointer().text_size(12)
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground)).when(!primary, (el) => el.text_color(t.muted))
      .hover((s) => (primary ? s.opacity(0.88) : s.bg(t.hover).text_color(t.foreground)))
      .on_click(onClick).child(label);
    const empty = this.threadTab === "unread"
      ? ["No unread threads", "You're all caught up"]
      : ["No followed threads", "Threads you start, reply to or follow will show here"];
    return v_flex().flex_1().min_w(0).h_full()
      .child(this.topBar(t, wide, !wide && (() => { this.selected = null; localStorage.removeItem("selected"); }),
        tab("all", "Followed threads", false),
        tab("unread", "Unreads", unreadCount > 0),
        div().flex_1(),
        ...(this.confirmMarkAll
          ? [div().text_size(12).text_color(t.muted).child("Mark all threads as read?"),
             small("mark-all-no", "Cancel", false, (_e, cx) => { this.confirmMarkAll = false; this.redraw(cx); }),
             small("mark-all-yes", "Mark read", true, (_e, cx) => this.markAllRead(cx))]
          : [div().id("mark-all").p(4).rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip("Mark all threads as read")
              .on_click((_e, cx) => { this.confirmMarkAll = true; this.redraw(cx); })
              .child(svg("mods/mattermost/icons/mark-read.svg").size(16))])))
      .child(!list
        ? div().flex_1()
        : !list.length
          ? v_flex().flex_1().items_center().justify_center().gap(8).px(20)
            .child(div().text_size(17).font_semibold().text_color(t.foreground).child(empty[0]))
            .child(div().text_size(13).text_color(t.muted).child(empty[1]))
          : v_flex().id(`threads-${this.threadTab}`).flex_1().min_h(0).overflow_y_scrollbar()
            .children(list.map((th) => this.threadCard(th, t))))
      .when(Boolean(this.error), (el) => el.child(div().px(14).py(6).text_size(12).text_color(t.blocked).child(this.error)));
  }

  preview(text) {
    return text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(SHORTCODES, (whole, name) => this.emoji[name.toLowerCase()] ?? whole)
      .replace(/(^|\s)@([a-z0-9._\-]+)/gi, (whole, before, name) => { const label = this.mentionLabel(name); return label ? `${before}@${label}` : whole; })
      .replace(/\s+/g, " ").slice(0, 240);
  }

  threadCard(th, t) {
    const p = th.post;
    const c = this.channels.get(p.channel_id);
    const direct = c?.type === "D" || c?.type === "G";
    const unread = th.unread_replies > 0;
    // As Mattermost draws it: the thread's author, then everyone else latest first.
    const people = [{ id: p.user_id }, ...(th.participants ?? []).filter((u) => u?.id && u.id !== p.user_id).reverse()];
    const shown = people.slice(0, 3);
    const menu = () => this.openMenu({
      kind: "thread", saved: this.saved.has(th.id), link: this.postLink(th.id),
      thread: { id: th.id, channel_id: p.channel_id, unread, following: th.is_following !== false },
    });
    const open = this.thread === th.id;
    return v_flex().id(`th-${th.id}`).relative().px(14).py(10).gap(6).border_b(1).border_color(t.border).cursor_pointer()
      .when(open, (el) => el.bg(t.selected)).hover((s) => s.bg(open ? t.selected : t.hover))
      .on_click((_e, cx) => cx.spawn(async (cx) => this.openThread(th.id, cx)))
      // Shown on hover by a layer over the card, which the card's own hover can't do for a child.
      .child(div().absolute().inset_0().opacity(0).hover((s) => s.opacity(1))
        .child(div().id(`thm-${th.id}`).absolute().top(6).right(8).size(28).flex().items_center().justify_center().rounded(4)
          .bg(t.hover).text_color(t.muted).hover((s) => s.bg(alpha(t.foreground, 0.08)).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); menu(); })
          .child(svg("mods/mattermost/icons/dots.svg").size(16))))
      .child(h_flex().gap(8).items_center()
        .when(unread, (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.accent)))
        .child(div().flex_none().font_semibold().child(this.authorName(p)))
        .when(Boolean(c) && !direct, (el) => el.child(div().flex_none().max_w(180).truncate().px(5).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(this.channelName(c))))
        .child(div().flex_1())
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(ago(th.last_reply_at || p.create_at))))
      .child(div().max_h(38).overflow_hidden().text_color(unread ? t.foreground : t.muted).child(this.preview(p.message || "") || " "))
      .child(h_flex().gap(8).items_center().text_size(12)
        .child(h_flex().items_center()
          .children(shown.map((u, i) => div().when(i > 0, (el) => el.ml(-6)).rounded_full().border_2().border_color(t.background).child(this.avatar(u.id, 20, t))))
          .when(people.length > shown.length, (el) => el.child(div().ml(-6).rounded_full().border_2().border_color(t.background)
            .child(div().size(20).rounded_full().bg(t.raised).flex().items_center().justify_center()
              .text_size(9).font_semibold().text_color(t.muted).child(`+${people.length - shown.length}`)))))
        // Mattermost counts only the new replies while there are some.
        .child(div().font_semibold().text_color(unread ? t.accent : t.muted).child(unread ? `${th.unread_replies} new ${th.unread_replies === 1 ? "reply" : "replies"}` : replies(th.reply_count)))
        .when(th.unread_mentions > 0, (el) => el.child(this.badge(th.unread_mentions, t))));
  }

  threadRows(posts, t, scope = "t", limit = this.shown) {
    const [root, ...rest] = posts;
    const rows = [[root.id, () => this.postRow(root, false, t, true, { scope })]];
    // Mattermost's reply count: a short line under the avatar, the count where the author's text starts.
    rows.push(["replies", () => h_flex().pl(POST_PAD + AVATAR_INSET).pt(12).pb(2).items_center()
      .child(div().h(1).w(AVATAR_COL - AVATAR_INSET - 13).flex_none().bg(t.border))
      .child(div().ml(13).mr(10).text_size(12).font_semibold().text_color(t.muted).child(replies(rest.length)))
      .child(div().h(1).flex_1().bg(t.border))]);
    const upto = Math.min(rest.length, limit);
    for (let i = 0; i < upto; i++) {
      const grouped = this.grouped(rest[i], rest[i - 1]);
      rows.push([`${rest[i].id}-${grouped}`, () => this.postRow(rest[i], grouped, t, true, { scope })]);
    }
    return rows;
  }

  // Pinned to the bottom like a channel, the reply box under the newest reply.
  threadView(t, wide, back) {
    const posts = this.threadPosts.get(this.thread);
    const c = this.channels.get(posts?.[0]?.channel_id);
    const following = this.following.get(this.thread);
    return v_flex().flex_1().min_w(0).h_full()
      .child(this.topBar(t, wide, back && (() => this.closeThread()),
        div().font_semibold().text_size(15).child("Thread"),
        ...(c ? [div().w(1).h(16).flex_none().bg(t.border), div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.channelName(c))] : [div().flex_1()]),
        ...(following !== undefined && posts?.length ? [this.followButton(posts[0], following, t, "thread-follow")] : []),
        ...(posts?.length ? [div().id("thread-menu").size(28).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (e) => this.openMenu({
            kind: "thread", saved: this.saved.has(this.thread), link: this.postLink(this.thread), alignRight: true,
            thread: { id: this.thread, channel_id: posts[0].channel_id, unread: false, following: Boolean(following) },
          }, e.bounds))
          .child(svg("mods/mattermost/icons/dots.svg").size(16))] : [])))
      .child(posts?.length ? this.timeline(`thread-${this.thread}`, this.threadRows(posts, t, "t", Infinity), t, false) : div().flex_1())
      .child(this.composer(t, this.threadInput));
  }

  avatar(userId, size, t) {
    const u = this.users.get(userId);
    const path = this.media.avatar(u);
    if (path) return image(path).size(size).flex_none().rounded_full();
    const initials = (u ? this.userName(u.id) : "?").split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
    return div().size(size).flex_none().rounded_full().bg(t.raised).flex().items_center().justify_center()
      .text_size(Math.round(size * 0.4)).text_color(t.muted).child(initials);
  }

  emojiToken(name) {
    return this.customEmoji.has(name) ? { custom: name } : this.emoji[name] ? { emoji: this.emoji[name] } : { text: `:${name}:` };
  }

  emojiEl(tok, size, t) {
    if (tok.custom) {
      const path = this.media.emoji(this.customEmoji.get(tok.custom));
      return path ? image(path).size(size).flex_none() : div().text_color(t.dim).child(`:${tok.custom}:`);
    }
    const path = tok.emoji && this.cfg && this.media.standard(this.cfg.url, tok.emoji);
    return path ? image(path).size(size).flex_none() : div().text_size(Math.round(size * 0.85)).child(tok.emoji ?? tok.text);
  }

  // Turning a message into its parts is regex work that made up most of a render, so it is done once
  // per message text and redone only when the names or emoji it depends on change.
  parsed(cacheKey, message) {
    const key = `${this.textRev}:${message}`;
    let hit = this.parsedCache.get(cacheKey);
    if (hit?.key === key) return hit;
    // warm() runs this ahead of every redraw, so a message it can't handle comes out as plain text instead of
    // stopping them all.
    let big = null, parts;
    try {
      big = jumbo(message, this.text);
      parts = big ? null : segments(message, this.text);
    } catch {
      parts = [{ md: message }];
    }
    hit = { key, big, parts };
    if (this.parsedCache.size >= PARSED) this.parsedCache.clear();
    this.parsedCache.set(cacheKey, hit);
    return hit;
  }

  emojiLine(key, line, t) {
    const scale = line.heading ? [0, 24, 20, 18, 16, 14, 14][line.heading] : 14;
    const words = line.tokens.map((tok, i) => {
      if (tok.space) return div().w(4).h(4).flex_none();
      if (tok.custom || tok.emoji) return this.emojiEl(tok, Math.round(scale * 1.3), t);
      if (tok.mention) return div().text_color(t.accent).when(tok.mine, (el) => el.bg(this.mentionBg).rounded(2)).child(tok.mention);
      return div().id(`${key}-w${i}`).when(tok.bold || line.heading > 0, (el) => el.font_bold()).when(tok.italic, (el) => el.italic()).when(tok.strike, (el) => el.line_through())
        .when(Boolean(tok.code), (el) => el.px(4).rounded(4).bg(alpha(t.foreground, 0.08)).font_family(settings()?.font ?? "monospace").text_size(12))
        .when(Boolean(tok.link), (el) => el.text_color(t.accent).cursor_pointer().on_click(() => openLink(tok.link)))
        .child(tok.text);
    });
    return h_flex().flex_wrap().items_center().min_h(20).my(2).pl(line.indent * 6).text_size(scale)
      .when(line.quote, (el) => el.pl(12).border_l_2().border_color(alpha(t.foreground, 0.2)))
      .when(Boolean(line.marker), (el) => el.child(div().w(18).flex_none().child(line.marker)))
      .children(words);
  }

  richText(key, message, t, p, maxW) {
    const { big, parts } = this.parsed(key, message);
    if (big) return [h_flex().gap(4).py(2).children(big.map((tok) => this.emojiEl(tok, 32, t)))];
    return parts.map((part, i) => {
      const id = i ? `${key}-${i}` : key;
      if (part.line) return this.emojiLine(id, part.line, t);
      if (part.image) return div().py(2).child(remoteImage(this, id, part.image.url, p, { ...part.image, maxW }, t));
      return TextView.markdown(`md-${id}`, part.md).selectable(true).on_link_click((url) => openLink(url));
    });
  }

  reactions(p, t, hovered) {
    const groups = new Map();
    for (const r of p.metadata?.reactions ?? []) {
      const g = groups.get(r.emoji_name) ?? { name: r.emoji_name, count: 0, mine: false, users: [] };
      g.count++;
      g.mine ||= r.user_id === this.me?.id;
      g.users.push(r.user_id);
      groups.set(r.emoji_name, g);
    }
    return h_flex().flex_wrap().gap(4).pt(4).children([...groups.values()].map((g) =>
      h_flex().id(`rx-${p.id}-${g.name}`).h(24).px(6).gap(4).items_center().rounded(6).border_1().cursor_pointer()
        .border_color(g.mine ? t.accent : t.border).bg(g.mine ? t.selected : t.raised).hover((s) => s.border_color(t.accent))
        .tooltip(`${g.users.map((id) => this.userName(id)).join(", ")} reacted with :${g.name}:`)
        .on_click((_e, cx) => this.toggleReaction(p, g.name, g.mine, cx))
        .child(this.emojiEl(this.emojiToken(g.name), 16, t))
        .child(div().text_size(11.5).font_semibold().text_color(g.mine ? t.accent : t.muted).child(String(g.count)))))
      .when(hovered, (el) => el.child(div().id(`rx-add-${p.id}`).size(24).flex().items_center().justify_center().rounded(4).cursor_pointer()
        .bg(alpha(t.foreground, 0.08)).text_color(alpha(t.foreground, 0.56)).hover((s) => s.bg(alpha(t.foreground, 0.16)).text_color(t.foreground))
        .tooltip("Add a reaction")
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.openPicker(p, e.bounds); })
        .child(svg("mods/mattermost/icons/smile-plus.svg").size(16))));
  }

  // Mattermost's post menu: over the post's top right corner, above the text rather than beside it.
  postActions(p, t, key, scope, date) {
    const saved = this.saved.has(p.id);
    const button = (id, icon, tip, on, handler) => div().id(`pa-${id}`).size(28).flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_color(on ? t.accent : alpha(t.foreground, 0.64)).when(on, (el) => el.bg(alpha(t.accent, 0.08)))
      .hover((s) => s.bg(on ? alpha(t.accent, 0.08) : alpha(t.foreground, 0.08)).text_color(on ? t.accent : alpha(t.foreground, 0.8)))
      .tooltip(tip)
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); handler(e, cx); })
      .child(svg(`mods/mattermost/icons/${icon}.svg`).size(18));
    const popup = (open) => (e) => open(e.bounds);
    // The bar sticks out over the post above, which would otherwise take the hover from under it; its
    // moves come before that post's.
    return h_flex().id(`pa-bar-${p.id}`).on_mouse_move(() => { this.moveOn ??= key; }).absolute().top(date ? DATE_HALF - 6 : -12).right(16).p(4).gap(0).rounded(4).border_1().border_color(alpha(t.foreground, 0.2))
      .bg(t.background).shadow_md()
      .child(button("emoji", "smile-plus", "Add Reaction", false, popup((box) => this.openPicker(p, box))))
      .child(button("save", saved ? "bookmark-filled" : "bookmark", saved ? "Remove from Saved" : "Save Message", saved, (_e, cx) => this.toggleSave(p, cx)))
      .when(scope === "c", (el) => el.child(button("reply", "reply", "Reply", false, (_e, cx) => this.openReply(p.root_id || p.id, cx))))
      .child(button("more", "ellipsis", "Message actions", false, popup((box) => this.postMenu(p, box))));
  }

  postRow(p, grouped, t, inThread, options) {
    // A throw from a row would stop the whole part from rendering for as long as that post is on screen.
    try {
      return this.drawPost(p, grouped, t, inThread, options);
    } catch {
      return div().id(`post-${p.id}`).pl(POST_PAD + AVATAR_COL).py(2).text_size(13).text_color(t.muted).child("This message can't be shown.");
    }
  }

  // Mattermost's date line lies on the boundary between two posts instead of in a row of its own, so a
  // hovered post's highlight reaches from the line above it to the line below.
  drawPost(p, grouped, t, inThread, { date = null, beforeDate = false, scope = null } = {}) {
    const key = scope && `${scope}:${p.id}`;
    const hovered = Boolean(key) && this.hoverPost === key;
    const row = h_flex().id(`post-${p.id}`).relative().items_start().pl(POST_PAD).pr(15)
      .pt(date ? 8 + DATE_HALF : grouped ? 0 : 8).pb(beforeDate ? 6 + DATE_HALF : 3)
      .text_size(14).line_height("20px").hover((s) => s.bg(alpha(t.foreground, 0.04)))
      .when(Boolean(key), (el) => el.on_mouse_move(() => { this.moveOn ??= key; }));
    return row.children(isSystem(p) ? this.systemPost(p, t) : this.userPost(p, grouped, t, inThread, hovered, scope))
      .when(Boolean(date), (el) => el.child(this.dateLine(date, t)))
      .when(hovered && !isSystem(p) && this.editing !== p.id, (el) => el.child(this.postActions(p, t, key, scope, date)));
  }

  // Mattermost's thread footer: who replied, latest first, the reply count, and following the thread.
  threadFooter(p, t, hovered) {
    const people = (p.participants ?? []).map((u) => u.id).filter(Boolean).reverse();
    const shown = people.slice(0, 3);
    const following = this.following.get(p.id);
    return h_flex().pt(6).gap(8).items_center().text_size(12)
      .when(shown.length > 0, (el) => el.child(h_flex().items_center()
        .children(shown.map((id, i) => div().when(i > 0, (d) => d.ml(-6)).rounded_full().border_2().border_color(t.background).child(this.avatar(id, 22, t))))
        .when(people.length > shown.length, (el) => el.child(div().ml(-6).size(26).rounded_full().border_2().border_color(t.background).bg(t.raised)
          .flex().items_center().justify_center().text_size(10).font_semibold().text_color(t.muted).child(`+${people.length - shown.length}`)))))
      .child(h_flex().id(`replies-${p.id}`).h(24).px(6).gap(4).items_center().rounded(4).cursor_pointer().font_semibold().text_color(t.accent)
        .hover((s) => s.bg(alpha(t.accent, 0.08)))
        .on_click((_e, cx) => this.openReply(p.id, cx))
        .child(svg("mods/mattermost/icons/reply.svg").size(14)).child(replies(p.reply_count)))
      .when(following !== undefined, (el) => el.child(this.followButton(p, following, t, `follow-${p.id}`)))
      // Mattermost shows when the last reply came only while the post is hovered.
      .when(hovered && Boolean(p.last_reply_at), (el) => el.child(div().pl(8).text_color(alpha(t.foreground, 0.75)).child(`Last reply ${ago(p.last_reply_at)}`)));
  }

  dateLine(label, t) {
    const line = () => div().h(1).flex_1().bg(alpha(t.foreground, 0.12));
    return h_flex().absolute().left(0).right(0).top(-DATE_HALF).h(2 * DATE_HALF).items_center()
      .child(line())
      .child(div().h_full().px(13).flex().items_center().rounded(DATE_HALF).bg(t.background).text_size(13).font_bold().text_color(t.foreground).child(label))
      .child(line());
  }

  systemPost(p, t) {
    return [div().w(AVATAR_COL).flex_none(), div().flex_1().min_w(0).py(1).text_color(alpha(t.foreground, 0.75)).child(p.message)];
  }

  userPost(p, grouped, t, inThread, hovered = false, scope = null) {
    const threadRoot = !inThread && (p.reply_count ?? 0) > 0;
    const time = inThread ? stamp(p.create_at) : clock(p.create_at);
    const person = !fromWebhook(p);
    const custom = person && !grouped ? liveStatus(this.users.get(p.user_id)?.custom) : null;
    // Mattermost's post avatar ring: 15px at right -3, bottom -4 of the 32px avatar, an 11px icon.
    const avatar = person ? this.withStatus(p.user_id, this.postAvatar(p, 32, t), 32, 15, 11, 20, t) : this.postAvatar(p, 32, t);
    const saved = scope !== "p" && this.saved.has(p.id);
    // Mattermost's pre-header: the bookmark at the avatar column's edge, "Saved" over the name.
    return [
      v_flex().w(AVATAR_COL).flex_none()
        .when(saved, (el) => el.child(h_flex().h(20).mb(5).pr(6).justify_end().items_center()
          .child(svg("mods/mattermost/icons/bookmark-filled.svg").size(12).text_color(t.accent))))
        .when(!grouped, (el) => el.child(div().pt(2).pl(AVATAR_INSET).child(avatar))),
      v_flex().flex_1().min_w(0)
        .when(saved, (el) => el.child(div().h(20).mb(5).flex().items_center().text_size(12).text_color(t.accent).child("Saved")))
        .when(!grouped, (el) => el.child(h_flex().mb(2).gap(8).items_center()
          .child(div().font_semibold().text_color(t.foreground).child(this.authorName(p)))
          .when(Boolean(custom?.emoji), (el) => el.child(this.statusEmoji(`ps-${p.id}`, custom, 16, t).ml(-4)))
          .when(this.isBot(p), (el) => el.child(div().h(16).px(4).rounded(4).flex().items_center().bg(alpha(t.foreground, 0.08))
            .text_size(10).line_height("12px").font_semibold().text_color(t.foreground).child("BOT")))
          .child(div().text_size(12).text_color(t.foreground).opacity(0.73).child(time))
          .when(p.edit_at > 0, (el) => el.child(div().text_size(12).text_color(t.foreground).opacity(0.56).child("Edited")))))
        .children(this.editing === p.id ? [this.editBox(p, t)] : this.richText(p.id, p.message ?? "", t, p, this.contentWidth(scope)))
        .children(postFiles(this, p, t, scope))
        .children(postAttachments(this, p, t, scope))
        .children(postEmbeds(this, p, t, scope))
        .when((p.metadata?.reactions ?? []).length > 0, (el) => el.child(this.reactions(p, t, hovered)))
        .when(threadRoot, (el) => el.child(this.threadFooter(p, t, hovered))),
    ];
  }

}
