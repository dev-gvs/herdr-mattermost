import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, props, readTextFile } from "herdr";
import { alpha, openLink, sleep, FULL_MONTHS } from "../main.js";
import { jiraDemo, JIRA_DEMO_SITE } from "../demo/jira.js";

export const JIRA = "jira";
const ROW_PAD = 9;
const PAGE = 50;
const TIMEOUT = 15e3;
const POLL = 60e3;
// Jira's bell keeps a month of notifications, and its empty state says so.
const DAYS = 30;

// The gateway warns about unnamed operations. Every field here was checked against a real site, but a node
// with content was never seen there, so the code treats every part of one as optional.
const FEED = `query JiraFeed($category: InfluentsNotificationCategory, $after: DateTime, $all: Boolean!) {
  notifications {
    direct: notificationFeed(first: ${PAGE}, filter: { categoryFilter: direct, readStateFilter: unread, afterTimestamp: $after }) { ...JiraNodes }
    watching: notificationFeed(first: ${PAGE}, filter: { categoryFilter: watching, readStateFilter: unread, afterTimestamp: $after }) { ...JiraNodes }
    all: notificationFeed(first: ${PAGE}, filter: { categoryFilter: $category, afterTimestamp: $after }) @include(if: $all) { ...JiraNodes }
  }
}
fragment JiraNodes on InfluentsNotificationFeedConnection {
  nodes { headNotification { notificationId readState timestamp category content { type message url actor { displayName avatarURL } entity { title url contentSubtype } bodyItems { type document { format data } } } } }
}`;
const MARK = {
  read: ["JiraRead", "mutation JiraRead($ids: [String!]!) { notifications { markNotificationsByIdsAsRead(ids: $ids) } }"],
  unread: ["JiraUnread", "mutation JiraUnread($ids: [String!]!) { notifications { markNotificationsByIdsAsUnread(ids: $ids) } }"],
};

// Jira's own issue type colours, so the marks read as they do in Jira.
const TYPES = {
  bug: ["#e5493a", null],
  story: ["#63ba3c", "bookmark"],
  epic: ["#904ee2", "zap"],
  subtask: ["#4bade8", "check"],
  task: ["#4bade8", "check"],
};
const AVATAR_COLORS = ["#0052cc", "#00875a", "#de350b", "#5243aa", "#ff8b00", "#00a3bf", "#c9372c", "#6554c0"];

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

// Comments arrive as Atlassian documents; the excerpt is their text on one line.
function docText(doc) {
  if (!doc?.data) return "";
  if (doc.format && !/adf|json/i.test(doc.format)) return String(doc.data);
  let root;
  try { root = JSON.parse(doc.data); } catch { return String(doc.data); }
  const parts = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.text === "string") parts.push(n.text);
    else if (n.attrs?.text) parts.push(n.attrs.text);
    else if (n.attrs?.shortName) parts.push(n.attrs.shortName);
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
    if (n.type === "paragraph" || n.type === "hardBreak") parts.push(" ");
  };
  walk(root);
  return parts.join("").replace(/\s+/g, " ").trim();
}

function issueKey(...urls) {
  for (const u of urls) {
    const m = /\/browse\/([A-Z][A-Z0-9_]*-\d+)/.exec(u ?? "") ?? /[?&]selectedIssue=([A-Z][A-Z0-9_]*-\d+)/.exec(u ?? "");
    if (m) return m[1];
  }
  return "";
}

function normalize(item) {
  const n = item?.headNotification;
  if (!n?.notificationId) return null;
  const c = n.content ?? {};
  const actor = c.actor?.displayName || "Someone";
  let message = c.message ?? "";
  if (message.startsWith(actor)) message = message.slice(actor.length).trim();
  return {
    id: n.notificationId,
    category: n.category,
    read: n.readState === "read",
    time: Date.parse(n.timestamp) || Number(n.timestamp) || 0,
    actor,
    avatar: c.actor?.avatarURL ?? null,
    message,
    url: c.url || c.entity?.url || "",
    title: c.entity?.title ?? "",
    key: issueKey(c.entity?.url, c.url),
    type: (c.entity?.contentSubtype ?? "").toLowerCase().replace(/[^a-z]/g, ""),
    excerpt: (c.bodyItems ?? []).map((b) => docText(b?.document)).find(Boolean)?.slice(0, 280) ?? "",
  };
}

