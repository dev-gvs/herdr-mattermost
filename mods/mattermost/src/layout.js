// The reading pane: every section is a list and a reader showing what's picked in it. This file has what all of
// them share (the section tabs, the rail, the folder strip, the one list row, headers and empty states) and the
// two sections with no module of their own, Drafts and You. Narrow stacks the list over the reader, medium puts it
// beside, and full adds a rail and keeps a details column open.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";
import { alpha, clock, MONTHS } from "../main.js";

export const NARROW = 620, FULL = 1500;
export const CONTEXT_W = { m: 360, f: 460 };
const READER_MIN = 420;
export const ROW_H = 56;
const STRIP_H = 40;
// Space before a strip's first tab, so its pill lines up with the rows' avatars.
const STRIP_PAD = 12;
const TAB_PAD = 9;
// How far past the edge a strip scrolls to show the picked tab.
const REVEAL = 60;
// Jira's and the mock's violet for what Claude does, and amber for a warning; the theme has neither.
export const VIOLET = "#b89cff";
export const AMBER = "#f0b44c";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const SECTIONS = [
  ["find", "Find", "search"],
  ["chats", "Chats", "message-circle"],
  ["threads", "Threads", "message-square"],
  ["jira", "Jira", "bell"],
  ["drafts", "Drafts", "pencil"],
  ["me", "You", "user"],
];

const zoom = () => Number(settings()?.zoom) || 1;
const icon = (name, size = 16) => svg(`mods/mattermost/icons/${name}.svg`).size(size).flex_none();

export const modeOf = (w) => (w < NARROW ? "n" : w < FULL ? "m" : "f");
export const listWidth = (mode, w) => (mode === "f" ? 400 : Math.round(Math.max(280, Math.min(360, w * 0.3))));
// A thread or details sit beside the reader while it keeps room to read, and replace it otherwise.
export const contextBeside = (mode, w) => mode === "f" || (mode === "m" && w - listWidth(mode, w) - CONTEXT_W.m >= READER_MIN);

