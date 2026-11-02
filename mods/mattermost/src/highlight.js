// What Mattermost lights up for you in a message: your mention keys, your groups' keys and, on a server whose
// plan has it, keywords that highlight without notifying. Mattermost finds them in the text nodes of parsed
// markdown; TextView parses the markdown itself, so here they are found in the text as typed, a line at a time.

// Mattermost's cjkrPattern. A key holding one of these gets no word boundaries: the script is written without
// spaces, or `\b` can't see its letters.
const CJKR = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f\u0400-\u04ff\u0500-\u052f\u2de0-\u2dff\u0e00-\u0e7f]/;

const CLOUD_STARTER = "cloud-starter";
const SELF_HOSTED_STARTER = "starter";
const GROUP_PAGE = 60;

const LOCAL = "\\p{L}\\p{Nd}!#$%&'*+\\-\\/=?^_`{|}~.";
// What Mattermost's formatter never reads as words: code and link targets, which it doesn't format, and the
// mentions, channels, addresses, hashtags and emoji it swaps for tokens first. The lookbehinds let a branch start only
// at the first character of a run. Without them the email branch rescans a long word from each of its letters, and
// Herdr's cut-off can't be caught.
const TOKEN = new RegExp([
  "```.*?```|`[^`]*`",
  "\\]\\((?:[^()\\s]|\\([^()\\s]*\\))*(?:\\s+\"[^\"]*\")?\\)",
  "<\\/?[a-z][^<>]*>",
  "(?<![a-z0-9+.\\-])[a-z][a-z0-9+.\\-]{0,30}:\\/\\/[^\\s<]*",
  "(?<![a-z0-9])www\\.[^\\s<]+",
  "(?<!\\w)(_*@[a-z0-9.\\-_]+(?::[a-z0-9.\\-_]+)?)",
  "(?<!\\w)~([a-z0-9.\\-_]*)",
  `(?<![${LOCAL}])([${LOCAL}]+@[\\p{L}\\d.\\-]+\\.\\p{L}{2,5})(?!\\p{L})`,
  "(?<!\\w)(#\\p{L}[\\p{L}\\d\\-_.]*[\\p{L}\\d])",
  "(?<!\\w)(:[\\w+\\-]+:)(?!\\w)",
].join("|"), "giu");
// `@a@b` is two mentions in Mattermost, whose second pass finds the second one beside the first's token.
const NEXT_MENTION = /@[a-z0-9.\-_]+(?::[a-z0-9.\-_]+)?/iy;
const SPECIAL = /^@(?:channel|all|here)(?!(?:\.|-|_)*[^\W_])/i;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const PUNCTUATION = /[^\p{L}\d]/u;

const escapeKey = (key) => key.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

function compile({ key, caseSensitive }) {
  const body = escapeKey(key);
  return {
    token: key.toLowerCase(),
    // Regex `i` compares by toUpperCase, so this is never stricter than the pattern and only spares running it.
    upper: key.toUpperCase(),
    re: new RegExp(CJKR.test(key) ? `()(${body})()` : `(^|\\W)(${body})(\\b|_+\\b)`, caseSensitive ? "g" : "gi"),
  };
}

// As Mattermost's getCurrentUserMentionKeys, whose order decides which of two overlapping keys wins.
function userKeys(me) {
  const notify = me?.notify_props;
  if (!notify) return [];
  const keys = notify.mention_keys ? notify.mention_keys.split(",").map((key) => ({ key })) : [];
  if (notify.first_name === "true" && me.first_name) keys.push({ key: me.first_name, caseSensitive: true });
  if (notify.channel === "true") keys.push({ key: "@channel" }, { key: "@all" }, { key: "@here" });
  const username = `@${me.username}`;
  if (!keys.some((k) => k.key === username)) keys.push({ key: username });
  return keys.filter((k) => k.key);
}

