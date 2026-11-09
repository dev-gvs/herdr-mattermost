// Mattermost's message priority: the (!) control on a channel's message box, its picker (a popup copy of
// this mod with the prop `priorityPicker`), the labels it leaves in the box and the tag on a sent post. The
// server has it when its client config says `PostPriority`, and it travels in the post's `metadata.priority`.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme } from "herdr";
import { FONT, alpha } from "../main.js";
import { request } from "./menu.js";
import { openOwnOverlay } from "./rhs.js";

const INFO = "#5d89ea", DANGER = "#d24b4e", ONLINE = "#3db887";
const HEAD = 48, ROW = 36, TOGGLE = 64, FOOTER = 64, RULE = 17;
const icon = (name, size) => svg(`mods/mattermost/icons/compass/${name}.svg`).size(size).flex_none();

export const PRIORITIES = [
  { value: "", label: "Standard", icon: "message-text-outline", color: null },
  { value: "important", label: "Important", icon: "alert-circle-outline", color: INFO },
  { value: "urgent", label: "Urgent", icon: "alert-outline", color: DANGER },
];

export const priorityEnabled = (config) => config?.PostPriority === "true";
const acksEnabled = (config) => priorityEnabled(config) && config?.PostAcknowledgements === "true";

export const hasPriority = (p) => Boolean(p?.priority || p?.requested_ack);

// Mattermost's Tag, xs: the label in capitals on the priority's colour.
export function priorityTag(priority, t) {
  const p = PRIORITIES.find((x) => x.value && x.value === priority);
  if (!p) return null;
  return h_flex().h(16).px(4).gap(2).flex_none().items_center().rounded(4).bg(p.color).text_color("#ffffff")
    .text_size(10).line_height("16px").font_semibold().child(icon(p.icon, 12)).child(p.label.toUpperCase());
}

// The row over the text while a priority is set, with a × that takes it off again.
export function priorityLabels(priority, t, remove) {
  if (!hasPriority(priority)) return null;
  const tag = priorityTag(priority.priority, t);
  return h_flex().pl(16).pt(12).gap(6).items_center()
    .children(tag ? [tag] : [])
    .when(Boolean(priority.requested_ack), (el) => el.child(h_flex().gap(4).items_center().text_color(ONLINE).text_size(11).font_semibold()
      .child(div().id("prio-ack").tooltip("Acknowledgement will be requested").child(icon("check-circle-outline", 14)))
      .when(!priority.priority, (r) => r.child("Request acknowledgement"))))
    .child(div().id("prio-remove").size(16).flex().items_center().justify_center().cursor_pointer().text_size(17).text_color(t.foreground).opacity(0.73)
      .tooltip(`Remove ${priority.priority || "priority"} label`)
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); remove(cx); })
      .child("×"));
}

export function pickerSize(config) {
  const acks = acksEnabled(config);
  return { width: acks ? 324 : 220, height: HEAD + RULE + 3 * ROW + 8 + (acks ? RULE + TOGGLE + RULE + FOOTER : 0) };
}

// Opens over the button, its bottom-left corner on the button's top-left, as Mattermost's menu does.
export function openPriorityPicker(panel, box, at) {
  const config = panel.clientConfig;
  const { width, height } = pickerSize(config);
  const z = panel.zoom();
  const where = at ? { x: Math.max(4, at.x), y: Math.max(4, at.y - height * z - 4) } : "pointer";
  panel.popupOpened(openOwnOverlay({
    mod: "mattermost", kind: "popup", frame: "none", width, height, at: where,
    props: { demo: panel.cfg?.demo, priorityPicker: { box: box.name, key: box.key, settings: panel.priorityOf(box.key) ?? {}, acks: acksEnabled(config) } },
  }));
}

export class PriorityPicker {
  constructor() {
    this.spec = props().priorityPicker;
    const s = this.spec.settings ?? {};
    this.priority = s.priority ?? "";
    this.ack = Boolean(s.requested_ack);
  }

  close() {
    closeOverlay(props().overlay);
  }

  apply(settings) {
    request("priority", { box: this.spec.box, key: this.spec.key, priority: hasPriority(settings) ? settings : null });
    this.close();
  }

  // Without acknowledgements a choice is the whole answer; with them it waits for Apply.
  choose(value, cx) {
    this.priority = value;
    if (!this.spec.acks) return this.apply({ priority: value, requested_ack: false, persistent_notifications: false });
    cx.notify();
  }

  render() {
    const t = theme();
    const rule = () => div().h(RULE).flex_none().flex().items_center().child(div().w_full().h(1).bg(alpha(t.foreground, 0.08)));
    const row = (p) => h_flex().id(`prio-${p.value || "standard"}`).h(ROW).px(20).gap(10).items_center().cursor_pointer()
      .hover((s) => s.bg(alpha(t.foreground, 0.08)))
      .on_click((_e, cx) => this.choose(p.value, cx))
      .child(div().text_color(p.color ?? alpha(t.foreground, 0.75)).child(icon(p.icon, 18)))
      .child(div().flex_1().text_size(14).child(p.label))
      .when(this.priority === p.value, (el) => el.child(div().ml(24).text_color(t.accent).child(icon("check", 18))));
    const button = (id, label, primary, onClick) => div().id(id).h(32).px(16).flex().items_center().rounded(4).cursor_pointer().text_size(12).font_semibold()
      .bg(primary ? t.accent : alpha(t.accent, 0.08)).text_color(primary ? "#ffffff" : t.accent)
      .hover((s) => s.opacity(0.9)).on_click(onClick).child(label);
    const toggle = h_flex().id("prio-ack-toggle").h(TOGGLE).px(20).gap(10).items_center().cursor_pointer()
      .hover((s) => s.bg(alpha(t.foreground, 0.1)))
      .on_click((_e, cx) => { this.ack = !this.ack; cx.notify(); })
      .child(div().text_color(alpha(t.foreground, 0.75)).child(icon("check-circle-outline", 18)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(14).child("Request acknowledgement"))
        .child(div().max_w(200).text_size(12).line_height("16px").text_color(alpha(t.foreground, 0.75)).child("An acknowledgement button will appear with your message")))
      .child(div().w(28).h(16).flex_none().rounded(8).p(2).flex().items_center().bg(this.ack ? t.accent : alpha(t.foreground, 0.24))
        .when(this.ack, (el) => el.justify_end()).child(div().size(12).rounded(6).bg("#ffffff")));
    return v_flex().id("mm-priority").size_full().rounded(4).border_1().border_color(alpha(t.foreground, 0.16)).bg(t.background).shadow_lg()
      .font_family(FONT).text_color(t.foreground).overflow_hidden()
      .child(div().h(HEAD).flex_none().px(20).flex().items_center().text_size(14).font_semibold().child("Message priority"))
      .child(rule())
      .children(PRIORITIES.map(row))
      .child(div().h(8).flex_none())
      .when(this.spec.acks, (el) => el.child(rule()).child(toggle).child(rule())
        .child(h_flex().h(FOOTER).px(16).gap(8).items_center().justify_end()
          .child(button("prio-cancel", "Cancel", false, () => this.close()))
          .child(button("prio-apply", "Apply", true, () => this.apply({ priority: this.priority, requested_ack: this.ack, persistent_notifications: false })))));
  }
}
