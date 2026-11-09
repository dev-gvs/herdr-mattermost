import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, appHome, props, exec, readTextFile, writeTextFile } from "herdr";
import { alpha, openLink, sleep } from "../main.js";
import { hash } from "./media.js";
import { jiraDemo, JIRA_DEMO_SITE } from "../demo/jira.js";

export const JIRA = "jira";
const ROW_PAD = 9;
const PAGE = 50;
const TIMEOUT = 15e3;
const POLL = 60e3;
// Jira's bell keeps a month of notifications, and its empty state says so.
const DAYS = 30;
const ICONS = "data/mattermost/jira";
// Jira's own colours, dark and light, so the page reads as Jira's bell does.
const BLUE = ["#579dff", "#0c66e4"];
const SWITCH = ["#94c748", "#6a9a23"];
// Atlassian's colour for an avatar without a picture.
const NAVY = "#172b4d";
// Rows have no line clamp, so titles and comments are cut by an estimate of how many characters fit.
const CHAR_W = 0.6;
// Wrapping at word ends leaves part of each line empty.
const WRAP_LOSS = 0.35;
const TITLE_LINE = 20;
const BODY_LINE = 20;

// The gateway warns about unnamed operations. Every field here was checked against a real site.
const ITEM = `fragment JiraItem on InfluentsNotificationItem {
  notificationId readState timestamp category
  content { type message url actor { displayName avatarURL } entity { title url contentSubtype iconUrl status } path { title url } bodyItems { type document { format data } } }
}`;
const FEED = `query JiraFeed($category: InfluentsNotificationCategory, $after: DateTime, $all: Boolean!, $ari: String) {
  notifications {
    direct: notificationFeed(first: ${PAGE}, collabContextRoutingAri: $ari, filter: { categoryFilter: direct, readStateFilter: unread, afterTimestamp: $after }) { ...JiraNodes }
    watching: notificationFeed(first: ${PAGE}, collabContextRoutingAri: $ari, filter: { categoryFilter: watching, readStateFilter: unread, afterTimestamp: $after }) { ...JiraNodes }
    all: notificationFeed(first: ${PAGE}, collabContextRoutingAri: $ari, filter: { categoryFilter: $category, afterTimestamp: $after }) @include(if: $all) { ...JiraNodes }
  }
}
fragment JiraNodes on InfluentsNotificationFeedConnection {
  nodes { groupId groupSize additionalActors { displayName avatarURL } headNotification { ...JiraItem } }
  pageInfo { hasNextPage }
}
${ITEM}`;
// The group's newest item is the head the feed already showed.
const GROUP = `query JiraGroup($groupId: String!, $ari: String) {
  notifications { notificationGroup(groupId: $groupId, first: ${PAGE}, collabContextRoutingAri: $ari) { nodes { ...JiraItem } } }
}
${ITEM}`;
// Without the site's routing id the gateway answers from an empty context: no notifications and an unseen count of 0,
// for an API token and a browser login alike. Jira's own bell sends ari:cloud:jira:<cloudId>:workspace/<activation id>.
const TENANT = `query JiraTenant($hosts: [String!]!) { tenantContexts(hostNames: $hosts) { cloudId activationIdByProduct(product: "jira") { active } } }`;
const MARK = {
  read: ["JiraRead", "mutation JiraRead($ids: [String!]!, $ari: String) { notifications { markNotificationsByIdsAsRead(ids: $ids, collabContextRoutingAri: $ari) } }"],
  unread: ["JiraUnread", "mutation JiraUnread($ids: [String!]!, $ari: String) { notifications { markNotificationsByIdsAsUnread(ids: $ids, collabContextRoutingAri: $ari) } }"],
};
const READ_ALL = "mutation JiraReadAll($category: InfluentsNotificationCategory, $ari: String) { notifications { markNotificationsAsRead(category: $category, collabContextRoutingAri: $ari) } }";

