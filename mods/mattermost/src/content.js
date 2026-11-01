// Mattermost message text, turned into what the panel draws.

const SHORTCODE = /:([a-z0-9_+\-]+):/gi;
// The lookbehind keeps addresses inside URLs and emails ("/@x", "a@b") from reading as mentions.
const MENTION = /(^|[\s(\[*_>~])@([a-z0-9][a-z0-9._\-]*[a-z0-9_]|[a-z0-9])/gi;
export const SPECIAL = new Set(["channel", "here", "all"]);
const PICTOGRAPH = /^\p{Extended_Pictographic}/u;
// Mattermost's `![alt](url =WxH "title")`, optionally inside a link.
const IMAGE = /\[?!\[([^\]]*)\]\(\s*<?(https?:\/\/(?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+=(\d*)(?:x(\d*))?)?(?:\s+"[^"]*")?\s*\)(?:\]\(\s*([^\s)]+)\s*\))?/gi;
// IMAGE can scan the rest of the text from every "![", and Herdr's cut-off can't be caught, so a message
// made of nothing else would never finish parsing. Past this many, its images stay as typed.
const MAX_IMAGES = 32;
const fewImages = (text) => text.split("![").length - 1 <= MAX_IMAGES;
// A word-by-word line costs an element per word, and a render is cut off at 50 ms. Past this many characters
// in a message, its custom emoji stay as :names:.
const WORD_LAYOUT = 2000;
const LINE_COST = 30;
// Each line costs a few regexes, and attachments are parsed during a render. A message longer than this isn't split.
const MAX_LINES = 1000;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

// Mattermost leaves code as typed, so every rewrite skips fenced blocks and inline spans.
function outsideCode(text, fn) {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, i) => (i % 2 ? part : fn(part))).join("");
}

export function mentionNames(text) {
  const names = new Set();
  outsideCode(text, (part) => {
    for (const m of part.matchAll(MENTION)) names.add(m[2].replace(/\.$/, "").toLowerCase());
    return part;
  });
  return [...names].filter((n) => !SPECIAL.has(n));
}

// Markdown for TextView: standard emoji as characters, mentions as links, and single newlines kept,
// since Mattermost breaks lines where CommonMark would join them. Mentions that notify you are
// highlighted as Mattermost does, with TextView's inline <mark>.
export function prepare(text, { emoji, mention, mine, highlight }) {
  const inline = outsideCode(text, (part) => (fewImages(part) ? part.replace(IMAGE, (_whole, alt, url) => `[${alt || "image"}](${url})`) : part)
    .replace(SHORTCODE, (whole, name) => emoji[name.toLowerCase()] ?? whole)
    .replace(MENTION, (whole, before, name) => {
      const bare = name.replace(/\.$/, "");
      const label = mention(bare);
      if (!label) return whole;
      const link = `[@${label}](mention:${name})`;
      return `${before}${mine?.(bare) ? `<mark color="${highlight()}">${link}</mark>` : link}${name.endsWith(".") ? "." : ""}`;
    }));
  // Inline code spans sit inside a line, so only fenced blocks are kept out of the line-break pass.
  return inline.split(/(```[\s\S]*?```)/g).map((part, i) => (i % 2 ? part : part.replace(/([^\n])\n(?=[^\n])/g, "$1  \n"))).join("");
}

// TextView reserves room for an image but never draws one, and it can't take custom emoji at all, so
// those parts of a message are drawn outside it: { md } blocks, { image } blocks and { line } rows. Code and
// tables stay whole, since splitting one would break it; an image in a table becomes a link instead.
export function segments(text, ctx) {
  const out = [];
  let md = [];
  const flush = () => {
    const body = md.join("\n").replace(/^\n+/, "").trimEnd();
    md = [];
    if (body) out.push({ md: prepare(body, ctx) });
  };
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES) {
    md = lines;
    flush();
    return out;
  }
  const whole = wholeLines(lines);
  const images = fewImages(text);
  let room = WORD_LAYOUT;
  lines.forEach((line, i) => {
    if (whole[i]) { md.push(line); return; }
    for (const piece of images && line.includes("![") ? pieces(line) : [line]) {
      if (piece.image) { flush(); out.push(piece); }
      else if (piece.length <= room && piece.includes(":") && hasCustom(piece, ctx)) { room -= piece.length + LINE_COST; flush(); out.push({ line: inlineLine(piece, ctx) }); }
      else md.push(piece);
    }
  });
  flush();
  return out;
}

// Which lines markdown reads as code or a table, and so have to reach TextView as typed.
function wholeLines(lines) {
  let fence = null, table = false, list = false, code = false, blank = true;
  return lines.map((line, i) => {
    const afterBlank = blank;
    blank = !line.trim();
    if (fence) {
      if (fence.test(line)) fence = null;
      return true;
    }
    // An odd number of ``` leaves a block open; an even one is inline code within the line.
    if (line.includes("```") && line.split("```").length % 2 === 0) { fence = /```/; return true; }
    if (/^\s*~{3,}/.test(line)) { fence = /^\s*~{3,}\s*$/; return true; }
    if (blank) { table = false; return false; }
    if (!table && line.includes("|")) {
      const next = lines[i + 1] ?? "";
      table = next.includes("|") && next.includes("-") && /^[\s|:-]+$/.test(next);
    }
    if (table || /^\s*\|/.test(line)) return true;
    const indented = /^(?: {4}|\t)/.test(line);
    // Indentation under a list item continues the item, and right under a paragraph continues the paragraph.
    code = indented && !list && (code || afterBlank);
    if (!indented) list = LIST_ITEM.test(line) || (list && !afterBlank);
    return code;
  });
}

function pieces(line) {
  const code = [...line.matchAll(/`[^`]*`/g)].map((m) => [m.index, m.index + m[0].length]);
  const out = [];
  let at = 0;
  for (const m of line.matchAll(IMAGE)) {
    if (code.some(([a, b]) => m.index >= a && m.index < b)) continue;
    out.push(line.slice(at, m.index), { image: { alt: m[1], url: m[2], w: Number(m[3]) || 0, h: Number(m[4]) || 0, link: m[5] ?? null } });
    at = m.index + m[0].length;
  }
  out.push(line.slice(at));
  // A list marker or quote sign left with nothing beside it, once its image has moved out.
  return out.length === 1 ? out : out.filter((p) => p.image || !/^(?:>|[-*+]|\d+[.)])?$/.test(p.trim()));
}

// matchAll and a regex split each build a new RegExp, which costs about 50 µs in Herdr's engine, and this runs
// on every line, so these two keep their own and loop over exec.
const SHORTCODE_SCAN = new RegExp(SHORTCODE);
const hasCustom = (text, { custom }) => {
  const bare = text.includes("`") ? text.replace(/`[^`]*`/g, " ") : text;
  SHORTCODE_SCAN.lastIndex = 0;
  for (let m; (m = SHORTCODE_SCAN.exec(bare)); ) if (custom(m[1].toLowerCase())) return true;
  return false;
};

const INLINE = /`([^`]+)`|\[([^\]]+)\]\(((?:[^\s()]|\([^\s()]*\))+)[^)]*\)|(\*\*\*|\*\*|__|~~|\*(?=\S)|(?<=\S)\*|(?<![a-z0-9])_(?=\S)|(?<=\S)_(?![a-z0-9]))|:([a-z0-9_+\-]+):|(https?:\/\/[^\s<>]+)|(?<![a-z0-9/])@([a-z0-9][a-z0-9._\-]*[a-z0-9_]|[a-z0-9])|(\s+)/gi;

// One line of markdown as styled words, for the lines that hold a custom emoji.
function inlineLine(text, { emoji, custom, mention, mine }) {
  const [, indent, prefix = "", body] = text.match(/^(\s*)(#{1,6}\s+|(?:>\s*)+|[-*+]\s+|\d+[.)]\s+)?([\s\S]*)$/);
  const style = { bold: false, italic: false, strike: false };
  const tokens = [];
  const add = (token) => tokens.push({ ...style, ...token });
  let at = 0;
  INLINE.lastIndex = 0;
  for (let m; (m = INLINE.exec(body)); ) {
    if (m.index > at) add({ text: body.slice(at, m.index) });
    at = m.index + m[0].length;
    const [whole, code, label, url, mark, name, bare, who, space] = m;
    if (code) add({ text: code, code: true });
    else if (label) add({ text: label, link: url });
    else if (mark) {
      if (mark.startsWith("~")) style.strike = !style.strike;
      else {
        if (mark.length >= 2) style.bold = !style.bold;
        if (mark.length !== 2) style.italic = !style.italic;
      }
    } else if (name) {
      const n = name.toLowerCase();
      add(custom(n) ? { custom: n } : emoji[n] ? { emoji: emoji[n] } : { text: whole });
    } else if (bare) add({ text: bare, link: bare });
    else if (who) {
      const person = who.replace(/\.$/, "");
      const shown = mention(person);
      add(shown ? { mention: `@${shown}`, mine: Boolean(mine?.(person)) } : { text: whole });
    } else if (space) tokens.push({ space: true });
  }
  if (at < body.length) add({ text: body.slice(at) });
  const trimmed = prefix.trim();
  return {
    tokens,
    indent: indent.length,
    heading: trimmed.startsWith("#") ? trimmed.length : 0,
    quote: trimmed.startsWith(">"),
    marker: /^[-*+]$/.test(trimmed) ? "•" : /^\d/.test(trimmed) ? trimmed : null,
  };
}

// Mattermost draws a message that is only a few emoji large.
export function jumbo(text, { emoji, custom }) {
  const parts = text.trim().split(/\s+/);
  if (!parts[0] || parts.length > 8) return null;
  const out = [];
  for (const part of parts) {
    const codes = part.match(/^(:[a-z0-9_+\-]+:)+$/i);
    if (codes) {
      for (const [, name] of part.matchAll(SHORTCODE)) {
        const n = name.toLowerCase();
        if (custom(n)) out.push({ custom: n });
        else if (emoji[n]) out.push({ emoji: emoji[n] });
        else return null;
      }
    } else if (PICTOGRAPH.test(part) && [...part].length <= 3) out.push({ emoji: part });
    else return null;
  }
  return out;
}
