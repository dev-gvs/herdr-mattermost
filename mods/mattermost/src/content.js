// Mattermost message text, turned into what the panel draws.

const SHORTCODE = /:([a-z0-9_+\-]+):/gi;
// The lookbehind keeps addresses inside URLs and emails ("/@x", "a@b") from reading as mentions.
const MENTION = /(^|[\s(\[*_>~])@([a-z0-9][a-z0-9._\-]*[a-z0-9_]|[a-z0-9])/gi;
export const SPECIAL = new Set(["channel", "here", "all"]);
const PICTOGRAPH = /^\p{Extended_Pictographic}/u;

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

// For messages with custom emoji, which TextView cannot place inline: lines of words, emoji and mentions.
export function tokens(text, { emoji, custom, mention, mine }) {
  return text.split("\n").map((line) => {
    const out = [];
    for (const word of line.split(/(\s+)/)) {
      if (!word) continue;
      let rest = word;
      while (rest) {
        const m = rest.match(/:([a-z0-9_+\-]+):/i);
        if (!m) { out.push(textToken(rest, mention, mine)); break; }
        if (m.index > 0) out.push(textToken(rest.slice(0, m.index), mention, mine));
        const name = m[1].toLowerCase();
        if (custom(name)) out.push({ custom: name });
        else if (emoji[name]) out.push({ emoji: emoji[name] });
        else out.push({ text: m[0] });
        rest = rest.slice(m.index + m[0].length);
      }
    }
    return out;
  });
}

function textToken(text, mention, mine) {
  const m = text.match(/^@([a-z0-9._\-]+)$/i);
  const bare = m && m[1].replace(/\.$/, "");
  const label = bare && mention(bare);
  return label ? { mention: `@${label}`, mine: Boolean(mine?.(bare)) } : { text };
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