// Nothing lights up, as on Mattermost's Drafts page.
export const NO_KEYS = { id: "none", mention: [], words: [], me: null, channels: null };

// Which keys apply to which text, memoized as a scope: { id, mention, words, me, channels }. `id` goes in the key of
// the parsed-message cache, because two posts' texts are parsed differently under different scopes.
export class HighlightKeys {
  constructor(panel) {
    this.panel = panel;
    this.license = null;
    this.sku = null;
    this.groups = [];
    this.teamGroups = [];
    this.channelGroups = {};
    this.rebuild();
  }

  // Mattermost's team_controller: groups need a license, and LDAP's or custom groups being on.
  async load(cx) {
    const { panel } = this, me = panel.me;
    this.license ??= await panel.api(cx, "/license/client?format=old").catch(() => null);
    const license = this.license ?? {};
    if (this.license) panel.directory.license ??= license;
    const ldap = license.LDAPGroups === "true";
    this.groups = [];
    if (license.IsLicensed === "true" && (ldap || panel.clientConfig?.EnableCustomGroups === "true")) {
      this.groups = await panel.api(cx, `/groups?filter_allow_reference=false&page=0&per_page=${GROUP_PAGE}&include_archived=false&filter_has_member=${me.id}`).catch(() => []);
      const query = "?paginate=false&filter_allow_reference=true";
      if (ldap && panel.team?.group_constrained) this.teamGroups = (await panel.api(cx, `/teams/${panel.team.id}/groups${query}`).catch(() => null))?.groups ?? [];
      if (ldap && [...panel.channels.values()].some((c) => c.group_constrained)) this.channelGroups = (await panel.api(cx, `/teams/${panel.team.id}/groups_by_channels${query}`).catch(() => null))?.groups ?? {};
    }
    if (license.Cloud === "true" && me.notify_props?.highlight_keys && this.sku === null) {
      const [subscription, products] = await Promise.all([
        panel.api(cx, "/cloud/subscription").catch(() => null),
        panel.api(cx, "/cloud/products").catch(() => null),
      ]);
      this.sku = products?.find?.((p) => p.id === subscription?.product_id)?.sku ?? null;
    }
    this.rebuild();
  }

  // Mattermost's PostMarkdown: `isEnterpriseReady && !isEnterpriseOrCloudOrSKUStarterFree`.
  wordsAllowed() {
    const license = this.license;
    if (!license || this.panel.clientConfig?.BuildEnterpriseReady !== "true") return false;
    const cloudStarter = license.Cloud === "true" && this.sku === CLOUD_STARTER;
    const selfHostedStarter = license.IsLicensed === "false";
    const starterLicense = license.IsLicensed === "true" && license.SelfHostedProducts === SELF_HOSTED_STARTER;
    return !cloudStarter && !selfHostedStarter && !starterLicense;
  }

  // Everything but the network, so a name changed here counts at once.
  rebuild() {
    const me = this.panel.me;
    this.keys = userKeys(me);
    this.own = this.keys.map(compile);
    this.mine = this.groups.filter((g) => g.name && g.allow_reference && !g.delete_at);
    this.allGroups = this.mine.map((g) => compile({ key: `@${g.name}` }));
    const words = this.wordsAllowed() && me?.notify_props?.highlight_keys ? me.notify_props.highlight_keys.split(",").filter(Boolean) : [];
    this.words = words.sort((a, b) => b.length - a.length).map((key) => compile({ key }));
    this.scopes = new Map();
  }

  // What a mention search looks for. It has no use for case, so it's only the words.
  terms() {
    return [...this.keys.map((k) => k.key), ...this.mine.map((g) => `@${g.name}`)];
  }

  scope(id, make) {
    let scope = this.scopes.get(id);
    if (!scope) this.scopes.set(id, scope = { id, me: null, channels: null, words: [], ...make() });
    return scope;
  }

