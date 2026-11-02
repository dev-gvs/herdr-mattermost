// Recent Mentions' filters: how they change the search, the chips under the panel's header, and the Filters
// popover, which a popup copy of this mod draws. Sizes are Mattermost's popover over Compass's Combobox,
// Checkbox, Radio, Chip and Button.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popup, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { props, closeOverlay, theme } from "herdr";
import { FONT, alpha } from "../main.js";
import { request } from "./menu.js";

export const FILTERS_W = 320;
// Room for chips to wrap in the channel field, which can't be measured before the popup opens.
export const FILTERS_SPARE = 120;
const FIELD_W = FILTERS_W - 2 - 2 * 16;
const FIELD_H = 40;
const ROW = 36;
const MENU_MAX = 280 - 16;
const ALL_TEAMS = "all_teams";

export const NO_FILTERS = { channelIds: [], mentionTypes: [], date: "any" };
const TYPES = [["direct", "Directly mentioning you"], ["group", "Group mentions"], ["keyword", "Keywords triggering mentions"]];
const DATES = [["any", "Any time"], ["today", "Today"], ["last_7_days", "Last 7 days"]];
const label = (list, key) => list.find(([k]) => k === key)[1];
// They match far more posts than people think of as a mention of them.
const CHANNEL_WIDE = ["@channel", "@all", "@here"];

export const hasMentionFilters = (f, team) => Boolean(team) || f.channelIds.length > 0 || f.mentionTypes.length > 0 || f.date !== "any";

export const countMentionFilters = (f, team) => f.channelIds.length + f.mentionTypes.length + (team ? 1 : 0) + (f.date !== "any" ? 1 : 0);

// No type chosen means every type. `own` is what getCurrentUserMentionKeys gives, `groups` the group keys.
export function mentionKeysForTypes(types, username, own, groups) {
  const mine = own.filter((key) => !CHANNEL_WIDE.includes(key));
  const wants = (type) => !types.length || types.includes(type);
  const keys = [
    ...(wants("direct") ? mine.filter((key) => key === `@${username}`) : []),
    ...(wants("group") ? groups : []),
    ...(wants("keyword") ? mine.filter((key) => key !== `@${username}`) : []),
  ];
  return [...new Set(keys)].filter((key) => key.trim());
}

const pad = (n) => String(n).padStart(2, "0");
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// `after:` leaves out the day it names, so the last 7 days reach back 7 to take in the 6 before today.
function dateModifier(range) {
  const now = new Date();
  if (range === "today") return `on:${dayOf(now)}`;
  if (range !== "last_7_days") return "";
  now.setDate(now.getDate() - 7);
  return `after:${dayOf(now)}`;
}

// Keys are quoted so a key split by dashes stays whole and a keyword such as on:call isn't read as a filter.
// Channels go by id, since a name only identifies a channel within one team; the server tries an `in:`
// value it can't find as a name as an id.
export function mentionQuery(keys, filters) {
  const date = dateModifier(filters.date);
  return [...keys.map((key) => `"${key}"`), ...filters.channelIds.map((id) => `in:${id}`), ...(date ? [date] : [])].join(" ");
}

// A popped-out panel gets its filters as props. Anything it doesn't recognise is dropped rather than searched on,
// since a channel value that isn't an id would add terms of its own to the query.
export function filtersFromProps(p) {
  return {
    channelIds: (Array.isArray(p.mentionChannels) ? p.mentionChannels : []).filter((id) => /^[a-z0-9-]+$/i.test(id)),
    mentionTypes: (Array.isArray(p.mentionTypes) ? p.mentionTypes : []).filter((type) => TYPES.some(([k]) => k === type)),
    date: DATES.some(([k]) => k === p.mentionDate) ? p.mentionDate : "any",
  };
}

export function filtersToProps(f) {
  return {
    ...(f.channelIds.length ? { mentionChannels: f.channelIds } : {}),
    ...(f.mentionTypes.length ? { mentionTypes: f.mentionTypes } : {}),
    ...(f.date !== "any" ? { mentionDate: f.date } : {}),
  };
}

