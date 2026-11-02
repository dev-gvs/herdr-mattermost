// Mattermost's "Set a status" dialog, drawn by a dialog copy of this mod: an emoji and text, when it clears,
// your recent statuses and the standard suggestions. The panel picks up the result from the server's
// user_updated event, and from a request for the demo, which has no websocket. Also the dialog that turns on
// Do not disturb until a chosen time.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popup } from "gpui-base";
import { props, closeOverlay, openOverlay, theme, shared } from "herdr";
import { FONT, alpha } from "../main.js";
import { request } from "./menu.js";
import { PICKER_W, PICKER_H } from "./picker.js";
import { DateTimeInput, roundedUp } from "./datetime.js";

export const STATUS_W = 600, STATUS_H = 560;
export const DND_W = 600, DND_H = 500;
const MAX_TEXT = 100;
const DEFAULT_DURATION = "today";
const CUSTOM_TIME = "date_and_time";
// What the dropdown picks, which a saved status never has, so choosing it counts as a change even when the
// status already clears at a custom time.
const CHOOSE_TIME = "custom_date_time";
const isCustomTime = (d) => d === CUSTOM_TIME || d === CHOOSE_TIME;
const DURATIONS = [["", "Don't clear"], ["thirty_minutes", "30 minutes"], ["one_hour", "1 hour"], ["four_hours", "4 hours"], ["today", "Today"], ["this_week", "This week"], [CHOOSE_TIME, "Choose date and time"]];
export const SUGGESTIONS = [
  { emoji: "calendar", text: "In a meeting", duration: "one_hour" },
  { emoji: "hamburger", text: "Out for lunch", duration: "thirty_minutes" },
  { emoji: "sneezing_face", text: "Out sick", duration: "today" },
  { emoji: "house", text: "Working from home", duration: "today" },
  { emoji: "palm_tree", text: "On a vacation", duration: "this_week" },
];

const durationName = (d) => (isCustomTime(d) ? "Custom Date and Time" : DURATIONS.find(([k]) => k === d)?.[1] ?? "Don't clear");

// As Mattermost's calculateExpiryTime, whose week ends on Saturday in its default locale.
function expiryFor(duration) {
  const d = new Date();
  const later = (minutes) => { d.setMinutes(d.getMinutes() + minutes, 0, 0); return d.toISOString(); };
  if (duration === "thirty_minutes") return later(30);
  if (duration === "one_hour") return later(60);
  if (duration === "four_hours") return later(240);
  if (duration === "today") { d.setHours(24, 0, 0, 0); return d.toISOString(); }
  if (duration === "this_week") { d.setDate(d.getDate() + 6 - d.getDay()); d.setHours(23, 59, 59, 999); return d.toISOString(); }
  return "";
}

export class StatusDialog {
  constructor(view) {
    this.view = view;
    this.spec = props().statusDialog;
    const c = this.spec.current;
    this.emoji = c?.emoji ?? "";
    this.duration = c ? c.duration : DEFAULT_DURATION;
    this.recent = this.spec.recent;
    this.glyphs = { ...this.spec.glyphs };
    this.error = null;
    this.saving = false;
    this.expiryOpen = false;
    // Shared state outlives a dialog, so an emoji already there was picked for an earlier one.
    this.seenPick = shared("mattermost.status-emoji")?.id;
    this.when = new DateTimeInput("st-when", c?.duration === CUSTOM_TIME && c.expires_at ? Date.parse(c.expires_at) : roundedUp(Date.now()), {
      onOpen: () => { this.expiryOpen = false; },
    });
    this.text = InputState.new({ placeholder: "Set a status", value: c?.text ?? "" });
    this.text.on("change", (_e, cx) => cx.notify());
    this.text.on("submit", (_e, cx) => { if (this.canSet() && !this.when.open) this.set(cx); });
    this.text.focus();
  }

  close() {
    closeOverlay(props().overlay);
  }

  isSet() {
    return Boolean(this.emoji || this.text.value());
  }

  canSet() {
    return this.isSet() && this.text.value().length <= MAX_TEXT && !this.saving && (!isCustomTime(this.duration) || this.when.isValid());
  }

