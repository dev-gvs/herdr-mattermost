// What Mattermost's formatting bar does to the text: its apply_markdown.ts, the bar's layout modes and the
// composer's shortcuts, ported as they are so the same press gives the same text and selection.

export const MODES = ["bold", "italic", "strike", "heading", "link", "code", "quote", "ul", "ol"];

export const CONTROLS = {
  bold: { icon: "format-bold", tip: "Bold", keys: "Ctrl+B" },
  italic: { icon: "format-italic", tip: "Italic", keys: "Ctrl+I" },
  strike: { icon: "format-strikethrough-variant", tip: "Strikethrough", keys: "Shift+Alt+X" },
  heading: { icon: "format-header", tip: "Heading" },
  link: { icon: "link-variant", tip: "Link", keys: "Ctrl+Alt+K" },
  code: { icon: "code-tags", tip: "Code", keys: "Ctrl+Alt+C" },
  quote: { icon: "format-quote-open", tip: "Quote", keys: "Shift+Alt+9" },
  ul: { icon: "format-list-bulleted", tip: "Bulleted List", keys: "Shift+Alt+8" },
  ol: { icon: "format-list-numbered", tip: "Numbered List", keys: "Shift+Alt+7" },
};

export const tooltip = (tip, keys) => (keys ? `${tip}  ${keys}` : tip);

// Widths are the bar's own, which spans the box under the actions on its right.
const THRESHOLDS = { center: [[641, "wide"], [424, "normal"], [310, "narrow"]], rhs: [[620, "wide"], [460, "normal"], [340, "narrow"]] };
const VISIBLE = { wide: 9, normal: 5, narrow: 2, min: 1 };

export function layoutMode(width, rhs) {
  for (const [min, mode] of THRESHOLDS[rhs ? "rhs" : "center"]) if (width >= min) return mode;
  return "min";
}

// Center boxes fit one extra control before giving up a formatting one; the right-hand side fits none.
export function splitControls(mode, extra, rhs) {
  const count = mode === "wide" ? VISIBLE.wide : Math.max(0, VISIBLE[mode] - (rhs ? extra : Math.max(0, extra - 1)));
  return { shown: MODES.slice(0, count), hidden: MODES.slice(count) };
}

// What a key press in the composer asks for, by Mattermost's use_key_handler. Shift with a digit arrives as
// the shifted character on most layouts, so both spellings count.
export function shortcut(keystroke) {
  const parts = keystroke.split("-"), key = parts.pop() || "-", mods = new Set(parts);
  const ctrl = mods.has("ctrl") || mods.has("cmd"), alt = mods.has("alt"), shift = mods.has("shift");
  if (ctrl && !alt && !shift) return { b: "bold", i: "italic", k: "link-selected", u: "attach" }[key] ?? null;
  if (ctrl && alt && !shift) return { k: "link", c: "code", e: "emoji", t: "toggle", p: "preview" }[key] ?? null;
  if (alt && !ctrl) return { x: "strike", 7: "ol", "&": "ol", 8: "ul", "*": "ul", 9: "quote", "(": "quote" }[key] ?? null;
  return null;
}

