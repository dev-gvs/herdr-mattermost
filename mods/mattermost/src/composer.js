// Mattermost's message box: the bordered box with the text, the formatting bar under it and the actions on
// its right (show or hide the bar, emoji, send). Each box is a retained part, so a press on the bar redraws
// the box and not the messages above it.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Textarea, Popup } from "gpui-base";
import { settings } from "herdr";
import { FONT, alpha } from "../main.js";
import { chooseFiles, uploadFiles } from "./upload.js";
import { CONTROLS, applyMarkdown, isWithinCodeBlock, layoutMode, readSelection, shortcut, splitControls, tooltip } from "./format.js";

const BAR_H = 48;
const LINE = 20;
// The text's padding, from Mattermost's .custom-textarea: 13px 0 12px 16px.
const TEXT_TOP = 13, TEXT_BOTTOM = 12, TEXT_LEFT = 16;
const ONE_LINE = TEXT_TOP + LINE + TEXT_BOTTOM;
// Below this window width Mattermost runs the box from edge to edge.
const NARROW_SCREEN = 768;
export const FORMAT_PREF = "advanced_text_editor";

const icon = (name, size = 18) => svg(`mods/mattermost/icons/compass/${name}.svg`).size(size);
const zoom = () => Number(settings()?.zoom) || 1;

export function iconButton(id, t, glyph, tip, press, { active = false, disabled = false } = {}) {
  return div().id(id).size(32).flex().flex_none().items_center().justify_center().rounded(4)
    .text_color(active ? t.accent : alpha(t.foreground, disabled ? 0.32 : 0.56))
    .when(active, (el) => el.bg(alpha(t.accent, 0.08)))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => (active ? s : s.bg(alpha(t.foreground, 0.08)).text_color(alpha(t.foreground, 0.72)))))
    .tooltip(tip)
    // Acting on the press keeps the box's keyboard and selection, as Mattermost's preventDefault does.
    .on_mouse_down("left", (e, cx) => {
      cx.stop_propagation();
      if (!disabled) press(e, cx);
    })
    .child(typeof glyph === "string" ? icon(glyph) : glyph);
}

const separator = (t) => div().w(1).h(24).flex_none().bg(alpha(t.foreground, 0.16));

export function formatHidden(panel, box) {
  return Boolean(panel.formatHidden?.[box.where]);
}

// Replaces the box's text and selection as an edit would, keeping the draft and the suggestions in step.
// The box reports the change later, by which time its text is this.
export function setText(panel, box, text, start, end = start) {
  box.input.set_value(text);
  box.input.set_selected_range({ start, end });
  box.suggest.reset(end);
  box.now = text;
  panel.noteDraft(box);
  box.input.focus();
  box.empty = !text.trim();
}

// The placeholder and the send button follow whether there's text. True when that changed.
export function noteEmpty(box) {
  const empty = !box.input.value().trim();
  if (empty === box.empty) return false;
  box.empty = empty;
  return true;
}

export function applyFormat(panel, box, mode, cx) {
  if (box.preview) return;
  const res = applyMarkdown({ markdownMode: mode, ...readSelection(box.input) });
  setText(panel, box, res.message, res.selectionStart, res.selectionEnd);
  cx.notify(box.part);
}

// Emoji go in at the caret with a space after, and one before when they'd touch a word.
export function insertAtCaret(panel, box, text) {
  const { message, selectionStart, selectionEnd } = readSelection(box.input);
  const spaced = selectionStart !== 0 && !/\s/.test(message[selectionStart - 1]) ? ` ${text} ` : `${text} `;
  setText(panel, box, message.slice(0, selectionStart) + spaced + message.slice(selectionEnd), selectionStart + spaced.length);
}

export function toggleFormatBar(panel, box, cx) {
  if (box.preview) return;
  panel.setFormatHidden(box.where, !formatHidden(panel, box), cx);
}

// The text drawn as it will post, in place of the box; the message is parsed here because a render mustn't.
export function togglePreview(panel, box, cx) {
  if (!box.preview && (box.empty || formatHidden(panel, box))) return;
  box.preview = !box.preview;
  if (box.preview) panel.parsed(`preview-${box.name}`, box.input.value());
  else box.input.focus();
  cx.notify(box.part);
}