  // As Mattermost's getAssociatedGroupsForReference: a group-constrained team or channel reaches only its own groups,
  // besides custom ones. A direct message belongs to no team. This names which case a channel is in, cheaply, since
  // it runs for every post on every redraw.
  constraint(channelId) {
    const { panel } = this;
    const c = panel.channels.get(channelId) ?? panel.extraChannels.get(channelId);
    if (c?.group_constrained) return channelId;
    return c && c.type !== "D" && c.type !== "G" && panel.team?.group_constrained ? "team" : "";
  }

  groupKeys(within) {
    if (!within) return this.allGroups;
    const ofTeam = this.panel.team?.group_constrained ? this.teamGroups : [];
    const ofChannel = within === "team" ? [] : this.channelGroups[within] ?? [];
    const allowed = new Set([...ofTeam, ...ofChannel].map((g) => g.name));
    return this.mine.filter((g) => g.source === "custom" || allowed.has(g.name)).map((g) => compile({ key: `@${g.name}` }));
  }

  // A message, as PostMarkdown and makeGetMentionKeysForPost format it. The server sets mentionHighlightDisabled on a
  // post by someone who may not use channel-wide mentions, and that turns off every mention highlight on it, though
  // not the keywords.
  forPost(p) {
    const off = Boolean(p.props?.mentionHighlightDisabled), noGroups = Boolean(p.props?.disable_group_highlight);
    const within = off || noGroups ? "" : this.constraint(p.channel_id);
    const scope = this.scope(`p${off ? 0 : 1}${noGroups ? 0 : 1}${within}`, () => ({
      mention: off ? [] : noGroups ? this.own : [...this.own, ...this.groupKeys(within)],
      me: off ? null : this.panel.me?.username?.toLowerCase() ?? null,
      words: this.words,
    }));
    return p.props?.channel_mentions ? { ...scope, channels: p.props.channel_mentions } : scope;
  }

  // Text that isn't a message's own, such as an attachment's: Mattermost's plain Markdown component, which is
  // given your groups' keys whatever the channel and no keywords, and doesn't read `@you.` as you.
  forText() {
    return this.scope("t", () => ({ mention: [...this.own, ...this.allGroups] }));
  }
}

// Lets nearly every message skip the scan.
export function hasKey(text, scope) {
  if (!scope.mention.length && !scope.words.length) return false;
  const upper = text.toUpperCase();
  return scope.mention.some((k) => upper.includes(k.upper)) || scope.words.some((k) => upper.includes(k.upper));
}

function ownMention(text, me) {
  if (!me) return 0;
  // Mattermost's getPotentialMentionsForName: the punctuation that ends a sentence isn't part of the name.
  let name = text.slice(1).toLowerCase();
  for (;;) {
    if (name === me) return name.length + 1;
    if (!/[._-]$/.test(name)) return 0;
    name = name.slice(0, -1);
  }
}

function channelToken(name, known) {
  let lower = name.toLowerCase();
  if (known(lower)) return lower.length;
  for (let c = lower.length; c > 0; c--) {
    if (!PUNCTUATION.test(lower[c - 1])) return 0;
    lower = lower.slice(0, c - 1);
    if (known(lower)) return lower.length;
  }
  return 0;
}