const CODE_FENCE = /^```.*$/gm;

export function isWithinCodeBlock(message, caret) {
  const fences = message.slice(0, caret).match(CODE_FENCE);
  return Boolean(fences && fences.length % 2 !== 0);
}

// A private-use character nobody types, standing in for the selection while it's found.
const MARK = "\uE000";

// Herdr's text state can set the selection but not read it. Replacing the selection with a marker shows
// where it was, and what's missing from the text is what it held; the text then goes back as it was.
export function readSelection(input) {
  const before = input.value();
  input.replace(MARK);
  const after = input.value();
  let start = 0;
  while (start < after.length && after[start] === before[start] && after[start] !== MARK) start++;
  const end = start + before.length - (after.length - MARK.length);
  input.set_value(before);
  input.set_selected_range({ start, end });
  return { message: before, selectionStart: start, selectionEnd: end };
}

export function applyMarkdown({ markdownMode, selectionStart, selectionEnd, message }) {
  if (selectionStart === null || selectionEnd === null) return { message, selectionStart: message.length, selectionEnd: message.length };
  const o = { selectionStart, selectionEnd, message };
  switch (markdownMode) {
    case "bold": return applyBoldItalicMarkdown({ ...o, markdownMode: "bold" });
    case "italic": return applyBoldItalicMarkdown({ ...o, markdownMode: "italic" });
    case "link": return applyLinkMarkdown(o);
    case "ol": return applyOlMarkdown(o);
    case "ul": return applyMarkdownToSelectedLines({ ...o, delimiter: "- " });
    case "heading": return applyMarkdownToSelectedLines({ ...o, delimiter: "### " });
    case "quote": return applyMarkdownToSelectedLines({ ...o, delimiter: "> " });
    case "strike": return applyMarkdownToSelection({ ...o, delimiter: "~~" });
    case "code": return applyCodeMarkdown(o);
  }
  throw Error(`Unsupported markdown mode: ${markdownMode}`);
}

const getMultilineSuffix = (suffix) => {
  if (suffix.startsWith("\n")) return "";
  return suffix.indexOf("\n") === -1 ? suffix : suffix.slice(0, suffix.indexOf("\n"));
};

const getNewSuffix = (suffix) => {
  if (suffix.startsWith("\n")) return suffix;
  return suffix.indexOf("\n") === -1 ? "" : suffix.slice(suffix.indexOf("\n"));
};

function applyOlMarkdown({ selectionEnd, selectionStart, message }) {
  const prefix = message.slice(0, selectionStart);
  const selection = message.slice(selectionStart, selectionEnd);
  const suffix = message.slice(selectionEnd);
  const newPrefix = prefix.includes("\n") ? prefix.slice(0, prefix.lastIndexOf("\n")) : "";
  const multilineSuffix = getMultilineSuffix(suffix);
  const newSuffix = getNewSuffix(suffix);
  const delimiterLength = 3;
  let counter = 1;
  const getDelimiter = () => `${counter++}. `;
  const multilinePrefix = prefix.includes("\n") ? prefix.slice(prefix.lastIndexOf("\n")) : prefix;
  let multilineSelection = multilinePrefix + selection + multilineSuffix;
  const isFirstLineSelected = !multilineSelection.startsWith("\n");
  if (selection.startsWith("\n")) multilineSelection = prefix + selection + multilineSuffix;

  const hasCurrentMarkdown = () => {
    const linesQuantity = (multilineSelection.match(/\n/g) || []).length;
    const withDelimiters = (multilineSelection.match(/\n\d\. /g) || []).length;
    if (withDelimiters === linesQuantity && !isFirstLineSelected) return true;
    return linesQuantity === withDelimiters && /^\d\. /.test(multilineSelection);
  };

  let newValue, newStart, newEnd;
  if (hasCurrentMarkdown()) {
    if (isFirstLineSelected) multilineSelection = multilineSelection.slice(delimiterLength);
    newValue = newPrefix + multilineSelection.replace(/\n\d\. /g, "\n") + newSuffix;
    let count = isFirstLineSelected ? 1 : 0;
    count += (multilineSelection.match(/\n/g) || []).length;
    newStart = Math.max(selectionStart - delimiterLength, 0);
    newEnd = Math.max(selectionEnd - delimiterLength * count, 0);
  } else {
    let count = 0;
    if (isFirstLineSelected) {
      multilineSelection = getDelimiter() + multilineSelection;
      count++;
    }
    multilineSelection = Array.from(multilineSelection).map((ch) => (ch === "\n" ? `\n${getDelimiter()}` : ch)).join("");
    newValue = newPrefix + multilineSelection + newSuffix;
    count += (multilineSelection.match(/\n/g) || []).length;
    newStart = selectionStart + delimiterLength;
    newEnd = selectionEnd + delimiterLength * count;
  }
  return { message: newValue, selectionStart: newStart, selectionEnd: newEnd };
}

function applyMarkdownToSelectedLines({ selectionEnd, selectionStart, message, delimiter }) {
  const prefix = message.slice(0, selectionStart);
  const selection = message.slice(selectionStart, selectionEnd);
  const suffix = message.slice(selectionEnd);
  const newPrefix = prefix.includes("\n") ? prefix.slice(0, prefix.lastIndexOf("\n")) : "";
  const multilinePrefix = prefix.includes("\n") ? prefix.slice(prefix.lastIndexOf("\n")) : prefix;
  const multilineSuffix = getMultilineSuffix(suffix);
  const newSuffix = getNewSuffix(suffix);
  let multilineSelection = multilinePrefix + selection + multilineSuffix;
  const isFirstLineSelected = !multilineSelection.startsWith("\n");
  if (selection.startsWith("\n")) multilineSelection = prefix + selection + multilineSuffix;

  const hasCurrentMarkdown = () => {
    const linesQuantity = (multilineSelection.match(/\n/g) || []).length;
    const withDelimiters = (multilineSelection.match(new RegExp(`\n${delimiter}`, "g")) || []).length;
    if (withDelimiters === linesQuantity && !isFirstLineSelected) return true;
    return linesQuantity === withDelimiters && multilineSelection.startsWith(delimiter);
  };

  let newValue, newStart, newEnd;
  if (hasCurrentMarkdown()) {
    if (isFirstLineSelected) multilineSelection = multilineSelection.slice(delimiter.length);
    newValue = newPrefix + multilineSelection.replace(new RegExp(`\n${delimiter}`, "g"), "\n") + newSuffix;
    let count = isFirstLineSelected ? 1 : 0;
    count += (multilineSelection.match(/\n/g) || []).length;
    newStart = Math.max(selectionStart - delimiter.length, 0);
    newEnd = Math.max(selectionEnd - delimiter.length * count, 0);
  } else {
    newValue = newPrefix + multilineSelection.replace(/\n/g, `\n${delimiter}`) + newSuffix;
    let count = 0;
    if (isFirstLineSelected) {
      newValue = delimiter + newValue;
      count++;
    }
    count += (multilineSelection.match(/\n/g) || []).length;
    newStart = selectionStart + delimiter.length;
    newEnd = selectionEnd + delimiter.length * count;
  }
  return { message: newValue, selectionStart: newStart, selectionEnd: newEnd };
}

function applyMarkdownToSelection({ selectionEnd, selectionStart, message, delimiter, delimiterStart, delimiterEnd }) {
  const opening = delimiterStart ?? delimiter, closing = delimiterEnd ?? delimiter;
  let prefix = message.slice(0, selectionStart);
  let selection = message.slice(selectionStart, selectionEnd);
  let suffix = message.slice(selectionEnd);
  const hasCurrentMarkdown = prefix.endsWith(opening) && suffix.startsWith(closing);
  let newValue, newStart = selectionStart, newEnd = selectionEnd;
  if (selection.endsWith(" ")) {
    selection = selection.slice(0, -1);
    suffix = ` ${suffix}`;
    newEnd -= 1;
  }
  if (selection.startsWith(" ")) {
    selection = selection.slice(1);
    prefix = `${prefix} `;
    newStart += 1;
  }
  if (hasCurrentMarkdown) {
    newValue = prefix.slice(0, prefix.length - opening.length) + selection + suffix.slice(closing.length);
    newStart -= opening.length;
    newEnd -= closing.length;
  } else {
    newValue = prefix + opening + selection + closing + suffix;
    newStart += opening.length;
    newEnd += closing.length;
  }
  return { message: newValue, selectionStart: newStart, selectionEnd: newEnd };
}

function applyBoldItalicMarkdown({ selectionEnd, selectionStart, message, markdownMode }) {
  const BOLD = "**", ITALIC = "*";
  let prefix = message.slice(0, selectionStart);
  let selection = message.slice(selectionStart, selectionEnd);
  let suffix = message.slice(selectionEnd);
  let newValue, newStart = selectionStart, newEnd = selectionEnd;
  if (selection.endsWith(" ")) {
    selection = selection.slice(0, -1);
    suffix = ` ${suffix}`;
    newEnd -= 1;
  }
  if (selection.startsWith(" ")) {
    selection = selection.slice(1);
    prefix = `${prefix} `;
    newStart += 1;
  }
  // Italic on **text** wraps it once more instead of taking one star off each side.
  let isItalicFollowedByBold = false, delimiter = "";
  if (markdownMode === "bold") delimiter = BOLD;
  else {
    delimiter = ITALIC;
    isItalicFollowedByBold = prefix.endsWith(BOLD) && suffix.startsWith(BOLD);
  }
  const hasCurrentMarkdown = prefix.endsWith(delimiter) && suffix.startsWith(delimiter);
  const hasItalicAndBold = prefix.endsWith(BOLD + ITALIC) && suffix.startsWith(BOLD + ITALIC);
  if (hasItalicAndBold || (hasCurrentMarkdown && !isItalicFollowedByBold)) {
    newValue = prefix.slice(0, prefix.length - delimiter.length) + selection + suffix.slice(delimiter.length);
    newStart -= delimiter.length;
    newEnd -= delimiter.length;
  } else {
    newValue = prefix + delimiter + selection + delimiter + suffix;
    newStart += delimiter.length;
    newEnd += delimiter.length;
  }
  return { message: newValue, selectionStart: newStart, selectionEnd: newEnd };
}

const URL = "url";

function applyLinkMarkdown({ selectionEnd, selectionStart, message, url = URL }) {
  const prefix = message.slice(0, selectionStart);
  const selection = message.slice(selectionStart, selectionEnd);
  const suffix = message.slice(selectionEnd);
  const delimiterStart = "[", delimiterEnd = `](${url})`;
  const hasMarkdown = prefix.endsWith(delimiterStart) && suffix.startsWith(delimiterEnd);
  let newValue, newStart, newEnd;
  // From the end of the label to the start of the url: "](".
  const urlShift = delimiterStart.length + 2;
  if (hasMarkdown) {
    newValue = prefix.slice(0, prefix.length - delimiterStart.length) + selection + suffix.slice(delimiterEnd.length);
    newStart = selectionStart - delimiterStart.length;
    newEnd = selectionEnd - delimiterStart.length;
  } else if (message.length === 0) {
    newValue = delimiterStart + delimiterEnd;
    newStart = newEnd = delimiterStart.length;
  } else if (selectionStart < selectionEnd) {
    newValue = prefix + delimiterStart + selection + delimiterEnd + suffix;
    newStart = selectionEnd + urlShift;
    newEnd = newStart + url.length;
  } else {
    const spaceBefore = prefix.charAt(prefix.length - 1) === " ";
    const spaceAfter = suffix.charAt(0) === " ";
    const cursorBeforeWord = (selectionStart !== 0 && spaceBefore && !spaceAfter) || (selectionStart === 0 && !spaceAfter);
    const cursorAfterWord = (selectionEnd !== message.length && spaceAfter && !spaceBefore) || (selectionEnd === message.length && !spaceBefore);
    if (cursorBeforeWord) {
      const word = message.slice(selectionStart, findWordEnd(message, selectionStart));
      newValue = prefix + delimiterStart + word + delimiterEnd + suffix.slice(word.length);
      newStart = selectionStart + word.length + urlShift;
      newEnd = newStart + urlShift;
    } else if (cursorAfterWord) {
      if (selectionStart === selectionEnd && selectionEnd === message.length) {
        newValue = `${message} ${delimiterStart}${delimiterEnd}`;
        newStart = newEnd = selectionEnd + 1 + delimiterStart.length;
      } else {
        const word = message.slice(findWordStart(message, selectionStart), selectionStart);
        newValue = prefix.slice(0, prefix.length - word.length) + delimiterStart + word + delimiterEnd + suffix;
        newStart = selectionStart + urlShift;
        newEnd = newStart + urlShift;
      }
    } else {
      const wordStart = findWordStart(message, selectionStart), wordEnd = findWordEnd(message, selectionStart);
      const word = message.slice(wordStart, wordEnd);
      newValue = prefix.slice(0, wordStart) + delimiterStart + word + delimiterEnd + message.slice(wordEnd);
      newStart = wordEnd + urlShift;
      newEnd = newStart + urlShift;
    }
  }
  return { message: newValue, selectionStart: newStart, selectionEnd: newEnd };
}

function applyCodeMarkdown({ selectionEnd, selectionStart, message }) {
  if (message.slice(selectionStart, selectionEnd).includes("\n")) {
    return applyMarkdownToSelection({ selectionEnd, selectionStart, message, delimiterStart: "```\n", delimiterEnd: "\n```" });
  }
  return applyMarkdownToSelection({ selectionEnd, selectionStart, message, delimiter: "`" });
}

function findWordEnd(text, start) {
  const end = text.indexOf(" ", start);
  return end === -1 ? text.length : end;
}

function findWordStart(text, start) {
  return text.lastIndexOf(" ", start - 1) + 1;
}
