// Mattermost's DateTimeInput: a date box and a time box, each with a dropdown, always holding a moment that
// can still be picked. Times are local and offered every 30 minutes, from the next one on today.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Popup, CalendarState, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { FONT, FULL_MONTHS, alpha, clock } from "../main.js";

const STEP = 30;
const CELL = 36;
const MENU_ROW = 32, MENU_ROWS = 9;
const WEEKDAY_INITIALS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// new Date("YYYY-MM-DD") would read the day as UTC, which is the day before in the west.
const atDay = (key, minutes = 0) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d, 0, minutes).getTime(); };
const minuteOfDay = (ms) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };

// Unlike Mattermost's getRoundedTime this also rounds seconds up, since a time that has just passed can't be saved.
export function roundedUp(ms) {
  const d = new Date(ms);
  const over = d.getSeconds() || d.getMilliseconds() ? 1 : 0;
  d.setMinutes(Math.ceil((d.getMinutes() + over) / STEP) * STEP, 0, 0);
  return d.getTime();
}

function dayName(ms) {
  const key = dayKey(ms), now = Date.now();
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(atDay(dayKey(now), 36 * 60))) return "Tomorrow";
  const d = new Date(ms);
  return `${FULL_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export class DateTimeInput {
  constructor(id, value, { onOpen = null } = {}) {
    this.id = id;
    this.value = value;
    this.onOpen = onOpen;
    this.open = null;
    this.calendar = CalendarState.new();
    this.timesScroll = VirtualListScrollHandle.new();
  }

  isValid() {
    return this.value > Date.now();
  }

  closeMenus() {
    if (!this.open) return false;
    this.open = null;
    return true;
  }

  toggle(which, cx) {
    this.open = this.open === which ? null : which;
    if (this.open === "date") this.showMonthOf(this.value);
    if (this.open === "time") this.timesScroll.scroll_to_item(Math.max(0, this.times().indexOf(this.value)), "center");
    if (this.open) this.onOpen?.();
    cx.notify();
  }

  showMonthOf(ms) {
    const d = new Date(ms), want = d.getFullYear() * 12 + d.getMonth();
    const shown = () => this.calendar.year() * 12 + this.calendar.month() - 1;
    while (shown() < want) this.calendar.next_month();
    while (shown() > want) this.calendar.prev_month();
  }

  // The time of day carries over to another day, and today can't keep one that has passed.
  pickDay(key, cx) {
    const at = atDay(key, minuteOfDay(this.value)), now = Date.now();
    this.value = at > now ? at : roundedUp(now);
    this.open = null;
    cx.notify();
  }

  times() {
    const key = dayKey(this.value), now = Date.now();
    const first = key === dayKey(now) ? roundedUp(now) : 0;
    const all = Array.from({ length: 24 * 60 / STEP }, (_, i) => atDay(key, i * STEP));
    // Where clocks go forward, two steps land on the same moment.
    return [...new Set(all)].filter((ms) => ms >= first);
  }

  box(t, which, icon, label, value) {
    const on = this.open === which;
    return h_flex().id(`${this.id}-${which}`).relative().w_full().h(40).px(12).gap(8).items_center().rounded(4).cursor_pointer()
      .border_1().border_color(on ? t.accent : alpha(t.foreground, 0.24))
      .hover((s) => s.border_color(on ? t.accent : alpha(t.foreground, 0.4)))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.toggle(which, cx); })
      .child(div().absolute().top(-8).left(12).px(4).bg(t.popover).text_size(10).text_color(alpha(t.foreground, 0.75)).child(label))
      .child(svg(`mods/mattermost/icons/${icon}.svg`).size(16).flex_none().text_color(alpha(t.foreground, 0.64)))
      .child(div().min_w(0).truncate().text_size(14).child(value));
  }

  menuCard(t) {
    return v_flex().mt(4).rounded(4).border_1().border_color(alpha(t.foreground, 0.16)).bg(t.background).shadow_lg()
      .font_family(FONT).text_size(14).text_color(t.foreground);
  }

  monthView(t) {
    const [weeks] = this.calendar.month_days();
    const today = dayKey(Date.now()), selected = dayKey(this.value), month = this.calendar.month();
    const atFirstMonth = today.slice(0, 7) === `${this.calendar.year()}-${pad(month)}`;
    const nav = (key, icon, enabled, onClick) => div().id(`${this.id}-${key}`).size(28).flex().flex_none().items_center().justify_center().rounded(4)
      .text_color(alpha(t.foreground, enabled ? 0.75 : 0.24))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(alpha(t.foreground, 0.08))).on_click(onClick))
      .child(svg(`mods/mattermost/icons/${icon}.svg`).size(16));
    const dayCell = (day) => {
      const past = day < today || (this.maxDay && day > this.maxDay), on = day === selected, outside = Number(day.slice(5, 7)) !== month;
      const color = on ? t.accent_foreground : day === today ? t.accent : alpha(t.foreground, past ? 0.32 : outside ? 0.56 : 1);
      return div().id(`${this.id}-${day}`).size(CELL).flex().flex_none().items_center().justify_center().rounded(CELL).font_semibold().text_color(color)
        .when(on, (el) => el.bg(t.accent))
        .when(!past, (el) => el.cursor_pointer().hover((s) => s.bg(on ? t.accent : alpha(t.foreground, 0.08))).on_click((_e, cx) => this.pickDay(day, cx)))
        .child(String(Number(day.slice(8))));
    };
    return this.menuCard(t).p(16).gap(2)
      .child(h_flex().h(32).items_center()
        .child(nav("prev", "chevron-left", !atFirstMonth, (_e, cx) => { this.calendar.prev_month(); cx.notify(); }))
        .child(div().flex_1().text_center().text_size(16).font_semibold().child(`${FULL_MONTHS[month - 1]} ${this.calendar.year()}`))
        .child(nav("next", "chevron-right", true, (_e, cx) => { this.calendar.next_month(); cx.notify(); })))
      // Named from the grid's own first week, which starts on whichever day Herdr's calendar starts it.
      .child(h_flex().children(weeks[0].map((day) => div().w(CELL).h(24).flex().flex_none().items_center().justify_center().text_size(12).font_semibold()
        .text_color(alpha(t.foreground, 0.75)).child(WEEKDAY_INITIALS[new Date(atDay(day)).getDay()]))))
      .children(weeks.map((week) => h_flex().children(week.map(dayCell))));
  }

  timeView(t) {
    const times = this.times(), id = `${this.id}-times`;
    const row = (ms) => div().h(MENU_ROW).flex().items_center().px(16).cursor_pointer()
      .when(ms === this.value, (el) => el.font_semibold().text_color(t.accent))
      .hover((s) => s.bg(alpha(t.foreground, 0.08)))
      .child(clock(ms));
    return this.menuCard(t).py(8).child(v_flex().relative().h(Math.min(times.length, MENU_ROWS) * MENU_ROW)
      .child(v_virtual_list(id, times.length, MENU_ROW, (i) => String(times[i]), (range) => times.slice(range.start, range.end).map(row))
        .track_scroll(this.timesScroll)
        .on_item_click((key, cx) => { this.value = Number(key); this.open = null; cx.notify(); }))
      .child(Scrollbar.vertical(id).absolute().inset_0()));
  }

  // Only the day, for whoever needs no time.
  renderDate(t) {
    return Popup.new(`${this.id}-date-menu`, this.box(t, "date", "calendar", "Date", dayName(this.value))).anchor("top_left")
      .when(this.open === "date", (el) => el.content(this.monthView(t)));
  }

  render(t) {
    return h_flex().flex_none().gap(24)
      .child(div().flex_1().min_w(0).child(Popup.new(`${this.id}-date-menu`, this.box(t, "date", "calendar", "Date", dayName(this.value))).anchor("top_left")
        .when(this.open === "date", (el) => el.content(this.monthView(t)))))
      .child(div().flex_1().min_w(0).child(Popup.new(`${this.id}-time-menu`, this.box(t, "time", "clock", "Time", clock(this.value))).anchor("top_left")
        .when(this.open === "time", (el) => el.content(this.timeView(t).w(200)))));
  }
}