// Spans a key can't match inside. One with `text` is a Mattermost token: a key equal to its text lights it whole.
function tokens(line, scope, ctx) {
  const out = [];
  const addMention = (from, to) => {
    let text = line.slice(from, to);
    const special = SPECIAL.exec(text);
    if (special) { text = special[0]; to = from + text.length; }
    out.push({ from, to, text, at: true });
    return to;
  };
  TOKEN.lastIndex = 0;
  for (let m; (m = TOKEN.exec(line)); ) {
    const [whole, at, channel, email, hashtag, emoji] = m;
    const from = m.index, to = from + whole.length;
    if (at) {
      let end = addMention(from + at.length - at.replace(/^_+/, "").length, to);
      while (line[end] === "@") {
        NEXT_MENTION.lastIndex = end;
        const next = NEXT_MENTION.exec(line);
        if (!next) break;
        end = addMention(end, end + next[0].length);
      }
      TOKEN.lastIndex = end;
    } else if (channel !== undefined) {
      const size = channelToken(channel, (name) => Boolean(scope.channels?.[name]) || ctx.channelKnown(name));
      if (size) {
        out.push({ from, to: from + size + 1, text: line.slice(from, from + size + 1) });
        TOKEN.lastIndex = from + size + 1;
      }
    } else if (hashtag) {
      // Too short to be a hashtag, it stays words.
      if (hashtag.length >= ctx.minHashtag() + 1) out.push({ from, to, text: whole });
    } else if (email || emoji) {
      out.push({ from, to, text: whole });
    } else {
      out.push({ from, to, text: null });
    }
  }
  return out;
}

// `_` is a word character to `\W`, so a key inside `_emphasis_` would never see its boundary. Mattermost's parser
// has taken those off before its formatter looks. One without a partner stays text, as it does there.
function emphasisMarks(line, taken) {
  if (!line.includes("_")) return [];
  const marks = [];
  let open = null, t = 0;
  for (let at = line.indexOf("_"); at >= 0; ) {
    let end = at + 1;
    while (line[end] === "_") end++;
    while (t < taken.length && taken[t].to <= at) t++;
    if (t === taken.length || taken[t].from >= end) {
      const before = line[at - 1], after = line[end];
      const closes = before !== undefined && !SPACE.test(before) && !(after !== undefined && WORD_CHAR.test(after));
      const opens = after !== undefined && !SPACE.test(after) && !(before !== undefined && WORD_CHAR.test(before));
      if (open && closes) {
        marks.push(open, { from: at, to: end, text: null });
        open = null;
      } else if (opens) open = { from: at, to: end, text: null };
    }
    at = line.indexOf("_", end);
  }
  return marks;
}

const byStart = (a, b) => a.from - b.from;

function scanKey(line, key, kind, taken) {
  const found = [];
  let at = 0;
  for (let i = 0; i <= taken.length; i++) {
    const end = i < taken.length ? taken[i].from : line.length;
    if (end > at) {
      const gap = line.slice(at, end);
      key.re.lastIndex = 0;
      for (let m; (m = key.re.exec(gap)); ) {
        const from = at + m.index + m[1].length;
        found.push({ from, to: from + m[2].length, kind });
      }
    }
    if (i < taken.length) at = Math.max(at, taken[i].to);
  }
  if (!found.length) return taken;
  return [...taken, ...found].sort(byStart);
}

// Where keys match in a line of markdown, as sorted { from, to, kind } spans. Follows Mattermost's doFormatText:
// tokens first, then every mention key in order, then the keywords, each unable to reach into what came before.
export function keyRanges(line, scope, ctx) {
  const upper = line.toUpperCase();
  const mention = scope.mention.filter((k) => upper.includes(k.upper));
  const words = scope.words.filter((k) => upper.includes(k.upper));
  if (!mention.length && !words.length) return [];
  let taken = tokens(line, scope, ctx);
  for (const t of taken) {
    if (!t.text) continue;
    const lower = t.text.toLowerCase();
    const own = t.at ? ownMention(t.text, scope.me) : 0;
    if (mention.some((k) => k.token === lower)) t.kind = "mention";
    else if (own) { t.kind = "mention"; t.lit = own; }
    else if (words.some((k) => k.token === lower)) t.kind = "word";
  }
  taken = [...taken, ...emphasisMarks(line, taken)].sort(byStart);
  for (const key of mention) taken = scanKey(line, key, "mention", taken);
  for (const key of words) taken = scanKey(line, key, "word", taken);
  return taken.filter((t) => t.kind).map((t) => ({ from: t.from, to: t.lit ? t.from + t.lit : t.to, kind: t.kind }));
}
