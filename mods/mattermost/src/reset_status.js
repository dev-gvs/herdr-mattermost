// Mattermost's ResetStatusModal: on coming back with a status you set yourself, or Out of office, it asks whether to
// go back online. Drawn by a dialog copy of this mod. The dialog only answers: the panel makes the calls, since the
// copy is gone as soon as it closes and Esc closes it without asking.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme } from "herdr";
import { FONT, alpha } from "../main.js";
import { request } from "./menu.js";

export const RESET_W = 600;
// Out of office has no checkbox row, and only its Do not disturb wording takes two lines.
export const resetHeight = ({ status, newStatus }) => (status.status !== "ooo" ? 234 : newStatus === "dnd" ? 224 : 204);
const OUT_OF_OFFICE = "ooo";
const PREFERENCE = "auto_reset_manual_status";

const WORDS = {
  away: {
    autoResponder: 'Would you like to switch your status to "Away" and disable automatic replies?',
    button: 'Set status to "Away"',
    cancel: 'Stay as "Away"',
    message: 'Would you like to switch your status to "Away"?',
    title: 'Your status is set to "Away"',
  },
  dnd: {
    autoResponder: 'Would you like to switch your status to "Do not disturb" and disable automatic replies?',
    button: 'Set status to "Do not disturb"',
    cancel: 'Stay as "Do not disturb"',
    message: 'Would you like to switch your status to "Do not disturb"?',
    title: 'Your status is set to "Do not disturb"',
  },
  offline: {
    autoResponder: 'Would you like to switch your status to "Offline" and disable automatic replies?',
    button: 'Set status to "Offline"',
    cancel: 'Stay "Offline"',
    message: 'Would you like to switch your status to "Offline"?',
    title: 'Your status is set to "Offline"',
  },
  online: {
    autoResponder: 'Would you like to switch your status to "Online" and disable automatic replies?',
    button: 'Set status to "Online"',
    message: 'Would you like to switch your status to "Online"?',
  },
  ooo: {
    cancel: 'Stay "Out of office"',
    title: 'Your status is set to "Out of office"',
  },
};

// A web page mounts the modal once per load, and every panel here shares this module, so a second panel doesn't ask
// again. Keyed by whether it's the demo, which is a separate account.
const started = new Set();
export function firstStart(demo) {
  if (started.has(demo)) return false;
  started.add(demo);
  return true;
}
export const forgetStart = (demo) => started.delete(demo);

// As Mattermost's getStatusFromSlashCommand.
export function statusFromCommand(message) {
  const status = message.split(" ")[0].slice(1);
  return message[0] === "/" && (status === "online" || status === "away" || status === "dnd" || status === "offline") ? status : "";
}

// Mattermost's autoResetStatus and the modal's componentDidMount: what to ask, if anything. A status you set yourself
// asks until "Do not ask me again" is on file, then either resets by itself or stays. Out of office always asks,
// because the automatic replies keep going while it stands.
export async function resetCheck(panel, cx, newStatus = "online") {
  if (panel.clientConfig?.EnableUserStatuses === "false") return null;
  const me = panel.me.id;
  try {
    const [status] = await panel.api(cx, "/users/status/ids", { method: "POST", body: [me] });
    if (!status) return null;
    panel.statuses.set(me, status.status);
    panel.dndEnd = status.dnd_end_time ?? 0;
    if (status.status !== OUT_OF_OFFICE && status.manual && panel.autoResetPref === "true") {
      await panel.api(cx, `/users/${me}/status`, { method: "PUT", body: { user_id: me, status: "online" } });
      panel.statuses.set(me, "online");
      panel.dndEnd = 0;
    }
    return status.status === OUT_OF_OFFICE || (status.manual && panel.autoResetPref === "") ? { status, newStatus } : null;
  } catch {
    return null;
  }
}