  // Mattermost shows the lists until you've started changing a status, then only what you're setting.
  showLists() {
    const c = this.spec.current;
    return !this.isSet() || (c && c.emoji === this.emoji && c.text === this.text.value() && c.duration === this.duration);
  }

  send(cx, call, then) {
    if (this.saving) return;
    this.saving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.view.cfgReady;
        await call(cx);
        then();
        this.close();
      } catch (e) {
        this.error = e?.text ?? String(e?.message ?? e);
        this.saving = false;
        cx.notify();
      }
    });
  }

  set(cx) {
    const custom = isCustomTime(this.duration);
    const expires = custom ? new Date(this.when.value).toISOString() : expiryFor(this.duration);
    const status = { emoji: this.emoji || "speech_balloon", text: this.text.value().trim(), duration: custom ? CUSTOM_TIME : this.duration, ...(expires ? { expires_at: expires } : {}) };
    this.send(cx, (cx) => this.view.api(cx, "/users/me/status/custom", { method: "PUT", body: status }), () => request("custom-status", { status }));
  }

  clearStatus(cx) {
    this.send(cx, (cx) => this.view.api(cx, "/users/me/status/custom", { method: "DELETE" }), () => request("custom-status", { status: null }));
  }

  forget(status, cx) {
    this.recent = this.recent.filter((s) => s !== status);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.view.cfgReady;
        await this.view.api(cx, "/users/me/status/custom/recent/delete", { method: "POST", body: status });
        request("recent-status-removed", { status });
      } catch (e) {
        this.error = e?.text ?? String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  use(status) {
    this.emoji = status.emoji;
    this.text.set_value(status.text);
    this.duration = status.duration ?? "";
    this.text.focus();
  }

  clearInput() {
    this.emoji = "";
    this.text.set_value("");
    this.duration = DEFAULT_DURATION;
    this.text.focus();
  }

  openPicker(box) {
    openOverlay({
      mod: "mattermost", kind: "popup", frame: "none", width: PICKER_W, height: PICKER_H, at: { x: box.x, y: box.y + box.height + 4 },
      props: { demo: props()?.demo, picker: { status: true, me: this.spec.me, team: this.spec.team, height: PICKER_H } },
    });
  }

  glyph(name, size) {
    const g = this.glyphs[name];
    return g?.path ? image(g.path).size(size).flex_none() : div().text_size(Math.round(size * 0.85)).child(g?.char ?? "");
  }

  row(t, status, i, onClear) {
    const label = status.duration && !isCustomTime(status.duration) ? durationName(status.duration) : "";
    return h_flex().id(`st-${onClear ? "recent" : "sug"}-${i}`).relative().flex_none().h(40).pl(18).pr(10).gap(15).items_center().rounded(4).cursor_pointer()
      .hover((s) => s.bg(alpha(t.foreground, 0.08)))
      .on_click((_e, cx) => { this.use(status); cx.notify(); })
      .child(this.glyph(status.emoji, 20))
      .child(div().min_w(0).truncate().font_semibold().child(status.text))
      .when(Boolean(label), (el) => el.child(div().flex_none().text_color(alpha(t.foreground, 0.75)).child(label)))
      // An invisible layer, so the row's own hover can reveal a child.
      .when(Boolean(onClear), (el) => el.child(h_flex().absolute().inset_0().pr(10).justify_end().items_center().opacity(0).hover((s) => s.opacity(1))
        .child(div().id(`st-clear-${i}`).p(2).rounded(4).cursor_pointer().text_color(alpha(t.foreground, 0.64)).tooltip("Clear")
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); onClear(cx); })
          .child(svg("mods/mattermost/icons/circle-x.svg").size(18)))));
  }

  lists(t) {
    const heading = (text) => div().flex_none().h(24).mt(8).flex().items_center().text_size(12).font_semibold().text_color(alpha(t.foreground, 0.55)).child(text);
    const taken = new Set(this.recent.map((s) => s.text));
    const suggestions = SUGGESTIONS.filter((s) => !taken.has(s.text));
    return v_flex().id("st-lists").flex_1().min_h(0).overflow_y_scrollbar()
      .when(this.recent.length > 0, (el) => el.child(heading("RECENT"))
        .children(this.recent.map((s, i) => this.row(t, s, i, (cx) => this.forget(s, cx)))))
      .when(suggestions.length > 0, (el) => el.child(heading("SUGGESTIONS"))
        .children(suggestions.map((s, i) => this.row(t, s, i, null))));
  }

  expiry(t) {
    const c = this.spec.current;
    const value = this.showLists() && this.duration && c?.until ? c.until.replace(/^Until /, "") : durationName(this.duration);
    const trigger = h_flex().id("st-expiry").gap(4).items_center().cursor_pointer()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.expiryOpen = !this.expiryOpen; this.when.closeMenus(); cx.notify(); })
      .child(div().child("Clear after:"))
      .child(div().font_semibold().child(value))
      .child(svg("mods/mattermost/icons/chevron-down.svg").size(12).text_color(t.muted));
    const item = ([key, label]) => div().id(`st-exp-${key || "none"}`).h(32).flex_none().px(16).flex().items_center().cursor_pointer()
      .hover((s) => s.bg(alpha(t.foreground, 0.08)))
      .on_click((_e, cx) => { this.duration = key; this.expiryOpen = false; this.text.focus(); cx.notify(); })
      .child(label);
    return div().flex_none().mt(12).mb(12).child(Popup.new("st-expiry-menu", trigger).anchor("top_left")
      .when(this.expiryOpen, (el) => el.content(v_flex().w(200).mt(4).py(8).rounded(4).border_1().border_color(alpha(t.foreground, 0.16)).bg(t.background).shadow_lg().font_family(FONT).text_size(14).text_color(t.foreground)
        .children(DURATIONS.map(item)))));
  }

  render(cx) {
    const t = theme();
    const picked = shared("mattermost.status-emoji");
    if (picked?.id && picked.id !== this.seenPick) {
      this.seenPick = picked.id;
      this.emoji = picked.name;
      this.glyphs[picked.name] = { path: picked.path, char: picked.char };
      cx.timer.after(0, () => this.text.focus());
    }
    const set = this.isSet(), text = this.text.value(), over = text.length - MAX_TEXT;
    const can = this.canSet();
    const button = (id, label, primary, enabled, onClick) => div().id(id).h(40).px(20).flex().flex_none().items_center().rounded(4).text_size(14).font_semibold()
      .bg(!enabled ? alpha(t.foreground, 0.08) : primary ? t.accent : alpha(t.accent, 0.08))
      .text_color(!enabled ? alpha(t.foreground, 0.32) : primary ? t.accent_foreground : t.accent)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(primary ? t.accent : alpha(t.accent, 0.16))).on_click(onClick))
      .child(label);
    return v_flex().id("mm-status-dialog").relative().size_full().p(32).bg(t.popover).font_family(FONT).text_size(14).text_color(t.foreground)
      .on_mouse_down("left", (_e, cx) => {
        const closed = this.when.closeMenus() || this.expiryOpen;
        this.expiryOpen = false;
        if (closed) cx.notify();
      })
      .child(h_flex().flex_none().mb(16).items_center().gap(12)
        .child(div().flex_1().min_w(0).truncate().text_size(22).font_semibold().child("Set a status"))
        .child(div().id("st-close").size(32).flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.close()).child(svg("mods/mattermost/icons/x.svg").size(18))))
      .child(h_flex().flex_none().h(48).px(6).gap(6).items_center().rounded(4).border_1().border_color(t.accent)
        .child(div().id("st-emoji").size(36).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(alpha(t.foreground, 0.64))
          .hover((s) => s.bg(alpha(t.foreground, 0.08)).text_color(alpha(t.foreground, 0.8)))
          .tooltip("Select an emoji")
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.openPicker(e.bounds ?? { ...e.position, width: 0, height: 0 }); })
          .child(set ? this.glyph(this.emoji || "speech_balloon", 20) : svg("mods/mattermost/icons/smile.svg").size(20)))
        .child(div().flex_1().min_w(0).on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.text.focus(); })
          .child(Input.new(this.text).w_full().text_size(14).font_semibold()))
        .when(over > 0, (el) => el.child(div().flex_none().text_size(12).text_color(t.blocked).child(`-${over}`)))
        .when(set, (el) => el.child(div().id("st-input-clear").size(28).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(alpha(t.foreground, 0.64))
          .hover((s) => s.text_color(t.foreground))
          .tooltip("Clear")
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.clearInput(); cx.notify(); })
          .child(svg("mods/mattermost/icons/circle-x.svg").size(18)))))
      .when(set, (el) => el.child(this.expiry(t)))
      .when(!set, (el) => el.child(div().flex_none().h(8)))
      .when(!this.showLists() && isCustomTime(this.duration), (el) => el.child(div().flex_none().mt(12).child(this.when.render(t))))
      .child(this.showLists() ? this.lists(t) : div().flex_1())
      .when(Boolean(this.error), (el) => el.child(div().flex_none().pt(8).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().flex_none().pt(20).gap(8).justify_end()
        .when(Boolean(this.spec.current), (el) => el.child(button("st-unset", "Clear Status", false, !this.saving, (_e, cx) => this.clearStatus(cx))))
        .child(button("st-set", "Set Status", true, can, (_e, cx) => this.set(cx))));
  }
}