function chipRemove(id, size, pad, t, onRemove) {
  return div().id(id).flex_none().p(pad).rounded_full().cursor_pointer().text_color(alpha(t.foreground, 0.32))
    .hover((s) => s.text_color(alpha(t.foreground, 0.64)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => onRemove(cx))
    .child(svg("mods/mattermost/icons/close-circle.svg").size(size));
}

// The filters narrowing the list, each removable on its own; nothing when none is applied.
export function filterChips(panel, t) {
  const f = panel.mentionFilters, team = panel.mentionTeam;
  const apply = (filters, teamId, cx) => panel.applyMentionFilters(filters, teamId, cx);
  const chip = (id, text, onRemove, icon = null) => h_flex().id(`chip-${id}`).min_w(0).max_w_full().pl(9).pr(7).py(5).gap(4).items_center().rounded(4)
    .bg(alpha(t.foreground, 0.08)).hover((s) => s.bg(alpha(t.foreground, 0.16)))
    .text_size(10).line_height("12px").font_semibold()
    .when(Boolean(icon), (el) => el.child(svg(`mods/mattermost/icons/${icon}.svg`).size(10).flex_none()))
    .child(div().min_w(0).truncate().child(text))
    .child(chipRemove(`chip-x-${id}`, 10, 1, t, onRemove));
  const channelLabel = (id) => {
    const c = panel.filterable?.get(id) ?? panel.channelOf(id);
    if (!c) return "Channel";
    // Without a team filter the chips can span teams, where a channel's name alone is ambiguous.
    const teamName = !team && c.team_id ? panel.teams?.find((x) => x.id === c.team_id)?.display_name : null;
    return teamName ? `${panel.channelName(c)} (${teamName})` : panel.channelName(c);
  };
  const teamName = panel.teams?.find((x) => x.id === team)?.display_name;
  return h_flex().flex_none().flex_wrap().px(16).py(8).gap(8).border_b(1).border_color(alpha(t.foreground, 0.08))
    // The channels were chosen from the team being dropped.
    .when(Boolean(teamName), (el) => el.child(chip("team", teamName, (cx) => apply({ ...f, channelIds: [] }, null, cx))))
    .children(f.channelIds.map((id) => chip(id, channelLabel(id), (cx) => apply({ ...f, channelIds: f.channelIds.filter((x) => x !== id) }, team, cx))))
    .children(TYPES.filter(([k]) => f.mentionTypes.includes(k)).map(([k, text]) => chip(k, text, (cx) => apply({ ...f, mentionTypes: f.mentionTypes.filter((x) => x !== k) }, team, cx))))
    .when(f.date !== "any", (el) => el.child(chip("date", label(DATES, f.date), (cx) => apply({ ...f, date: "any" }, team, cx), "calendar")));
}

// Compass's Combobox, with the label floating onto the border. `spec` has `label`, `multiple`, `placeholder`,
// `empty`, and these as functions: `all` the options, `picked` the chosen values, `pick` and `drop`.
class Combobox {
  constructor(id, spec, cx) {
    this.id = id;
    this.spec = spec;
    this.open = false;
    this.focused = false;
    this.query = "";
    this.active = 0;
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "", value: spec.multiple ? "" : this.pickedLabel() });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.open = true;
      this.active = 0;
      cx.notify();
    });
    this.input.on("focus", (_e, cx) => { this.focused = true; this.show(cx); });
    this.input.on("blur", (_e, cx) => { this.focused = false; this.hide(cx); });
    this.input.on("submit", (_e, cx) => { const o = this.list()[this.active]; if (this.open && o) this.choose(o, cx); });
  }

  pickedLabel() {
    return this.spec.all().find((o) => o.value === this.spec.picked()[0])?.label ?? "";
  }

  list() {
    return this.spec.all().filter((o) => o.matches(this.query));
  }

  show(cx) {
    if (this.open) return;
    this.open = true;
    const list = this.list(), picked = this.spec.picked();
    this.active = Math.max(0, list.findIndex((o) => picked.includes(o.value)));
    this.scroll.scroll_to_item(this.active, "center");
    if (!this.spec.multiple) this.input.set_selected_range({ start: 0, end: this.input.value().length });
    cx.notify();
  }

  hide(cx) {
    if (!this.open) return;
    this.open = false;
    this.active = 0;
    if (!this.spec.multiple) {
      this.query = "";
      this.input.set_value(this.pickedLabel());
    }
    cx.notify();
  }

  // The caller's draft has changed under the box.
  refresh() {
    if (!this.spec.multiple) this.input.set_value(this.pickedLabel());
  }

  choose(o, cx) {
    if (this.spec.multiple) {
      if (this.spec.picked().includes(o.value)) this.spec.drop(o.value);
      else this.spec.pick(o.value);
      this.query = "";
      this.input.set_value("");
    } else {
      this.spec.pick(o.value);
    }
    this.hide(cx);
    cx.notify();
  }

  move(by, cx) {
    if (!this.open) return this.show(cx);
    const n = this.list().length;
    if (!n) return;
    this.active = (this.active + by + n) % n;
    this.scroll.scroll_to_item(this.active, "center");
    cx.notify();
  }

  chip(o, t, bg, cx) {
    return h_flex().id(`${this.id}-chip-${o.value}`).min_w(0).max_w_full().pl(9).pr(7).py(5).gap(4).items_center().rounded(4)
      .bg(alpha(t.foreground, 0.08)).hover((s) => s.bg(alpha(t.foreground, 0.16)))
      .text_size(12).line_height("16px").font_semibold()
      .child(div().min_w(0).truncate().child(o.label))
      .child(chipRemove(`${this.id}-x-${o.value}`, 12, 2, t, (cx) => { this.spec.drop(o.value); cx.notify(); }));
  }

  menu(t, bg, list) {
    const picked = this.spec.picked();
    const row = (o, i) => h_flex().h(ROW).px(16).gap(6).items_center().cursor_pointer()
      .when(i === this.active, (el) => el.bg(alpha(t.accent, 0.08)))
      .hover((s) => s.bg(i === this.active ? alpha(t.accent, 0.12) : alpha(t.foreground, 0.08)))
      .child(h_flex().flex_1().min_w(0).px(4).gap(8).items_center()
        .child(div().min_w(0).truncate().text_size(14).child(o.label))
        .when(Boolean(o.secondary), (el) => el.child(div().flex_none().text_size(12).opacity(0.75).child(o.secondary))))
      .when(picked.includes(o.value), (el) => el.child(div().p(4).flex_none().text_color(t.accent).child(svg("mods/mattermost/icons/check.svg").size(16))));
    const card = v_flex().mt(4).w(FIELD_W).rounded(8).border_1().border_color(alpha(t.foreground, 0.16)).bg(bg).shadow_lg()
      .font_family(FONT).text_color(t.foreground).py(8);
    if (!list.length) return card.child(div().px(16).py(10).text_size(12).line_height("16px").text_color(alpha(t.foreground, 0.64)).child(this.spec.empty));
    const id = `${this.id}-list`;
    return card.child(v_flex().relative().h(Math.min(list.length * ROW, MENU_MAX))
      .child(v_virtual_list(id, list.length, ROW, (i) => list[i].value, (range) => {
        const out = [];
        for (let i = range.start; i < range.end; i++) out.push(row(list[i], i));
        return out;
      })
        .track_scroll(this.scroll)
        .on_item_click((key, cx) => { const o = list.find((x) => x.value === key); if (o) this.choose(o, cx); }))
      .child(Scrollbar.vertical(id).absolute().inset_0()));
  }

  render(t, bg, cx) {
    const { multiple, placeholder, label: name } = this.spec;
    const picked = this.spec.picked(), all = this.spec.all();
    const chips = multiple ? picked.map((v) => all.find((o) => o.value === v)).filter(Boolean) : [];
    const typed = this.input.value().length > 0;
    const floated = this.focused || this.open || typed || (multiple ? chips.length > 0 : picked.length > 0);
    const list = this.open ? this.list() : [];
    const on = this.focused;
    // Two pixels of border when focused, as Compass's double ring, without moving what's inside.
    const field = h_flex().id(this.id).relative().w(FIELD_W).min_h(FIELD_H).items_center().rounded(4).cursor_pointer()
      .when(on, (el) => el.border_2().border_color(t.accent).px(15).py(chips.length ? 7 : 9))
      .when(!on, (el) => el.border_1().border_color(alpha(t.foreground, 0.16)).px(16).py(chips.length ? 8 : 10)
        .hover((s) => s.border_color(alpha(t.foreground, 0.24))))
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.focused = true;
        this.input.focus();
        this.show(cx);
        cx.notify();
      })
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(6).items_center()
        .children(chips.map((o) => this.chip(o, t, bg, cx)))
        .child(div().relative().flex_1().min_w(40)
          .when(floated && !typed && !chips.length && Boolean(placeholder), (el) => el.child(div().absolute().top(0).left(0).w_full().truncate()
            .text_size(14).line_height("20px").text_color(alpha(t.foreground, 0.64)).child(placeholder)))
          .child(Input.new(this.input).text_size(14).h(20))))
      .child(div().flex_none().ml(10).mr(4).text_color(alpha(t.foreground, 0.64))
        .child(svg(`mods/mattermost/icons/chevron-${this.open ? "up" : "down"}.svg`).size(12)));
    // Beside the field rather than in it, since an element's border paints over its children.
    const framed = div().relative().w(FIELD_W).child(field)
      .child(div().absolute().left(12).px(4).bg(bg).when(floated, (el) => el.top(-7).text_size(10).line_height("14px"))
        .when(!floated, (el) => el.top(10).text_size(14).line_height("20px"))
        .text_color(on ? t.accent : alpha(t.foreground, 0.64)).child(name));
    return Popup.new(`${this.id}-menu`, framed).anchor("top_left").when(this.open, (el) => el.content(this.menu(t, bg, list)));
  }
}

