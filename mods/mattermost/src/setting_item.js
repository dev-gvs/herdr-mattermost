// What the Profile modal is made of: a section as a title and a line of text that opens into a form, its text
// boxes, buttons and stacked modals.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popup } from "gpui-base";
import { FONT, alpha, MONTHS, FULL_MONTHS } from "../main.js";

export const icon = (name) => `mods/mattermost/icons/${name}.svg`;
export const errorText = (e) => e?.text ?? String(e?.message ?? e);
const two = (n) => String(n).padStart(2, "0");
export const shortDate = (ms) => { const d = new Date(ms); return `${MONTHS[d.getMonth()]} ${two(d.getDate())}, ${d.getFullYear()}`; };
export const longDate = (ms) => { const d = new Date(ms); return `${FULL_MONTHS[d.getMonth()]} ${two(d.getDate())}, ${d.getFullYear()}`; };

// Shares of the 484px a form has between the modal's sidebar and its scrollbar.
const OFFSET = 80, LABEL_W = 168;

export function button(t, id, label, onClick, { emphasis = "primary", enabled = true } = {}) {
  const primary = emphasis === "primary";
  return div().id(id).h(40).px(20).flex().flex_none().items_center().justify_center().rounded(4).text_size(14).font_semibold()
    .bg(!enabled ? alpha(t.foreground, 0.08) : primary ? t.accent : alpha(t.accent, 0.08))
    .text_color(!enabled ? alpha(t.foreground, 0.32) : primary ? t.accent_foreground : t.accent)
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(primary ? t.accent : alpha(t.accent, 0.16))).on_click(onClick))
    .child(label);
}

export const textLink = (t, id, label, onClick) => div().id(id).flex_none().cursor_pointer().text_color(t.accent)
  .hover((s) => s.underline()).on_click(onClick).child(label);

export const errorRow = (t, text) => h_flex().w_full().gap(6).items_start().text_color(t.blocked)
  .child(svg(icon("circle-alert")).size(14).flex_none().mt(3))
  .child(div().flex_1().min_w(0).child(text));

// `hovered` and `onHover` are the row's, because the underline on Edit follows the whole row and GPUI has no
// group hover.
export function sectionMin(t, id, { title, describe, hovered, onHover, onOpen }) {
  return v_flex().id(`pf-min-${id}`).w_full().p(14).rounded(4).cursor_pointer()
    .hover((s) => s.bg(alpha(t.foreground, 0.04)))
    .on_hover(onHover)
    .on_click(onOpen)
    .child(h_flex().w_full().justify_between().items_start()
      .child(div().min_w(0).mb(5).pr(50).font_semibold().child(title))
      .child(h_flex().id(`${id}Edit`).flex_none().gap(4).items_center().mb(5).text_color(t.accent)
        .child(svg(icon("pencil")).size(14))
        .child(hovered ? div().underline().child("Edit") : div().child("Edit"))))
    .child(div().w_full().opacity(0.75).truncate().child(describe ?? ""));
}

export const hint = (t, content) => div().w_full().mt(20).text_color(alpha(t.foreground, 0.75)).child(content);

// `submit` null means a section that only says why it can't be changed, so no Save.
export function sectionMax(t, id, { title, inputs = [], extra, infoTop, error, full, saving, valid, submit, cancel, cancelLabel = "Cancel" }) {
  const info = extra && (infoTop ? div().w_full().pb(12).child(extra) : hint(t, extra));
  return v_flex().id(`pf-max-${id}`).w_full().p(12).bg(alpha(t.foreground, 0.04))
    .child(typeof title === "string" ? div().w_full().child(title) : title)
    .child(v_flex().w_full().pt(20).when(!full, (el) => el.pl(OFFSET))
      .when(Boolean(infoTop && info), (el) => el.child(info))
      .children(inputs)
      .when(Boolean(!infoTop && info), (el) => el.child(info))
      .child(div().w_full().h(1).my(24).bg(alpha(t.foreground, 0.12)))
      .when(Boolean(error), (el) => el.child(div().w_full().mb(16).child(errorRow(t, error))))
      .child(h_flex().w_full().gap(8)
        .when(Boolean(submit), (el) => el.child(button(t, `${id}-save`, saving ? "Saving" : "Save", (_e, cx) => submit(cx), { enabled: !saving && valid !== false })))
        .child(button(t, `${id}-cancel`, cancelLabel, (_e, cx) => cancel(cx), { emphasis: "tertiary" }))));
}

export const formRow = (t, label, control) => h_flex().w_full().mb(25).items_start()
  .child(div().w(LABEL_W).flex_none().pr(15).pt(7).text_right().font_semibold().truncate().child(label))
  .child(div().flex_1().min_w(0).child(control));

// A text box has no length limit of its own, so one that goes past `max` is cut back.
export class Field {
  constructor({ value = "", masked = false, max = 0, validate = null, disabled = false, placeholder = "", onSubmit = null }) {
    this.validate = validate;
    this.disabled = disabled;
    this.error = null;
    this.focused = false;
    this.state = InputState.new({ value, placeholder });
    if (masked) this.state.set_masked(true);
    this.state.on("change", (_e, cx) => {
      if (max && this.state.value().length > max) this.state.set_value(this.state.value().slice(0, max));
      this.error = null;
      cx.notify();
    });
    this.state.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.state.on("blur", (_e, cx) => { this.focused = false; this.check(); cx.notify(); });
    if (onSubmit) this.state.on("submit", (_e, cx) => onSubmit(cx));
  }