// A list's time: the clock today, the weekday this week, else the date.
export function shortTime(ms) {
  if (!ms) return "";
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(ms);
  if (now - d < 6 * 86400e3) return WEEKDAYS[d.getDay()];
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() === now.getFullYear() ? "" : `, ${d.getFullYear()}`}`;
}

export function countBadge(n, t, red, small = false) {
  return div().min_w(small ? 15 : 17).h(small ? 15 : 17).px(small ? 3 : 5).flex_none().flex().items_center().justify_center().rounded(9)
    .bg(red ? t.blocked : t.accent).text_color(red ? t.background : t.accent_foreground).text_size(10).line_height("10px").font_semibold()
    .child(String(n));
}

export const unreadDot = (t) => div().size(7).flex_none().rounded_full().bg(t.accent);

export const iconTile = (name, t, size = 36) => div().size(size).flex_none().rounded_full().bg(alpha(t.foreground, 0.08)).flex().items_center().justify_center()
  .text_color(t.muted).child(icon(name, 15));

export function iconButton(id, t, name, tip, onClick, { on = false, label = null } = {}) {
  return h_flex().id(id).min_w(26).h(26).px(4).gap(4).flex_none().items_center().justify_center().rounded(5).cursor_pointer()
    .text_size(11).text_color(on ? t.accent : t.muted).hover((s) => s.bg(t.hover).text_color(on ? t.accent : t.foreground))
    .tooltip(tip)
    .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); onClick(e, cx); })
    .child(icon(name, 15))
    .when(label != null, (el) => el.child(div().child(String(label))));
}

export function button(id, t, label, onClick, { primary = false, danger = false, iconName = null, disabled = false } = {}) {
  return h_flex().id(id).h(29).px(11).gap(6).flex_none().items_center().rounded(6).text_size(13)
    .when(!danger, (el) => el.bg(primary ? t.accent : alpha(t.foreground, 0.08)))
    .text_color(primary ? t.accent_foreground : danger ? t.blocked : t.foreground).when(primary, (el) => el.font_semibold())
    .when(disabled, (el) => el.opacity(0.5))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => (primary ? s.opacity(0.88) : s.bg(t.hover))).on_click(onClick))
    .when(Boolean(iconName), (el) => el.child(icon(iconName, 13)))
    .child(label);
}

export function header(t, ...children) {
  return h_flex().h(38).flex_none().px(11).gap(8).items_center().border_b_1().border_color(t.border)
    .text_size(14).font_semibold().text_color(t.foreground).children(children);
}

export const headerNote = (t, text) => div().min_w(0).truncate().text_size(12).font_normal().text_color(t.muted).child(text);

export function empty(t, name, title, text = null) {
  return v_flex().flex_1().size_full().items_center().justify_center().gap(6).p(24).text_size(13).text_color(t.muted).text_center()
    .child(icon(name, 24).text_color(t.dim))
    .child(div().font_semibold().text_color(t.foreground).child(title))
    .when(Boolean(text), (el) => el.child(div().child(text)));
}

export const nothingPicked = (t) => empty(t, "message-circle", "Nothing selected", "Pick something from the list.");

export const sectionHeading = (t, text) => div().flex_none().px(12).pt(10).pb(4).text_size(11).font_semibold().text_color(t.dim).child(text);

// The one row every list uses: a 36px picture, the title and its time, then a line of preview with a mention
// count or an unread dot.
export function listRow(o, t) {
  const sel = Boolean(o.selected);
  return h_flex().id(o.id).relative().w_full().h(ROW_H).flex_none().px(12).gap(11).items_center().cursor_pointer().text_size(13)
    .when(sel, (el) => el.bg(t.selected)).hover((s) => s.bg(sel ? t.selected : t.hover))
    .when(Boolean(o.onClick), (el) => el.on_click(o.onClick))
    .when(Boolean(o.onMenu), (el) => el.on_mouse_down("right", (e, cx) => { cx.stop_propagation(); o.onMenu(e, cx); }))
    .child(div().flex_none().when(Boolean(o.muted), (el) => el.opacity(0.4)).child(o.icon))
    .child(v_flex().flex_1().min_w(0).when(Boolean(o.muted), (el) => el.opacity(0.4))
      .child(h_flex().h(18).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().line_height("18px")
          .text_color(o.unread || sel ? t.foreground : alpha(t.foreground, 0.86)).when(Boolean(o.unread), (el) => el.font_semibold()).child(o.title))
        .when(Boolean(o.time), (el) => el.child(div().flex_none().text_size(11).text_color(sel ? alpha(t.foreground, 0.75) : t.dim).child(o.time))))
      .child(h_flex().h(16).gap(8).items_center().text_size(12).line_height("16px").text_color(sel ? alpha(t.foreground, 0.75) : t.muted)
        .child(div().flex_1().min_w(0).truncate().child(o.preview || ""))
        .when(o.badge > 0, (el) => el.child(countBadge(o.badge, t, true)))
        .when(!(o.badge > 0) && Boolean(o.dot), (el) => el.child(unreadDot(t)))))
    .children(o.extra ?? []);
}

export function scrollList(id, rows) {
  return v_flex().id(id).flex_1().min_h(0).overflow_y_scrollbar().pb(8).children(rows);
}

// Tabs over the list in narrow and medium panels: labels under the icons when narrow, icons alone when not.
export function sectionTabs(panel, t, mode) {
  const narrow = mode === "n";
  return h_flex().h(narrow ? 44 : 38).flex_none().border_b_1().border_color(t.border)
    .when(panel.frame, (el) => el.rounded_t(9))
    .children(panel.sections().map(([key, label, name]) => {
      const on = panel.section === key, n = panel.sectionBadge(key);
      // The highlight is inset because a square one would poke through the rounded corners of the block around the panel.
      return div().relative().flex_1().min_w(0).h_full().p(3)
        .child(v_flex().id(`tab-${key}`).size_full().rounded(7).items_center().justify_center().gap(2).cursor_pointer()
          .text_size(11).font_semibold().text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(label)
          .on_click((_e, cx) => panel.showSection(key, cx))
          .child(icon(name, narrow ? 16 : 17))
          .when(narrow, (el) => el.child(div().line_height("14px").child(label))))
        .when(on, (el) => el.child(div().absolute().left(0).right(0).bottom(0).h(2).bg(t.accent)))
        .when(n.count > 0, (el) => el.child(h_flex().absolute().top(3).left(0).right(0)
          .child(div().flex_1()).child(h_flex().flex_1().pl(11).child(countBadge(n.count, t, n.red, true)))));
    }));
}

// The full panel's rail: the sections with their names, and you at the bottom.
export function rail(panel, t) {
  const item = ([key, label, name]) => {
    const on = panel.section === key, n = panel.sectionBadge(key);
    return h_flex().id(`rail-${key}`).relative().h(32).flex_none().px(14).gap(10).items_center().cursor_pointer().text_size(13)
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
      .on_click((_e, cx) => panel.showSection(key, cx))
      .when(on, (el) => el.child(div().absolute().left(0).top(0).bottom(0).w(2).bg(t.accent)))
      .child(icon(name, 16)).child(div().flex_1().min_w(0).truncate().child(label))
      .when(n.count > 0, (el) => el.child(countBadge(n.count, t, n.red)));
  };
  const me = panel.me && panel.users.get(panel.me.id);
  const on = panel.section === "me";
  const custom = panel.myCustomStatus();
  return v_flex().w(220).flex_none().h_full().py(8).border_r_1().border_color(t.border)
    .children(panel.sections().filter(([key]) => key !== "me").map(item))
    .child(div().flex_1())
    .when(Boolean(me), (el) => el.child(h_flex().id("rail-me").relative().h(42).flex_none().px(14).gap(10).items_center().cursor_pointer()
      .text_size(13).text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
      .on_click((_e, cx) => panel.showSection("me", cx))
      .when(on, (el) => el.child(div().absolute().left(0).top(0).bottom(0).w(2).bg(t.accent)))
      .child(panel.withStatus(me.id, panel.avatar(me.id, 26, t), 26, 13, 9, 15, t))
      .child(div().flex_1().min_w(0).truncate().child(panel.userName(me.id)))
      .when(Boolean(custom?.emoji), (el) => el.child(panel.emojiEl(panel.emojiToken(custom.emoji), 16, t)))));
}

// A row of folder tabs with a pill behind the picked one. Its tabs measure themselves, since text can't be measured
// from here: the pill and the scrolling follow those sizes. `stretch` spreads the tabs over the row while they fit,
// and shortens the first one's label to `short` when they don't.
export function strip(panel, t, { id, tabs, current, stretch = false, onPick, right = [] }) {
  const st = panel.strips[id] ??= { offset: 0, viewW: 0, sizes: new Map(), longLabel: 0, shown: null };
  const notify = (cx) => cx.notify(panel.sidePart);
  const measured = tabs.every((tab) => st.sizes.get(tab.key)?.w && st.sizes.get(tab.key)?.lw);
  // Whether the tabs fit is judged by their natural widths, with the first label long, so shortening it can't flip
  // the answer back.
  let short = false;
  if (stretch && measured && st.viewW) {
    const natural = tabs.reduce((sum, tab, i) => sum + 2 * TAB_PAD + (i === 0 && st.longLabel ? st.longLabel : st.sizes.get(tab.key).lw), 2 * STRIP_PAD);
    short = natural > st.viewW + 1;
  }
  let left = STRIP_PAD;
  const at = new Map();
  for (const tab of tabs) {
    const s = st.sizes.get(tab.key);
    at.set(tab.key, { left, w: s?.w ?? 0, lw: s?.lw ?? 0 });
    left += s?.w ?? 0;
  }
  const total = left + STRIP_PAD;
  const pick = at.get(current);
  if (measured && st.viewW && pick && st.shown !== current) {
    const from = pick.left - REVEAL, to = pick.left + pick.w + REVEAL - st.viewW;
    if (st.offset > from) st.offset = Math.max(0, from);
    else if (st.offset < to) st.offset = to;
    st.shown = current;
  }
  st.offset = Math.max(0, Math.min(st.offset, Math.max(0, total - st.viewW)));
  const pill = measured && pick ? div().absolute().top(8).h(24).rounded(12).bg(alpha(t.accent, 0.14))
    .left(pick.left + (pick.w - pick.lw) / 2 - TAB_PAD - 0.5).w(pick.lw + 2 * TAB_PAD + 1)
    .transition("left", { duration: 320, easing: "ease-out" }).transition("width", { duration: 320, easing: "ease-out" }) : null;
  const tabEl = (tab, i) => {
    const on = tab.key === current;
    const label = i === 0 && short && tab.short ? tab.short : tab.label;
    return h_flex().id(`ft-${id}-${tab.key}`).relative().h_full().px(TAB_PAD).items_center().justify_center().cursor_pointer()
      .when(stretch, (el) => el.flex_grow(1).flex_shrink_0()).when(!stretch, (el) => el.flex_none())
      .text_size(11).font_semibold().text_color(on ? t.accent : t.muted).hover((s) => s.text_color(on ? t.accent : t.foreground))
      .on_size_change((size, cx) => {
        const s = st.sizes.get(tab.key) ?? {}, w = size.width / zoom();
        if (Math.abs((s.w ?? 0) - w) < 0.5) return;
        st.sizes.set(tab.key, { ...s, w });
        notify(cx);
      })
      .on_click((_e, cx) => onPick(tab.key, cx))
      .when(Boolean(tab.menu), (el) => el.on_mouse_down("right", (e, cx) => { cx.stop_propagation(); tab.menu(e, cx); }))
      .child(h_flex().flex_none().gap(4).items_center()
        .on_size_change((size, cx) => {
          const s = st.sizes.get(tab.key) ?? {}, lw = size.width / zoom();
          if (i === 0 && label === tab.label) st.longLabel = lw;
          if (Math.abs((s.lw ?? 0) - lw) < 0.5) return;
          st.sizes.set(tab.key, { ...s, lw });
          notify(cx);
        })
        .child(div().flex_none().child(label))
        .when(tab.count > 0, (el) => el.child(div().min_w(15).h(15).px(4).flex().items_center().justify_center().rounded(8)
          .bg(on ? t.accent : t.dim).text_color(t.background).text_size(10).line_height("10px").font_semibold().child(String(tab.count)))));
  };
  return h_flex().id(`fs-${id}`).h(STRIP_H).flex_none().items_center().border_b_1().border_color(t.border)
    .child(div().id(`fs-${id}-view`).relative().flex_1().min_w(0).h_full().overflow_hidden()
      .on_size_change((size, cx) => {
        const w = size.width / zoom();
        if (Math.abs(w - st.viewW) < 0.5) return;
        st.viewW = w;
        notify(cx);
      })
      .on_scroll_wheel((e, cx) => {
        const next = Math.max(0, Math.min(st.offset - (e.delta.x || e.delta.y), Math.max(0, total - st.viewW)));
        if (next === st.offset) return;
        st.offset = next;
        notify(cx);
      })
      .child(h_flex().absolute().top(0).h(STRIP_H).left(-st.offset).px(STRIP_PAD).when(stretch, (el) => el.min_w(st.viewW || "100%"))
        .children(pill ? [pill] : []).children(tabs.map(tabEl))))
    .when(right.length > 0, (el) => el.child(h_flex().flex_none().pr(8).gap(2).items_center().children(right)));
}

function draftWhere(panel, d) {
  const c = panel.channels.get(d.channel_id);
  const direct = c?.type === "D" || c?.type === "G";
  return d.root_id ? `Thread ${direct ? "to" : "in"}:` : direct ? "To:" : "In:";
}

function draftAge(d) {
  return Date.now() - d.update_at < 60e3 ? "now" : shortTime(d.update_at);
}

export function draftsList(panel, t) {
  const list = panel.filedDrafts();
  if (!list.length) return empty(t, "pencil", "No drafts at the moment", "Any messages you've started will show here.");
  return scrollList("draft-list", list.map((d) => {
    const key = panel.draftKeyOf(d), files = d.file_ids?.length ?? 0;
    return listRow({
      id: `dr-${key}`, icon: iconTile("pencil", t), title: `${draftWhere(panel, d)} ${panel.channelName(panel.channels.get(d.channel_id))}`,
      preview: panel.preview(d.message) || (files ? `${files} ${files === 1 ? "attachment" : "attachments"}` : ""), time: draftAge(d),
      selected: panel.draftSel === key, onClick: (_e, cx) => panel.selectDraft(key, cx),
    }, t);
  }));
}

// The reader is the editor: the conversation's own message box, bound to the draft, with send in it.
export function draftReader(panel, t) {
  const d = panel.selectedDraft();
  if (!d) return panel.filedDrafts().length ? nothingPicked(t) : empty(t, "pencil", "No drafts at the moment", "Any messages you've started will show here.");
  const key = panel.draftKeyOf(d), c = panel.channels.get(d.channel_id), name = panel.channelName(c);
  const asking = panel.draftAsk?.key === key;
  const box = d.root_id ? panel.threadInput : panel.input;
  return v_flex().flex_1().min_w(0).h_full()
    .child(header(t, icon("pencil", 14), div().flex_none().child("Draft"), headerNote(t, `${draftWhere(panel, d)} ${name}`), div().flex_1(),
      iconButton("dr-delete", t, "trash", "Delete draft", (_e, cx) => { panel.draftAsk = { key, action: "delete" }; panel.redraw(cx); })))
    .child(v_flex().id("draft-page").flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().w_full().max_w(760).mx_auto().px(18).py(16).gap(12)
        .child(div().text_size(12).text_color(t.muted).child(`${draftWhere(panel, d)} ${name} · saved ${draftAge(d)}`))
        .child(panel.composer(t, box))
        .child(h_flex().flex_wrap().gap(6).items_center()
          .when(asking, (el) => el
            .child(div().text_size(13).text_color(t.foreground).child("Delete this draft?"))
            .child(button("dr-no", t, "Cancel", (_e, cx) => { panel.draftAsk = null; panel.redraw(cx); }))
            .child(button("dr-yes", t, "Delete", (_e, cx) => { panel.draftAsk = null; panel.clearDraft(key, cx); panel.redraw(cx); }, { primary: true })))
          .when(!asking, (el) => el
            .child(button("dr-open", t, d.root_id ? "Open thread" : "Open conversation", (_e, cx) => cx.spawn(async (cx) => panel.editDraft(d, cx))))))));
}

const ME_ROWS = [
  ["profile", "Profile", "user", "Name, username, email"],
  ["status", "Status", "smile", null],
  ["security", "Security", "lock", "Password, access tokens, sessions"],
];

const STATUS_ROWS = [["online", "Online", "#3db887"], ["away", "Away", "#f5ab00"], ["dnd", "Do not disturb", "#d24b4e"], ["offline", "Offline", "#afb3c0bf"]];

export function meList(panel, t) {
  const status = panel.statuses.get(panel.me?.id) ?? "offline";
  const custom = panel.myCustomStatus();
  const statusText = [STATUS_ROWS.find(([k]) => k === status)?.[1] ?? (status === "ooo" ? "Out of office" : status), custom?.text].filter(Boolean).join(", ");
  return scrollList("me-list", ME_ROWS.map(([key, title, name, sub]) => listRow({
    id: `me-${key}`, icon: iconTile(name, t), title, preview: sub ?? statusText,
    selected: panel.meSel === key, onClick: (_e, cx) => { panel.meSel = key; panel.redraw(cx); },
  }, t)));
}

const field = (t, label, value) => v_flex().gap(4)
  .child(div().text_size(12).text_color(t.muted).child(label))
  .child(div().min_h(34).px(10).flex().items_center().rounded(6).border_1().border_color(t.input).text_size(13)
    .text_color(value ? t.foreground : t.dim).child(value || "Not set"));

const card = (t) => v_flex().p(12).gap(6).rounded(8).border_1().border_color(t.border).bg(alpha(t.foreground, 0.08));

// Profile, status and security on the page model. The forms that change a profile or a password stay in the
// Profile dialog, which these pages open.
export function meReader(panel, t) {
  const key = panel.meSel ?? "profile";
  const [, title, name] = ME_ROWS.find(([k]) => k === key) ?? ME_ROWS[0];
  const u = panel.me && panel.users.get(panel.me.id);
  if (!u) return nothingPicked(t);
  const page = v_flex().w_full().max_w(760).mx_auto().px(18).py(16).gap(14);
  let body;
  if (key === "status") body = statusPage(panel, t, page);
  else if (key === "security") {
    body = page
      .child(div().text_size(13).text_color(t.muted).child("Password, multi-factor authentication, personal access tokens, OAuth 2.0 applications, sign-in method, access history and active sessions."))
      .child(h_flex().gap(6).child(button("me-security", t, "Open Security", () => panel.openProfile("security"), { primary: true, iconName: "lock" })));
  } else {
    const full = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();
    const asking = panel.logoutAsk;
    body = page
      .child(h_flex().gap(14).items_center()
        .child(panel.withStatus(u.id, panel.avatar(u.id, 64, t), 64, 20, 14, 46, t))
        .child(v_flex().min_w(0).gap(2)
          .child(div().truncate().text_size(18).font_semibold().child(full || u.username))
          .child(div().truncate().text_size(13).text_color(t.muted).child(`@${u.username}`))))
      .child(field(t, "Full name", full))
      .child(field(t, "Username", u.username))
      .child(field(t, "Nickname", u.nickname))
      .child(field(t, "Position", u.position))
      .child(field(t, "Email", panel.me.email))
      .child(h_flex().flex_wrap().gap(6).items_center()
        .child(button("me-edit", t, "Edit profile", () => panel.openProfile(), { primary: true, iconName: "pencil" }))
        .child(div().flex_1())
        .when(!asking, (el) => el.child(button("me-logout", t, "Log out", (_e, cx) => { panel.logoutAsk = true; panel.redraw(cx); }, { danger: true, iconName: "log-out", disabled: Boolean(panel.cfg?.demo) })))
        .when(asking, (el) => el
          .child(div().text_size(12).text_color(t.muted).child("Log out? The token stays valid on the server until you revoke it."))
          .child(button("me-logout-no", t, "Cancel", (_e, cx) => { panel.logoutAsk = false; panel.redraw(cx); }))
          .child(button("me-logout-yes", t, "Log out", (_e, cx) => { panel.logoutAsk = false; cx.spawn(async (cx) => panel.logOut(cx)); }, { primary: true }))));
  }
  return v_flex().flex_1().min_w(0).h_full()
    .child(header(t, icon(name, 14), div().child(title)))
    .child(v_flex().id(`me-${key}`).flex_1().min_h(0).overflow_y_scrollbar().child(body));
}

function statusPage(panel, t, page) {
  const status = panel.statuses.get(panel.me.id) ?? "offline";
  const custom = panel.customEnabled() ? panel.myCustomStatus() : null;
  const opt = (id, dotColor, label, note, on, onClick) => h_flex().id(id).w_full().min_h(34).px(8).py(6).gap(10).items_center().rounded(6).cursor_pointer()
    .text_size(13).hover((s) => s.bg(t.hover)).on_click(onClick)
    .child(div().size(9).flex_none().rounded_full().bg(dotColor))
    .child(v_flex().flex_1().min_w(0).child(div().child(label)).when(Boolean(note), (el) => el.child(div().text_size(12).text_color(t.muted).child(note))))
    .when(on, (el) => el.child(icon("check", 14).text_color(t.accent)));
  const dndOpen = panel.dndChoices;
  const chip = (id, label, run) => div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(13).cursor_pointer().text_size(12)
    .bg(alpha(t.foreground, 0.08)).hover((s) => s.bg(t.hover)).on_click(run).child(label);
  return page
    .when(panel.customEnabled(), (el) => el.child(card(t).child(h_flex().gap(10).items_center()
      .child(custom?.emoji ? panel.emojiEl(panel.emojiToken(custom.emoji), 20, t) : icon("smile", 18).text_color(t.muted))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(13).text_color(custom ? t.foreground : t.muted).child(custom ? custom.text || "Set custom status text" : "Set a custom status"))
        .when(Boolean(custom && panel.statusUntil(custom)), (el) => el.child(div().text_size(12).text_color(t.muted).child(panel.statusUntil(custom)))))
      .child(button("me-custom", t, custom ? "Change" : "Set", (_e, cx) => cx.spawn(async (cx) => panel.openStatusDialog(cx))))
      .when(Boolean(custom), (el) => el.child(iconButton("me-custom-clear", t, "x", "Clear status", (_e, cx) => panel.clearCustomStatus(cx)))))))
    .child(v_flex().gap(2)
      .when(status === "ooo", (el) => el.child(opt("me-st-ooo", "#afb3c0bf", "Out of office", "Automatic replies are enabled", true, (_e, cx) => panel.setMyStatus("online", 0, cx))))
      .children(STATUS_ROWS.map(([k, label, color]) => opt(`me-st-${k}`, color, label,
        k === "dnd" ? (status === "dnd" ? panel.dndNote() : "Disables all notifications") : null, status === k,
        (_e, cx) => { if (k === "dnd") { panel.dndChoices = !dndOpen; panel.redraw(cx); } else panel.setMyStatus(k, 0, cx); })))
      .when(Boolean(dndOpen), (el) => el.child(h_flex().pl(27).pt(4).gap(6).flex_wrap()
        .child(div().text_size(12).text_color(t.muted).child("Clear after:"))
        .children(panel.dndPresets().map(([label, end], i) => chip(`me-dnd-${i}`, label, (_e, cx) => { panel.dndChoices = false; panel.setMyStatus("dnd", end, cx); })))
        .child(chip("me-dnd-pick", "Choose date and time", (_e, cx) => { panel.dndChoices = false; panel.redraw(cx); panel.openDndDialog(); })))));
}
