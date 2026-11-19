import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, appHome, props, exec, readTextFile, writeTextFile, notify } from "herdr";
import { alpha, openLink, sleep } from "../main.js";
import { hash } from "./media.js";
import { jiraDemo, JIRA_DEMO_SITE } from "../demo/jira.js";
import { listRow, strip, empty, header, headerNote, button, iconButton, shortTime, scrollList, nothingPicked } from "./layout.js";

export const JIRA = "jira";
const PAGE = 50;
// A connection can hang before TLS finishes while the next one goes straight through, so a quick retry beats a long
// wait. Slow handshakes that do succeed take about 6 s.
const TIMEOUT = 8e3;
const ATTEMPTS = 3;
const POLL = 60e3;
// One poll lost to the network isn't worth a red line that the next poll takes away.
const MISSES = 2;
// Jira's bell keeps a month of notifications, and its empty state says so.
const DAYS = 30;
const ICONS = "data/mattermost/jira";
// Jira's own colours, dark and light, so the page reads as Jira's bell does.
const BLUE = ["#579dff", "#0c66e4"];
const SWITCH = ["#94c748", "#6a9a23"];
// Atlassian's colour for an avatar without a picture.
const NAVY = "#172b4d";

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

// How long a card on screen keeps its status before asking Jira again.
const ISSUE_STALE = 10 * 60e3;
// Jira's lozenge colours by status category, dark and light: [background, text].
const LOZENGE = {
  new: [["#a1bdd914", "#9fadbc"], ["#091e420f", "#44546f"]],
  indeterminate: [["#09326c", "#85b8ff"], ["#e9f2ff", "#0055cc"]],
  done: [["#164b35", "#7ee2b8"], ["#dcfff1", "#216e4e"]],
};
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
    key: c.path?.[0]?.title || issueKey(c.entity?.url, url),
    status: c.entity?.status ?? "",
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