export function filtersHeight(showTeams, groups) {
  const section = (rows) => 16 + 8 + rows * 20 + (rows - 1) * 8;
  return 2 + 2 * 16 + (showTeams ? 2 * FIELD_H + 12 : FIELD_H) + 24 + section(groups ? 3 : 2) + 24 + section(3) + 24 + FIELD_H;
}

// What it changes stays a draft until Apply; pressing beside it throws the draft away.
export class FiltersMenu {
  constructor(_view, cx) {
    this.spec = props().filtersMenu;
    this.draft = { ...this.spec.filters };
    this.team = this.spec.team;
    this.teamBox = new Combobox("mf-team", {
      label: "Team",
      all: () => [{ id: ALL_TEAMS, label: "All teams" }, ...this.spec.teams].map((x) => ({
        value: x.id, label: x.label, matches: (q) => !q || x.label.toLowerCase().includes(q.toLowerCase()),
      })),
      picked: () => [this.team ?? ALL_TEAMS],
      pick: (v) => {
        this.team = v === ALL_TEAMS ? null : v;
        // The chosen channels belong to the team being left.
        this.draft = { ...this.draft, channelIds: [] };
      },
      drop: () => {},
      empty: "No results",
    }, cx);
    this.channelBox = new Combobox("mf-channels", {
      label: "Channel or Direct Messages",
      placeholder: "Channel or Direct Messages",
      multiple: true,
      all: () => this.spec.channels.filter((c) => !this.team || !c.team || c.team === this.team).map((c) => ({
        value: c.id, label: c.label,
        secondary: !this.team && c.team ? this.spec.teamNames[c.team] : "",
        matches: (q) => {
          const term = q.trim().toLowerCase();
          return !term || c.label.toLowerCase().includes(term) || c.name.toLowerCase().includes(term);
        },
      })),
      picked: () => this.draft.channelIds,
      pick: (v) => { this.draft = { ...this.draft, channelIds: [...this.draft.channelIds, v] }; },
      drop: (v) => { this.draft = { ...this.draft, channelIds: this.draft.channelIds.filter((x) => x !== v) }; },
      empty: "No channels found",
    }, cx);
    this.boxes = [this.teamBox, this.channelBox];
  }

