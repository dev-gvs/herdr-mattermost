// The menus drawn by a popup copy of this mod: a sidebar category's and a channel's ⋮, the channel
// name in the top bar, a post's ⋯, a followed thread's ⋮ and your account. Its props carry what the panel knew when
// it opened; the panel picks up results from the server's websocket events, and asks the panel itself
// (shared "mattermost.request") for what only it can do, such as opening a thread beside the channel.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, openOverlay, theme, setShared } from "herdr";
import { FONT, alpha, requestKey, MONTHS } from "../main.js";
import { imageEntries } from "./image.js";

const icon = (name) => `mods/mattermost/icons/${name}.svg`;
const SORTS = [["alpha", "Alphabetically"], ["recent", "Recent activity"], ["manual", "Manually"]];
// Mattermost's menu: 36px rows, 8px above and below the list, separators with 8px around them.
const ROW = 36, NOTE_ROW = 52, SEP = 17, PAD = 8, GAP = 2;
const WIDTH = { category: 250, channel: 250, header: 250, post: 260, thread: 270, account: 264, image: 210 };
const STATUS_ICON = { online: ["status-online", "#3db887"], away: ["status-away", "#f5ab00"], dnd: ["status-dnd", "#d24b4e"], offline: ["status-offline", "#afb3c0bf"] };
const DND_NOTE = "Disables all notifications";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SUB_WIDTH = 230;
const DM_SORTS = [["alpha", "Alphabetically"], ["recent", "Recent activity"]];
const DM_LIMITS = [10, 15, 20, 40];
const DM_RESULTS = 6;
// The Open a direct message form: its search box and a list of people.
const DM_FORM_H = 2 * PAD + 2 + 64 + DM_RESULTS * ROW;

const listHeight = (items) => 2 * PAD + 2 + items.reduce((h, it) => h + (it === "sep" ? SEP : it.note ? NOTE_ROW : ROW), 0);

export function request(action, data) {
  setShared(requestKey(), { id: `${Date.now()}-${Math.random()}`, action, ...data });
}

function tomorrowAt9() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

const twoDigits = (n) => String(n).padStart(2, "0");

