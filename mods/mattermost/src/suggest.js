// Mattermost's suggestions in a text box, going by the text before the caret: @ for people, groups and
// everyone, ~ for channels, : for emoji and / for commands at the start of a message.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Popup } from "gpui-base";
import { appHome, exec, settings } from "herdr";
import { FONT, alpha, customStatus, liveStatus } from "../main.js";

const WAIT = 100;
const LOADING_AFTER = 500;
const PEOPLE = 25;
const MAX_W = 496, MAX_H = 292;
const ROW = 40, COMMAND_ROW = 57, HEAD = 28, GAP = 12;
const MIN_CHANNEL = 2, MIN_EMOJI = 2;
const EXECUTE = "_execute_current_command";
const ACTION_UP = "mattermost-suggest-up", ACTION_DOWN = "mattermost-suggest-down", ACTION_TAB = "mattermost-suggest-tab";

// Up, down and Tab reach a list only as actions: Herdr's window takes Tab to move the keyboard on, and a
// textarea keeps all three for itself. They're bound only inside a box whose list is open, because Herdr
// reports any action nobody handles as an unknown command.
const LIST_OPEN = "mattermost-suggesting";
const KEYS = [["up", ACTION_UP], ["down", ACTION_DOWN], ["tab", ACTION_TAB]].map(([keystroke, action]) => ({ keystroke, action, context: `${LIST_OPEN} > Input` }));