function onKey(panel, box, e, cx) {
  if (e.keystroke === "escape" && box.more) {
    box.more = false;
    cx.notify(box.part);
    cx.stop_propagation();
    return;
  }
  const action = shortcut(e.keystroke);
  if (!action) return;
  cx.stop_propagation();
  if (action === "emoji") return panel.openComposerPicker(box);
  if (action === "attach") return box.canAttach && cx.spawn(async (cx) => chooseFiles(panel, box, cx));
  if (action === "toggle") return toggleFormatBar(panel, box, cx);
  if (action === "preview") return togglePreview(panel, box, cx);
  if (box.preview) return;
  const sel = readSelection(box.input);
  if (sel.selectionStart && isWithinCodeBlock(sel.message, sel.selectionStart)) return;
  if (action === "link-selected" && sel.selectionStart === sel.selectionEnd) return;
  const mode = action === "link-selected" ? "link" : action;
  const res = applyMarkdown({ markdownMode: mode, ...sel });
  setText(panel, box, res.message, res.selectionStart, res.selectionEnd);
  cx.notify(box.part);
}

function control(panel, box, mode, t) {
  const c = CONTROLS[mode];
  return iconButton(`fmt-${box.name}-${mode}`, t, c.icon, tooltip(c.tip, c.keys), (_e, cx) => applyFormat(panel, box, mode, cx), { disabled: box.preview });
}

// Mattermost's bar gives up controls into a "more" row as it narrows, by its own width.
function formattingBar(panel, box, t) {
  const mode = layoutMode(box.width ?? 1000, box.rhs);
  const extra = box.extraControls?.length ?? 0;
  const { shown, hidden } = splitControls(mode, extra, box.rhs);
  const wide = mode === "wide";
  const out = [];
  for (const m of shown) {
    out.push(control(panel, box, m, t));
    if (m === "heading" && wide) out.push(separator(t));
  }
  if (extra) {
    if (wide) out.push(separator(t));
    out.push(...box.extraControls);
  }
  if (hidden.length) {
    const row = h_flex().p(5).gap(2).rounded(4).border_1().border_color(alpha(t.foreground, 0.16)).bg(t.background).shadow_md()
      .children(hidden.map((m) => control(panel, box, m, t)));
    // The row is centred over the button, as Mattermost's floating "top" placement puts it.
    const rowW = hidden.length * 32 + (hidden.length - 1) * 2 + 12;
    const trigger = iconButton(`fmt-${box.name}-more`, t, "dots-horizontal", "More formatting options", (_e, cx) => {
      box.more = !box.more;
      cx.notify(box.part);
    }, { active: box.more });
    out.push(Popup.new(`fmt-${box.name}-more-row`, trigger).anchor("bottom_left")
      .when(Boolean(box.more), (el) => el.content(div().pb(4).ml(Math.min(0, 16 - rowW / 2) + (mode === "min" ? 55 : 0)).child(row))));
  }
  return h_flex().flex_1().min_w(0).h(BAR_H).pl(7).gap(2).items_center().overflow_hidden().children(out);
}

function sendButton(panel, box, t, disabled) {
  return div().id(`send-${box.name}`).w(48).h(32).flex().flex_none().items_center().justify_center().rounded(4)
    .bg(disabled ? alpha(t.foreground, 0.08) : t.accent).text_color(disabled ? alpha(t.foreground, 0.32) : "#ffffff")
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.9)).tooltip("Send Now  Enter"))
    .on_mouse_down("left", (_e, cx) => {
      cx.stop_propagation();
      if (!disabled) panel.sendBox(box, cx);
    })
    .child(icon("send"));
}

function actions(panel, box, t) {
  const hiddenBar = formatHidden(panel, box);
  const aa = div().id(`fmt-${box.name}-toggle`).h(32).px(6).flex().flex_none().items_center().rounded(4)
    .text_color(alpha(t.foreground, box.preview ? 0.32 : 0.56))
    .when(!box.preview, (el) => el.cursor_pointer().hover((s) => s.bg(alpha(t.foreground, 0.08)).text_color(alpha(t.foreground, 0.72))))
    .tooltip(tooltip(hiddenBar ? "Show Formatting" : "Hide Formatting", "Ctrl+Alt+T"))
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); toggleFormatBar(panel, box, cx); })
    .child(icon("format-letter-case")).child(icon(hiddenBar ? "chevron-down" : "chevron-up", 12));
  return h_flex().flex_none().gap(2).items_center()
    .child(aa)
    .child(separator(t))
    .when(Boolean(box.canAttach), (el) => el.child(iconButton(`attach-${box.name}`, t, "paperclip", tooltip("Upload files", "Ctrl+U"),
      (_e, cx) => cx.spawn(async (cx) => chooseFiles(panel, box, cx)))))
    .child(iconButton(`emoji-${box.name}`, t, "emoticon-happy-outline", tooltip("Emoji picker", "Ctrl+Alt+E"), (e) => {
      box.pickerAt = e.bounds ?? null;
      panel.openComposerPicker(box);
    }, { disabled: box.preview }))
    .child(sendButton(panel, box, t, (box.empty && !box.files) || box.uploading));
}