// As Mattermost's getSecondaryLabel words it.
function dndNote(end) {
  if (!end) return "Until indefinitely";
  const when = new Date(end * 1000), time = `${twoDigits(when.getHours())}:${twoDigits(when.getMinutes())}`;
  const days = Math.round((new Date(when).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400e3);
  if (days === 0) return `Until ${time}`;
  if (days === 1) return `Until tomorrow ${time}`;
  return `Until ${MONTHS[when.getMonth()]} ${when.getDate()}, ${when.getFullYear()} ${time}`;
}

export class Menu {
  constructor(view, spec = props().menu) {
    this.view = view;
    this.spec = spec;
    this.mode = spec.mode ?? null;
    this.sub = null;
    this.error = null;
    this.found = [];
    // A menu made only to measure itself (`size`, which render calls) has no view and must not create
    // inputs: state can't be created during render.
    if (!view) return;
    this.name = InputState.new({ placeholder: "Category name", value: spec.kind === "category" && spec.cat.type === "custom" ? spec.cat.display_name : "" });
    this.name.on("submit", (_e, cx) => this.submitName(cx));
    this.people = InputState.new({ placeholder: "Search for people" });
    this.people.on("change", (_e, cx) => this.findPeople(cx));
  }

  findPeople(cx) {
    const q = this.people.value().trim();
    cx.spawn(async (cx) => {
      try {
        await this.view.cfgReady;
        const res = await this.api(cx, `/users/autocomplete?in_team=${this.spec.team.id}&name=${encodeURIComponent(q)}&limit=${DM_RESULTS}`);
        if (this.people.value().trim() !== q) return;
        this.found = (res.users ?? []).filter((u) => u.id !== this.spec.me && !u.delete_at).slice(0, DM_RESULTS);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // Mattermost reopens a closed conversation by its show preference before going to it.
  openDirect(cx, user) {
    this.act(cx, async (cx) => {
      const c = await this.api(cx, "/channels/direct", { method: "POST", body: [this.spec.me, user.id] });
      await this.api(cx, `/users/${this.spec.me}/preferences`, { method: "PUT", body: [{ user_id: this.spec.me, category: "direct_channel_show", name: user.id, value: "true" }] });
      request("open", { channel: c.id });
    });
  }

  // The popup is sized once, when it opens, for the menu with its tallest submenu open; `mainW` and
  // `mainH` are the menu's own card, which the panel lines up with the button that opened it.
  static size(spec) {
    const m = new Menu(null, spec);
    const list = m.entries();
    const mainH = listHeight(list);
    let width = WIDTH[spec.kind], total = mainH;
    if (spec.kind === "category" && spec.cat.type === "direct_messages") total = Math.max(total, DM_FORM_H);
    for (const it of list) {
      if (it === "sep" || !it.sub) continue;
      width = WIDTH[spec.kind] + GAP + SUB_WIDTH;
      total = Math.max(total, m.subTop(list, it.sub) + listHeight(m.subEntries(it.sub)));
    }
    return { width, height: total, mainW: WIDTH[spec.kind], mainH };
  }

  subTop(list, sub) {
    let y = 0;
    for (const it of list) {
      if (it !== "sep" && it.sub === sub) return y;
      y += it === "sep" ? SEP : it.note ? NOTE_ROW : ROW;
    }
    return 0;
  }

  close() {
    closeOverlay(props().overlay);
  }

  base() {
    return `/users/${this.spec.me}/teams/${this.spec.team.id}/channels/categories`;
  }

  act(cx, fn) {
    cx.spawn(async (cx) => {
      try {
        await this.view.cfgReady;
        await fn(cx);
        this.close();
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  api(cx, path, opts) {
    return this.view.api(cx, path, opts);
  }

  updateCategories(cx, cats) {
    return this.api(cx, this.base(), { method: "PUT", body: cats });
  }

  move(cx, target) {
    const { channel, cat, categories } = this.spec;
    const to = categories.find((c) => c.id === target);
    return this.updateCategories(cx, [
      { ...cat, channel_ids: cat.channel_ids.filter((id) => id !== channel.id) },
      { ...to, channel_ids: [channel.id, ...to.channel_ids.filter((id) => id !== channel.id)] },
    ]);
  }

  submitName(cx) {
    const name = this.name.value().trim();
    if (!name) return;
    const { cat, me, team, channel } = this.spec;
    if (this.mode === "rename") this.act(cx, (cx) => this.api(cx, `${this.base()}/${cat.id}`, { method: "PUT", body: { ...cat, display_name: name } }));
    else this.act(cx, (cx) => this.api(cx, this.base(), { method: "POST", body: {
      user_id: me, team_id: team.id, display_name: name, type: "custom", channel_ids: this.mode === "create-move" ? [channel.id] : [],
    } }));
  }

  save(cx, postId, saved) {
    const pref = [{ user_id: this.spec.me, category: "flagged_post", name: postId, value: "true" }];
    return saved
      ? this.api(cx, `/users/${this.spec.me}/preferences/delete`, { method: "POST", body: pref })
      : this.api(cx, `/users/${this.spec.me}/preferences`, { method: "PUT", body: pref });
  }

  // An entry: { label, icon?, note?, danger?, disabled?, detail?, check?, sub?, run(cx) }, or "sep".
  entries() {
    const s = this.spec;
    if (s.kind === "category") return this.categoryEntries();
    if (s.kind === "post") return this.postEntries();
    if (s.kind === "thread") return this.threadEntries();
    if (s.kind === "account") return this.accountEntries();
    if (s.kind === "image") return imageEntries(s, () => this.close());
    return this.channelEntries();
  }

  setStatus(cx, status, dndEnd = 0) {
    this.act(cx, async (cx) => {
      await this.api(cx, `/users/${this.spec.me}/status`, { method: "PUT", body: { user_id: this.spec.me, status, ...(status === "dnd" ? { dnd_end_time: dndEnd } : {}) } });
      request("status", { status, dndEnd });
    });
  }

  // Out of office with no "Do not ask me again" on file, Mattermost confirms any status change first. A time
  // chosen under Do not disturb is dropped by that, as it is there.
  confirmStatus(newStatus) {
    request("reset-status", { newStatus });
    this.close();
  }

  // Mattermost's user_account_menu, with what's in reach here. The panel asks for its dialogs itself, since
  // it holds what they open with.
  accountEntries() {
    const { user, status, dndEnd, custom, customEnabled, isDemo, askFirst } = this.spec;
    const openDialog = (action) => () => { request(action); this.close(); };
    const change = (cx, key) => (askFirst ? this.confirmStatus(key) : this.setStatus(cx, key));
    const statusRow = (key, label, extra = {}) => {
      const [name, color] = STATUS_ICON[key];
      return { icon: name, iconColor: color, label, check: status === key, run: (cx) => change(cx, key), ...extra };
    };
    const glyph = custom?.glyph;
    return [
      { lead: (t) => (user.avatar ? image(user.avatar).size(36).flex_none().rounded_full() : div().size(36).flex_none().rounded_full().bg(t.raised)),
        label: user.name || `@${user.username}`, note: user.name ? `@${user.username}` : null, big: true, run: openDialog("profile-dialog") },
      "sep",
      ...(status === "ooo" ? [
        { icon: "circle-x", label: "Out of office", note: "Automatic replies are enabled", check: true, run: (cx) => change(cx, "online") },
        "sep",
      ] : []),
      ...(customEnabled ? [
        custom
          ? { lead: () => (glyph?.path ? image(glyph.path).size(18).flex_none() : div().w(18).flex_none().text_size(15).child(glyph?.char ?? "")),
            label: custom.text || "Set custom status text", note: custom.until || null, run: openDialog("status-dialog"),
            clear: (cx) => this.act(cx, async (cx) => {
              await this.api(cx, "/users/me/status/custom", { method: "DELETE" });
              request("custom-status", { status: null });
            }) }
          : { icon: "smile", label: "Set custom status", run: openDialog("status-dialog") },
        "sep",
      ] : []),
      statusRow("online", "Online"),
      statusRow("away", "Away"),
      statusRow("dnd", "Do not disturb", { note: status === "dnd" ? dndNote(dndEnd) : DND_NOTE, sub: "dnd", run: undefined }),
      statusRow("offline", "Offline"),
      "sep",
      { icon: "user", label: "Profile", run: openDialog("profile-dialog") },
      "sep",
      { icon: "log-out", label: "Log out", disabled: isDemo, run: (cx) => { this.mode = "logout"; cx.notify(); } },
    ];
  }

  categoryEntries() {
    const { cat, unreadIds, dmLimit } = this.spec;
    if (cat.type === "direct_messages") {
      return [
        { icon: "clock", label: "Sort", detail: DM_SORTS.find(([k]) => k === cat.sorting)?.[1] ?? "Recent activity", sub: "sort" },
        { icon: "users", label: "Show", detail: String(dmLimit), sub: "show" },
        "sep",
        { icon: "user-plus", label: "Open a direct message", run: (cx) => { this.mode = "dm"; this.people.focus(); this.findPeople(cx); cx.notify(); } },
      ];
    }
    const custom = cat.type === "custom";
    const sort = SORTS.find(([k]) => k === cat.sorting)?.[1] ?? "Manually";
    return [
      { icon: "mark-read", label: "Mark category as read", disabled: !unreadIds.length, run: (cx) => this.act(cx, async (cx) => {
        for (const id of unreadIds) await this.api(cx, "/channels/members/me/view", { method: "POST", body: { channel_id: id } });
      }) },
      "sep",
      { icon: cat.muted ? "bell" : "bell-off", label: cat.muted ? "Unmute Category" : "Mute Category",
        run: (cx) => this.act(cx, (cx) => this.api(cx, `${this.base()}/${cat.id}`, { method: "PUT", body: { ...cat, muted: !cat.muted } })) },
      ...(custom ? [
        { icon: "pencil", label: "Rename Category", run: (cx) => { this.mode = "rename"; this.name.focus(); cx.notify(); } },
        { icon: "trash", label: "Delete Category", danger: true, run: (cx) => { this.mode = "delete"; cx.notify(); } },
      ] : []),
      "sep",
      { icon: "list", label: "Sort", detail: sort, sub: "sort" },
      "sep",
      { icon: "folder-plus", label: "Create New Category", run: (cx) => { this.mode = "create"; this.name.set_value(""); this.name.focus(); cx.notify(); } },
    ];
  }

  channelEntries() {
    const { channel, muted, unread, link, peer, kind } = this.spec;
    const direct = channel.type === "D" || channel.type === "G";
    const header = kind === "header";
    const markRead = unread
      ? { icon: "mark-read", label: "Mark as Read", run: (cx) => this.act(cx, (cx) => this.api(cx, "/channels/members/me/view", { method: "POST", body: { channel_id: channel.id } })) }
      : { icon: "mail", label: "Mark as Unread", run: (cx) => this.act(cx, async (cx) => {
        const page = await this.api(cx, `/channels/${channel.id}/posts?per_page=1&collapsedThreads=true`);
        if (!page.order.length) return;
        await this.api(cx, `/users/${this.spec.me}/posts/${page.order[0]}/set_unread`, { method: "POST", body: { collapsed_threads_supported: true } });
      }) };
    const mute = { icon: muted ? "bell" : "bell-off", label: `${muted ? "Unmute" : "Mute"}${header ? "" : direct ? " Conversation" : " Channel"}`, run: (cx) => this.act(cx, (cx) =>
      this.api(cx, `/channels/${channel.id}/members/${this.spec.me}/notify_props`, { method: "PUT", body: { channel_id: channel.id, user_id: this.spec.me, mark_unread: muted ? "all" : "mention" } })) };
    const edit = (field, label) => ({ icon: "settings", label, run: () => {
      openOverlay({ mod: "mattermost", kind: "dialog", width: 640, height: 370, props: { edit: { field, value: channel[field] ?? "", channel } } });
      this.close();
    } });
    const closeDirect = { icon: "x", label: header ? (channel.type === "D" ? "Close Direct Message" : "Close Group Message") : "Close Conversation",
      run: (cx) => this.act(cx, (cx) => this.api(cx, `/users/${this.spec.me}/preferences`, { method: "PUT", body: [{
        user_id: this.spec.me, category: channel.type === "D" ? "direct_channel_show" : "group_channel_show", name: channel.type === "D" ? peer : channel.id, value: "false",
      }] })) };
    const leave = { icon: "log-out", label: "Leave Channel", danger: true, run: (cx) => { this.mode = "leave"; cx.notify(); } };
    const moveTo = { icon: "folder-input", label: "Move to…", sub: "move" };
    if (header) {
      return [
        { icon: "info", label: "View Info", run: () => { request("info", { channel: channel.id }); this.close(); } },
        mute,
        ...(direct ? [edit("header", "Edit Header")] : []),
        "sep",
        moveTo,
        "sep",
        ...(direct ? [closeDirect] : [
          edit("header", "Edit Channel Header"), edit("purpose", "Edit Channel Purpose"),
          "sep",
          { icon: "link", label: "Copy Link", run: (cx) => { cx.write_to_clipboard(link); this.close(); } },
          "sep",
          leave,
        ]),
      ];
    }
    const favorite = this.spec.cat.type === "favorites";
    return [
      markRead,
      { icon: favorite ? "star-filled" : "star", label: favorite ? "Unfavorite" : "Favorite", disabled: !this.favorites() || !this.home(),
        run: (cx) => this.act(cx, (cx) => this.move(cx, favorite ? this.home().id : this.favorites().id)) },
      mute,
      "sep",
      moveTo,
      "sep",
      { icon: "link", label: "Copy Link", run: (cx) => { cx.write_to_clipboard(link); this.close(); } },
      "sep",
      direct ? closeDirect : leave,
    ];
  }

  favorites() {
    return this.spec.categories.find((c) => c.type === "favorites");
  }

  home() {
    const direct = this.spec.channel.type === "D" || this.spec.channel.type === "G";
    return this.spec.categories.find((c) => c.type === (direct ? "direct_messages" : "channels"));
  }

  postEntries() {
    const { post, saved, following, link, own } = this.spec;
    const thread = post.root_id || post.id;
    return [
      { icon: "reply", label: "Reply", run: () => { request("reply", { post: thread }); this.close(); } },
      ...(following != null ? [{ icon: following ? "message-square-x" : "message-square-plus", label: following ? "Unfollow thread" : "Follow thread",
        run: (cx) => this.act(cx, (cx) => this.api(cx, `/users/${this.spec.me}/teams/${this.spec.team.id}/threads/${thread}/following`, { method: following ? "DELETE" : "PUT" })) }] : []),
      { icon: "mail", label: "Mark as Unread", run: (cx) => this.act(cx, (cx) =>
        this.api(cx, `/users/${this.spec.me}/posts/${post.id}/set_unread`, { method: "POST", body: { collapsed_threads_supported: true } })) },
      { icon: "clock", label: "Remind", sub: "remind" },
      { icon: saved ? "bookmark-filled" : "bookmark", label: saved ? "Remove from Saved" : "Save Message", run: (cx) => this.act(cx, (cx) => this.save(cx, post.id, saved)) },
      { icon: "pin", label: post.is_pinned ? "Unpin from Channel" : "Pin to Channel",
        run: (cx) => this.act(cx, (cx) => this.api(cx, `/posts/${post.id}/${post.is_pinned ? "unpin" : "pin"}`, { method: "POST" })) },
      "sep",
      { icon: "link", label: "Copy Link", run: (cx) => { cx.write_to_clipboard(link); this.close(); } },
      "sep",
      ...(own ? [{ icon: "pencil", label: "Edit", run: () => { request("edit", { post: post.id, scope: this.spec.scope }); this.close(); } }] : []),
      { icon: "copy", label: "Copy Text", run: (cx) => { cx.write_to_clipboard(post.message ?? ""); this.close(); } },
      ...(own ? [{ icon: "trash", label: "Delete", danger: true, run: (cx) => { this.mode = "delete-post"; cx.notify(); } }] : []),
    ];
  }

  threadEntries() {
    const { thread, saved, link } = this.spec;
    const base = `/users/${this.spec.me}/teams/${this.spec.team.id}/threads/${thread.id}`;
    return [
      thread.following
        ? { label: "Unfollow thread", note: "You won’t be notified about replies", run: (cx) => this.act(cx, (cx) => this.api(cx, `${base}/following`, { method: "DELETE" })) }
        : { label: "Follow thread", note: "You will be notified about replies", run: (cx) => this.act(cx, (cx) => this.api(cx, `${base}/following`, { method: "PUT" })) },
      { label: "Open in channel", run: () => { request("open", { channel: thread.channel_id }); this.close(); } },
      thread.unread
        ? { label: "Mark as read", run: (cx) => this.act(cx, (cx) => this.api(cx, `${base}/read/${Date.now()}`, { method: "PUT" })) }
        : { label: "Mark as unread", run: (cx) => this.act(cx, (cx) => this.api(cx, `${base}/set_unread/${thread.id}`, { method: "POST" })) },
      { label: saved ? "Unsave" : "Save", run: (cx) => this.act(cx, (cx) => this.save(cx, thread.id, saved)) },
      { label: "Copy link", run: (cx) => { cx.write_to_clipboard(link); this.close(); } },
    ];
  }

  subEntries(sub) {
    const s = this.spec;
    if (sub === "dnd") {
      const at = (label, ms, detail) => ({ label, detail, run: (cx) => (s.askFirst ? this.confirmStatus("dnd") : this.setStatus(cx, "dnd", ms ? Math.floor(ms / 1000) : 0)) });
      const tomorrow = new Date(tomorrowAt9());
      return [
        { heading: "Clear after:" },
        at("Don't clear", 0),
        at("30 mins", Date.now() + 30 * 60e3),
        at("1 hour", Date.now() + 3600e3),
        at("2 hours", Date.now() + 2 * 3600e3),
        at("Tomorrow", tomorrow.getTime(), `${WEEKDAYS[tomorrow.getDay()]}, 09:00`),
        { label: "Choose date and time", run: () => { if (s.askFirst) this.confirmStatus("dnd"); else { request("dnd-dialog"); this.close(); } } },
      ];
    }
    if (sub === "show") {
      return DM_LIMITS.map((n) => ({ label: String(n), check: n === s.dmLimit, run: (cx) => this.act(cx, (cx) =>
        this.api(cx, `/users/${s.me}/preferences`, { method: "PUT", body: [{ user_id: s.me, category: "sidebar_settings", name: "limit_visible_dms_gms", value: String(n) }] })) }));
    }
    if (sub === "sort") {
      const sorts = s.cat.type === "direct_messages" ? DM_SORTS : SORTS;
      return sorts.map(([key, label]) => ({ label, check: key === s.cat.sorting || (key === "recent" && s.cat.type === "direct_messages" && s.cat.sorting !== "alpha"),
        run: (cx) => this.act(cx, (cx) => this.api(cx, `${this.base()}/${s.cat.id}`, { method: "PUT", body: { ...s.cat, sorting: key } })) }));
    }
    if (sub === "remind") {
      const at = (label, ms) => ({ label, run: (cx) => this.act(cx, (cx) =>
        this.api(cx, `/users/${s.me}/posts/${s.post.id}/reminder`, { method: "POST", body: { target_time: Math.floor(ms / 1000) } })) });
      return [at("30 mins", Date.now() + 30 * 60e3), at("1 hour", Date.now() + 3600e3), at("2 hours", Date.now() + 2 * 3600e3), at("Tomorrow", tomorrowAt9())];
    }
    // Move to: Favorites first, as Mattermost lists it, then the rest in sidebar order; a channel can't
    // go under Direct Messages, nor a conversation under Channels.
    const direct = s.channel.type === "D" || s.channel.type === "G";
    const cats = s.categories.filter((c) => c.type !== (direct ? "channels" : "direct_messages"))
      .sort((a, b) => (b.type === "favorites") - (a.type === "favorites"));
    return [
      ...cats.map((c) => ({ icon: c.type === "favorites" ? "star" : "folder", label: c.display_name, check: c.id === s.cat?.id,
        run: (cx) => (c.id === s.cat?.id ? this.close() : this.act(cx, (cx) => this.move(cx, c.id))) })),
      "sep",
      { icon: "folder-plus", label: "New Category", run: (cx) => { this.mode = "create-move"; this.name.set_value(""); this.name.focus(); cx.notify(); } },
    ];
  }

  row(t, it, key) {
    const color = it.disabled ? t.dim : it.danger ? t.blocked : t.foreground;
    const open = it.sub && this.sub === it.sub;
    return h_flex().id(`mi-${key}`).h(it.note ? NOTE_ROW : ROW).flex_none().px(16).gap(10).items_center()
      .text_color(color).when(open, (el) => el.bg(alpha(t.foreground, 0.08)))
      // Hovering a row opens its submenu and closes any other, as Mattermost's menus do.
      .on_hover((hovered, cx) => {
        if (!hovered || this.mode) return;
        const next = it.sub ?? (key.startsWith("sub-") ? this.sub : null);
        if (next !== this.sub) { this.sub = next; cx.notify(); }
      })
      .when(!it.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(alpha(t.foreground, 0.08)))
        .on_click((_e, cx) => { if (it.run) it.run(cx); else { this.sub = it.sub; cx.notify(); } }))
      .when(Boolean(it.icon), (el) => el.child(svg(icon(it.icon)).size(18).flex_none().text_color(it.iconColor ?? (it.danger ? t.blocked : alpha(t.foreground, 0.64)))))
      .when(Boolean(it.lead), (el) => el.child(it.lead(t)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().when(Boolean(it.big), (l) => l.text_size(16).font_semibold()).child(it.label))
        .when(Boolean(it.note), (el) => el.child(div().truncate().text_size(12).text_color(alpha(t.foreground, 0.56)).child(it.note))))
      .when(Boolean(it.detail), (el) => el.child(div().text_size(12).text_color(t.dim).child(it.detail)))
      .when(Boolean(it.clear), (el) => el.child(div().id(`mi-clear-${key}`).p(2).flex_none().rounded(4).text_color(alpha(t.foreground, 0.56)).hover((s) => s.text_color(t.foreground))
        .tooltip("Clear custom status")
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); it.clear(cx); })
        .child(svg(icon("circle-x")).size(16))))
      .when(Boolean(it.check), (el) => el.child(svg(icon("check")).size(16).flex_none().text_color(t.accent)))
      .when(Boolean(it.sub), (el) => el.child(svg(icon("chevron-right")).size(14).flex_none().text_color(alpha(t.foreground, 0.56))));
  }

  card(t, w, children) {
    return v_flex().w(w).flex_none().py(PAD).rounded(4).border_1().border_color(alpha(t.foreground, 0.16)).bg(t.background).shadow_lg()
      .children(children);
  }

  list(t, items, prefix) {
    return items.map((it, i) => {
      if (it === "sep") return div().h(1).my(8).flex_none().bg(alpha(t.foreground, 0.16));
      if (it.heading) return div().h(ROW).flex_none().px(16).flex().items_center().font_bold().child(it.heading);
      return this.row(t, it, `${prefix}${i}`);
    });
  }

  confirm(t, question, action, onOk) {
    const button = (id, label, primary, onClick) => div().id(id).px(12).py(6).rounded(4).cursor_pointer().text_size(13).font_semibold()
      .when(primary, (el) => el.bg(t.blocked).text_color("#ffffff"))
      .when(!primary, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
      .on_click(onClick).child(label);
    return v_flex().gap(10).px(16).py(4)
      .child(div().text_color(t.foreground).child(question))
      .child(h_flex().gap(6).justify_end()
        .child(button("cancel", "Cancel", false, (_e, cx) => {
          // Opened straight at the question, there's no menu to go back to.
          if (this.spec.mode) return this.close();
          this.mode = null;
          cx.notify();
        }))
        .child(button("ok", action, true, (_e, cx) => this.act(cx, onOk))));
  }

  dmForm(t) {
    return v_flex().gap(8).px(16).py(4)
      .child(div().text_size(12).text_color(t.muted).child("Open a direct message"))
      .child(div().h(32).px(8).flex().items_center().rounded(4).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.people).flex_1().text_size(14)))
      .child(v_flex().mx(-16).children(this.found.map((u) => {
        const full = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();
        return h_flex().id(`dm-${u.id}`).h(ROW).px(16).gap(8).items_center().cursor_pointer().hover((s) => s.bg(alpha(t.foreground, 0.08)))
          .on_click((_e, cx) => this.openDirect(cx, u))
          .child(div().min_w(0).truncate().child(full || u.username))
          .child(div().flex_none().text_size(12).text_color(t.dim).child(`@${u.username}`));
      })));
  }

  nameForm(t) {
    return v_flex().gap(8).px(16).py(4)
      .child(div().text_size(12).text_color(t.muted).child(this.mode === "rename" ? "Rename category" : "New category"))
      .child(div().h(32).px(8).flex().items_center().rounded(4).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.name).flex_1().text_size(14)))
      .child(div().text_size(11).text_color(t.dim).child("Enter to save, Esc to cancel"));
  }

  render() {
    const t = theme();
    const { kind, cat, channel, post } = this.spec;
    const w = WIDTH[kind];
    let body;
    if (this.mode === "delete") body = [this.confirm(t, `Delete “${cat.display_name}”? Its channels move back to Channels.`, "Delete", (cx) => this.api(cx, `${this.base()}/${cat.id}`, { method: "DELETE" }))];
    else if (this.mode === "leave") body = [this.confirm(t, `Leave ${channel.display}?`, "Leave", (cx) => this.api(cx, `/channels/${channel.id}/members/${this.spec.me}`, { method: "DELETE" }))];
    else if (this.mode === "delete-post") body = [this.confirm(t, "Delete this message?", "Delete", (cx) => this.api(cx, `/posts/${post.id}`, { method: "DELETE" }))];
    else if (this.mode === "logout") body = [this.confirm(t, "Log out here? This deletes the saved token from this machine. The token stays valid on the server, and you'll need it or a new one to log back in.", "Log out", () => { request("logout"); })];
    else if (this.mode === "dm") body = [this.dmForm(t)];
    else if (this.mode) body = [this.nameForm(t)];
    else body = this.list(t, this.entries(), "m");
    const main = this.card(t, w, body)
      .when(Boolean(this.error), (el) => el.child(div().px(16).pt(6).text_size(12).text_color(t.blocked).child(this.error)));
    const subItems = this.sub && !this.mode ? this.subEntries(this.sub) : null;
    // `layout.up`: the menu opened above its button, so it sits at the popup's bottom; `layout.flip`:
    // it is right-aligned to the button, so submenus open to its left.
    const { up = false, flip = false } = this.spec.layout ?? {};
    this.dims ??= Menu.size(this.spec);
    const { height, mainH } = this.dims;
    const top = up ? height - mainH : 0;
    const subY = subItems ? Math.max(0, Math.min(top + this.subTop(this.entries(), this.sub), height - listHeight(subItems))) : 0;
    // Sized explicitly: a frameless popup is as big as its content, and both cards are out of flow.
    return div().id("mm-menu").relative().w(this.dims.width).h(height).font_family(FONT).text_size(14).text_color(t.foreground)
      .child(main.absolute().top(top).when(flip, (el) => el.right(0)).when(!flip, (el) => el.left(0)))
      .when(Boolean(subItems), (el) => el.child(this.card(t, SUB_WIDTH, this.list(t, subItems, "sub-"))
        .absolute().top(subY).when(flip, (s) => s.left(0)).when(!flip, (s) => s.left(w + GAP))));
  }
}
