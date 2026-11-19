// Find, the first section: Mattermost's Find Channels as a list. With nothing typed it lists unread and recent
// conversations; typing searches yours, asks the server for public channels you haven't joined and for people,
// and ranks them as Mattermost's quick switcher does. Picking one opens it in Chats, joining a channel or starting
// a direct message first when needed. The conversation being read stays in the reader meanwhile.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { alpha, byRecency } from "../main.js";
import { listRow, iconTile, sectionHeading, empty, shortTime } from "./layout.js";

const MONTH = 30 * 24 * 3600e3;

export class Find {
  constructor(panel) {
    this.panel = panel;
    this.query = "";
    this.remote = { channels: [], users: [] };
    this.sel = 0;
    this.moved = false;
    this.error = null;
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Find channels and people" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value().trim();
      this.sel = 0;
      this.search(cx);
      cx.notify(panel.sidePart);
    });
    this.input.on("submit", (_e, cx) => { const it = this.items()[this.sel]; if (it) this.choose(it, cx); });
  }

  focus() {
    this.input.focus();
  }

  clear() {
    this.input.set_value("");
    this.query = "";
    this.remote = { channels: [], users: [] };
    this.sel = 0;
    this.moved = false;
  }

  // Your conversations, as Mattermost's switcher lists them (switch_channel_provider.tsx); the one being read is left out.
  conversations() {
    const p = this.panel;
    return [...p.channels.values()].filter((c) => c.id !== p.selected).map((c) => {
      const viewed = Math.max(p.members.get(c.id)?.last_viewed_at ?? 0, p.viewTimes?.get(c.id) ?? 0);
      const u = c.type === "D" ? p.users.get(p.dmPeer(c)) : null;
      const display = p.channelName(c) + (u?.nickname ? ` (${u.nickname})` : "");
      return { kind: "channel", id: c.id, type: c.type, c, display, name: c.type === "D" ? u?.username ?? "" : c.type === "G" ? "" : c.name, viewed,
        unread: !p.muted(c) && p.unread(c).count > 0, last: p.lastActivity(c) };
    });
  }

  search(cx) {
    const q = this.query;
    if (!q) {
      this.remote = { channels: [], users: [] };
      return;
    }
    const p = this.panel;
    cx.spawn(async (cx) => {
      try {
        const [channels, users] = await Promise.all([
          p.api(cx, `/teams/${p.team.id}/channels/search`, { method: "POST", body: { term: q } }),
          p.api(cx, `/users/autocomplete?in_team=${p.team.id}&name=${encodeURIComponent(q)}&limit=10`),
        ]);
        if (this.query !== q) return;
        const peers = new Set([...p.channels.values()].filter((c) => c.type === "D").map((c) => p.dmPeer(c)));
        this.remote = {
          channels: channels.filter((c) => !p.channels.has(c.id) && !c.delete_at).slice(0, 10).map((c) => ({
            kind: "join", id: c.id, type: c.type, display: c.display_name || c.name, name: c.name, purpose: c.purpose ?? "", viewed: 0,
          })),
          users: (users.users ?? []).filter((u) => !peers.has(u.id) && !u.delete_at).map((u) => {
            const full = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();
            p.addUser(u);
            return { kind: "user", id: u.id, type: "D", display: (full || u.username) + (u.nickname ? ` (${u.nickname})` : ""), name: u.username, viewed: 0 };
          }),
        };
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify(p.sidePart);
    });
  }

  // Mattermost's quick switch ranking (makeQuickSwitchSorter): penalties for never or long ago viewed,
  // for the term not starting the name, and for being a group or channel rather than a DM; then recency.
  rank(it, q) {
    const activity = !it.viewed ? 24 : Date.now() - it.viewed > MONTH ? 12 : 0;
    const prefix = it.type !== "G" && (it.display.toLowerCase().startsWith(q) || it.name.toLowerCase().startsWith(q)) ? 0 : 6;
    const type = it.type === "D" ? 0 : it.type === "G" ? 2 : 4;
    return activity + prefix + type;
  }

  sections() {
    const p = this.panel, all = this.conversations();
    const q = this.query.toLowerCase().replace(/^@/, "");
    if (!q) {
      const unread = all.filter((it) => it.unread).sort((a, b) => b.last - a.last).slice(0, 5);
      if (p.threadTotals.total_unread_threads > 0) unread.unshift({ kind: "threads", id: "threads", type: "threads", display: "Threads", name: "", viewed: Date.now() });
      const shown = new Set(unread.map((it) => it.id));
      return [["UNREAD", unread], ["RECENT", all.filter((it) => !shown.has(it.id)).sort(byRecency).slice(0, 20)]].filter(([, list]) => list.length);
    }
    const ranked = (list) => list.sort((a, b) => this.rank(a, q) - this.rank(b, q) || byRecency(a, b));
    const mine = all.filter((it) => it.display.toLowerCase().includes(q) || it.name.toLowerCase().includes(q));
    return [["YOUR CONVERSATIONS", ranked(mine)], ["NOT JOINED", ranked([...this.remote.channels])], ["PEOPLE", ranked([...this.remote.users])]]
      .filter(([, list]) => list.length);
  }

  items() {
    return this.sections().flatMap(([, list]) => list);
  }

  choose(it, cx) {
    const p = this.panel;
    if (it.kind === "threads") {
      this.clear();
      return p.showSection("threads", cx);
    }
    if (it.kind === "channel") {
      this.clear();
      return cx.spawn(async (cx) => p.open(it.id, cx));
    }
    cx.spawn(async (cx) => {
      try {
        let id = it.id;
        if (it.kind === "join") await p.api(cx, `/channels/${id}/members`, { method: "POST", body: { user_id: p.me.id } });
        else {
          id = (await p.api(cx, "/channels/direct", { method: "POST", body: [p.me.id, it.id] })).id;
          await p.api(cx, `/users/${p.me.id}/preferences`, { method: "PUT", body: [{ user_id: p.me.id, category: "direct_channel_show", name: it.id, value: "true" }] });
        }
        if (!p.channels.has(id)) await p.loadSidebar(cx);
        this.clear();
        await p.open(id, cx);
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify(p.sidePart);
      }
    });
  }

  move(by, cx) {
    const n = this.items().length;
    if (!n) return;
    this.sel = this.moved ? (this.sel + by + n) % n : by > 0 ? 0 : n - 1;
    this.moved = true;
    let index = 0, child = 0;
    for (const [, list] of this.sections()) {
      child++;
      if (this.sel < index + list.length) { child += this.sel - index; break; }
      index += list.length;
      child += list.length;
    }
    this.scroll.scroll_to_item(child);
    cx.notify(this.panel.sidePart);
  }

  icon(it, t) {
    const p = this.panel;
    if (it.kind === "channel") return p.chatIcon(it.c, t);
    if (it.kind === "user") return p.avatar(it.id, 36, t);
    if (it.kind === "threads") return iconTile("message-square", t);
    return iconTile(it.type === "P" ? "lock" : "globe", t);
  }

  row(it, i, t) {
    const p = this.panel;
    const picked = (this.query || this.moved) && i === this.sel;
    const base = { id: `find-${it.kind}-${it.id}`, icon: this.icon(it, t), title: it.display, selected: picked, onClick: (_e, cx) => this.choose(it, cx) };
    if (it.kind === "channel") {
      const { count, mentions } = p.unread(it.c);
      return listRow({ ...base, preview: p.channelPreview(it.c), time: shortTime(it.last), unread: count > 0, badge: mentions, dot: count > 0 }, t);
    }
    if (it.kind === "threads") return listRow({ ...base, preview: `${p.threadTotals.total_unread_threads} unread`, dot: true, unread: true }, t);
    if (it.kind === "join") return listRow({ ...base, preview: it.purpose || "Public channel", time: "Join" }, t);
    return listRow({ ...base, preview: `@${it.name}`, time: "Message" }, t);
  }

  render(t) {
    const sections = this.sections();
    let i = 0;
    const rows = [];
    for (const [head, list] of sections) {
      rows.push(sectionHeading(t, head));
      for (const it of list) rows.push(this.row(it, i++, t));
    }
    return v_flex().flex_1().min_h(0)
      .on_key_down((e, cx) => {
        if (e.keystroke === "up") this.move(-1, cx);
        else if (e.keystroke === "down") this.move(1, cx);
        else if (e.keystroke === "escape" && this.query) { this.clear(); cx.notify(this.panel.sidePart); }
      })
      .child(h_flex().id("find-bar").h(36).flex_none().px(11).gap(9).items_center().border_b_1().border_color(t.border).text_color(t.muted)
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.input.focus(); })
        .child(svg("mods/mattermost/icons/search.svg").size(14).flex_none())
        .child(Input.new(this.input).flex_1().min_w(0).h(30).border_0().bg(alpha(t.background, 0)).text_size(13))
        .when(Boolean(this.query), (el) => el.child(div().id("find-clear").size(22).flex().flex_none().items_center().justify_center().rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Clear")
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.clear(); this.input.focus(); cx.notify(this.panel.sidePart); })
          .child(svg("mods/mattermost/icons/x.svg").size(14)))))
      .when(Boolean(this.error), (el) => el.child(div().px(12).py(6).text_size(12).text_color(t.blocked).child(this.error)))
      .child(rows.length
        ? v_flex().id("find-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).pb(8).children(rows)
        : this.query ? empty(t, "search", "Nothing found", `No results for “${this.query}”`) : empty(t, "search", "Find channels and people"));
  }
}
