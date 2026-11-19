// The message box: a flat bar across the bottom of a conversation with attach, the text, emoji and a send button
// that shows once there's something to send. Each box is a retained part, so a press in it redraws the box and not
// the messages above it. The box that edits a post in place is the same bar in a border of its own, with Save and
// Cancel under it instead of send.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Textarea } from "gpui-base";
import { settings } from "herdr";
import { FONT, alpha } from "../main.js";
import { chooseFiles, filesAsText, pasteFiles, uploadFiles } from "./upload.js";
import { applyMarkdown, isWithinCodeBlock, readSelection, shortcut } from "./format.js";

const LINE = 20;
const BUTTON = 36;
const PAD_Y = 6;

const zoom = () => Number(settings()?.zoom) || 1;

function roundButton(id, t, icon, tip, press, { primary = false, disabled = false } = {}) {
  return div().id(id).size(BUTTON).my(PAD_Y).flex().flex_none().items_center().justify_center().rounded_full()
    .when(primary, (el) => el.bg(t.accent)).text_color(primary ? t.accent_foreground : disabled ? alpha(t.muted, 0.5) : t.muted)
    .when(primary && disabled, (el) => el.opacity(0.5))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => (primary ? s.opacity(0.88) : s.bg(t.hover).text_color(t.foreground))))
    .tooltip(tip)
    // Acting on the press keeps the box's keyboard and selection.
    .on_mouse_down("left", (e, cx) => {
      cx.stop_propagation();
      if (!disabled) press(e, cx);
    })
    .child(svg(`mods/mattermost/icons/${icon}.svg`).size(primary ? 15 : 18));
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

// The placeholder and the send button follow whether there's text. True when the box needs drawing again.
export function noteText(box) {
  const empty = !box.input.value().trim();
  if (empty === box.empty) return false;
  box.empty = empty;
  return true;
}

// Files copied in a file manager paste as their URLs in text, and the box has inserted them by the time it
// reports the change, so the text comes out again and the files go up instead, as a drop of them would.
// True when it took the paste.
export function takeFilePaste(panel, box, before, now, cx) {
  if (!box.canAttach) return false;
  let start = 0;
  while (start < before.length && start < now.length && before[start] === now[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < now.length - start && before[before.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  const inserted = now.slice(start, now.length - tail);
  // Only a change that looks like one goes to the clipboard, which isn't free to read on every keystroke.
  if (!filesAsText(inserted)) return false;
  const text = cx.read_from_clipboard();
  const bare = (s) => s?.replace(/\r/g, "");
  if (!filesAsText(text) || bare(inserted) !== bare(text)) return false;
  setText(panel, box, before, start, before.length - tail);
  cx.spawn(async (cx) => pasteFiles(panel, box, cx, text));
  return true;
}

// Emoji go in at the caret with a space after, and one before when they'd touch a word.
export function insertAtCaret(panel, box, text) {
  const { message, selectionStart, selectionEnd } = readSelection(box.input);
  const spaced = selectionStart !== 0 && !/\s/.test(message[selectionStart - 1]) ? ` ${text} ` : `${text} `;
  setText(panel, box, message.slice(0, selectionStart) + spaced + message.slice(selectionEnd), selectionStart + spaced.length);
}

function onKey(panel, box, e, cx) {
  const action = shortcut(e.keystroke);
  if (!action) return;
  cx.stop_propagation();
  if (action === "emoji") return panel.openComposerPicker(box);
  if (action === "attach") return box.canAttach && cx.spawn(async (cx) => chooseFiles(panel, box, cx));
  const sel = readSelection(box.input);
  if (sel.selectionStart && isWithinCodeBlock(sel.message, sel.selectionStart)) return;
  if (action === "link-selected" && sel.selectionStart === sel.selectionEnd) return;
  const mode = action === "link-selected" ? "link" : action;
  const res = applyMarkdown({ markdownMode: mode, ...sel });
  setText(panel, box, res.message, res.selectionStart, res.selectionEnd);
  cx.notify(box.part);
}

// `boxed` draws the bar in a border of its own, as on a page rather than at the bottom of a conversation.
export function composerView(panel, box, t, { placeholder, error, files, footer = [], boxed = false }) {
  const framed = box.edit || boxed;
  const sendable = (!box.empty || Boolean(box.files)) && !box.edit;
  const text = div().relative().flex_1().min_w(0).my(PAD_Y)
    .child(box.suggest.around(Textarea.new(box.input).w_full().pl(10).pr(8).py(8)
      .line_height(`${LINE}px`).rounded(0).border_0().bg(framed ? t.background : alpha(t.background, 0)).text_size(14).font_family(FONT)))
    .when(box.empty, (el) => el.child(div().absolute().left(10).top(8).right(8).h(LINE).truncate()
      .text_size(14).line_height(`${LINE}px`).text_color(t.dim).child(placeholder)));
  const bar = h_flex().px(6).gap(2).items_end()
    .when(Boolean(box.canAttach), (el) => el.child(roundButton(`attach-${box.name}`, t, "paperclip", "Attach files  Ctrl+U",
      (_e, cx) => cx.spawn(async (cx) => chooseFiles(panel, box, cx)))))
    .child(text)
    .child(roundButton(`emoji-${box.name}`, t, "smile", "Emoji  Ctrl+Alt+E", (e) => {
      box.pickerAt = e.bounds ?? null;
      panel.openComposerPicker(box);
    }))
    .when(sendable, (el) => el.child(roundButton(`send-${box.name}`, t, "send", "Send  Enter", (_e, cx) => panel.sendBox(box, cx),
      { primary: true, disabled: box.uploading })));
  const frame = box.suggest.keys(v_flex().id(`composer-${box.name}`), 0).relative()
    .when(framed, (el) => el.bg(t.background))
    .when(!framed, (el) => el.border_t_1().border_color(box.focused ? t.accent : t.border))
    .when(framed, (el) => el.border_1().rounded(6).border_color(box.focused ? t.accent : t.border))
    .on_size_change((size) => { box.width = size.width / zoom(); })
    .on_key_down((e, cx) => onKey(panel, box, e, cx))
    .when(Boolean(box.canAttach), (el) => el.on_drop((e, cx) => { if (e.paths?.length) cx.spawn(async (cx) => uploadFiles(panel, box, e.paths, cx)); }))
    .on_mouse_down("left", (_e, cx) => {
      cx.stop_propagation();
      box.input.focus();
      box.suggest.moved(cx);
    })
    .when(Boolean(files), (el) => el.child(files))
    .child(bar);
  if (box.edit) {
    return v_flex().pt(6).font_family(FONT).child(frame)
      .when(Boolean(error), (el) => el.child(div().pt(4).text_size(12).text_color(t.blocked).child(error)))
      .children(footer);
  }
  return v_flex().flex_none().font_family(FONT)
    .when(Boolean(error), (el) => el.child(div().px(12).py(4).text_size(12).truncate().border_t_1().border_color(t.border).text_color(t.blocked).child(error)))
    .child(frame);
}