// Drawn when an item has no icon or it couldn't be fetched: Jira's own issue type colours.
const TYPES = {
  bug: ["#e5493a", null],
  story: ["#63ba3c", "bookmark"],
  epic: ["#904ee2", "zap"],
  subtask: ["#4bade8", "check"],
  task: ["#4bade8", "check"],
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(text) {
  const bytes = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}

function readIni(text, section) {
  const out = {};
  let current = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) { current = head[1].trim(); continue; }
    const eq = line.indexOf("=");
    if (eq < 0 || (current && current !== section)) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

// A comment arrives as an Atlassian document. Jira's card shows its text on one run, list items after " * ",
// and the first link in it on a line of its own.
function docBody(doc) {
  if (!doc?.data) return { text: "", link: "" };
  if (doc.format && !/adf|json/i.test(doc.format)) return { text: String(doc.data).replace(/\s+/g, " ").trim(), link: "" };
  let root;
  try { root = JSON.parse(doc.data); } catch { return { text: String(doc.data), link: "" }; }
  const parts = [];
  let link = "";
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "listItem") parts.push(" * ");
    const href = n.marks?.find((m) => m?.type === "link")?.attrs?.href ?? (/Card$/.test(n.type ?? "") ? n.attrs?.url : null);
    if (!link && typeof href === "string" && /^https?:\/\//i.test(href)) link = href;
    if (typeof n.text === "string") parts.push(n.text);
    else if (n.attrs?.text) parts.push(n.attrs.text);
    else if (n.attrs?.shortName) parts.push(n.attrs.shortName);
    else if (/Card$/.test(n.type ?? "") && n.attrs?.url) parts.push(n.attrs.url);
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
    if (n.type === "paragraph" || n.type === "hardBreak" || n.type === "heading") parts.push(" ");
  };
  walk(root);
  const text = parts.join("").replace(/\s+/g, " ").replace(/^\s*\*\s+/, "").trim();
  return { text, link };
}

function issueKey(...urls) {
  for (const u of urls) {
    const m = /\/browse\/([A-Z][A-Z0-9_]*-\d+)/.exec(u ?? "") ?? /[?&]selectedIssue=([A-Z][A-Z0-9_]*-\d+)/.exec(u ?? "");
    if (m) return m[1];
  }
  return "";
}

function item(n, site) {
  if (!n?.notificationId) return null;
  const c = n.content ?? {};
  const actor = c.actor?.displayName || "Someone";
  const raw = c.url || c.entity?.url || "";
  const url = raw.startsWith("/") ? `${site}${raw}` : raw;
  const body = (c.bodyItems ?? []).map((b) => docBody(b?.document)).find((b) => b.text || b.link) ?? { text: "", link: "" };
  return {
    id: n.notificationId,
    category: n.category,
    read: n.readState === "read",
    time: Date.parse(n.timestamp) || Number(n.timestamp) || 0,
    actor,
    avatar: c.actor?.avatarURL ?? null,
    message: c.message || actor,
    url,
    title: c.entity?.title ?? "",
    icon: c.entity?.iconUrl ?? null,
    // A Jira issue's path is its key; a Confluence page's is its space, and a page has no status.
    meta: [c.path?.[0]?.title || issueKey(c.entity?.url, url), c.entity?.status].filter(Boolean).join(" • "),
    page: /\/wiki\//.test(url),
    comment: /[?&]focusedCommentId=/.test(url),
    type: (c.entity?.contentSubtype ?? "").toLowerCase().replace(/[^a-z]/g, ""),
    excerpt: body.text.slice(0, 600),
    link: body.link,
  };
}

function normalize(node, site) {
  const n = item(node?.headNotification, site);
  if (!n) return null;
  n.groupId = node.groupId ?? null;
  n.groupSize = node.groupSize ?? 1;
  n.others = (node.additionalActors ?? []).filter((a) => a?.displayName);
  return n;
}