// The list's own short form: minutes and hours, then the date as the other lists give it.
function shortAgo(ms) {
  const min = Math.floor((Date.now() - ms) / 60e3);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h`;
  return shortTime(ms);
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

// Off unless the panel's props carry a `jira` block, so nobody else's panel changes.
export function jiraFor(view, cx) {
  const spec = props()?.jira;
  if (!spec) return null;
  if (props()?.demo) return new JiraInbox(view, cx, { demo: true, site: JIRA_DEMO_SITE });
  if (typeof spec !== "object" || !/^https?:\/\//i.test(spec.site ?? "") || !spec.credentials) return null;
  return new JiraInbox(view, cx, { site: spec.site.replace(/\/+$/, ""), credentials: String(spec.credentials) });
}

class NoAnswer extends Error {}

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
    // The notification in the reader. Picking a tab leaves it there, so it's kept as an item, not a place in a list.
    this.picked = null;
    this.error = null;
    this.loaded = false;
    this.misses = 0;
    this.seq = 0;
    // Direct ids already seen, so only new ones notify; null until the first load.
    this.seen = null;
    // Issues linked in messages, by key: their card, null while it loads, false when it can't be had.
    this.issues = new Map();
    this.wantedIssues = new Set();
    // Cards are asked for while drawing, where nothing can be fetched, so the fetch comes on the next tick.
    cx.timer.every(250, (cx) => { if (this.wantedIssues.size && !this.fetchingIssues) cx.spawn(async (cx) => this.fetchIssues(cx)); });
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
    const request = JSON.stringify({ query, operationName, variables });
    let res, failure;
    for (let i = 0; i < ATTEMPTS && !res; i++) res = await this.ask(cx, auth, request).catch((e) => { failure = e; });
    if (!res) throw new NoAnswer(String(failure?.message ?? failure));
    if (res.status === 401 || res.status === 403) throw new Error(`Jira didn't accept the credentials in ${this.cfg.credentials}`);
    if (!res.ok) throw new Error(`Jira answered HTTP ${res.status}`);
    const body = res.body;
    if (body?.errors?.length && !body.data) throw new Error(`Jira: ${body.errors[0]?.message ?? "request failed"}`);
    return body.data;
  }

  // The body is read inside the time limit, since a connection can stall there as well.
  ask(cx, auth, body) {
    const answer = fetch(`${this.cfg.site}/gateway/api/graphql`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
      body,
    }).then(async (res) => ({ status: res.status, ok: res.ok, body: res.ok ? await res.json() : null }));
    return Promise.race([answer, sleep(cx, TIMEOUT).then(() => { throw new Error("Jira didn't answer in time"); })]);
  }

  async refresh(cx) {
    const seq = ++this.seq;
    const all = !this.unreadOnly;
    let answered = false;
    try {
      const after = new Date(Date.now() - DAYS * 86400e3).toISOString();
      const data = await this.gql(cx, "JiraFeed", FEED, { category: this.tab, after, all });
      if (seq !== this.seq) return;
      const feeds = data?.notifications ?? {};
      const list = (feed) => (feed?.nodes ?? []).map((n) => normalize(n, this.cfg.site)).filter(Boolean);
      this.unread = { direct: list(feeds.direct), watching: list(feeds.watching) };
      this.all = all ? list(feeds.all) : null;
      // The real gateway says hasNextPage for a filtered feed whose page wasn't even full (seen 2026-11-09 with one
      // unread notification), so a short page counts as the end.
      const more = (f) => Boolean(f?.pageInfo?.hasNextPage) && (f?.nodes?.length ?? 0) >= PAGE;
      this.more = { direct: more(feeds.direct), watching: more(feeds.watching), all: more(feeds.all) };
      this.error = null;
      this.misses = 0;
      answered = true;
    } catch (e) {
      if (seq !== this.seq) return;
      const showing = this.loaded && (!all || this.all);
      const excused = e instanceof NoAnswer && showing && ++this.misses < MISSES;
      if (!excused) this.error = String(e?.message ?? e);
    }
    this.loaded = true;
    const fresh = this.find(this.picked?.id);
    if (fresh) this.picked = fresh;
    // A failed load says nothing about whether the item is gone.
    else if (!this.picked || answered) this.picked = this.shown()[0] ?? null;
    this.view.redraw(cx);
    if (await this.fetchIcons(cx, [...this.unread.direct, ...this.unread.watching, ...(this.all ?? [])])) this.view.redraw(cx);
    if (!this.error && seq === this.seq) this.announce(this.unread.direct);
  }

  // New Direct notifications go to the desktop, as Jira's own push does; Watching stays in the bell. The first load
  // only learns what's there. Past three at once, one summary instead of a flood.
  announce(list) {
    const fresh = this.seen ? list.filter((n) => !this.seen.has(n.id)) : [];
    this.seen = new Set([...(this.seen ?? []), ...list.map((n) => n.id)]);
    if (!fresh.length || this.cfg.demo || !this.view.lead()) return;
    const shown = fresh.length > 3 ? fresh.slice(0, 2) : fresh;
    for (const n of shown) {
      notify({
        title: n.message,
        body: [[n.meta, n.title].filter(Boolean).join(" · "), n.excerpt.slice(0, 200)].filter(Boolean).join("\n"),
        icon: this.icons.get(n.icon) || undefined,
        // Opens the browser, so Herdr must not come up over it.
        action: { name: `mattermost.jira-open ${n.id}${n.url ? ` ${n.url}` : ""}`, args: { raise: false } },
      });
    }
    if (shown.length < fresh.length) {
      notify({ title: `${fresh.length - shown.length} more Jira notifications`, action: { name: `mattermost.jira-open - ${this.cfg.site}/jira/your-work`, args: { raise: false } } });
    }
  }

  // A click on a desktop notification: open it as a row click would, or just its link once it's left the list.
  openFromNotification(id, url, cx) {
    const n = this.find(id);
    if (n) {
      this.picked = n;
      this.activate(n, cx);
    } else if (url) openLink(url);
  }

  find(id) {
    if (!id) return null;
    const groups = [...this.groups.values()].flatMap((items) => items ?? []);
    return [...this.unread.direct, ...this.unread.watching, ...(this.all ?? []), ...this.kept.values(), ...groups].find((x) => x.id === id) ?? null;
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

  keyOf(url) {
    if (!url.toLowerCase().startsWith(`${this.cfg.site.toLowerCase()}/browse/`)) return null;
    return /^\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:[/?#]|$)/.exec(url.slice(this.cfg.site.length))?.[1] ?? null;
  }

  async fetchIssues(cx) {
    this.fetchingIssues = true;
    const keys = [...this.wantedIssues].slice(0, 8);
    for (const key of keys) this.wantedIssues.delete(key);
    try {
      const auth = this.cfg.demo ? null : await this.authHeader().catch(() => null);
      await Promise.all(keys.map(async (key) => {
        const old = this.issues.get(key);
        try {
          if (!auth) throw new Error("no login");
          const res = await Promise.race([
            fetch(`${this.cfg.site}/rest/api/3/issue/${key}?fields=summary,status,issuetype`, { headers: { Authorization: auth, Accept: "application/json" } }),
            sleep(cx, TIMEOUT).then(() => null),
          ]);
          if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
          const f = (await res.json())?.fields ?? {};
          this.issues.set(key, {
            at: Date.now(),
            summary: f.summary ?? "",
            status: f.status?.name ?? "",
            category: f.status?.statusCategory?.key ?? "",
            icon: f.issuetype?.iconUrl ?? null,
            type: (f.issuetype?.name ?? "").toLowerCase().replace(/[^a-z]/g, ""),
          });
        } catch {
          // A stale card beats a bare link when only the refresh failed.
          this.issues.set(key, old ? { ...old, at: Date.now() } : false);
        }
      }));
      await this.fetchIcons(cx, keys.map((k) => this.issues.get(k)).filter(Boolean));
    } finally {
      this.fetchingIssues = false;
    }
    this.view.redraw(cx);
  }

  // Jira's inline smart link: the type icon, "KEY: summary" as a link, and the status lozenge. Null when the
  // issue can't be had, so the caller draws the plain link.
  issueCard(id, key, t, open) {
    const hit = this.issues.get(key);
    if (hit === false) return null;
    if (hit === undefined) this.issues.set(key, null);
    if (!hit || Date.now() - hit.at > ISSUE_STALE) this.wantedIssues.add(key);
    const title = hit ? `${key}: ${hit.summary}` : key;
    const [bg, fg] = (LOZENGE[hit?.category] ?? LOZENGE.new)[dark(t) ? 0 : 1];
    return h_flex().id(id).max_w_full().h(22).px(4).gap(4).items_center().rounded(4).border_1().border_color(alpha(t.foreground, 0.16))
      .cursor_pointer().hover((s) => s.bg(alpha(t.foreground, 0.06)))
      .tooltip(title)
      .on_click((_e, cx) => open(cx))
      .child(hit ? this.icon({ icon: hit.icon, type: hit.type }) : div().size(14).m(1).flex_none().rounded(3).bg(alpha(t.foreground, 0.12)))
      .child(div().min_w(0).truncate().text_color(t.accent).child(title))
      .when(Boolean(hit?.status), (el) => el.child(div().flex_none().px(4).rounded(3).bg(bg).text_color(fg).text_size(12).font_semibold().line_height("16px").child(hit.status)));
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
    this.kept.clear();
    this.groups.clear();
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

  // Up and down move through the list and show each in the reader; Enter opens it in the browser.
  onKey(e, cx) {
    if (this.view.section !== JIRA || this.view.typing) return false;
    const list = this.shown();
    if (!list.length) return false;
    if (e.keystroke === "down" || e.keystroke === "up") {
      const step = e.keystroke === "down" ? 1 : -1;
      const at = list.findIndex((n) => n.id === this.picked?.id);
      this.picked = list[at < 0 ? (step > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, at + step))];
      this.view.redraw(cx);
      return true;
    }
    if (e.keystroke === "enter" && this.picked) {
      this.activate(this.picked, cx);
      return true;
    }
    return false;
  }

  pick(n, cx) {
    this.picked = n;
    this.view.redraw(cx);
  }

  // Direct and Watching on the folder strip, with Only show unread, the site and Mark all as read at its end.
  list(t) {
    const v = this.view;
    const d = dark(t);
    const on = this.unreadOnly;
    const counts = this.counts();
    const toggle = h_flex().id("jira-unread").h(26).px(4).flex_none().items_center().rounded(5).cursor_pointer().tooltip("Only show unread")
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.setUnreadOnly(!on, cx); })
      .child(h_flex().w(32).h(18).flex_none().rounded(9).px(2).items_center().justify_between()
        .bg(on ? SWITCH[d ? 0 : 1] : alpha(t.foreground, 0.24))
        .child(on ? svg("mods/mattermost/icons/check.svg").size(11).text_color(t.background) : div().size(14).rounded(7).bg("#ffffff"))
        .when(on, (el) => el.child(div().size(14).rounded(7).bg(t.background))));
    const right = [
      toggle,
      iconButton("jira-site", t, "external-link", "Open Jira", () => openLink(this.cfg.site)),
      iconButton("jira-more", t, "dots", "More actions", (e) => v.openMenu({
        kind: "jira", category: this.tab, unread: counts[this.tab] > 0, alignRight: true,
      }, e.bounds ?? { ...e.position, width: 0, height: 0 })),
    ];
    const list = this.shown();
    const blank = on ? "You've read all your notifications from the last 30 days." : "You have no notifications from the last 30 days.";
    return v_flex().flex_1().min_h(0)
      .child(strip(v, t, { id: "jira", current: this.tab, right,
        tabs: [{ key: "direct", label: "Direct", count: counts.direct }, { key: "watching", label: "Watching", count: counts.watching }],
        onPick: (key, cx) => this.setTab(key, cx) }))
      .when(Boolean(this.error), (el) => el.child(div().px(12).py(6).text_size(12).text_color(t.blocked).child(this.error)))
      .child(!this.loaded || (!on && !this.all) || (this.error && !list.length)
        ? div().flex_1()
        : !list.length
          ? empty(t, "bell", blank)
          : scrollList(`jira-${this.tab}-${on}`, [
            ...list.map((n) => this.row(n, t)),
            ...(this.more[on ? this.tab : "all"] ? [] : [this.end(t, on)]),
            this.hint(t),
          ]));
  }

  row(n, t) {
    const picked = n.id === this.picked?.id;
    const toggle = div().id(`jn-dot-${n.id}`).absolute().right(6).bottom(8).size(20).flex().items_center().justify_center().rounded(4).cursor_pointer()
      .tooltip(n.read ? "Mark as unread" : "Mark as read")
      .when(n.read, (el) => el.opacity(0).hover((s) => s.opacity(1).bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.mark(n, !n.read, cx); })
      .when(n.read, (el) => el.child(div().size(8).rounded(4).border_1().border_color(t.muted)));
    return listRow({
      id: `jn-${n.id}`, icon: this.avatar(n, 36), title: n.message, time: shortAgo(n.time),
      preview: [n.key, n.title].filter(Boolean).join(" • "), unread: !n.read, dot: !n.read, selected: picked,
      onClick: (_e, cx) => this.pick(n, cx), extra: [toggle],
    }, t);
  }

  // The notification as the feed gives it: Jira's API for the bell has no assignee, priority or other fields.
  reader(t) {
    const n = this.picked;
    if (!n) return this.loaded ? nothingPicked(t) : div();
    const d = dark(t);
    const blue = BLUE[d ? 0 : 1];
    const extra = n.groupSize - 1;
    const open = this.groups.has(n.groupId);
    const items = this.groups.get(n.groupId);
    const others = n.others ?? [];
    const tag = (text, color) => div().flex_none().px(6).rounded(4).bg(alpha(t.foreground, 0.08)).text_size(11).line_height("17px").text_color(color ?? t.muted).child(text);
    const site = n.page ? "Confluence" : "Jira";
    return v_flex().flex_1().min_w(0).h_full()
      .child(header(t, this.icon(n), div().min_w(0).truncate().child(n.key || site), ...(n.status ? [headerNote(t, n.status)] : []), div().flex_1(),
        iconButton("jr-open-top", t, "external-link", `Open in ${site}`, (_e, cx) => this.activate(n, cx))))
      .child(v_flex().id(`jr-${n.id}`).flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().w_full().max_w(760).mx_auto().px(18).py(16).gap(12)
          .when(Boolean(n.title), (el) => el.child(div().text_size(18).line_height("24px").font_semibold().text_color(t.foreground).child(n.title)))
          .child(h_flex().flex_wrap().gap(4).items_center().text_size(12).text_color(t.muted)
            .when(Boolean(n.key), (el) => el.child(tag(n.key, blue)))
            .when(Boolean(n.status), (el) => el.child(tag(n.status)))
            .child(div().pl(2).child(ago(n.time))))
          .child(h_flex().gap(10).items_center()
            .child(this.avatar(n, 28))
            .child(div().flex_1().min_w(0).text_size(14).text_color(t.foreground).child(n.message)))
          .when(Boolean(n.excerpt || n.link), (el) => el.child(v_flex().px(12).py(10).gap(6).rounded(8).border_1().border_color(t.border).bg(alpha(t.foreground, 0.08)).text_size(14)
            .when(Boolean(n.excerpt), (el) => el.child(div().text_color(t.foreground).child(n.excerpt)))
            .when(Boolean(n.link), (el) => el.child(this.link(`jn-link-${n.id}`, h_flex().gap(6).items_center().text_size(13).text_color(t.muted).hover((s) => s.text_color(t.foreground)),
              () => openLink(n.link))
              .child(svg("mods/mattermost/icons/link.svg").size(14).flex_none())
              .child(div().flex_1().min_w(0).truncate().child(n.link))))))
          .when(extra > 0 && Boolean(n.groupId), (el) => el.child(this.link(`jn-group-${n.id}`, h_flex().gap(8).items_center().text_size(13).text_color(blue).hover((s) => s.opacity(0.8)),
            (cx) => this.toggleGroup(n, cx))
            .when(others.length > 0, (el) => el.child(h_flex().flex_none().children(others.slice(0, 3).map((a, k) =>
              div().when(k > 0, (el) => el.ml(-6)).rounded_full().border_2().border_color(t.background).child(this.avatar(a, 20))))))
            .child(div().flex_1().min_w(0).truncate()
              .child(`${open ? "Hide" : "+"}${open ? " " : ""}${extra} ${extra === 1 ? "update" : "updates"}${others[0] ? ` from ${others[0].displayName}${others.length > 1 ? " and others" : ""}` : ""}`))))
          .when(open, (el) => el.child(v_flex().gap(2)
            .when(items === null, (el) => el.child(div().py(4).text_size(12).text_color(t.muted).child("Loading…")))
            .children((items ?? []).map((x) => this.subRow(x, t, blue)))))
          .child(h_flex().flex_wrap().gap(6).pt(4)
            .child(button("jr-open", t, `Open in ${site}`, (_e, cx) => this.activate(n, cx), { primary: true, iconName: "external-link" }))
            .child(button("jr-read", t, n.read ? "Mark as unread" : "Mark as read", (_e, cx) => this.mark(n, !n.read, cx), { iconName: "check" })))));
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
    return h_flex().flex_none().mx(12).px(10).py(8).gap(5).items_center().flex_wrap().rounded(4).border_1().border_color(t.border)
      .text_size(13).text_color(t.muted)
      .child("Press").child(key("↓")).child(key("↑")).child("to move through notifications.");
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

  // A link inside a row: it acts alone, without the row's own click.
  link(id, el, run) {
    return el.id(id).cursor_pointer().on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); run(cx); });
  }

  // A group's older item: a click opens it, and its dot marks it read or unread without opening anything.
  subRow(n, t, blue) {
    return this.link(`jn-sub-${n.id}`, h_flex().relative().px(6).py(4).gap(8).items_center().rounded(4).hover((s) => s.bg(t.hover)), (cx) => this.activate(n, cx))
      .child(this.avatar(n, 20))
      .child(h_flex().flex_1().min_w(0).gap(6).items_baseline().text_size(13)
        .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(n.message))
        .child(div().flex_none().text_size(12).text_color(t.muted).child(ago(n.time))))
      .child(div().id(`jn-dot-${n.id}`).size(24).flex().flex_none().items_center().justify_center().rounded(4).cursor_pointer()
        .tooltip(n.read ? "Mark as unread" : "Mark as read").hover((s) => s.bg(alpha(t.foreground, 0.08)))
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.mark(n, !n.read, cx); })
        .child(n.read ? div().size(8).rounded(4).border_1().border_color(t.muted) : div().size(8).rounded(4).bg(blue)));
  }
}