  close() {
    closeOverlay(props().overlay);
  }

  isReset() {
    return !this.team && !this.draft.channelIds.length && !this.draft.mentionTypes.length && this.draft.date === "any";
  }

  reset(cx) {
    this.draft = { ...NO_FILTERS };
    this.team = null;
    for (const box of this.boxes) box.refresh();
    cx.notify();
  }

  apply() {
    request("mention-filters", { filters: this.draft, team: this.team });
    this.close();
  }

  section(title, t, rows) {
    return v_flex().flex_none().gap(8)
      .child(div().text_size(12).line_height("16px").font_semibold().text_color(alpha(t.foreground, 0.75)).child(title.toUpperCase()))
      .child(v_flex().gap(8).children(rows));
  }

  checkbox(key, text, on, t, onClick) {
    return h_flex().id(`mf-${key}`).w_full().gap(10).items_start().cursor_pointer().on_click(onClick)
      .child(div().mt(2).size(16).flex_none().flex().items_center().justify_center().rounded(2).border_1()
        .border_color(on ? t.accent : alpha(t.foreground, 0.24)).when(on, (el) => el.bg(t.accent).text_color(t.accent_foreground)
          .child(svg("mods/mattermost/icons/check.svg").size(12))))
      .child(div().text_size(14).line_height("20px").child(text));
  }