export function composerView(panel, box, t, { placeholder, error, files }) {
  const w = (panel.width ?? 1000) / zoom();
  const edge = w < NARROW_SCREEN;
  const hiddenBar = formatHidden(panel, box);
  // With the bar hidden, the actions share the first line until the text needs more.
  const inline = hiddenBar && !box.rhs && !box.long;
  // Mattermost keeps the preview's eye in the box's top right while the bar shows and there's text.
  const eye = !hiddenBar && (!box.empty || box.preview);
  const text = box.preview ? v_flex().flex_1().min_w(0).min_h(ONE_LINE).pl(TEXT_LEFT).pr(48).pt(TEXT_TOP).pb(TEXT_BOTTOM).text_size(14)
    .children(panel.previewText(box, t)) : div().relative().flex_1().min_w(0)
    .on_size_change((size, cx) => {
      const long = size.height / zoom() > ONE_LINE + 4;
      if (long === box.long) return;
      box.long = long;
      cx.notify(box.part);
    })
    .child(box.suggest.around(Textarea.new(box.input).w_full().pl(TEXT_LEFT).pr(hiddenBar ? 16 : 48).pt(TEXT_TOP).pb(TEXT_BOTTOM)
      .line_height(`${LINE}px`).rounded(0).border_0().bg(t.background).text_size(14).font_family(FONT)))
    .when(box.empty && !box.preview, (el) => el.child(div().absolute().left(TEXT_LEFT).top(TEXT_TOP).right(16).h(LINE).truncate()
      .text_size(14).line_height(`${LINE}px`).text_color(alpha(t.foreground, 0.64)).child(placeholder)));
  const border = alpha(t.foreground, box.focused ? 0.32 : 0.16);
  const frame = box.suggest.keys(v_flex().id(`composer-${box.name}`), 0).relative().bg(t.background)
    .when(!edge, (el) => el.border_2().rounded(4))
    .when(edge, (el) => el.border_t_2().border_b_2())
    .border_color(border)
    .when(!box.focused, (el) => el.hover((s) => s.border_color(alpha(t.foreground, 0.24))))
    .on_size_change((size, cx) => {
      const width = size.width / zoom() - (edge ? 0 : 4);
      if (Math.abs(width - (box.width ?? 0)) < 1) return;
      const before = box.width === undefined ? null : layoutMode(box.width, box.rhs);
      box.width = width;
      if (layoutMode(width, box.rhs) !== before) cx.notify(box.part);
    })
    .on_key_down((e, cx) => onKey(panel, box, e, cx))
    .when(Boolean(box.canAttach), (el) => el.on_drop((e, cx) => { if (e.paths?.length) cx.spawn(async (cx) => uploadFiles(panel, box, e.paths, cx)); }))
    .on_mouse_down("left", (_e, cx) => {
      cx.stop_propagation();
      box.input.focus();
      box.suggest.moved(cx);
      if (box.more) {
        box.more = false;
        cx.notify(box.part);
      }
    })
    .when(Boolean(box.labels), (el) => el.child(box.labels))
    .when(inline && !files, (el) => el.child(h_flex().items_start().child(text).child(div().pt(7).pr(7).flex_none().child(actions(panel, box, t)))))
    .when(!inline || Boolean(files), (el) => el.child(text).when(Boolean(files), (f) => f.child(files)).child(h_flex().relative().h(BAR_H).items_center()
      .child(hiddenBar ? div().flex_1() : formattingBar(panel, box, t))
      .child(div().pr(7).flex_none().child(actions(panel, box, t)))))
    // Last, so it paints over the text box's own background.
    .when(eye, (el) => el.child(div().absolute().top(7).right(7).child(iconButton(`preview-${box.name}`, t, "eye-outline",
      tooltip("Show/Hide Preview", "Ctrl+Alt+P"), (_e, cx) => togglePreview(panel, box, cx), { active: box.preview }))));
  return v_flex().flex_none().px(edge ? 0 : box.rhs ? 16 : 24).pt(box.rhs ? 12 : 0).font_family(FONT)
    .child(frame)
    .child(div().h(24).flex_none().px(edge ? 16 : 0).pt(4).text_size(12).truncate().text_color(t.blocked).child(error ?? ""));
}