// Mattermost's DndCustomTimePicker.
export class DndDialog {
  constructor(view, cx) {
    this.view = view;
    this.spec = props().dndDialog;
    this.error = null;
    this.saving = false;
    const now = new Date();
    // Later than this, today has hardly a time left to offer, so it starts on tomorrow morning.
    const late = now.getHours() === 23 && now.getMinutes() > 20;
    this.when = new DateTimeInput("dnd-when", late ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9).getTime() : roundedUp(now.getTime()));
    this.focus = cx.focus_handle();
    this.focus.focus();
  }

  close() {
    closeOverlay(props().overlay);
  }

  canConfirm() {
    return this.when.isValid() && !this.saving;
  }

  confirm(cx) {
    if (!this.canConfirm()) return;
    this.saving = true;
    cx.notify();
    const dndEnd = Math.floor(this.when.value / 1000);
    cx.spawn(async (cx) => {
      try {
        await this.view.cfgReady;
        await this.view.api(cx, `/users/${this.spec.me}/status`, { method: "PUT", body: { user_id: this.spec.me, status: "dnd", dnd_end_time: dndEnd } });
        request("status", { status: "dnd", dndEnd });
        this.close();
      } catch (e) {
        this.error = e?.text ?? String(e?.message ?? e);
        this.saving = false;
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    const can = this.canConfirm();
    return v_flex().id("mm-dnd-dialog").relative().size_full().p(32).bg(t.popover).font_family(FONT).text_size(14).text_color(t.foreground)
      .track_focus(this.focus)
      .on_key_down((e, cx) => { if (e.keystroke === "enter" && !this.when.open) this.confirm(cx); })
      .on_mouse_down("left", (_e, cx) => { if (this.when.closeMenus()) cx.notify(); })
      .child(h_flex().flex_none().mb(24).items_center().gap(12)
        .child(div().flex_1().min_w(0).truncate().text_size(22).font_semibold().child("Disable notifications until"))
        .child(div().id("dnd-close").size(32).flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.close()).child(svg("mods/mattermost/icons/x.svg").size(18))))
      .child(this.when.render(t))
      .child(div().flex_1())
      .when(Boolean(this.error), (el) => el.child(div().flex_none().pt(8).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().flex_none().pt(20).gap(8).justify_end()
        .child(div().id("dnd-cancel").h(40).px(20).flex().flex_none().items_center().rounded(4).cursor_pointer().text_size(14).font_semibold()
          .bg(alpha(t.accent, 0.08)).text_color(t.accent).hover((s) => s.bg(alpha(t.accent, 0.16)))
          .on_click(() => this.close()).child("Cancel"))
        .child(div().id("dnd-confirm").h(40).px(20).flex().flex_none().items_center().rounded(4).text_size(14).font_semibold()
          .bg(can ? t.accent : alpha(t.foreground, 0.08)).text_color(can ? t.accent_foreground : alpha(t.foreground, 0.32))
          .when(can, (el) => el.cursor_pointer().on_click((_e, cx) => this.confirm(cx)))
          .child(this.saving ? "Saving…" : "Disable Notifications")));
  }
}
