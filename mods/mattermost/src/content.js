// Mattermost message text, turned into what the panel draws.

const SHORTCODE = /:([a-z0-9_+\-]+):/gi;
// The lookbehind keeps addresses inside URLs and emails ("/@x", "a@b") from reading as mentions.
const MENTION = /(^|[\s(\[*_>~])@([a-z0-9][a-z0-9._\-]*[a-z0-9_]|[a-z0-9])/gi;
export const SPECIAL = new Set(["channel", "here", "all"]);
const PICTOGRAPH = /^\p{Extended_Pictographic}/u;
// Mattermost's `![alt](url =WxH "title")`, optionally inside a link.
const IMAGE = /\[?!\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+=(\d*)x?(\d*))?(?:\s+"[^"]*")?\s*\)(?:\]\(\s*([^\s)]+)\s*\))?/gi;

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
  const inline = outsideCode(text, (part) => part
    .replace(IMAGE, (_whole, alt, url) => `[${alt || "image"}](${url})`)
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
// those parts of a message are drawn outside it: { md } blocks, { image } blocks and { line } rows. A
// table stays whole, since splitting one would break it; its images become links instead.
export function segments(text, ctx) {
  const out = [];
  let md = [];
  const flush = () => {
    const body = md.join("\n").replace(/^\n+|\s+$/g, "");
    md = [];
    if (body) out.push({ md: prepare(body, ctx) });
  };
  text.split(/(```[\s\S]*?```)/g).forEach((part, i) => {
    if (i % 2) { md.push(part); return; }
    for (const line of part.split("\n")) {
      if (/^\s*\|/.test(line)) { md.push(line); continue; }
      for (const piece of pieces(line)) {
        if (piece.image) { flush(); out.push(piece); }
        else if (hasCustom(piece, ctx)) { flush(); out.push({ line: inlineLine(piece, ctx) }); }
        else md.push(piece);
      }
    }
  });
  flush();
  return out;
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
  return out.length === 1 ? out : out.filter((p) => p.image || !/^\s*(>|[-*+]|\d+[.)])?\s*$/.test(p));
}

const hasCustom = (text, { custom }) => {
  let found = false;
  outsideCode(text, (part) => {
    for (const [, name] of part.matchAll(SHORTCODE)) found ||= custom(name.toLowerCase());
    return part;
  });
  return found;
};

const INLINE = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|(\*\*\*|\*\*|__|~~|\*(?=\S)|(?<=\S)\*|(?<![a-z0-9])_(?=\S)|(?<=\S)_(?![a-z0-9]))|:([a-z0-9_+\-]+):|(https?:\/\/[^\s<>]+)|(?<![a-z0-9/])@([a-z0-9][a-z0-9._\-]*[a-z0-9_]|[a-z0-9])|(\s+)/gi;

// One line of markdown as styled words, for the lines that hold a custom emoji.
function inlineLine(text, { emoji, custom, mention, mine }) {
  const [, indent, prefix = "", body] = text.match(/^(\s*)(#{1,6}\s+|(?:>\s*)+|[-*+]\s+|\d+[.)]\s+)?(.*)$/);
  const style = { bold: false, italic: false, strike: false };
  const tokens = [];
  const add = (token) => tokens.push({ ...style, ...token });
  let at = 0;
  for (const m of body.matchAll(INLINE)) {
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