  get value() {
    return this.state.value();
  }

  check() {
    this.error = this.validate?.(this.value) ?? null;
  }

  focus() {
    if (!this.disabled) this.state.focus();
  }

  dispose() {
    this.state.release();
  }

  draw(t, id) {
    const color = this.error ? t.blocked : this.focused ? t.accent : alpha(t.foreground, 0.16);
    const box = h_flex().id(id).w_full().h(34).items_center().rounded(4).border_color(color).bg(t.background)
      .when(this.focused, (el) => el.px(11).border_2())
      .when(!this.focused, (el) => el.px(12).border_1())
      .when(this.disabled, (el) => el.opacity(0.6).child(div().flex_1().min_w(0).truncate().child(this.value)))
      .when(!this.disabled, (el) => el
        .when(!this.error && !this.focused, (b) => b.hover((s) => s.border_color(alpha(t.foreground, 0.48))))
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.state.focus(); })
        .child(Input.new(this.state).w_full().text_size(14)));
    return v_flex().w_full().child(box)
      .when(Boolean(this.error), (el) => el.child(div().w_full().mt(5).text_size(12).child(errorRow(t, this.error))));
  }
}

export function selectBox(t, id, { label, open, onToggle, items, onPick, width = 200, picked = null }) {
  const trigger = h_flex().id(id).w_full().h(34).px(12).gap(8).items_center().rounded(4).cursor_pointer().bg(t.background)
    .border_1().border_color(open ? t.accent : alpha(t.foreground, 0.16))
    .hover((s) => s.border_color(open ? t.accent : alpha(t.foreground, 0.48)))
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); onToggle(cx); })
    .child(div().flex_1().min_w(0).truncate().child(label))
    .child(svg(icon("chevron-down")).size(14).flex_none().text_color(alpha(t.foreground, 0.64)));
  const item = ([value, text]) => h_flex().id(`${id}-${value}`).h(32).flex_none().px(16).gap(8).items_center().cursor_pointer()
    .hover((s) => s.bg(alpha(t.foreground, 0.08)))
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); onPick(value, cx); })
    .child(div().flex_1().min_w(0).truncate().child(text))
    .when(Boolean(picked?.(value)), (el) => el.child(svg(icon("check")).size(14).flex_none().text_color(t.accent)));
  return Popup.new(`${id}-menu`, trigger).anchor("top_left")
    .when(open, (el) => el.content(v_flex().w(width).mt(4).py(8).rounded(4).border_1().border_color(alpha(t.foreground, 0.16)).bg(t.background).shadow_lg()
      .font_family(FONT).text_size(14).text_color(t.foreground).children(items.map(item))));
}

// A stacked modal is drawn inside the dialog, because a second dialog overlay would replace the first. The
// dimmer takes presses so nothing under it reacts, and has to stop them: a press that bubbles out makes
// Herdr give the keyboard away.
const dimmer = (id) => div().id(id).absolute().inset_0().flex().items_center().justify_center().bg("#00000066")
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation());

export function confirmLayer(t, { title, body = [], confirmLabel, confirmEnabled = true, cancelLabel = "Cancel", hideCancel, onConfirm, onCancel }) {
  return dimmer("pf-confirm").child(v_flex().w(512).max_h("90%").p(32).gap(16).rounded(8).bg(t.popover).shadow_lg().border_1().border_color(alpha(t.foreground, 0.16))
    .child(div().w_full().text_size(22).font_semibold().child(title))
    .children(body)
    .child(h_flex().w_full().pt(8).gap(8).justify_end()
      .when(!hideCancel, (el) => el.child(button(t, "pf-confirm-cancel", cancelLabel, (_e, cx) => onCancel(cx), { emphasis: "tertiary" })))
      .child(button(t, "pf-confirm-ok", confirmLabel, (_e, cx) => onConfirm(cx), { enabled: confirmEnabled }))));
}

export function stackedModal(t, id, title, onClose, content) {
  return dimmer(`${id}-dim`).child(v_flex().absolute().top(24).bottom(24).left(24).right(24).rounded(8).bg(t.popover).shadow_lg().border_1().border_color(alpha(t.foreground, 0.16))
    .child(h_flex().flex_none().h(76).pl(32).pr(18).items_center().gap(12).border_b_1().border_color(alpha(t.foreground, 0.08))
      .child(div().flex_1().min_w(0).truncate().text_size(22).font_semibold().child(title))
      .child(closeButton(t, `${id}-close`, onClose)))
    .child(content));
}

export const closeButton = (t, id, onClick) => div().id(id).size(40).flex().flex_none().items_center().justify_center().rounded(4).cursor_pointer()
  .text_color(alpha(t.foreground, 0.64))
  .hover((s) => s.bg(alpha(t.foreground, 0.08)).text_color(t.foreground))
  .on_click(onClick).child(svg(icon("x")).size(18));

export const alertBox = (t, color, children) => v_flex().w_full().px(12).py(8).gap(8).rounded(4).bg(alpha(color, 0.12)).text_color(t.foreground).children(children);

export const dividerDark = (t) => div().w_full().h(1).flex_none().bg(alpha(t.foreground, 0.12));
export const dividerLight = (t) => div().w_full().h(1).flex_none().bg(alpha(t.foreground, 0.08));
export const tabHeader = (text) => div().w_full().mb(18).text_size(18).font_semibold().child(text);