function ago(ms) {
  const min = Math.floor((Date.now() - ms) / 60e3);
  if (min < 1) return "just now";
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} ${d === 1 ? "day" : "days"} ago`;
  const w = Math.floor(d / 7);
  return `${w} weeks ago`;
}

// Jira's bell has only these three.
function dayLabel(ms) {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === new Date(now.getTime() - 86400e3).toDateString()) return "Yesterday";
  return "Older";
}

// First and last word, as Atlassian's own initials pictures have them ("Automation for Jira" is AJ).
function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 1).concat(words.length > 1 ? words.slice(-1) : []).map((w) => [...w][0]).join("").toUpperCase();
}

function dark(t) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(t.background ?? "");
  if (!m) return true;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

// Cuts text to what `lines` lines of `width` px are likely to hold, ending in "…" as Jira does.
function fit(text, width, lines, size) {
  const max = Math.max(12, Math.floor((width / (size * CHAR_W)) * (lines - WRAP_LOSS)));
  if ([...text].length <= max) return text;
  const cut = [...text].slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.7 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// Off unless the panel's props carry a `jira` block, so nobody else's panel changes.
export function jiraFor(view, cx) {
  const spec = props()?.jira;
  if (!spec) return null;
  if (props()?.demo) return new JiraInbox(view, cx, { demo: true, site: JIRA_DEMO_SITE });
  if (typeof spec !== "object" || !/^https?:\/\//i.test(spec.site ?? "") || !spec.credentials) return null;
  return new JiraInbox(view, cx, { site: spec.site.replace(/\/+$/, ""), credentials: String(spec.credentials) });
}

export class JiraInbox {
  constructor(view, cx, cfg) {
    this.view = view;
    this.cfg = cfg;
    this.tab = "direct";
    this.unreadOnly = true;
    this.unread = { direct: [], watching: [] };
    this.more = { direct: false, watching: false, all: false };
    this.all = null;
    // Marked read while the unread list is up: Jira keeps those in place until the list is left.
    this.kept = new Map();
    // Open groups by id: their older items, or null while they load.
    this.groups = new Map();
    // Icon URL to its cached file, or null when it can't be had.
    this.icons = new Map();
    this.cursor = -1;
    this.error = null;
    this.loaded = false;
    this.seq = 0;
    cx.timer.after(0, (cx) => cx.spawn(async (cx) => this.refresh(cx)));
    cx.timer.every(POLL, (cx) => cx.spawn(async (cx) => this.refresh(cx)));
  }

  // Read for each request rather than kept, so a new token in the file works without a restart.
  async authHeader() {
    const text = await readTextFile(this.cfg.credentials.replace(/^~(?=\/|$)/, home())).catch(() => null);
    if (text == null) throw new Error(`Couldn't read the Jira credentials in ${this.cfg.credentials}`);
    const { email, token } = readIni(text, "jira");
    if (!email || !token) throw new Error(`${this.cfg.credentials} needs email and token under [jira]`);
    return `Basic ${base64(`${email}:${token}`)}`;
  }

  // Looked up once per panel; a failed lookup is retried on the next request.
  async routingAri(cx) {
    if (this.ari) return this.ari;
    const data = await this.post(cx, "JiraTenant", TENANT, { hosts: [new URL(this.cfg.site).host] });
    const t = data?.tenantContexts?.[0], cloud = t?.cloudId, workspace = t?.activationIdByProduct?.active;
    if (!cloud || !workspace) throw new Error(`Jira didn't say which site ${this.cfg.site} is`);
    return (this.ari = `ari:cloud:jira:${cloud}:workspace/${workspace}`);
  }

  async gql(cx, operationName, query, variables) {
    if (this.cfg.demo) return jiraDemo(operationName, variables);
    return this.post(cx, operationName, query, { ...variables, ari: await this.routingAri(cx) });
  }

  async post(cx, operationName, query, variables) {
    const auth = await this.authHeader();
    const res = await Promise.race([
      fetch(`${this.cfg.site}/gateway/api/graphql`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query, operationName, variables }),
      }),
      sleep(cx, TIMEOUT).then(() => { throw new Error("Jira didn't answer in time"); }),
    ]);
    if (res.status === 401 || res.status === 403) throw new Error(`Jira didn't accept the credentials in ${this.cfg.credentials}`);
    if (!res.ok) throw new Error(`Jira answered HTTP ${res.status}`);
    const body = await res.json();
    if (body?.errors?.length && !body.data) throw new Error(`Jira: ${body.errors[0]?.message ?? "request failed"}`);
    return body.data;
  }

  async refresh(cx) {
    const seq = ++this.seq;
    const all = !this.unreadOnly;
    try {
      const after = new Date(Date.now() - DAYS * 86400e3).toISOString();
      const data = await this.gql(cx, "JiraFeed", FEED, { category: this.tab, after, all });
      if (seq !== this.seq) return;
      const feeds = data?.notifications ?? {};
      const list = (feed) => (feed?.nodes ?? []).map((n) => normalize(n, this.cfg.site)).filter(Boolean);
      this.unread = { direct: list(feeds.direct), watching: list(feeds.watching) };
      this.all = all ? list(feeds.all) : null;
      this.more = { direct: Boolean(feeds.direct?.pageInfo?.hasNextPage), watching: Boolean(feeds.watching?.pageInfo?.hasNextPage), all: Boolean(feeds.all?.pageInfo?.hasNextPage) };
      this.error = null;
    } catch (e) {
      if (seq !== this.seq) return;
      this.error = String(e?.message ?? e);
    }
    this.loaded = true;
    this.view.redraw(cx);
    if (await this.fetchIcons(cx, [...this.unread.direct, ...this.unread.watching, ...(this.all ?? [])])) this.view.redraw(cx);
  }

  // Issue type icons live on the Jira site behind the same login as the API, so they come down here, with the
  // header, rather than through the panel's image loader, which sends no credentials. fetch() gives text only,
  // which SVG is; Jira Cloud serves its issue type and page icons as SVG, and anything else gets the drawn mark.
  async fetchIcons(cx, items) {
    if (this.cfg.demo) return false;
    let got = false;
    for (const url of new Set(items.map((n) => n.icon).filter(Boolean))) {
      if (this.icons.has(url)) continue;
      this.icons.set(url, null);
      let origin;
      try { origin = new URL(url).origin; } catch { continue; }
      if (!/^https?:/i.test(url)) continue;
      const rel = `${ICONS}/${hash(url)}.svg`, path = `${appHome()}/${rel}`;
      try {
        if ((await readTextFile(path).catch(() => null)) == null) {
          const headers = origin === new URL(this.cfg.site).origin ? { Authorization: await this.authHeader() } : {};
          const res = await Promise.race([fetch(url, { headers }), sleep(cx, TIMEOUT).then(() => null)]);
          if (!res?.ok) continue;
          const text = await res.text();
          if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) continue;
          await exec("mkdir", ["-p", `${appHome()}/${ICONS}`]);
          await writeTextFile(path, text, null).catch(() => {});
        }
        this.icons.set(url, rel);
        got = true;
      } catch {}
    }
    return got;
  }

  counts() {
    return { direct: this.unread.direct.length, watching: this.unread.watching.length };
  }

  shown() {
    if (!this.unreadOnly) return this.all ?? [];
    const list = [...this.unread[this.tab]];
    const ids = new Set(list.map((n) => n.id));
    for (const n of this.kept.values()) if (n.category === this.tab && !ids.has(n.id)) list.push(n);
    return list.sort((a, b) => b.time - a.time);
  }

  open(cx) {
    this.view.select(JIRA);
    this.kept.clear();
    this.groups.clear();
    this.cursor = -1;
    this.view.redraw(cx);
    cx.spawn(async (cx) => this.refresh(cx));
  }

  setTab(tab, cx) {
    if (tab === this.tab) return;
    this.tab = tab;
    this.reset(cx);
  }

  setUnreadOnly(on, cx) {
    this.unreadOnly = on;
    this.reset(cx);
  }

  reset(cx) {
    this.kept.clear();
    this.groups.clear();
    this.cursor = -1;
    this.all = null;
    this.view.redraw(cx);
    cx.spawn(async (cx) => this.refresh(cx));
  }

  // Shown at once; the refresh after the request brings the server's word. An item inside an open group
  // isn't in the feed's lists, so only its own state changes.
  mark(n, read, cx) {
    if (n.read === read) return;
    n.read = read;
    const unread = this.unread[n.category] ?? [];
    if (!n.sub && read) {
      if (this.unreadOnly) this.kept.set(n.id, n);
      const i = unread.findIndex((x) => x.id === n.id);
      if (i >= 0) unread.splice(i, 1);
    } else if (!n.sub && !unread.some((x) => x.id === n.id)) {
      unread.push(n);
    }
    this.view.redraw(cx);
    const [op, query] = MARK[read ? "read" : "unread"];
    cx.spawn(async (cx) => {
      try {
        await this.gql(cx, op, query, { ids: [n.id] });
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.view.redraw(cx);
        return;
      }
      await this.refresh(cx);
    });
  }

  // The ⋮ menu's Mark all as read, for the open tab as in Jira.
  markAll(category, cx) {
    for (const n of this.unread[category] ?? []) {
      n.read = true;
      if (this.unreadOnly && category === this.tab) this.kept.set(n.id, n);
    }
    for (const n of this.all ?? []) if (n.category === category) n.read = true;
    for (const items of this.groups.values()) for (const n of items ?? []) if (n.category === category) n.read = true;
    this.unread[category] = [];
    this.view.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        await this.gql(cx, "JiraReadAll", READ_ALL, { category });
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.view.redraw(cx);
        return;
      }
      await this.refresh(cx);
    });
  }

  toggleGroup(n, cx) {
    if (this.groups.has(n.groupId)) {
      this.groups.delete(n.groupId);
      this.view.redraw(cx);
      return;
    }
    this.groups.set(n.groupId, null);
    this.view.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        const data = await this.gql(cx, "JiraGroup", GROUP, { groupId: n.groupId });
        if (!this.groups.has(n.groupId)) return;
        const items = (data?.notifications?.notificationGroup?.nodes ?? []).map((x) => item(x, this.cfg.site)).filter((x) => x && x.id !== n.id);
        for (const x of items) x.sub = true;
        this.groups.set(n.groupId, items);
        this.view.redraw(cx);
        if (await this.fetchIcons(cx, items)) this.view.redraw(cx);
      } catch (e) {
        this.groups.delete(n.groupId);
        this.error = String(e?.message ?? e);
        this.view.redraw(cx);
      }
    });
  }

  activate(n, cx, url = n.url) {
    if (url) openLink(url);
    this.mark(n, true, cx);
  }

  // Up, down and Enter, as in Find Channels. Returns whether it used the key.
  onKey(e, cx) {
    if (this.view.selected !== JIRA || this.view.typing) return false;
    const list = this.shown();
    if (!list.length) return false;
    if (e.keystroke === "down" || e.keystroke === "up") {
      const step = e.keystroke === "down" ? 1 : -1;
      this.cursor = this.cursor < 0 ? (step > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, this.cursor + step));
      this.view.redraw(cx);
      return true;
    }
    if (e.keystroke === "enter" && list[this.cursor]) {
      this.activate(list[this.cursor], cx);
      return true;
    }
    return false;
  }

  sidebarRow(t) {
    const v = this.view;
    const active = !v.opening && v.selected === JIRA;
    const { direct, watching } = this.counts();
    const lit = active || direct + watching > 0;
    return div().pb(2).flex_none().child(h_flex().id("jira").relative().h(30).pl(ROW_PAD).pr(8).gap(8).items_center().cursor_pointer()
      .when(active, (el) => el.bg(t.selected).child(v.activeBar(t))).hover((s) => s.bg(active ? t.selected : t.hover))
      .on_click((_e, cx) => this.open(cx))
      .child(v.slot(svg("mods/mattermost/icons/bell.svg").size(14).text_color(lit ? t.foreground : t.muted)))
      .child(div().flex_1().text_color(lit ? t.foreground : t.muted).when(direct + watching > 0, (el) => el.font_semibold()).child("Jira"))
      .when(direct > 0, (el) => el.child(v.badge(direct, t))));
  }

  page(t, wide) {
    const v = this.view;
    const d = dark(t);
    const blue = BLUE[d ? 0 : 1];
    const room = v.width - (wide ? v.sideW : 0) - (v.rhsGlobal?.() && v.rhsBeside?.() ? v.rhsW : 0);
    // The row's text column: the page less its padding, the avatar, the gaps and the dot.
    this.textW = Math.max(160, room - 16 - 32 - 12 - 12 - 24 - 16);
    const tab = (id, label) => {
      const on = this.tab === id;
      return v_flex().id(`jira-tab-${id}`).h_full().justify_end().cursor_pointer()
        .on_click((_e, cx) => this.setTab(id, cx))
        .child(div().pb(6).font_medium().text_color(on ? blue : t.muted).hover((s) => s.text_color(on ? blue : t.foreground)).child(label))
        .child(div().h(2).w_full().rounded(1).when(on, (el) => el.bg(blue)));
    };
    const on = this.unreadOnly;
    const toggle = h_flex().id("jira-unread").flex_none().gap(8).items_center().cursor_pointer().text_size(13).text_color(t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.setUnreadOnly(!on, cx))
      // Below this the title would be squeezed to a letter, so the switch keeps its label in a tooltip.
      .when(room >= 480, (el) => el.child("Only show unread")).when(room < 480, (el) => el.tooltip("Only show unread"))
      .child(h_flex().w(32).h(18).flex_none().rounded(9).px(2).items_center().justify_between()
        .bg(on ? SWITCH[d ? 0 : 1] : alpha(t.foreground, 0.24))
        .child(on ? svg("mods/mattermost/icons/check.svg").size(11).text_color(t.background) : div().size(14).rounded(7).bg("#ffffff"))
        .when(on, (el) => el.child(div().size(14).rounded(7).bg(t.background))));
    const button = (id, icon, tip, onDown) => div().id(id).p(4).flex_none().rounded(6).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); onDown(e, cx); })
      .child(svg(`mods/mattermost/icons/${icon}.svg`).size(16));
    const more = button("jira-more", "dots", "More actions", (e) => v.openMenu({
      kind: "jira", category: this.tab, unread: this.counts()[this.tab] > 0, alignRight: true,
    }, e.bounds ?? { ...e.position, width: 0, height: 0 }));
    const list = this.shown();
    const empty = on ? "You've read all your notifications from the last 30 days." : "You have no notifications from the last 30 days.";
    const header = h_flex().h(52).flex_none().pl(wide ? 16 : 8).pr(12).gap(10).items_center()
      .when(!wide, (el) => el.child(div().id("back").px(6).rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { v.selected = null; localStorage.removeItem("selected"); v.redraw(cx); }).child("‹")))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(20).child("Notifications"))
      .child(toggle)
      .child(button("jira-site", "external-link", "Open Jira", () => openLink(this.cfg.site)))
      .child(more);
    return v_flex().flex_1().min_w(0).h_full()
      .child(header)
      .child(h_flex().h(34).flex_none().mx(16).gap(20).items_end().border_b(1).border_color(t.border)
        .child(tab("direct", "Direct"))
        .child(tab("watching", "Watching")))
      .when(Boolean(this.error), (el) => el.child(div().px(16).py(6).text_size(12).text_color(t.blocked).child(this.error)))
      .child(!this.loaded || (!on && !this.all) || (this.error && !list.length)
        ? div().flex_1()
        : !list.length
          ? v_flex().flex_1().items_center().justify_center().gap(10).px(20)
            .child(svg("mods/mattermost/icons/bell.svg").size(32).text_color(t.dim))
            .child(div().text_size(13).text_color(t.muted).child(empty))
          : v_flex().id(`jira-${this.tab}-${on}`).flex_1().min_h(0).overflow_y_scrollbar().pb(16)
            .children(this.rows(list, t, blue))
            .when(!this.more[on ? this.tab : "all"], (el) => el.child(this.end(t, on)))
            .child(this.hint(t)));
  }

  // As Jira ends the list, with the panel's bell in place of Atlassian's flag.
  end(t, unread) {
    return v_flex().flex_none().items_center().gap(12).pt(28).pb(20).px(24)
      .child(svg("mods/mattermost/icons/bell.svg").size(28).text_color(t.dim))
      .child(h_flex().flex_wrap().justify_center().gap_x(4).text_size(14).text_color(t.foreground)
        .child("That's all your")
        .when(unread, (el) => el.child(div().font_bold().child("unread")))
        .child("notifications from the last 30 days."));
  }

  hint(t) {
    const key = (k) => div().px(5).rounded(3).bg(alpha(t.foreground, 0.1)).text_color(t.foreground).child(k);
    return h_flex().flex_none().mx(16).px(10).py(8).gap(5).items_center().flex_wrap().rounded(4).border_1().border_color(t.border)
      .text_size(13).text_color(t.muted)
      .child("Press").child(key("↓")).child(key("↑")).child("to move through notifications.");
  }

  rows(list, t, blue) {
    const out = [];
    let last = null;
    list.forEach((n, i) => {
      const label = dayLabel(n.time);
      if (label !== last) {
        out.push(div().flex_none().px(16).pt(14).pb(4).text_size(13).font_semibold().text_color(t.foreground).child(label));
        last = label;
      }
      out.push(this.row(n, i, t, blue));
    });
    return out;
  }

  avatar(person, size) {
    const name = person.displayName ?? person.actor ?? "?";
    const url = person.avatarURL !== undefined ? person.avatarURL : person.avatar;
    const path = this.cfg.demo ? (url ? `mods/mattermost/demo/avatars/${url.split("/").pop()}` : null) : this.view.media.external(url);
    if (path) return image(path).size(size).flex_none().rounded_full();
    return div().size(size).flex_none().rounded_full().bg(NAVY).flex().items_center().justify_center()
      .text_size(Math.round(size * 0.4)).font_semibold().text_color("#ffffff").child(initials(name));
  }

  icon(n) {
    const path = !n.icon ? null : this.cfg.demo ? `mods/mattermost/demo/jira/${n.icon.split("/").pop()}` : this.icons.get(n.icon);
    if (path) return image(path).size(16).flex_none();
    if (n.page) return svg("mods/mattermost/icons/file-doc.svg").size(16).flex_none().text_color("#1d7afc");
    const [bg, mark] = TYPES[n.type] ?? TYPES.task;
    return div().size(14).m(1).flex_none().rounded(3).bg(bg).flex().items_center().justify_center()
      .child(mark ? svg(`mods/mattermost/icons/${mark}.svg`).size(10).text_color("#ffffff") : div().size(6).rounded(3).bg("#ffffff"));
  }

  dotButton(n, t, blue) {
    const unread = !n.read;
    return div().id(`jn-dot-${n.id}`).size(24).flex().items_center().justify_center().rounded(4).cursor_pointer()
      .tooltip(unread ? "Mark as read" : "Mark as unread")
      .hover((s) => s.bg(alpha(t.foreground, 0.08)))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.mark(n, unread, cx); })
      .child(unread ? div().size(8).rounded(4).bg(blue) : div().size(8).rounded(4).border_1().border_color(t.muted));
  }

  // The dot is the toggle, as in Jira: a press on it changes the read state without opening anything. A read
  // row offers it only on hover, through a layer the row's own hover can't do for a child.
  dot(el, n, t, blue, top, right) {
    return el.child(div().w(24).h(24).flex_none().when(!n.read, (el) => el.child(this.dotButton(n, t, blue))))
      .when(n.read, (el) => el.child(div().absolute().inset_0().opacity(0).hover((s) => s.opacity(1))
        .child(div().absolute().top(top).right(right).child(this.dotButton(n, t, blue)))));
  }

  // A link inside a row: it acts alone, without the row's own click.
  link(id, el, run) {
    return el.id(id).cursor_pointer().on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); run(cx); });
  }

  row(n, i, t, blue) {
    const picked = i === this.cursor;
    const w = this.textW;
    const card = Boolean(n.excerpt || n.link);
    const extra = n.groupSize - 1;
    const open = this.groups.has(n.groupId);
    const items = this.groups.get(n.groupId);
    const others = n.others ?? [];
    const content = v_flex().flex_1().min_w(0)
      .child(h_flex().flex_wrap().gap_x(6).items_baseline()
        .child(div().min_w(0).max_w_full().font_semibold().text_color(t.foreground).child(n.message))
        .child(div().flex_none().text_size(13).text_color(t.muted).child(ago(n.time))))
      .when(Boolean(n.title), (el) => el.child(h_flex().mt(2).gap(6).items_start()
        .child(div().mt(2).child(this.icon(n)))
        .child(div().flex_1().min_w(0).max_h(2 * TITLE_LINE).overflow_hidden().line_height(`${TITLE_LINE}px`).text_color(t.foreground)
          .child(fit(n.title, w - 22, 2, 14)))))
      .when(Boolean(n.meta), (el) => el.child(div().mt(2).text_size(12).text_color(t.muted).truncate().child(n.meta)))
      .when(card, (el) => el.child(v_flex().mt(8).px(10).py(8).gap(4).rounded(4).border_1().border_color(t.border).text_size(13)
        .when(Boolean(n.excerpt), (el) => el.child(div().max_h(2 * BODY_LINE).overflow_hidden().line_height(`${BODY_LINE}px`).text_color(t.foreground)
          .child(fit(n.excerpt, w - 22, 2, 13))))
        .when(Boolean(n.link), (el) => el.child(this.link(`jn-link-${n.id}`, h_flex().gap(6).items_center().text_color(t.muted).hover((s) => s.text_color(t.foreground)),
          () => openLink(n.link))
          .child(svg("mods/mattermost/icons/link.svg").size(14).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(n.link))))))
      .when(n.comment, (el) => el.child(h_flex().mt(6).justify_end()
        .child(this.link(`jn-thread-${n.id}`, div().text_size(13).font_semibold().text_color(blue).hover((s) => s.opacity(0.8)), (cx) => this.activate(n, cx))
          .child("View thread"))))
      .when(extra > 0 && Boolean(n.groupId), (el) => el.child(this.link(`jn-group-${n.id}`, h_flex().mt(10).gap(8).items_center().text_color(blue).hover((s) => s.opacity(0.8)),
        (cx) => this.toggleGroup(n, cx))
        .when(others.length > 0, (el) => el.child(h_flex().flex_none().children(others.slice(0, 3).map((a, k) =>
          div().when(k > 0, (el) => el.ml(-6)).rounded_full().border_2().border_color(t.background).child(this.avatar(a, 20))))))
        .child(div().flex_1().min_w(0).truncate()
          .child(`+${extra} ${extra === 1 ? "update" : "updates"}${others[0] ? ` from ${others[0].displayName}${others.length > 1 ? " and others" : ""}` : ""}`))))
      .when(open, (el) => el.child(v_flex().mt(6).gap(2)
        .when(items === null, (el) => el.child(div().py(4).text_size(12).text_color(t.muted).child("Loading…")))
        .children((items ?? []).map((x) => this.subRow(x, t, blue)))));
    return this.dot(h_flex().id(`jn-${n.id}`).relative().px(16).py(10).gap(12).items_start().cursor_pointer()
      .when(picked, (el) => el.bg(t.selected)).hover((s) => s.bg(picked ? t.selected : t.hover))
      .on_click((_e, cx) => { this.cursor = i; this.activate(n, cx); })
      .child(this.avatar(n, 32))
      .child(content), n, t, blue, 10, 16);
  }

  subRow(n, t, blue) {
    return this.dot(this.link(`jn-sub-${n.id}`, h_flex().relative().py(4).gap(8).items_center().rounded(4).hover((s) => s.bg(t.hover)), (cx) => this.activate(n, cx))
      .child(this.avatar(n, 20))
      .child(h_flex().flex_1().min_w(0).gap(6).items_baseline().text_size(13)
        .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(n.message))
        .child(div().flex_none().text_size(12).text_color(t.muted).child(ago(n.time)))), n, t, blue, 2, 0);
  }
}
