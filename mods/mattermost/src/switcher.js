// Mattermost's Find Channels dialog, drawn by a dialog copy of this mod. The panel hands it the
// conversations you have, most recently viewed first; typing also asks the server for public channels
// you haven't joined and for people, so a new conversation starts from here too.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme } from "herdr";
import { FONT, alpha, byRecency } from "../main.js";
import { Media } from "./media.js";
import { request } from "./menu.js";

export const SWITCHER_W = 600, SWITCHER_H = 520;
const ROW = 42, ROWS = 8;
const MONTH = 30 * 24 * 3600e3;
const STATUS = { online: ["online", "#3db887"], away: ["away", "#f5ab00"], dnd: ["dnd", "#d24b4e"] };

export class Switcher {
  constructor(view, cx) {
    this.view = view;
    this.spec = props().switcher;
    this.media = new Media();
    this.media.demo = Boolean(props()?.demo);
    this.query = "";
    this.remote = { channels: [], users: [] };
    this.sel = 0;
    this.start = 0;
    this.error = null;
    this.input = InputState.new({ placeholder: "" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value().trim();
      this.sel = 0;
      this.start = 0;
      this.search(cx);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => { const it = this.items()[this.sel]; if (it) this.choose(it, cx); });
    this.input.focus();
    cx.timer.every(400, (cx) => {
      if (this.media.pending() && this.view.cfg) cx.spawn(async (cx) => { if (await this.media.flush(this.view.cfg)) cx.notify(); });
    });
    cx.spawn(async () => { await this.media.scan(); });
  }

  close() {
    closeOverlay(props().overlay);
  }

  search(cx) {
    const q = this.query;
    if (!q) {
      this.remote = { channels: [], users: [] };
      return;
    }
    cx.spawn(async (cx) => {
      try {
        await this.view.cfgReady;
        const { me, team } = this.spec;
        const [channels, users] = await Promise.all([
          this.view.api(cx, `/teams/${team.id}/channels/search`, { method: "POST", body: { term: q } }),
          this.view.api(cx, `/users/autocomplete?in_team=${team.id}&name=${encodeURIComponent(q)}&limit=10`),
        ]);
        if (this.query !== q) return;
        const joined = new Set(this.spec.items.map((it) => it.id));
        const peers = new Set(this.spec.items.map((it) => it.peer).filter(Boolean));
        this.remote = {
          channels: channels.filter((c) => !joined.has(c.id) && !c.delete_at).slice(0, 10).map((c) => ({
            kind: "join", id: c.id, type: c.type, display: c.display_name || c.name, name: c.name, sub: `~${c.name}`, viewed: 0,
          })),
          users: (users.users ?? []).filter((u) => !peers.has(u.id) && !u.delete_at).map((u) => {
            const full = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();
            const display = (full || u.username) + (u.nickname ? ` (${u.nickname})` : "");
            return { kind: "user", id: u.id, type: "D", display, name: u.username, viewed: 0, sub: display === u.username ? "" : `@${u.username}`,
              user: { id: u.id, last_picture_update: u.last_picture_update ?? 0 }, bot: Boolean(u.is_bot), self: u.id === me };
          }),
        };
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
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
    const q = this.query.toLowerCase().replace(/^@/, "");
    if (!q) return [["UNREAD", this.spec.unread ?? []], ["RECENT", this.spec.recent ?? this.spec.items]].filter(([, list]) => list.length);
    const local = this.spec.items.filter((it) => it.display.toLowerCase().includes(q) || it.name.toLowerCase().includes(q));
    const all = [...local, ...this.remote.channels, ...this.remote.users];
    return [[null, all.sort((a, b) => this.rank(a, q) - this.rank(b, q) || byRecency(a, b))]];
  }

  items() {
    return this.sections().flatMap(([, list]) => list);
  }

  // Joining a public channel and starting a conversation both end in the panel opening it.
  choose(it, cx) {
    const { me } = this.spec;
    if (it.kind === "channel" || it.kind === "threads") {
      request(it.kind === "threads" ? "threads" : "open", { channel: it.id });
      return this.close();
    }
    cx.spawn(async (cx) => {
      try {
        await this.view.cfgReady;
        let id = it.id;
        if (it.kind === "join") await this.view.api(cx, `/channels/${id}/members`, { method: "POST", body: { user_id: me } });
        else {
          id = (await this.view.api(cx, "/channels/direct", { method: "POST", body: [me, it.id] })).id;
          await this.view.api(cx, `/users/${me}/preferences`, { method: "PUT", body: [{ user_id: me, category: "direct_channel_show", name: it.id, value: "true" }] });
        }
        request("open", { channel: id });
        this.close();
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  // The list's lines: section headings and rows; `start` is the first line shown.
  lines() {
    const out = [];
    let i = 0;
    for (const [head, list] of this.sections()) {
      if (head) out.push({ head });
      for (const it of list) out.push({ it, i: i++ });
    }
    return out;
  }

  move(by, cx) {
    const n = this.items().length;
    if (!n) return;
    this.sel = (this.sel + by + n) % n;
    const lines = this.lines();
    const at = lines.findIndex((l) => l.i === this.sel);
    // Keep the selected row in view, and its section's heading with it when it's the first row.
    const top = at > 0 && lines[at - 1].head ? at - 1 : at;
    if (top < this.start) this.start = top;
    if (at >= this.start + ROWS) this.start = at - ROWS + 1;
    cx.notify();
  }

  icon(it, t) {
    if (it.type === "D") {
      const path = it.avatar ?? (it.user ? this.media.avatar(it.user) : null);
      const pic = path ? image(path).size(24).rounded_full() : div().size(24).rounded_full().bg(t.raised);
      if (it.bot || !it.status) return div().size(24).flex_none().child(pic);
      const [name, color] = STATUS[it.status] ?? ["offline", "#afb3c0bf"];
      return div().relative().size(24).flex_none().child(pic)
        .child(div().absolute().left(13).top(13).size(13).flex().items_center().justify_center().rounded_full().bg(t.background)
          .child(svg(`mods/mattermost/icons/status-${name}.svg`).size(10).text_color(color)));
    }
    if (it.type === "threads") {
      return div().size(24).flex_none().flex().items_center().justify_center()
        .child(svg("mods/mattermost/icons/threads.svg").size(16).text_color(alpha(t.foreground, 0.64)));
    }
    if (it.type === "G") {
      return div().size(24).flex_none().flex().items_center().justify_center()
        .child(div().size(18).flex().items_center().justify_center().pb(1).rounded(2).bg(alpha(t.foreground, 0.16))
          .text_size(12).line_height("16px").font_semibold().child(String(it.count ?? "")));
    }
    return div().size(24).flex_none().flex().items_center().justify_center()
      .child(svg(`mods/mattermost/icons/${it.type === "P" ? "lock" : "globe"}.svg`).size(16).text_color(alpha(t.foreground, 0.64)));
  }

  row(it, i, t) {
    const on = i === this.sel;
    return h_flex().id(`sw-${it.kind}-${it.id}`).h(ROW).flex_none().px(32).gap(12).items_center().cursor_pointer()
      .when(on, (el) => el.bg(alpha(t.foreground, 0.08)))
      .on_hover((hovered, cx) => { if (hovered && this.sel !== i) { this.sel = i; cx.notify(); } })
      .on_click((_e, cx) => this.choose(it, cx))
      .child(this.icon(it, t))
      .child(div().flex_none().max_w(320).truncate().text_color(t.foreground).child(it.display))
      .when(it.bot, (el) => el.child(div().h(16).px(4).flex().flex_none().items_center().rounded(4).bg(alpha(t.foreground, 0.08))
        .text_size(10).font_semibold().child("BOT")))
      .when(Boolean(it.sub), (el) => el.child(div().min_w(0).truncate().text_color(alpha(t.foreground, 0.56)).child(it.sub)))
      .when(Boolean(it.emoji), (el) => el.child(it.emoji.path ? image(it.emoji.path).size(16).flex_none() : div().flex_none().child(it.emoji.char ?? "")));
  }

  render() {
    const t = theme();
    const items = this.items();
    const lines = this.lines();
    const shown = lines.slice(this.start, this.start + ROWS + 1);
    const strong = (text) => div().font_bold().child(text);
    return v_flex().id("mm-switcher").size_full().font_family(FONT).text_size(14).text_color(t.foreground).bg(t.background)
      .on_key_down((e, cx) => {
        if (e.keystroke === "up") this.move(-1, cx);
        else if (e.keystroke === "down") this.move(1, cx);
      })
      .child(h_flex().px(32).pt(28).items_center()
        .child(div().flex_1().text_size(22).font_semibold().child("Find Channels"))
        .child(div().id("sw-close").size(32).flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(alpha(t.foreground, 0.56))
          .hover((s) => s.bg(alpha(t.foreground, 0.08)).text_color(t.foreground))
          .on_click(() => this.close()).child(svg("mods/mattermost/icons/x.svg").size(20))))
      .child(h_flex().px(32).pt(6).gap(4).flex_wrap().text_size(12).text_color(alpha(t.foreground, 0.75))
        .child("Type to find a channel. Use").child(strong("UP/DOWN")).child("to browse,").child(strong("ENTER"))
        .child("to select,").child(strong("ESC")).child("to dismiss."))
      .child(h_flex().mx(32).mt(24).h(40).flex_none().px(12).gap(8).items_center().rounded(4).border_2().border_color(t.accent)
        .child(svg("mods/mattermost/icons/search.svg").size(16).flex_none().text_color(alpha(t.foreground, 0.64)))
        .child(Input.new(this.input).flex_1().text_size(14)))
      .child(div().mt(24).h(1).flex_none().bg(alpha(t.foreground, 0.12)))
      .child(v_flex().id("sw-list").flex_1().min_h(0).overflow_hidden().pt(8)
        .on_scroll_wheel((e, cx) => {
          const max = Math.max(0, lines.length - ROWS);
          const next = Math.max(0, Math.min(max, this.start + (e.delta.y < 0 ? 1 : e.delta.y > 0 ? -1 : 0)));
          if (next !== this.start) { this.start = next; cx.notify(); }
        })
        .children(shown.map((l) => (l.head
          ? div().h(32).flex_none().px(32).flex().items_end().pb(8).text_size(12).font_semibold().text_color(alpha(t.foreground, 0.56)).child(l.head)
          : this.row(l.it, l.i, t))))
        .when(Boolean(this.query) && !items.length, (el) => el.child(div().px(32).py(16).text_color(alpha(t.foreground, 0.56))
          .child(`No results for “${this.query}”`)))
        .when(Boolean(this.error), (el) => el.child(div().px(32).py(8).text_size(12).text_color(t.blocked).child(this.error))));
  }
}