  radio(key, text, on, t, onClick) {
    return h_flex().id(`mf-${key}`).w_full().gap(8).items_start().cursor_pointer().on_click(onClick)
      .child(div().mt(2).size(16).flex_none().flex().items_center().justify_center().rounded_full().border_1()
        .border_color(on ? t.accent : alpha(t.foreground, 0.24)).when(on, (el) => el.child(div().size(8).rounded_full().bg(t.accent))))
      .child(div().text_size(14).line_height("20px").child(text));
  }

  footerButton(id, text, primary, enabled, t, onClick) {
    return div().id(id).h(FIELD_H).px(20).flex().flex_none().items_center().justify_center().rounded(4).text_size(14).font_semibold()
      .when(primary, (el) => el.bg(t.accent).text_color(t.accent_foreground).hover((s) => s.opacity(0.92)))
      .when(!primary && enabled, (el) => el.bg(alpha(t.accent, 0.08)).text_color(t.accent).hover((s) => s.bg(alpha(t.accent, 0.12))))
      .when(!enabled, (el) => el.bg(alpha(t.foreground, 0.08)).text_color(alpha(t.foreground, 0.32)))
      .when(enabled, (el) => el.cursor_pointer().on_click(onClick))
      .child(text);
  }

  render(cx) {
    const t = theme(), bg = t.background;
    const { showTeams, groups, height, up, short } = this.spec;
    const types = TYPES.filter(([k]) => k !== "group" || groups);
    // A scroll area fills its parent, so it's only one where the panel is too short for the card.
    const card = v_flex().id("mf-card").w(FILTERS_W).when(short, (el) => el.h_full().overflow_y_scrollbar()).p(16).gap(24).rounded(8).border_1().border_color(alpha(t.foreground, 0.16))
      .bg(bg).shadow_lg().font_family(FONT).text_color(t.foreground)
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); for (const box of this.boxes) box.hide(cx); })
      .child(v_flex().flex_none().gap(12)
        .when(showTeams, (el) => el.child(this.teamBox.render(t, bg, cx)))
        .child(this.channelBox.render(t, bg, cx)))
      .child(this.section("Mention type", t, types.map(([k, text]) => {
        const on = this.draft.mentionTypes.includes(k);
        return this.checkbox(k, text, on, t, (_e, cx) => {
          this.draft = { ...this.draft, mentionTypes: on ? this.draft.mentionTypes.filter((x) => x !== k) : [...this.draft.mentionTypes, k] };
          cx.notify();
        });
      })))
      .child(this.section("Date", t, DATES.map(([k, text]) => this.radio(k, text, this.draft.date === k, t, (_e, cx) => {
        this.draft = { ...this.draft, date: k };
        cx.notify();
      }))))
      .child(h_flex().flex_none().justify_between().items_center()
        .child(this.footerButton("mf-reset", "Reset", false, !this.isReset(), t, (_e, cx) => this.reset(cx)))
        .child(this.footerButton("mf-apply", "Apply", true, true, t, () => this.apply())));
    // Taller than the card, so it can grow while chips wrap; a press on what's left over counts as beside it.
    return v_flex().id("mm-filters").w(FILTERS_W).h(height).when(up, (el) => el.justify_end())
      .on_mouse_down("left", () => this.close())
      .on_key_down((e, cx) => {
        const box = this.boxes.find((b) => b.focused || b.open);
        if (e.keystroke === "up") box?.move(-1, cx);
        else if (e.keystroke === "down") box?.move(1, cx);
        else if (e.keystroke === "backspace" && box?.spec.multiple && !box.input.value() && box.spec.picked().length) {
          box.spec.drop(box.spec.picked().at(-1));
          cx.notify();
        }
      })
      .child(card);
  }
}
