// Mattermost's emoji picker, drawn by a popup copy of this mod: search, category tabs, recently used
// (the server's recent_emojis preference, named by the user's id and shared with the official apps), every standard emoji and the
// server's custom ones. Picking one reacts to the post; the panel sees it in the reaction_added event.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, exec, readTextFile, appHome } from "herdr";
import { FONT, alpha } from "../main.js";
import { Media } from "./media.js";

export const PICKER_W = 360, PICKER_H = 432;
const COLS = 9, CELL = 36, HEAD = 28, MAX_RECENT = 27;
const TABS = [
  ["recent", "clock", "Recently Used"], ["smileys-emotion", "smile", "Smileys & Emotion"], ["people-body", "user", "People & Body"],
  ["animals-nature", "leaf", "Animals & Nature"], ["food-drink", "apple", "Food & Drink"], ["travel-places", "plane", "Travel & Places"],
  ["activities", "volleyball", "Activities"], ["objects", "lightbulb", "Objects"], ["symbols", "heart", "Symbols"], ["flags", "flag", "Flags"],
  ["custom", "smile-plus", "Custom"],
];

export class EmojiPicker {
  constructor(view, cx) {
    this.view = view;
    this.spec = props().picker;
    this.media = new Media();
    this.media.demo = Boolean(props()?.demo);
    this.sections = [];
    this.byName = new Map();
    this.custom = [];
    this.recent = [];
    this.offset = 0;
    this.hover = null;
    this.query = "";
    this.search = InputState.new({ placeholder: "Search emojis" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); this.offset = 0; cx.notify(); });
    this.search.on("submit", (_e, cx) => { const first = this.items()[0]; if (first) this.pick(first, cx); });
    this.search.focus();
    cx.timer.every(400, (cx) => {
      if (this.media.pending() && this.view.cfg) cx.spawn(async (cx) => { if (await this.media.flush(this.view.cfg)) cx.notify(); });
    });
    cx.spawn(async (cx) => {
      try {
        await this.view.cfgReady;
        await this.media.scan();
        const cats = JSON.parse(await readTextFile(`${appHome()}/mods/mattermost/emoji/picker.json`) ?? "[]");
        for (const [, list] of cats) for (const [name, char, aliases] of list) this.byName.set(name, { name, char, search: aliases ? `${name} ${aliases}` : name });
        this.sections = cats.map(([key, list]) => ({ key, items: list.map(([name]) => this.byName.get(name)) }));
        cx.notify();
        await Promise.all([this.loadRecent(cx), this.loadCustom(cx)]);
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  async loadRecent(cx) {
    try {
      const prefs = await this.view.api(cx, `/users/${this.spec.me}/preferences/recent_emojis`);
      this.recentRaw = JSON.parse(prefs.find((x) => x.name === this.spec.me)?.value ?? "[]");
    } catch {
      this.recentRaw = [];
    }
  }

  async loadCustom(cx) {
    for (let page = 0; ; page++) {
      const list = await this.view.api(cx, `/emoji?page=${page}&per_page=200&sort=name`);
      for (const e of list) {
        const item = { name: e.name, id: e.id, search: e.name };
        this.byName.set(e.name, item);
        this.custom.push(item);
      }
      if (list.length < 200) break;
    }
  }

  close() {
    closeOverlay(props().overlay);
  }

  recentItems() {
    return [...(this.recentRaw ?? [])].sort((a, b) => b.usageCount - a.usageCount)
      .map((r) => this.byName.get(r.name)).filter(Boolean).slice(0, MAX_RECENT);
  }

  allSections() {
    const recent = this.recentItems();
    return [
      ...(recent.length ? [{ key: "recent", items: recent }] : []),
      ...this.sections,
      ...(this.custom.length ? [{ key: "custom", items: this.custom }] : []),
    ];
  }

  items() {
    if (!this.query) return [];
    const q = this.query.replace(/^:|:$/g, "");
    const all = [...this.byName.values()].filter((e) => e.search.includes(q));
    return all.sort((a, b) => (b.name.startsWith(q) - a.name.startsWith(q)) || a.name.length - b.name.length);
  }

  // Lines of the scroll area, each with its height: section headings and rows of nine.
  lines() {
    if (this.query) {
      const found = this.items();
      const out = [];
      for (let i = 0; i < found.length; i += COLS) out.push({ h: CELL, row: found.slice(i, i + COLS) });
      return out;
    }
    const out = [];
    for (const s of this.allSections()) {
      out.push({ h: HEAD, head: TABS.find(([k]) => k === s.key)?.[2] ?? s.key, key: s.key });
      for (let i = 0; i < s.items.length; i += COLS) out.push({ h: CELL, row: s.items.slice(i, i + COLS), key: s.key });
    }
    return out;
  }

  pick(e, cx) {
    const { me, post } = this.spec;
    cx.spawn(async (cx) => {
      try {
        await this.view.api(cx, "/reactions", { method: "POST", body: { user_id: me, post_id: post, emoji_name: e.name } });
        const recent = (this.recentRaw ?? []).filter((r) => r.name !== e.name);
        const was = (this.recentRaw ?? []).find((r) => r.name === e.name)?.usageCount ?? 0;
        recent.push({ name: e.name, usageCount: was + 1 });
        recent.sort((a, b) => a.usageCount - b.usageCount);
        await this.view.api(cx, `/users/${me}/preferences`, { method: "PUT", body: [{ user_id: me, category: "recent_emojis", name: me, value: JSON.stringify(recent) }] });
      } catch (err) {
        this.error = String(err?.message ?? err);
        cx.notify();
        return;
      }
      this.close();
    });
  }

  glyph(e, size) {
    const path = e.id ? this.media.emoji(e.id) : this.view.cfg ? this.media.standard(this.view.cfg.url, e.char) : null;
    return path ? image(path).size(size).flex_none() : div().text_size(Math.round(size * 0.85)).child(e.char ?? "");
  }

  cell(e, t) {
    const on = this.hover?.name === e.name;
    return div().id(`em-${e.name}`).size(CELL).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
      .when(on, (el) => el.bg(alpha(t.foreground, 0.08)))
      .on_hover((hovered, cx) => { if (hovered && this.hover !== e) { this.hover = e; cx.notify(); } })
      .on_click((_e, cx) => this.pick(e, cx))
      .child(this.glyph(e, 24));
  }

  render() {
    const t = theme();
    const lines = this.lines();
    const total = lines.reduce((h, l) => h + l.h, 0);
    // A frameless popup is as tall as its content, and the grid's content is positioned out of flow,
    // so the grid gets the height the popup opened with (less when the panel is short).
    const viewH = (this.spec.height ?? PICKER_H) - 2 - 56 - 40 - 64;
    this.offset = Math.max(0, Math.min(this.offset, total - viewH));
    // Only what's in view is built: the full grid is thousands of images.
    const out = [];
    let y = 0, gap = 0, active = null;
    for (const l of lines) {
      if (y <= this.offset) active = l.key ?? active;
      if (y + l.h < this.offset - CELL || y > this.offset + viewH + CELL) gap += l.h;
      else {
        if (gap) out.push(div().h(gap).flex_none());
        gap = 0;
        out.push(l.head
          ? div().h(l.h).flex_none().px(12).flex().items_end().pb(6).text_size(12).font_semibold().text_color(alpha(t.foreground, 0.56)).child(l.head.toUpperCase())
          : h_flex().h(l.h).flex_none().px(8).children(l.row.map((e) => this.cell(e, t))));
      }
      y += l.h;
    }
    const starts = new Map();
    y = 0;
    for (const l of lines) { if (l.head) starts.set(l.key, y); y += l.h; }
    const tab = ([key, ic, title]) => {
      const on = !this.query && active === key;
      const there = starts.has(key);
      return div().id(`tab-${key}`).size(28).flex_none().flex().items_center().justify_center().rounded(4)
        .text_color(on ? t.accent : alpha(t.foreground, there ? 0.56 : 0.24)).when(on, (el) => el.bg(alpha(t.accent, 0.08)))
        .when(there, (el) => el.cursor_pointer().hover((s) => s.text_color(on ? t.accent : t.foreground))
          .on_click((_e, cx) => { this.search.set_value(""); this.query = ""; this.offset = starts.get(key); cx.notify(); }))
        .tooltip(title)
        .child(svg(`mods/mattermost/icons/${ic}.svg`).size(18));
    };
    const shown = this.hover;
    return v_flex().id("mm-picker").w_full().h(this.spec.height ?? PICKER_H).font_family(FONT).text_size(14).text_color(t.foreground)
      .rounded(4).border_1().border_color(alpha(t.foreground, 0.16)).bg(t.background).shadow_lg().overflow_hidden()
      .child(div().h(56).flex_none().px(12).pt(12).pb(8)
        .child(h_flex().h_full().px(10).gap(8).items_center().rounded(4).border_1().border_color(t.accent)
          .child(svg("mods/mattermost/icons/search.svg").size(16).flex_none().text_color(alpha(t.foreground, 0.64)))
          .child(Input.new(this.search).flex_1().text_size(14))))
      .child(h_flex().h(40).flex_none().px(8).justify_between().items_center().border_b(1).border_color(alpha(t.foreground, 0.16))
        .children(TABS.map(tab)))
      .child(div().id("picker-grid").relative().h(viewH).flex_none().overflow_hidden()
        .on_scroll_wheel((e, cx) => { this.offset = Math.max(0, Math.min(total - viewH, this.offset + e.delta.y * -1)); cx.notify(); })
        .child(v_flex().absolute().left(0).right(0).top(-this.offset)
          .children(out)
          .when(Boolean(this.query) && !lines.length, (el) => el.child(div().p(16).text_color(t.dim).child(`No results for “${this.query}”`)))))
      .child(h_flex().h(64).flex_none().px(16).gap(10).items_center().border_t(1).border_color(alpha(t.foreground, 0.16))
        .when(Boolean(shown), (el) => el.child(this.glyph(shown, 32)).child(div().flex_1().min_w(0).truncate().text_color(alpha(t.foreground, 0.75)).child(`:${shown.name}:`)))
        .when(!shown, (el) => el.child(div().flex_1().text_color(alpha(t.foreground, 0.56)).child(this.error ?? "Select an Emoji")))
        .child(div().id("custom-emoji").h(32).px(16).flex().flex_none().items_center().rounded(4).cursor_pointer().text_size(12).font_semibold()
          .bg(alpha(t.accent, 0.08)).text_color(t.accent).hover((s) => s.bg(alpha(t.accent, 0.16)))
          .on_click(() => { exec("xdg-open", [`${this.view.cfg.url}/${this.spec.team}/emoji`]); this.close(); })
          .child("Custom Emoji")));
  }
}