const AT_MENTION = /(?:^|\W)([@＠]([\p{L}\d\-_. ]*))$/iu;
const CHANNEL_MENTION = /\B(~([^~\r\n]*))$/i;
const EMOJI = /(^|\s|^\+|^-)(:([^:\s]*))$/;
// Typed faces, which should stay as they are rather than open the emoji list.
const EMOTICONS = [
  /(^|\B)(\\?:-?\))($|\B)/, /(^|\B)(\\?:o)($|\b)/i, /(^|\B)(\\?:-o)($|\b)/i, /(^|\B)(\\?:-?])($|\B)/, /(^|\B)(\\?:-?d)($|\b)/i,
  /(^|\B)(\\?:-?p)($|\b)/i, /(^|\B)(\\?:-?[[@])($|\B)/, /(^|\B)(\\?:-?\()($|\B)/, /(^|\B)(\\?:[`'’]-?\(|\\?:&#x27;\(|\\?:&#39;\()($|\B)/,
  /(^|\B)(\\?:-?\/)($|\B)/, /(^|\B)(\\?:-?s)($|\b)/i, /(^|\B)(\\?:-?\|)($|\B)/, /(^|\B)(\\?:-?\$)($|\B)/, /(^|\B)(\\?:-x)($|\b)/i,
];
const CARET_KEYS = new Set(["left", "right", "home", "end", "up", "down", "pageup", "pagedown"]);
const TONES = { light: "1F3FB", medium_light: "1F3FC", medium: "1F3FD", medium_dark: "1F3FE", dark: "1F3FF" };
const TONE_NAME = /_(medium_light|medium_dark|light|medium|dark)_skin_tone/;
const THUMBS = { thumbsup: ["thumbsdown", "-1", -1], "+1": ["thumbsdown", "-1", -1], thumbsdown: ["thumbsup", "+1", 1], "-1": ["thumbsup", "+1", 1] };
const CHANNEL_TYPES = { O: 0, P: 1, D: 2, G: 3 };

// Herdr doesn't tell a mod where the caret is, but an edit leaves it right after what changed. A known
// caret settles the cases a plain comparison can't, such as typing inside a run of equal letters.
export function caretAfter(before, after, caret) {
  if (caret !== null) {
    const at = caret + after.length - before.length, same = Math.min(caret, at);
    if (at >= 0 && after.slice(0, same) === before.slice(0, same) && after.slice(at) === before.slice(caret)) return at;
  }
  const most = Math.min(before.length, after.length);
  let start = 0, end = 0;
  while (start < most && before[start] === after[start]) start++;
  while (end < most - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return after.length - end;
}

function suffixes(term, by) {
  const parts = term.split(by), tails = parts.map((_, i) => parts.slice(i).join(by));
  return by === " " ? tails : tails.flatMap((tail, i) => (i ? [by + tail, tail] : [tail]));
}

const plain = (text) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const lower = (text) => (text ?? "").toLowerCase();

function profileMatches(u, prefix) {
  const wanted = plain(prefix);
  const names = [".", "-", "_"].flatMap((by) => suffixes(lower(u.username), by))
    .concat(...[u.first_name, u.last_name, u.nickname].map((name) => suffixes(lower(name), " ")), `${lower(u.first_name)} ${lower(u.last_name)}`);
  return names.some((name) => plain(name).startsWith(wanted));
}

function groupMatches(g, prefix) {
  const names = [".", "-", "_"].flatMap((by) => suffixes(lower(g.name), by)).concat(suffixes(lower(g.display_name), " "), lower(g.display_name));
  return names.some((name) => name.startsWith(prefix));
}

function channelMatches(c, words) {
  const names = lower(c.name).split(/\s+/).concat(lower(c.display_name).split(/\s+/));
  return words.every((word) => !word || names.some((name) => name.startsWith(word)));
}

// A name just put in opens no list of its own while the text goes on from it. Anywhere else, or as the
// start of a longer word, it mustn't get in the way of another name that starts the same.
function inCompleted(memo, prefix, start) {
  const name = memo.completed;
  if (name && start === memo.start && prefix.startsWith(name) && !/^[\p{L}\d\-_]/u.test(prefix.slice(name.length))) return true;
  memo.completed = "";
  return false;
}

const bareName = (name) => name.replace(/[.,'"\/#!$%\^&\*;:{}=\-_`~()]/g, "");

export function compareChannels(a, b) {
  if (a.type !== b.type && CHANNEL_TYPES[a.type] !== CHANNEL_TYPES[b.type]) return CHANNEL_TYPES[a.type] - CHANNEL_TYPES[b.type];
  const aName = bareName(a.display_name ?? ""), bName = bareName(b.display_name ?? "");
  if (aName !== bName) return aName.toLowerCase().localeCompare(bName.toLowerCase(), "en", { numeric: true });
  return lower(a.name).localeCompare(lower(b.name), "en", { numeric: true });
}

function compareEmoji(a, b, q) {
  const nameOf = (e) => e.names?.find((n) => n.startsWith(q)) ?? e.names?.[0] ?? e.name;
  const aName = nameOf(a), bName = nameOf(b);
  const aFirst = aName.startsWith(q), bFirst = bName.startsWith(q);
  if (aFirst !== bFirst) return aFirst ? -1 : 1;
  const rule = Object.hasOwn(THUMBS, aName) ? THUMBS[aName] : null;
  if (rule && (bName === rule[0] || bName === rule[1])) return rule[2];
  if (Boolean(a.custom) !== Boolean(b.custom)) return a.custom ? 1 : -1;
  return aName.localeCompare(bName);
}

// The longest start of `b` that `a` ends in.
function overlap(a, b) {
  const end = a.toLowerCase(), start = b.toLowerCase();
  for (let i = start.length; i > 0; i--) if (end.endsWith(start.slice(0, i))) return start.slice(0, i);
  return "";
}

const enc = encodeURIComponent;
const group = (key, label, items) => ({ key, label, items });
const loading = (key, label) => group(key, label, [{ loading: true, term: "" }]);

// What the boxes share: answers from the server worth keeping between lookups.
export class Directory {
  constructor(panel) {
    this.panel = panel;
    this.profiles = new Map();
    this.roles = new Map();
    this.teamRoles = null;
    this.license = null;
    this.agents = null;
    this.emoji = null;
    this.keysStamp = null;
  }

  // Herdr drops a mod's key bindings whenever keys.json's modified time changes, even with the same text,
  // so they go back in when they next matter. Binding them regardless would only pile them up.
  async bindKeys(cx) {
    const stat = await exec("sh", ["-c", 'stat -c %y "$1" 2>/dev/null || stat -f %Fm "$1"', "sh", `${appHome()}/keys.json`]).catch(() => null);
    const stamp = stat?.stdout ?? "";
    if (stamp === this.keysStamp) return;
    this.keysStamp = stamp;
    cx.bind_keys(KEYS);
  }

  known(channel) {
    let map = this.profiles.get(channel);
    if (!map) this.profiles.set(channel, map = new Map());
    return map;
  }

  roleNames(channel) {
    const { panel } = this;
    return [panel.me?.roles, this.teamRoles, panel.members.get(channel)?.roles].flatMap((s) => (s ?? "").split(" ")).filter(Boolean);
  }

  // Unknown roles count as allowed: the server has the last word on a mention anyway.
  can(channel, permission) {
    const names = this.roleNames(channel);
    return !names.length || names.some((name) => !this.roles.has(name) || this.roles.get(name).has(permission));
  }

  async loadRoles(cx, channel) {
    const { panel } = this;
    try {
      if (this.teamRoles === null) {
        const mine = (await panel.api(cx, "/users/me/teams/members")).find((m) => m.team_id === panel.team.id);
        this.teamRoles = mine?.roles ?? "";
      }
      const missing = this.roleNames(channel).filter((name) => !this.roles.has(name));
      if (!missing.length) return;
      const found = await panel.api(cx, "/roles/names", { method: "POST", body: missing });
      for (const name of missing) this.roles.set(name, new Set());
      for (const role of found) this.roles.set(role.name, new Set(role.permissions));
    } catch {}
  }

  async people(cx, prefix, channel) {
    const { panel } = this;
    const data = await panel.api(cx, `/users/autocomplete?in_team=${panel.team.id}&in_channel=${channel}&name=${enc(prefix)}&limit=${PEOPLE}`);
    const known = this.known(channel);
    for (const u of data.users ?? []) known.set(u.id, u);
    return data;
  }

  async groups(cx, prefix, channel) {
    const { panel } = this;
    if (!this.can(channel, "use_group_mentions")) return [];
    this.license ??= await panel.api(cx, "/license/client?format=old").catch(() => ({}));
    const custom = panel.clientConfig?.EnableCustomGroups === "true";
    if (!custom && !(this.license.IsLicensed === "true" && this.license.LDAPGroups === "true")) return [];
    const found = await panel.api(cx, `/groups?q=${enc(prefix)}&filter_allow_reference=true&page=0&per_page=60&include_member_count=true&include_channel_member_count=${channel}`);
    const ofTeam = panel.team.group_constrained, ofChannel = panel.channels.get(channel)?.group_constrained;
    if (!ofTeam && !ofChannel) return found;
    // A group-constrained team or channel reaches only its own groups, besides custom ones.
    const allowed = new Set();
    const query = "?paginate=false&filter_allow_reference=true";
    if (ofTeam) for (const g of (await panel.api(cx, `/teams/${panel.team.id}/groups${query}`)).groups ?? []) allowed.add(g.id);
    if (ofChannel) for (const g of (await panel.api(cx, `/channels/${channel}/groups${query}`)).groups ?? []) allowed.add(g.id);
    return found.filter((g) => g.source === "custom" || allowed.has(g.id));
  }

  async defaultAgent(cx) {
    this.agents ??= await this.panel.api(cx, "/agents").catch(() => []);
    return Array.isArray(this.agents) ? this.agents.find((a) => a.is_default) : null;
  }

  // Standard emoji by character, each with all its names; only one of a skin tone's variants is listed.
  emojiList() {
    if (this.emoji) return this.emoji;
    const names = this.panel.emoji, chars = new Map();
    for (const [name, char] of Object.entries(names)) {
      if (name.startsWith("skin-tone-")) continue;
      const e = chars.get(char) ?? { kind: "emoji", term: char, char, names: [], skin: null };
      chars.set(char, e);
      e.names.push(name);
      const tone = TONE_NAME.exec(name);
      if (tone) e.skin = TONES[tone[1]];
      else if (names[`${name}_light_skin_tone`] && !e.skin) e.skin = "default";
    }
    return this.emoji = [...chars.values()];
  }
}

export class Suggest {
  constructor(panel, input, where, part, name, { commands = true, execute = null } = {}) {
    this.panel = panel;
    this.input = input;
    this.where = where;
    this.part = part;
    this.name = name;
    this.commands = commands;
    this.execute = execute;
    this.value = input.value();
    this.caret = this.value.length;
    this.pretext = "";
    this.results = null;
    this.selection = "";
    this.locked = false;
    this.offset = 0;
    this.run = 0;
    this.width = MAX_W;
    this.at = { completed: "", empty: "", data: null };
    this.tilde = { trimmed: "", empty: "", completed: "" };
  }

  get directory() {
    return this.panel.directory;
  }

  isOpen() {
    return Boolean(this.results);
  }

  hasLoaded() {
    return Boolean(this.results?.groups.some((g) => g.items.some((it) => !it.loading)));
  }

  terms() {
    return this.results?.groups.flatMap((g) => g.items.filter((it) => !it.loading).map((it) => it.term)) ?? [];
  }

  // The text changed behind the box's back, so the list no longer belongs to it.
  reset(caret = null) {
    this.run++;
    this.value = this.input.value();
    this.caret = caret ?? this.value.length;
    this.pretext = this.value.slice(0, this.caret);
    this.results = null;
    this.selection = "";
    this.locked = false;
    this.completeNext = false;
    this.at.completed = "";
    this.tilde.completed = "";
    this.shownOpen = false;
    this.shownLive = false;
  }

  changed(cx) {
    const value = this.input.value();
    if (value === this.value) return;
    this.caret = caretAfter(this.value, value, this.caret);
    this.value = value;
    this.pretextChanged(value.slice(0, this.caret), cx);
  }

  pretextChanged(pretext, cx) {
    this.locked = false;
    this.pretext = pretext;
    this.completeNext = false;
    const run = ++this.run;
    cx.timer.after(WAIT, (cx) => { if (run === this.run) this.lookup(pretext, cx); });
  }

  lookup(pretext, cx) {
    if (!this.panel.me) return false;
    const found = this.atMention(pretext, cx) || this.channelMention(pretext, cx) || this.emoticon(pretext, cx) || this.command(pretext, cx);
    if (!found) this.clear(cx);
    return found;
  }

  show(matched, groups, cx) {
    const shown = groups.filter((g) => g.items.length);
    this.results = shown.length ? { matched, groups: shown } : null;
    const terms = this.terms();
    if (!this.locked || !terms.includes(this.selection)) {
      this.selection = terms[0] ?? "";
      this.locked = false;
      this.offset = 0;
    }
    this.redraw(cx);
    if (this.completeNext && this.selection) {
      this.completeNext = false;
      this.complete(this.selection, matched, cx);
    }
  }

  // A lookup has its last word. If that left nothing for a key pressed ahead of the list, the key does what
  // it otherwise does.
  settled(cx) {
    if (!this.completeNext) return;
    this.completeNext = false;
    this.otherwise?.(cx);
  }

  clear(cx) {
    this.results = null;
    this.selection = "";
    this.locked = false;
    this.completeNext = false;
    this.redraw(cx);
  }

  // Opening or closing changes the box's popup and key context, which belong to the messages part.
  redraw(cx) {
    const open = this.isOpen(), live = this.hasLoaded();
    if (open !== Boolean(this.shownOpen) || live !== Boolean(this.shownLive)) {
      if (live && !this.shownLive) cx.spawn((cx) => this.directory.bindKeys(cx));
      this.shownOpen = open;
      this.shownLive = live;
      cx.notify(this.panel.mainPart);
    }
    cx.notify(this.part);
  }

  atMention(pretext, cx) {
    const found = AT_MENTION.exec(pretext.toLowerCase());
    const { channel } = this.where();
    if (!found || !channel) return false;
    const [, matched, prefix] = found, memo = this.at;
    if (memo.channel !== channel) Object.assign(memo, { channel, data: null, empty: "" });
    if (inCompleted(memo, prefix, pretext.length - matched.length)) return false;
    if (memo.empty && prefix.startsWith(memo.empty)) return false;
    const run = this.run, directory = this.directory;
    this.show(matched, this.atGroups(prefix, channel), cx);
    let waiting = true;
    cx.timer.after(LOADING_AFTER, (cx) => {
      if (waiting && run === this.run) this.show(matched, [...this.atGroups(prefix, channel), loading("otherMembers", "Other Members")], cx);
    });
    cx.spawn(async (cx) => {
      let data = null;
      try {
        await directory.loadRoles(cx, channel);
        const [people, groups] = await Promise.all([directory.people(cx, prefix, channel), directory.groups(cx, prefix, channel).catch(() => []), directory.defaultAgent(cx)]);
        data = { ...people, groups };
      } catch {}
      waiting = false;
      if (run !== this.run) return;
      memo.data = data;
      const groups = this.atGroups(prefix, channel);
      if (data) {
        if (!groups.some((g) => g.items.length)) memo.empty = prefix;
        else if (memo.empty === prefix) memo.empty = "";
      }
      this.show(matched, groups, cx);
      this.settled(cx);
      this.loadShown(data, cx);
    });
    return true;
  }

  // Statuses and custom status emoji for who just came back, drawn when they arrive.
  loadShown(data, cx) {
    if (!data) return;
    const { panel } = this;
    const people = [...(data.users ?? []), ...(data.out_of_channel ?? [])];
    const missing = people.filter((u) => !panel.statuses.has(u.id)).map((u) => u.id);
    const emoji = [...new Set(people.map((u) => liveStatus(customStatus(u.props?.customStatus))?.emoji).filter(Boolean))];
    if (!missing.length && !emoji.length) return;
    cx.spawn(async (cx) => {
      if (missing.length) await panel.loadStatuses(cx, missing);
      for (const name of emoji) await panel.ensureEmoji(cx, name);
      cx.notify(this.part);
    });
  }

  atGroups(prefix, channel) {
    const { panel, directory } = this;
    const { data } = this.at, { root } = this.where(), me = panel.me.id;
    const matches = (u) => Boolean(u) && profileMatches(u, prefix);
    const viewed = new Map();
    for (const c of panel.channels.values()) if (c.type === "D") viewed.set(panel.dmPeer(c), panel.members.get(c.id)?.last_viewed_at ?? 0);
    const person = (u, extra = {}) => ({ kind: "user", term: `@${u.username}`, user: u, self: u.id === me, ...extra });
    const order = (a, b) => {
      const aFirst = a.username.startsWith(prefix), bFirst = b.username.startsWith(prefix);
      if (aFirst !== bFirst) return aFirst ? -1 : 1;
      const aSeen = viewed.get(a.id) ?? 0, bSeen = viewed.get(b.id) ?? 0;
      if (aSeen && bSeen) return bSeen - aSeen;
      if (aSeen || bSeen) return aSeen ? -1 : 1;
      return a.username.localeCompare(b.username);
    };
    const authors = root ? [...new Set((panel.threadPosts.get(root) ?? []).map((p) => p.user_id))].filter((id) => id !== me) : [];
    const priority = authors.map((id) => panel.users.get(id)).filter(matches);
    const priorityIds = new Set(priority.map((u) => u.id));
    // Until the server first answers for a channel, those who wrote in it stand in, so the list doesn't open on @here.
    const known = [...directory.known(channel).values()];
    const writers = known.length || data ? [] : [...new Set((panel.posts.get(channel) ?? []).filter((p) => p.props?.from_webhook !== "true").map((p) => p.user_id))].map((id) => panel.users.get(id));
    const local = (known.length ? known : writers).filter(matches).slice(0, PEOPLE).filter((u) => !priorityIds.has(u.id));
    const localIds = new Set(local.map((u) => u.id));
    const remote = (data?.users ?? []).filter(matches).filter((u) => !localIds.has(u.id) && !priorityIds.has(u.id));
    const agents = (data?.agents ?? []).filter(matches).sort(order);
    const agentNames = new Set(agents.map((u) => u.username));
    const members = [...priority, ...[...local, ...remote].sort(order)].filter((u) => !agentNames.has(u.username));
    const fallback = prefix === "" ? directory.agents?.find?.((a) => a.is_default) : null;
    const main = fallback ? agents.find((u) => u.username === fallback.username) : null;
    const groups = (data?.groups ?? []).filter((g) => groupMatches(g, prefix)).sort((a, b) => {
      const aFirst = a.name.startsWith(prefix), bFirst = b.name.startsWith(prefix);
      return aFirst !== bFirst ? (aFirst ? -1 : 1) : a.name.localeCompare(b.name);
    });
    const special = directory.can(channel, "use_channel_mentions") ? ["here", "channel", "all"].filter((name) => name.startsWith(prefix)) : [];
    const outside = (data?.out_of_channel ?? []).filter(matches).filter((u) => !localIds.has(u.id) && !priorityIds.has(u.id)).sort(order);
    return [
      group("defaultAgent", null, main ? [person(main, { agent: true })] : []),
      group("members", "Channel Members", members.map((u) => person(u))),
      group("agents", "Agents", agents.filter((u) => u !== main).map((u) => person(u, { agent: true }))),
      group("groups", "Group Mentions", groups.map((g) => ({ kind: "group", term: `@${g.name}`, group: g }))),
      group("specialMentions", "Special Mentions", special.map((name) => ({ kind: "special", term: `@${name}`, name }))),
      group("nonMembers", "Not in Channel", outside.map((u) => person(u))),
    ];
  }

  channelMention(pretext, cx) {
    const found = CHANNEL_MENTION.exec(pretext.toLowerCase());
    if (!found || (found.index > 0 && pretext[found.index - 1] === "~")) return false;
    const [, matched, prefix] = found, memo = this.tilde, { panel } = this;
    if (panel.clientConfig?.DelayChannelAutocomplete === "true" && prefix.length < MIN_CHANNEL) return false;
    // More spaces after a word ask for nothing new, but the list has to replace them too. An answer still
    // on its way was dropped with the edit, so that one has to be asked for again.
    if (memo.trimmed && prefix.trim() === memo.trimmed && this.results?.groups.every((g) => g.items.every((it) => !it.loading))) {
      this.show(matched, this.results.groups, cx);
      return true;
    }
    memo.trimmed = prefix.trim();
    if (memo.empty && prefix.startsWith(memo.empty)) return false;
    if (inCompleted(memo, prefix, pretext.length - matched.length)) return false;
    const words = prefix.split(/\s+/);
    const item = (channel) => ({ kind: "channel", term: `~${channel.name}`, channel });
    const groups = (mine, others) => [group("myChannels", "My Channels", mine.sort(compareChannels).map(item)), others];
    const mine = [...panel.channels.values()].filter((c) => c.type === "O" && !c.delete_at && channelMatches(c, words));
    const run = this.run;
    this.show(matched, groups([...mine], loading("moreChannels", "Other Channels")), cx);
    cx.spawn(async (cx) => {
      let channels = [], failed = false;
      try {
        channels = await panel.api(cx, `/teams/${panel.team.id}/channels/autocomplete?name=${enc(prefix)}`);
      } catch {
        failed = true;
      }
      if (run !== this.run) return;
      if (!channels.length && !failed) memo.empty = prefix;
      const ids = new Set(mine.map((c) => c.id)), others = [];
      for (const c of channels) {
        const member = panel.members.has(c.id);
        if (c.delete_at > 0 && !member) continue;
        if (member) {
          if (!ids.has(c.id)) { ids.add(c.id); mine.push(c); }
          continue;
        }
        if (ids.delete(c.id)) mine.splice(mine.findIndex((x) => x.id === c.id), 1);
        others.push(c);
      }
      this.show(matched, groups(mine, group("moreChannels", "Other Channels", others.map(item))), cx);
      this.settled(cx);
    });
    return true;
  }

  emoticon(pretext, cx) {
    const found = EMOJI.exec(pretext.toLowerCase());
    if (!found) return false;
    const [, before, text, partial] = found;
    if (partial.length < MIN_EMOJI) return false;
    if (before !== "-" && before !== "+" && EMOTICONS.some((face) => face.test(text))) return false;
    const { panel } = this, run = this.run;
    if (panel.clientConfig?.EnableCustomEmoji !== "true") {
      this.findEmoji(text, partial, cx);
      return true;
    }
    cx.spawn(async (cx) => {
      try {
        for (const e of await panel.api(cx, `/emoji/autocomplete?name=${enc(partial)}`)) panel.customEmoji.set(e.name, e.id);
      } catch {}
      if (run === this.run) this.findEmoji(text, partial, cx);
    });
    return true;
  }

  findEmoji(text, partial, cx) {
    const { panel, directory } = this;
    const recent = panel.recentEmoji ?? new Set(), tone = panel.skinTone ?? "default";
    const used = [], rest = [];
    for (const e of directory.emojiList()) {
      if (e.skin && e.skin !== tone) continue;
      const name = e.names.find((n) => n.includes(partial));
      if (name) (recent.has(name) || recent.has(e.names[0]) ? used : rest).push({ ...e, name });
    }
    for (const [name, id] of panel.customEmoji) {
      if (!name.includes(partial) || panel.emoji[name]) continue;
      (recent.has(name) ? used : rest).push({ kind: "emoji", term: `:${name}:`, name, custom: id });
    }
    const order = (a, b) => compareEmoji(a, b, partial);
    this.show(text, [group("emojis", "Emoji", [...used.sort(order), ...rest.sort(order)])], cx);
    this.settled(cx);
  }

  command(pretext, cx) {
    if (!this.commands || !pretext.startsWith("/")) return false;
    const { channel, root } = this.where();
    if (!channel) return false;
    const { panel } = this, run = this.run;
    const space = pretext.indexOf(" ");
    const typed = space < 0 ? pretext.toLowerCase() : pretext.slice(0, space).toLowerCase() + pretext.slice(space);
    const team = panel.team.id;
    cx.spawn(async (cx) => {
      let data = [];
      try {
        data = await panel.api(cx, `/teams/${team}/commands/autocomplete_suggestions?team_id=${team}&channel_id=${channel}&root_id=${root}&user_input=${enc(typed)}`);
      } catch {}
      if (run !== this.run) return;
      const seen = new Set(), matches = [];
      for (const s of data ?? []) {
        const term = `/${s.Complete}`;
        if (seen.has(term)) continue;
        seen.add(term);
        matches.push({ kind: "command", term, title: `${s.Suggestion} ${s.Hint ?? ""}`.trim(), about: s.Description ?? "", icon: s.IconData });
      }
      if (!pretext.includes(" ")) matches.sort((a, b) => (a.title.toLowerCase() > b.title.toLowerCase() ? 1 : a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 0));
      if (data?.length && (pretext.endsWith(" ") || data.some((s) => s.Suggestion === ""))) {
        matches.unshift({ kind: "command", term: pretext + EXECUTE, title: "Execute Current Command", about: "Select this option or use Ctrl+Enter to execute the current command.", icon: EXECUTE });
      }
      this.show(pretext, [group("commands", "Commands", matches)], cx);
      this.settled(cx);
    });
    return true;
  }

  complete(term, matched, cx) {
    this.run++;
    const finish = term.endsWith(EXECUTE);
    const fixed = finish ? term.slice(0, -EXECUTE.length) : term;
    const start = finish ? null : this.insert(fixed, matched);
    this.clear(cx);
    this.input.focus();
    if (finish) return this.execute?.(cx);
    if (start === null) return;
    const completed = fixed.replace(/^[@＠~]/, "").toLowerCase();
    Object.assign(this.at, { completed, start, empty: "" });
    Object.assign(this.tilde, { completed, start, empty: "" });
    if (this.commands && fixed.startsWith("/")) this.pretextChanged(`${fixed} `, cx);
  }

  // Where the term went in, or null when it no longer fits.
  insert(term, matched) {
    const text = this.input.value(), caret = this.caret ?? text.length, pretext = text.slice(0, caret);
    let start;
    if (pretext.toLowerCase().endsWith(matched.toLowerCase())) start = pretext.length - matched.length;
    else {
      // The text moved on since the list came; the term is put in only if it still fits.
      const shared = overlap(pretext, term.slice(matched.length));
      start = pretext.length - shared.length - matched.length;
      if (!shared || pretext.slice(start, start + matched.length).toLowerCase() !== matched.toLowerCase()) return null;
    }
    this.input.set_selected_range({ start, end: caret });
    this.caret = start + term.length + 1;
    this.value = `${text.slice(0, start)}${term} ${text.slice(caret)}`;
    this.input.replace(`${term} `);
    return start;
  }

  // Enter and Tab take the selected row. With the text ahead of the list, the row is taken as soon as
  // the list has caught up. False when there's nothing to take, so the key does what it otherwise does.
  accept(cx, otherwise = null) {
    if (!this.hasLoaded()) return false;
    const { matched } = this.results;
    if (this.pretext.toLowerCase().endsWith(matched.toLowerCase())) {
      this.complete(this.selection, matched, cx);
      return true;
    }
    this.completeNext = true;
    this.otherwise = otherwise;
    this.run++;
    return this.lookup(this.pretext, cx);
  }

  submit(event, cx, otherwise) {
    if (event?.secondary || !this.accept(cx, otherwise)) otherwise(cx);
  }

  // A textarea has already put the line break in by the time it reports Enter.
  dropLineBreak(text) {
    const caret = this.caret === null ? null : Math.max(0, this.caret - 1);
    this.input.set_value(text);
    this.value = text;
    this.caret = caret;
    if (caret === null) return;
    this.pretext = text.slice(0, caret);
    this.input.set_selected_range({ start: caret, end: caret });
  }

  arrow(by, cx) {
    if (!this.hasLoaded()) return false;
    const terms = this.terms(), at = terms.indexOf(this.selection);
    if (at < 0) return true;
    this.selection = terms[Math.max(0, Math.min(terms.length - 1, at + by))];
    this.locked = true;
    this.reveal();
    cx.notify(this.part);
    return true;
  }

  // The caret can't be read, so a caret moved by key or mouse is lost until the next edit, and a list
  // open at the old place can't be trusted to replace the right text.
  moved(cx) {
    this.caret = null;
    this.run++;
    if (this.isOpen()) this.clear(cx);
  }

  blur(cx) {
    this.run++;
    if (this.isOpen()) this.clear(cx);
  }

  // Key and caret handling for the element around the text box, `inset` wide on each side of it.
  keys(el, inset) {
    return el
      .when(this.hasLoaded(), (el) => el.key_context(LIST_OPEN))
      .on_action(ACTION_UP, (_e, cx) => this.arrow(-1, cx))
      .on_action(ACTION_DOWN, (_e, cx) => this.arrow(1, cx))
      .on_action(ACTION_TAB, (_e, cx) => this.accept(cx))
      .on_key_down((e, cx) => {
        if (e.keystroke !== "escape") return;
        this.run++;
        if (!this.isOpen()) return;
        this.clear(cx);
        cx.stop_propagation();
      })
      .on_key_up((e, cx) => {
        const arrowed = (e.key === "up" || e.key === "down") && this.isOpen();
        if ((CARET_KEYS.has(e.key) && !arrowed) || /^(ctrl|cmd)-a$/.test(e.keystroke)) this.moved(cx);
      })
      .on_size_change((size) => { this.width = size.width / (Number(settings()?.zoom) || 1) - 2 * inset; });
  }

  // The text box inside the surface that holds the list over everything else.
  around(box) {
    return Popup.new(this.name, box).w_full().anchor("bottom_left")
      .when(this.isOpen(), (el) => el.content(div().pb(4).child(this.part)));
  }

  lines() {
    const out = [];
    let y = 0;
    for (const g of this.results?.groups ?? []) {
      const first = !out.length;
      if (g.label) {
        out.push({ h: HEAD + GAP, y, head: g.label, line: !first });
        y += HEAD + GAP;
      }
      for (const it of g.items) {
        const h = it.kind === "command" ? COMMAND_ROW : ROW;
        out.push({ h, y, it });
        y += h;
      }
    }
    return out;
  }

  viewHeight(total) {
    const panelH = (this.panel.height ?? 0) / (Number(settings()?.zoom) || 1);
    return Math.min(total, MAX_H, panelH ? Math.max(120, panelH - 110) : MAX_H);
  }

  // Keeps the selected row in the list's view, and the heading above it when it's the first of its group.
  reveal() {
    const lines = this.lines();
    const at = lines.findIndex((l) => l.it?.term === this.selection);
    if (at < 0) return;
    const line = lines[at], top = lines[at - 1]?.head ? lines[at - 1].y : line.y;
    const total = lines.at(-1).y + lines.at(-1).h + GAP, view = this.viewHeight(total);
    if (top < this.offset) this.offset = top;
    else if (line.y + line.h > this.offset + view) this.offset = line.y + line.h + (at === lines.length - 1 ? GAP : 0) - view;
  }

  tag(label, t) {
    return div().h(16).px(4).flex().flex_none().items_center().rounded(4).bg(alpha(t.foreground, 0.08)).text_size(10).font_semibold().child(label);
  }

  iconSlot(name, t) {
    return div().size(24).flex_none().flex().items_center().justify_center()
      .child(svg(`mods/mattermost/icons/${name}.svg`).size(20).text_color(alpha(t.foreground, 0.73)));
  }

  userRow(it, t) {
    const u = it.user, { panel } = this;
    const path = panel.media.avatar(u);
    const pic = path ? image(path).size(24).rounded_full() : div().size(24).rounded_full().bg(t.raised);
    const custom = liveStatus(u.custom ?? customStatus(u.props?.customStatus));
    const full = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();
    const about = it.self ? full : `${full} ${u.nickname ? `(${u.nickname})` : ""}`.trim();
    return [
      div().relative().size(24).flex_none().child(pic)
        .when(!u.is_bot, (el) => el.child(div().absolute().left(13).top(13).size(13).flex().items_center().justify_center().rounded_full().bg(t.background)
          .child(panel.statusMark(panel.statuses.get(u.id), 10)))),
      div().flex_none().text_color(t.foreground).child(`@${u.username}`),
      ...(u.is_bot ? [this.tag(it.agent ? "AGENT" : "BOT", t)] : []),
      ...(about ? [div().min_w(0).truncate().child(about)] : []),
      ...(it.self ? [div().flex_none().child("(you)")] : []),
      ...(custom?.emoji ? [panel.emojiEl(panel.emojiToken(custom.emoji), 15, t)] : []),
      ...((u.roles ?? "").split(" ").includes("system_guest") ? [this.tag("GUEST", t)] : []),
    ];
  }

  rowBody(it, t) {
    const { panel } = this;
    if (it.kind === "user") return this.userRow(it, t);
    if (it.kind === "special") {
      const about = it.name === "here" ? "Notifies everyone online in this channel" : "Notifies everyone in this channel";
      return [this.iconSlot("users", t), div().flex_none().text_color(t.foreground).child(`@${it.name}`), div().min_w(0).truncate().child(about)];
    }
    if (it.kind === "group") {
      const n = it.group.member_count ?? 0;
      return [
        this.iconSlot("users", t),
        div().flex_none().text_color(t.foreground).child(`@${it.group.name}`),
        div().flex_1().min_w(0).truncate().child(`- ${it.group.display_name}`),
        div().flex_none().h(20).px(6).flex().items_center().rounded(4).bg(alpha(t.foreground, 0.08)).text_size(12).child(`${n} ${n === 1 ? "member" : "members"}`),
      ];
    }
    if (it.kind === "channel") {
      const c = it.channel, icon = c.delete_at ? "archive" : c.type === "P" ? "lock" : "globe";
      return [this.iconSlot(icon, t), div().flex_none().max_w("60%").truncate().text_color(t.foreground).child(c.display_name), div().min_w(0).truncate().child(`~${c.name}`)];
    }
    if (it.kind === "emoji") {
      const path = it.custom ? panel.media.emoji(it.custom) : panel.cfg ? panel.media.standard(panel.cfg.url, it.char) : null;
      return [
        path ? image(path).size(20).flex_none() : div().w(20).flex_none().child(it.char ?? ""),
        div().min_w(0).truncate().text_color(t.foreground).child(`:${it.name}:`),
      ];
    }
    const mark = it.icon === EXECUTE ? "↵" : it.icon === "error" ? "!" : "/";
    return [
      div().size(37).flex_none().flex().items_center().justify_center().rounded(4).bg(alpha(t.foreground, 0.08)).text_size(20).font_semibold().child(div().opacity(0.73).child(mark)),
      v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_color(t.foreground).line_height("16px").child(it.title))
        .child(div().truncate().text_size(12).line_height("15px").child(it.about)),
    ];
  }

  row(line, t) {
    const { it } = line;
    if (it.loading) return div().h(line.h).flex_none().flex().items_center().justify_center().text_size(12).text_color(alpha(t.foreground, 0.56)).child("Loading…");
    return h_flex().id(`sg-${it.term}`).h(line.h).flex_none().px(24).gap(8).items_center().cursor_pointer().text_color(alpha(t.foreground, 0.75))
      .when(it.term === this.selection, (el) => el.bg(alpha(t.foreground, 0.08)))
      // Not on hover: a list moving under a still pointer mustn't move the selection.
      .on_mouse_move((_e, cx) => {
        if (this.selection === it.term) return;
        this.selection = it.term;
        this.locked = true;
        cx.notify(this.part);
      })
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.complete(it.term, this.results.matched, cx);
      })
      .children(this.rowBody(it, t));
  }

  list(t) {
    if (!this.isOpen()) return div();
    const lines = this.lines();
    const total = lines.at(-1).y + lines.at(-1).h + GAP, view = this.viewHeight(total);
    this.offset = Math.max(0, Math.min(total - view, this.offset));
    const out = [];
    let gap = 0;
    for (const l of lines) {
      if (l.y + l.h < this.offset - ROW || l.y > this.offset + view + ROW) { gap += l.h; continue; }
      if (gap) out.push(div().h(gap).flex_none());
      gap = 0;
      out.push(l.head
        ? v_flex().h(l.h).flex_none().justify_end()
          .when(l.line, (el) => el.child(div().h(1).mb(6).flex_none().bg(alpha(t.foreground, 0.08))))
          .child(div().h(HEAD).flex_none().flex().items_center().px(24).text_size(12).font_semibold().text_color(alpha(t.foreground, 0.75)).child(l.head.toUpperCase()))
        : this.row(l, t));
    }
    return div().id(`${this.name}-list`).relative().w(Math.min(MAX_W, this.width)).h(view + 2).overflow_hidden()
      .font_family(FONT).text_size(14).line_height("20px").rounded(4).border_1().border_color(alpha(t.foreground, 0.16)).bg(t.background).shadow_lg()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); })
      .on_scroll_wheel((e, cx) => {
        this.offset = Math.max(0, Math.min(total - view, this.offset - e.delta.y));
        cx.stop_propagation();
        cx.notify(this.part);
      })
      .child(v_flex().absolute().left(0).right(0).top(-this.offset).children(out));
  }
}