// `status` is what to set, the whole of what the server said with the new status in it, as Mattermost sends it.
// Turning off the automatic replies is the server's doing, on any change away from Out of office.
export async function answerReset(panel, { status, pref }, cx) {
  const me = panel.me.id;
  if (pref) panel.autoResetPref = pref;
  const calls = [];
  if (status) {
    calls.push(panel.api(cx, `/users/${me}/status`, { method: "PUT", body: status }).then((saved) => {
      panel.statuses.set(me, saved.status);
      panel.dndEnd = saved.dnd_end_time ?? 0;
    }));
  }
  if (pref) calls.push(panel.api(cx, `/users/${me}/preferences`, { method: "PUT", body: [{ category: PREFERENCE, user_id: me, name: me, value: pref }] }));
  const failed = (await Promise.allSettled(calls)).find((r) => r.status === "rejected")?.reason;
  if (failed) panel.error = failed.text ?? String(failed.message ?? failed);
  panel.redraw(cx);
}

export class ResetStatusDialog {
  constructor(cx) {
    this.spec = props().resetStatus;
    this.checked = false;
    this.answered = false;
    this.focus = cx.focus_handle();
    this.focus.focus();
  }

  answer(confirmed) {
    this.answered = true;
    const pref = this.checked ? String(confirmed) : null;
    const status = confirmed ? { ...this.spec.status, status: this.spec.newStatus } : null;
    if (status || pref) request("reset-status-answer", { status, pref });
    closeOverlay(props().overlay);
  }

  // Mattermost hides on Esc and on a press outside through Cancel, ticked box included. Herdr closes the overlay for
  // those without telling the dialog first.
  closing() {
    if (!this.answered && this.checked) request("reset-status-answer", { status: null, pref: "false" });
  }

  render() {
    const t = theme();
    const { status, newStatus } = this.spec;
    const from = WORDS[status.status], to = WORDS[newStatus];
    const away = status.status === OUT_OF_OFFICE;
    const button = (id, label, primary, onClick) => div().id(id).h(40).px(20).flex().flex_none().items_center().rounded(4).cursor_pointer().text_size(14).font_semibold()
      .bg(primary ? t.accent : alpha(t.accent, 0.08)).text_color(primary ? t.accent_foreground : t.accent)
      .hover((s) => s.bg(primary ? t.accent : alpha(t.accent, 0.16)))
      .on_click(onClick).child(label);
    return v_flex().id("mm-reset-status").relative().size_full().p(32).bg(t.popover).font_family(FONT).text_size(14).text_color(t.foreground)
      .track_focus(this.focus)
      .on_key_down((e) => { if (e.keystroke === "enter") this.answer(true); })
      .child(h_flex().flex_none().mb(16).items_center().gap(12)
        .child(div().flex_1().min_w(0).truncate().text_size(22).font_semibold().child(from?.title ?? ""))
        .child(div().id("reset-close").size(32).flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.answer(false)).child(svg("mods/mattermost/icons/x.svg").size(18))))
      .child(div().flex_none().child((away ? to?.autoResponder : to?.message) ?? ""))
      .when(!away, (el) => el.child(h_flex().flex_none().mt(10).gap(6).justify_end().items_center()
        .child(h_flex().id("reset-ask").gap(6).items_center().cursor_pointer()
          .on_click((_e, cx) => { this.checked = !this.checked; cx.notify(); })
          .child(div().size(14).flex_none().flex().items_center().justify_center().rounded(2).border_1().border_color(this.checked ? t.accent : alpha(t.foreground, 0.32)).bg(this.checked ? t.accent : t.background)
            .when(this.checked, (box) => box.child(svg("mods/mattermost/icons/check.svg").size(12).text_color(t.accent_foreground))))
          .child(div().child("Do not ask me again")))))
      .child(div().flex_1())
      .child(h_flex().flex_none().pt(32).gap(8).justify_end()
        .child(button("reset-cancel", from?.cancel ?? "Cancel", false, () => this.answer(false)))
        .child(button("reset-confirm", to?.button ?? "", true, () => this.answer(true))));
  }
}