function ago(ms) {
  const min = Math.floor((Date.now() - ms) / 60e3);
  if (min < 1) return "just now";
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

function dayLabel(ms) {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return "TODAY";
  if (d.toDateString() === new Date(now.getTime() - 86400e3).toDateString()) return "YESTERDAY";
  return `${FULL_MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === now.getFullYear() ? "" : `, ${d.getFullYear()}`}`.toUpperCase();
}

const initials = (name) => name.split(/\s+/).map((w) => [...w][0] ?? "").join("").slice(0, 2).toUpperCase();

function colorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
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
    this.all = null;
    // Marked read while the unread list is up: Jira keeps those in place until the list is left.
    this.kept = new Map();
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

  async gql(cx, operationName, query, variables) {
    if (this.cfg.demo) return jiraDemo(operationName, variables);
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
      const list = (feed) => (feed?.nodes ?? []).map(normalize).filter(Boolean);
      this.unread = { direct: list(data?.notifications?.direct), watching: list(data?.notifications?.watching) };
      this.all = all ? list(data?.notifications?.all) : null;
      this.error = null;
    } catch (e) {
      if (seq !== this.seq) return;
      this.error = String(e?.message ?? e);
    }
    this.loaded = true;
    this.view.redraw(cx);
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
    this.cursor = -1;
    this.all = null;
    this.view.redraw(cx);
    cx.spawn(async (cx) => this.refresh(cx));
  }

  // Shown at once; the refresh after the request brings the server's word.
  mark(n, read, cx) {
    if (n.read === read) return;
    n.read = read;
    const unread = this.unread[n.category] ?? [];
    if (read) {
      if (this.unreadOnly) this.kept.set(n.id, n);
      const i = unread.findIndex((x) => x.id === n.id);
      if (i >= 0) unread.splice(i, 1);
    } else if (!unread.some((x) => x.id === n.id)) {
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

  activate(n, cx) {
    const url = n.url.startsWith("/") ? `${this.cfg.site}${n.url}` : n.url;
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
    const counts = this.counts();
    const tab = (id, label) => {
      const on = this.tab === id;
      return h_flex().id(`jira-tab-${id}`).h(28).px(10).gap(6).items_center().rounded(6).cursor_pointer().font_semibold()
        .text_color(on ? t.accent : t.muted).when(on, (el) => el.bg(t.selected)).hover((s) => s.text_color(on ? t.accent : t.foreground))
        .on_click((_e, cx) => this.setTab(id, cx))
        .child(label)
        .when(counts[id] > 0, (el) => el.child(div().size(6).rounded(3).bg(t.accent)));
    };
    const on = this.unreadOnly;
    const toggle = h_flex().id("jira-unread").flex_none().gap(8).items_center().cursor_pointer().text_size(12).text_color(t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => this.setUnreadOnly(!on, cx))
      .child("Only show unread")
      .child(div().w(28).h(16).flex_none().rounded(8).p(2).flex().items_center().bg(on ? t.accent : alpha(t.foreground, 0.24))
        .when(on, (el) => el.justify_end())
        .child(div().size(12).rounded(6).bg("#ffffff")));
    const jump = div().id("jira-site").p(4).flex_none().rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Open Jira").on_click(() => openLink(this.cfg.site))
      .child(svg("mods/mattermost/icons/external-link.svg").size(16));
    const list = this.shown();
    const empty = on ? "You've read all your notifications from the last 30 days." : "You have no notifications from the last 30 days.";
    return v_flex().flex_1().min_w(0).h_full()
      .child(v.topBar(t, wide, !wide && (() => { v.selected = null; localStorage.removeItem("selected"); }),
        div().flex_1().min_w(0).truncate().font_semibold().text_size(15).child("Notifications"),
        toggle, jump))
      .child(h_flex().h(40).flex_none().px(12).gap(4).items_center().border_b(1).border_color(t.border)
        .child(tab("direct", "Direct"))
        .child(tab("watching", "Watching")))
      .when(Boolean(this.error), (el) => el.child(div().px(14).py(6).text_size(12).text_color(t.blocked).child(this.error)))
      .child(!this.loaded || (!on && !this.all) || (this.error && !list.length)
        ? div().flex_1()
        : !list.length
          ? v_flex().flex_1().items_center().justify_center().gap(10).px(20)
            .child(svg("mods/mattermost/icons/bell.svg").size(32).text_color(t.dim))
            .child(div().text_size(13).text_color(t.muted).child(empty))
          : v_flex().id(`jira-${this.tab}-${on}`).flex_1().min_h(0).overflow_y_scrollbar().pb(6)
            .children(this.rows(list, t)));
  }

  rows(list, t) {
    const out = [];
    let last = null;
    list.forEach((n, i) => {
      const label = dayLabel(n.time);
      if (label !== last) {
        out.push(div().h(30).flex_none().px(14).pt(12).text_size(11).font_semibold().text_color(t.dim).child(label));
        last = label;
      }
      out.push(this.row(n, i, t));
    });
    return out;
  }

  avatar(n, size) {
    const path = this.view.media.external(n.avatar);
    if (path) return image(path).size(size).flex_none().rounded_full();
    return div().size(size).flex_none().rounded_full().bg(colorFor(n.actor)).flex().items_center().justify_center()
      .text_size(Math.round(size * 0.4)).font_semibold().text_color("#ffffff").child(initials(n.actor));
  }

  typeMark(type) {
    const [bg, icon] = TYPES[type] ?? TYPES.task;
    return div().size(14).flex_none().rounded(3).bg(bg).flex().items_center().justify_center()
      .child(icon ? svg(`mods/mattermost/icons/${icon}.svg`).size(10).text_color("#ffffff") : div().size(6).rounded(3).bg("#ffffff"));
  }

  dotButton(n, t) {
    const unread = !n.read;
    return div().id(`jn-dot-${n.id}`).size(24).flex().items_center().justify_center().rounded(4).cursor_pointer()
      .tooltip(unread ? "Mark as read" : "Mark as unread")
      .hover((s) => s.bg(alpha(t.foreground, 0.08)))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.mark(n, unread, cx); })
      .child(unread ? div().size(8).rounded(4).bg(t.accent) : div().size(8).rounded(4).border_1().border_color(t.muted));
  }

  row(n, i, t) {
    const picked = i === this.cursor;
    const unread = !n.read;
    return h_flex().id(`jn-${n.id}`).relative().px(14).py(10).gap(10).items_start().cursor_pointer()
      .when(picked, (el) => el.bg(t.selected)).hover((s) => s.bg(picked ? t.selected : t.hover))
      .on_click((_e, cx) => { this.cursor = i; this.activate(n, cx); })
      .child(this.avatar(n, 32))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(h_flex().flex_wrap().gap_x(4).text_color(unread ? t.foreground : t.muted)
          .child(div().flex_none().font_semibold().text_color(t.foreground).child(n.actor))
          .when(Boolean(n.message), (el) => el.child(div().min_w(0).child(n.message))))
        .when(Boolean(n.title || n.key), (el) => el.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
          .child(this.typeMark(n.type))
          .when(Boolean(n.key), (el) => el.child(div().flex_none().font_semibold().child(n.key)))
          .child(div().min_w(0).truncate().child(n.title))))
        .when(Boolean(n.excerpt), (el) => el.child(div().max_h(40).overflow_hidden().px(8).py(4).rounded(4).border_l(2).border_color(t.border)
          .bg(alpha(t.foreground, 0.04)).text_size(12.5).text_color(t.muted).child(n.excerpt)))
        .child(div().text_size(11.5).text_color(t.dim).child(ago(n.time))))
      // The dot is the toggle, as in Jira: a press on it changes the read state without opening the issue.
      .child(div().w(24).h(24).flex_none().when(unread, (el) => el.child(this.dotButton(n, t))))
      // A read row offers its toggle only on hover, through a layer the row's own hover can't do for a child.
      .when(!unread, (el) => el.child(div().absolute().inset_0().opacity(0).hover((s) => s.opacity(1))
        .child(div().absolute().top(10).right(14).child(this.dotButton(n, t)))));
  }
}
