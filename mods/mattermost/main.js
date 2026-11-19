import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, TextView, v_resizable, resizable_panel } from "gpui-base";
import { appHome, home, exec, readTextFile, writeTextFile, theme, props, layout, shared, setShared, closeOverlay, settings, nextCommand, notify, hc, run as command, terminals, panes, spaces, window as appWindow } from "herdr";
import { WebSocket } from "websocket";
import { Media, openExternally, playExternally } from "./src/media.js";
import { postFiles, postAttachments, postEmbeds, remoteImage } from "./src/attach.js";
import { Menu } from "./src/menu.js";
import { EmojiPicker, PICKER_W, PICKER_H } from "./src/picker.js";
import { EditDialog, StatusCard } from "./src/dialog.js";
import { Lightbox, handleImageRequest, openImageMenu } from "./src/image.js";
import { ProfileDialog, openProfileDialog } from "./src/profile.js";
import { StatusDialog, DndDialog, STATUS_W, STATUS_H, DND_W, DND_H, SUGGESTIONS } from "./src/status.js";
import { SPECIAL, prepare, segments, jumbo, mentionNames } from "./src/content.js";
import { Suggest, Directory } from "./src/suggest.js";
import { composerView, noteText, insertAtCaret, takeFilePaste } from "./src/composer.js";
import { filePreviews, canUpload, pasteFiles, pruneLocal } from "./src/upload.js";
import { priorityEnabled, priorityTag, hasPriority } from "./src/priority.js";
import { HighlightKeys, NO_KEYS } from "./src/highlight.js";
import { ResetStatusDialog, RESET_W, resetHeight, resetCheck, answerReset, statusFromCommand, firstStart, forgetStart } from "./src/reset_status.js";
import { openOwnOverlay as openOverlay, isPopout, popoutName, openPopout, loadPopout, handDrafts, takeDrafts, toPanel, isExpandKey, rhsExpandKey, shrinkOnPress, rhsButtons, BACK_TIPS, POPOUT_TIP } from "./src/rhs.js";
import { demoApi, demoStatus, DEMO } from "./demo/demo.js";
import { Find } from "./src/find.js";
import { foldedRail, UNFOLD_W, modeOf, listWidth, contextBeside, CONTEXT_W, sectionTabs, rail, strip, listRow, scrollList, iconTile, iconButton as barButton, button, header, headerNote, empty, nothingPicked, shortTime,
  draftsList, draftReader, meList, meReader, SECTIONS, VIOLET, AMBER, countBadge } from "./src/layout.js";
import { JIRA, jiraFor } from "./src/jira.js";

const PAGE = 60;
const THREAD_PAGE = 30;
const GROUP_GAP = 5 * 60e3;
// Mattermost's default for how many direct and group messages the sidebar lists.
const DM_LIMIT = 40;
const ATTEMPTS = 3;
const TIMEOUT = 15e3;
// A server gives an integration's command 30 seconds by default, and a command may not be safe to send twice.
const COMMAND_TIMEOUT = 60e3;
// Posts drawn at once; more are drawn as the timeline is scrolled up.
const WINDOW = 30;
// A row's height before it has been drawn once, so a fresh channel builds only what is near the screen.
const EST_ROW = 60;
const PARSED = 800;
// How long a part may spend building message rows before leaving the rest for the next render.
const ROW_BUDGET = 35;
const THREADS = "threads";
const DRAFTS = "drafts";
const AROUND = 30;
// How long a post you jumped to stays lit, as Mattermost's PERMALINK_FADEOUT.
const HIGHLIGHT = 5000;
const RHS_WIDE_SCREEN = 1280;
const EDIT_KEY = "edit:";
// The message box grows to 176px, eight lines; an edit in place gets more.
const EDIT_ROWS = 14, BOX_ROWS = 8;
const NO_SUCH_COMMAND = "api.command.execute_command.not_found.app_error";
// Decoded frames of the animations played so far. Herdr keeps them until it quits, so past this they open in a player.
const ANIMATION_BUDGET = 512 * 1024 * 1024;
const UNKNOWN_ANIMATION = 64 * 1024 * 1024;
// Shared state outlives the app, so a tab button can't tell a panel running now from one that ran last time
// unless the panel keeps restamping it.
const ALIVE_EVERY = 15e3;
// How long a started agent may take over its turns before the messages after the first are dropped.
const AGENT_PATIENCE = 10 * 60e3;

const TOKEN_DOCS = "https://docs.mattermost.com/developers/integrate/reference/personal-access-token";

// The server and token live in the Herdr home, outside the mod folder, so sharing the mod can't take them along.
export const loginPath = () => `${appHome()}/mattermost.json`;

// Off unless the panel's props name a folder. Save Message stays in the post menu either way.
function agentSpec() {
  const a = props()?.agent;
  if (!a || typeof a !== "object" || typeof a.folder !== "string" || !a.folder) return null;
  const list = (v, fallback) => (Array.isArray(v) && v.length ? v.map(String) : fallback);
  return {
    label: typeof a.label === "string" && a.label ? a.label : "Send to Claude Code",
    folder: a.folder.replace(/^~(?=\/|$)/, home()).replace(/\/+$/, ""),
    argv: list(a.argv, ["claude"]),
    messages: list(a.messages, ["{link}"]),
    chat: typeof a.chat === "string" && a.chat ? a.chat : null,
  };
}

// herdr-chat names a chat `c-` and eight hex digits. One post always gives the same name, so a second
// click finds the chat the first one opened, and a closed one comes back on its session.
function chatId(postId) {
  let h = 0x811c9dc5;
  for (let i = 0; i < postId.length; i++) h = Math.imul(h ^ postId.charCodeAt(i), 0x01000193);
  return `c-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

// By name first: a space's folder is only where its next terminal would start, and drifts from what it holds.
function agentSpace(folder) {
  const local = spaces().filter((s) => !s.machine);
  const name = folder.split("/").pop();
  return local.find((s) => s.name === name) ?? local.find((s) => s.folder.replace(/\/+$/, "") === folder) ?? null;
}

async function config() {
  if (props()?.demo) return DEMO;
  const own = JSON.parse((await readTextFile(loginPath()).catch(() => null)) ?? "null");
  if (!own?.url || !own?.token) return null;
  return { url: own.url.replace(/\/+$/, ""), token: own.token, team: own.team };
}

// People paste whatever is in the browser's address bar, often a channel's page.
const serverUrl = (text) => {
  const url = text.trim().replace(/\/+$/, "");
  if (!url) return "";
  return (/^https?:\/\//i.test(url) ? url : `https://${url}`).replace(/\/[^/]+\/(channels|messages|threads|pl)\/.*$/, "");
};

export const sleep = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
// A stalled TLS handshake otherwise leaves a request pending forever.
const timed = (cx, promise, ms = TIMEOUT) => Promise.race([promise, sleep(cx, ms).then(() => { throw new Error("timed out"); })]);
const pad = (n) => String(n).padStart(2, "0");
export const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Mattermost tints with rgba(center-channel-color, a); theme colors here are #rrggbb.
// Popups ask the panel for things through shared state; a demo panel listens on its own key, so a real
// one beside it doesn't act on made-up ids.
export const panelRequestKey = () => (props()?.demo ? "mattermost.demo-request" : "mattermost.request");
// A popped-out copy and its popups keep to a key of their own, so the panel beside it doesn't act on their requests.
export const requestKey = () => props()?.requestTo ?? (isPopout() ? `${panelRequestKey()}.${popoutName()}` : panelRequestKey());
// Links come from whoever wrote the message, so only web and mail addresses go to the system's opener.
export const openLink = (url) => { if (/^(https?|mailto):/i.test(url)) exec("xdg-open", [url]); };
// The web app's routes to conversations. Every other page on the server (sign-in, /emoji, the admin
// console, files, plugins, help) is left to the browser.
const CONVERSATION = /^\/([a-z0-9\-_]+)\/(pl|channels|messages|threads)(?:\/([^/]+))?\/?$/i;
// Mattermost's isInternalURL, taking either scheme and any trailing slash, since a link can be written by hand.
export function serverPath(url, base) {
  if (url.startsWith("/")) return url.replace(/[?#].*$/s, "");
  if (!base || !/^https?:\/\//i.test(url)) return null;
  const bare = (u) => u.replace(/^https?:\/\//i, "");
  const b = bare(base).replace(/\/+$/, ""), u = bare(url);
  if (u.slice(0, b.length).toLowerCase() !== b.toLowerCase()) return null;
  const path = u.slice(b.length).replace(/[?#].*$/s, "");
  return path === "" || path.startsWith("/") ? path : null;
}
const LINK_ID = /^[\w-]{1,64}$/;
export const alpha = (color, a) => (/^#[0-9a-f]{6}$/i.test(color) ? `${color}${pad(Math.round(a * 255).toString(16))}` : color);
// The panel assumes collapsed reply threads, so the sidebar orders and counts by root posts, as Mattermost does then.
const lastPost = (c) => c.last_root_post_at || c.last_post_at || c.create_at;
const previewOf = (p) => ({ id: p.id, at: p.create_at, user: p.user_id, text: p.message, files: postFileIds(p).length, system: isSystem(p) });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const replies = (n) => plural(n, "reply", "replies");
const SHORTCODES = /:([a-z0-9_+\-]+):/gi;

// Post ids and channel ids can't collide, so a thread or a channel names its one draft.
const draftKey = (d) => d.root_id || d.channel_id;
const draftEmpty = (d) => !d.message && !d.file_ids?.length;
// Files and priority come along, so saving a draft started in the web app doesn't strip them from it.
const serverDraft = (s) => ({ ...pick(s, ["channel_id", "root_id", "message", "file_ids", "props", "priority", "update_at"]), remote: true });

// The panel keeps only what it draws: the API's full objects are several times larger, and this
// runtime slows down sharply as its heap grows.
const CACHED = 10;
// How long a click on a channel whose posts aren't loaded keeps the previous one on screen.
const OPEN_WAIT = 500;
// The 32px avatar 12px in with 9px to the text, and the text 12px short of the edge.
const POST_GUTTER = { pad: 12, col: 41, inset: 0, right: 12 };
// About 75 characters of 14px Open Sans, so a line stays readable in a wide panel.
const TEXT_W = 600;
// The conversation's column in a full panel.
const CONVERSATION_W = 760;
// Half the date label's height: the label is centered on the line between two posts.
const DATE_HALF = 13;
// TextView's own gap between paragraphs, for a message split into two blocks at a paragraph break.
const PARAGRAPH_GAP = "0.75rem";
const scrollState = () => ({ offset: 0, viewH: 0, viewW: 0, contentH: 0, heights: new Map() });
const STATUS = { online: ["online", "#3db887"], away: ["away", "#f5ab00"], dnd: ["dnd", "#d24b4e"] };
// Mattermost's own UI font, so text and weights match the desktop app.
export const FONT = "Open Sans";
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const postFileIds = (p) => (p.file_ids?.length ? p.file_ids : (p.metadata?.files ?? []).map((f) => f.id));
const CHANNEL_KEYS = ["id", "team_id", "type", "name", "display_name", "purpose", "header", "create_at", "delete_at",
  "last_post_at", "last_root_post_at", "total_msg_count", "total_msg_count_root", "group_constrained"];
const slimChannel = (c) => pick(c, CHANNEL_KEYS);
const slimMember = (m) => ({
  ...pick(m, ["channel_id", "msg_count", "msg_count_root", "mention_count", "mention_count_root", "last_viewed_at", "roles"]),
  notify_props: { mark_unread: m.notify_props?.mark_unread, desktop: m.notify_props?.desktop },
});
const slimUser = (u) => ({ ...pick(u, ["id", "username", "first_name", "last_name", "nickname", "position", "last_picture_update", "is_bot"]), custom: customStatus(u.props?.customStatus) });

// A user's custom status (`props.customStatus` is JSON text), or null when unset or broken.
export function customStatus(raw) {
  try {
    const s = raw && JSON.parse(raw);
    return s?.emoji || s?.text ? { emoji: s.emoji ?? "", text: s.text ?? "", duration: s.duration ?? "", expires: Date.parse(s.expires_at ?? "") } : null;
  } catch {
    return null;
  }
}
// Mattermost's sortChannelsByRecencyAndTypeAndDisplayName: viewed ones newest first, then by type
// (public, private, direct, group) and name.
const TYPE_ORDER = { O: 0, P: 1, D: 2, G: 3 };
export function byRecency(a, b) {
  if (a.viewed && b.viewed) return b.viewed - a.viewed;
  if (a.viewed || b.viewed) return a.viewed ? -1 : 1;
  return (TYPE_ORDER[a.type] ?? 4) - (TYPE_ORDER[b.type] ?? 4) || a.display.localeCompare(b.display);
}

// Join and leave posts, which Mattermost hides unless the person (or the server's default) shows them.
const JOIN_LEAVE = new Set([
  "system_join_channel", "system_leave_channel", "system_add_to_channel", "system_remove_from_channel",
  "system_join_team", "system_leave_team", "system_add_to_team", "system_remove_from_team", "system_join_leave", "system_add_remove",
]);
const fromWebhook = (p) => p.props?.from_webhook === "true";
// Webhooks and plugins give their posts types of their own, such as slack_attachment, and those are ordinary posts.
// Answers to commands are "system" posts too, but they read like messages, with markdown and from System.
const isEphemeral = (p) => p.type === "system_ephemeral";
// Markdown read as the words it shows, on one line, for a notification's body.
const notificationText = (md) => (md ?? "")
  .replace(/```[\s\S]*?```/g, "[code]")
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/(\*\*|__|~~|`)/g, "")
  .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 300);
const isSystem = (p) => Boolean(p.type?.startsWith("system_")) && !isEphemeral(p);

// Keeps a Map to the most recently set entries.
function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHED) map.delete(map.keys().next().value);
}

function day(ms) {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === new Date(now.getTime() - 86400e3).toDateString()) return "Yesterday";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}

function dateLabel(ms) {
  const d = new Date(ms), label = day(ms);
  if (label === "Today" || label === "Yesterday") return label;
  return `${FULL_MONTHS[d.getMonth()]} ${pad(d.getDate())}${d.getFullYear() === new Date().getFullYear() ? "" : `, ${d.getFullYear()}`}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Mattermost's fileSizeToString: no space, whole kilobytes, and one decimal only below 10 of the larger units.
export function fileSize(n) {
  for (const [unit, power] of [["TB", 4], ["GB", 3], ["MB", 2]]) {
    const size = n / 1024 ** power;
    if (size > 1) return `${size < 10 ? Math.round(size * 10) / 10 : Math.round(size)}${unit}`;
  }
  return n > 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;
}

// As Mattermost's file list words it: "Wednesday at 14:24", "October 19 at 15:54".
function fileTime(ms) {
  const label = day(ms);
  const near = label === "Today" || label === "Yesterday" ? label : Date.now() - ms < 7 * 86400e3 ? WEEKDAYS[new Date(ms).getDay()] : dateLabel(ms);
  return `${near} at ${clock(ms)}`;
}

// Mattermost clears a timed status at expires_at; "dont_clear" keeps a placeholder date in year 1.
export function liveStatus(custom) {
  if (!custom) return null;
  return !custom.duration || custom.duration === "dont_clear" || !(custom.expires < Date.now()) ? custom : null;
}

export function until(custom) {
  if (!custom.duration || custom.duration === "dont_clear" || !Number.isFinite(custom.expires)) return "";
  return `Until ${expiryLabel(custom.expires)}`;
}

// As Mattermost's ExpiryTime, which drops the time of day from tomorrow onwards.
function expiryLabel(ms) {
  const d = new Date(ms), now = new Date();
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400e3);
  if (days <= 0) return clock(ms);
  if (days === 1) return `Tomorrow at ${clock(ms)}`;
  if (ms < now.getTime() + 6 * 86400e3) return WEEKDAYS[d.getDay()];
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() > now.getFullYear() ? `, ${d.getFullYear()}` : ""}`;
}

function ago(ms) {
  const min = Math.floor((Date.now() - ms) / 60e3);
  if (min < 1) return "just now";
  if (min < 60) return `${plural(min, "minute", "minutes")} ago`;
  if (min < 24 * 60) return `${plural(Math.floor(min / 60), "hour", "hours")} ago`;
  return day(ms);
}

function stamp(ms) {
  const d = day(ms);
  return d === "Today" ? clock(ms) : `${d.toLowerCase()} ${clock(ms)}`;
}

// Herdr re-renders a mod's root view on every change to its live data (agents, panes, focus), many
// times a second while agents work, and a render over 50 ms is cut off. Retained children are rebuilt
// only when notified, so the sidebar and the messages live in them and the root is a cheap frame.
const OWNERS = new Map();

class Part extends View {
  init(props) {
    this.owner = OWNERS.get(props.owner);
    this.part = props.part;
  }

  render(cx) {
    return this.owner.renderPart(this.part, cx);
  }
}

export default class Mattermost extends View {
  init(_props, cx) {
    if (props()?.statusCard) {
      this.popup = new StatusCard();
      return;
    }
    if (props()?.lightbox) {
      this.cfgReady = config().then((cfg) => { this.cfg = cfg; });
      this.popup = new Lightbox(this, cx);
      return;
    }
    if (props()?.statusDialog) {
      this.cfgReady = config().then((cfg) => { this.cfg = cfg; });
      this.popup = new StatusDialog(this);
      return;
    }
    if (props()?.dndDialog) {
      this.cfgReady = config().then((cfg) => { this.cfg = cfg; });
      this.popup = new DndDialog(this, cx);
      return;
    }
    if (props()?.resetStatus) {
      this.popup = new ResetStatusDialog(cx);
      return;
    }
    if (props()?.profile) {
      this.cfgReady = config().then((cfg) => { this.cfg = cfg; });
      this.popup = new ProfileDialog(this, cx);
      return;
    }
    if (props()?.edit) {
      this.cfgReady = config().then((cfg) => { this.cfg = cfg; });
      this.popup = new EditDialog(this);
      return;
    }
    if (props()?.menu) {
      this.cfgReady = config().then((cfg) => { this.cfg = cfg; });
      this.popup = new Menu(this);
      return;
    }
    if (props()?.picker) {
      this.cfgReady = config().then((cfg) => { this.cfg = cfg; });
      this.popup = new EmojiPicker(this, cx);
      return;
    }
    this.ownerKey = OWNERS.size ? Math.max(...OWNERS.keys()) + 1 : 1;
    OWNERS.set(this.ownerKey, this);
    this.sidePart = cx.new(Part, { owner: this.ownerKey, part: "side" });
    this.mainPart = cx.new(Part, { owner: this.ownerKey, part: "main" });
    this.parts = { side: this.sidePart, main: this.mainPart };
    this.suggesters = {};
    this.directory = new Directory(this);
    this.channels = new Map();
    this.members = new Map();
    this.users = new Map();
    this.posts = new Map();
    this.threadPosts = new Map();
    this.categories = [];
    this.threads = { all: null, unread: null };
    this.threadTab = "all";
    this.threadTotals = { total_unread_threads: 0, total_unread_mentions: 0 };
    this.solo = isPopout();
    this.selected = this.solo ? null : localStorage.getItem("selected");
    // Which section is up, and what's picked in the ones with no state of their own elsewhere.
    this.section = this.solo ? null : localStorage.getItem("section") ?? "chats";
    if ([THREADS, DRAFTS, JIRA].includes(this.selected)) {
      this.section = this.selected;
      this.selected = null;
    }
    this.chatFolder = localStorage.getItem("folder") ?? "all";
    this.draftSel = null;
    this.meSel = "profile";
    this.strips = {};
    // The newest root post of each conversation, for its row's preview, by channel id.
    this.previews = new Map();
    this.wantedPreviews = new Set();
    this.jira = this.solo ? null : jiraFor(this, cx);
    this.thread = null;
    this.live = false;
    this.busy = 0;
    this.unreadMemo = new Map();
    this.error = null;
    this.width = 0;
    this.offset = 0;
    this.shown = WINDOW;
    this.viewH = 0;
    this.viewW = 0;
    this.contentH = 0;
    this.heights = new Map();
    this.exhausted = new Set();
    this.media = new Media();
    this.fileState = new Map();
    this.playing = null;
    this.animationCost = new Map();
    this.emoji = {};
    this.customEmoji = new Map();
    this.missingEmoji = new Set();
    this.byUsername = new Map();
    this.unfinished = new Set();
    this.following = new Map();
    this.statuses = new Map();
    this.gmMembers = new Map();
    this.authors = new Set();
    this.saved = new Set();
    this.hoverPost = null;
    this.keepHover = null;
    this.rhsThread = null;
    this.rhsScroll = scrollState();
    this.threadScroll = scrollState();
    // Conversations posts in those lists come from that the sidebar doesn't have: closed, left or archived ones.
    this.extraChannels = new Map();
    // A channel showing posts around one you jumped to, cut off from its newest ones.
    this.detached = null;
    this.highlighted = null;
    // What a mention search looks for.
    this.keys = new HighlightKeys(this);
    // Mattermost's auto_reset_manual_status preference: empty until you've answered with "Do not ask me again".
    this.autoResetPref = "";
    if (props()?.demoStatus) demoStatus(props().demoStatus, props().demoAutoReset);
    this.recentStatuses = [];
    this.dndEnd = 0;
    // Bumped when logging out, which ends the loops that belong to the old login.
    this.session = 0;
    // Shared state outlives a restart, so a request already there is old news.
    this.seenRequest = shared(requestKey())?.id;
    this.rhs = null;
    this.rhsFrom = null;
    this.rhsExpanded = false;
    this.popouts = new Map();
    this.editHover = null;
    this.stats = new Map();
    this.rhsData = { members: new Map(), pinned: new Map(), files: new Map() };
    this.textRev = 0;
    this.parsedCache = new Map();
    this.text = {
      emoji: this.emoji,
      custom: (name) => this.customEmoji.has(name),
      mention: (name) => this.mentionLabel(name),
      highlight: () => this.mentionBg,
      textKeys: () => this.keys.forText(),
      channelKnown: (name) => [...this.channels.values()].some((c) => c.name === name),
      minHashtag: () => Number(this.clientConfig?.MinimumHashtagLength) || 3,
      issueKey: (url) => this.jira?.keyOf(url) ?? null,
    };
    // Indigo's mention highlight, until the person's Mattermost theme says otherwise.
    this.mentionBg = "#133a91";

    // The boxes draw their own placeholder, since it names the channel and a text state's is fixed.
    this.input = TextareaState.new();
    this.replyInput = TextareaState.new();
    this.threadInput = TextareaState.new();
    // The boxes are reused, so `key` says whose draft each one holds right now; see bindDrafts.
    this.boxes = [
      { input: this.input, thread: false, key: null, name: "post" },
      { input: this.replyInput, thread: true, key: null, name: "reply" },
      { input: this.threadInput, thread: true, key: null, name: "thread" },
    ];
    // Files on their way up, by draft, and what's known of the files drafts hold.
    this.uploads = new Map();
    // Small pictures made from the files picked or pasted here, by upload and then by file id.
    this.localThumbs = new Map();
    this.fileInfos = new Map();
    this.wantedInfos = new Set();
    this.drafts = this.readDrafts();
    this.pushing = new Set();
    this.draftAsk = null;
    // One edit box, reused for whichever post is being edited. Herdr's textarea inserts the newline
    // before reporting Enter, so a plain Enter saves the text as it was just before; Shift+Enter keeps it.
    // The message boxes work the same way.
    this.editInput = TextareaState.new({ placeholder: "Edit the post..." });
    this.editInput.set_auto_grow(1, EDIT_ROWS);
    const edit = this.editBox = { input: this.editInput, name: "edit", edit: true, key: null, fileIds: [], empty: true };
    this.editInput.on("change", (_e, cx) => {
      edit.before = edit.now;
      edit.now = this.editInput.value();
      if (takeFilePaste(this, edit, edit.before ?? "", edit.now, cx)) return;
      edit.suggest.changed(cx);
      if (noteText(edit)) cx.notify(edit.part);
    });
    this.editInput.on("submit", (e, cx) => {
      if (e.shift || !this.editing) return;
      edit.now = edit.before ?? "";
      edit.suggest.dropLineBreak(edit.now);
      edit.suggest.submit(e, cx, (cx) => this.saveEdit(cx));
    });
    this.editInput.on("paste_other", (_e, cx) => cx.spawn(async (cx) => pasteFiles(this, edit, cx)));
    this.editInput.on("focus", (_e, cx) => { edit.focused = true; cx.notify(edit.part); });
    this.editInput.on("blur", (_e, cx) => { edit.focused = false; edit.suggest.blur(cx); cx.notify(edit.part); });
    edit.suggest = this.newSuggest(cx, this.editInput, () => {
      const p = this.editing && this.findAnyPost(this.editing);
      return { channel: p?.channel_id, root: p?.root_id ?? "" };
    }, { commands: false });
    // The side panel has no pane frame, so the mod draws one; its border follows the keyboard like a pane's.
    this.frame = Boolean(props()?.frame);
    this.focus = cx.focus_handle();
    for (const box of this.boxes) {
      box.input.set_auto_grow(1, BOX_ROWS);
      box.suggest = this.newSuggest(cx, box.input, () => ({
        channel: box.thread ? this.drafts.get(box.key)?.channel_id ?? this.threadPosts.get(box.key)?.[0]?.channel_id : box.key,
        root: box.thread ? box.key : "",
      }), { execute: (cx) => this.send(box, cx) });
      box.part = this.parts[`composer-${box.name}`] = cx.new(Part, { owner: this.ownerKey, part: `composer-${box.name}` });
      box.suggest.host = box.part;
      box.empty = true;
      box.input.on("paste_other", (_e, cx) => cx.spawn(async (cx) => pasteFiles(this, box, cx)));
      box.input.on("focus", (_e, cx) => { this.typing = box.focused = true; cx.notify(); cx.notify(box.part); });
      box.input.on("blur", (_e, cx) => { this.typing = box.focused = false; box.suggest.blur(cx); cx.notify(); cx.notify(box.part); });
      box.input.on("change", (_e, cx) => {
        box.before = box.now;
        box.now = box.input.value();
        if (takeFilePaste(this, box, box.before ?? "", box.now, cx)) return;
        this.noteDraft(box);
        box.suggest.changed(cx);
        if (noteText(box)) cx.notify(box.part);
      });
      box.input.on("submit", (e, cx) => {
        if (e.shift) return;
        box.now = box.before ?? "";
        box.suggest.dropLineBreak(box.now);
        this.noteDraft(box);
        box.suggest.submit(e, cx, (cx) => this.send(box, cx));
      });
    }
    edit.part = this.parts["composer-edit"] = cx.new(Part, { owner: this.ownerKey, part: "composer-edit" });
    edit.suggest.host = edit.part;
    this.urlInput = InputState.new({ placeholder: "https://chat.example.com" });
    this.tokenInput = InputState.new({ placeholder: "Paste the token" });
    this.tokenInput.set_masked(true);
    this.urlInput.on("submit", () => this.tokenInput.focus());
    this.tokenInput.on("submit", (_e, cx) => cx.spawn(async (cx) => this.connectLogin(cx)));
    this.find = new Find(this);

    cx.timer.every(60e3, (cx) => cx.spawn(async (cx) => {
      if (!this.me) return;
      await this.loadStatuses(cx);
      cx.notify(this.sidePart);
    }));

    // A part whose render was cut off shows Herdr's error over its last frame until it renders again.
    cx.timer.every(200, (cx) => {
      if (!this.unfinished.size) return;
      this.warm();
      for (const part of this.unfinished) cx.notify(this.parts[part]);
      this.unfinished.clear();
    });

    // Downloads run outside render; this picks up whatever the last render asked for.
    // Rows ask for their previews while drawing, where nothing can be fetched, so the fetches come from here.
    cx.timer.every(250, (cx) => {
      if (!this.me) return;
      if (this.wantedPreviews.size && !this.fetchingPreviews) cx.spawn(async (cx) => this.fetchPreviews(cx));
      if (this.peekLoad) cx.spawn(async (cx) => this.loadPeek(this.peekLoad, cx));
    });

    cx.timer.every(1000, (cx) => {
      const t = theme(), look = `${t.background}${t.foreground}${t.accent}${t.border}`;
      this.publishBadge();
      this.saveDrafts();
      if (this.wantedInfos.size && this.me) cx.spawn(async (cx) => this.loadFileInfos(cx));
      if (look !== this.look) {
        if (this.look) this.redraw(cx);
        this.look = look;
      }
      if (this.cfg && this.media.pending()) cx.spawn(async (cx) => { if (await this.media.flush(this.cfg)) this.redraw(cx); });
    });

    if (!props()?.demo && !this.solo) {
      cx.timer.after(0, () => setShared("mattermost.alive", Date.now()));
      cx.timer.every(ALIVE_EVERY, () => setShared("mattermost.alive", Date.now()));
      cx.spawn(async (cx) => { for (;;) this.command(await nextCommand(), cx); });
    }

    cx.spawn(async (cx) => {
      try {
        this.cfg = await config();
        this.media.demo = Boolean(this.cfg?.demo);
        Object.assign(this.emoji, JSON.parse(await readTextFile(`${appHome()}/mods/mattermost/emoji/emoji.json`) ?? "{}"));
        await this.media.prune();
        await this.media.scan();
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.redraw(cx);
        return;
      }
      if (!this.cfg) {
        this.setup = { step: "login" };
        this.redraw(cx);
        return;
      }
      await this.start(cx);
    });
  }

  async start(cx) {
    const session = this.session;
    this.connect(cx);
    // A failed first load would otherwise leave the panel empty until the websocket reconnects.
    for (let delay = 5000; session === this.session; delay = Math.min(delay * 2, 60e3)) {
      try {
        await this.load(cx);
        if (firstStart(Boolean(this.cfg?.demo))) cx.spawn(async (cx) => this.checkStatus(cx));
        return;
      } catch (e) {
        if (session !== this.session) return;
        this.error = `${String(e?.message ?? e)} · retrying in ${delay / 1000}s`;
        this.redraw(cx);
        await sleep(cx, delay);
      }
    }
  }

  // Checks the login against the server before saving it, so a typo shows here and not as a failing panel.
  async connectLogin(cx) {
    if (this.setup.busy) return;
    const url = serverUrl(this.urlInput.value()), token = this.tokenInput.value().trim();
    if (!url || !token) {
      this.setup = { step: "login", error: "Fill in the server and the token." };
      return cx.notify();
    }
    this.setup = { step: "login", busy: true };
    cx.notify();
    const get = async (path) => {
      let res;
      try {
        res = await timed(cx, fetch(`${url}/api/v4${path}`, { headers: { Authorization: `Bearer ${token}` } }));
      } catch (e) {
        throw new Error(`Couldn't reach the server: ${e?.message ?? e}`);
      }
      if (res.status === 401) throw new Error("The server didn't accept this token.");
      if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}. Is it the address you open Mattermost at?`);
      try {
        return await res.json();
      } catch {
        throw new Error(`No Mattermost server answered at ${url}.`);
      }
    };
    try {
      await get("/users/me");
      const teams = (await get("/users/me/teams")).filter((t) => !t.delete_at);
      if (!teams.length) throw new Error("This account isn't in a team yet. Join one in Mattermost first.");
      if (teams.length === 1) return await this.saveLogin({ url, token, team: teams[0] }, cx);
      this.setup = { step: "team", url, token, teams: teams.sort((a, b) => a.display_name.localeCompare(b.display_name)) };
    } catch (e) {
      this.setup = { step: "login", error: String(e?.message ?? e) };
    }
    cx.notify();
  }

  async saveLogin({ url, token, team }, cx) {
    const path = loginPath();
    try {
      const old = await readTextFile(path).catch(() => null);
      await writeTextFile(path, `${JSON.stringify({ url, token, team: team.name }, null, 2)}\n`, old);
      // The token is a password to the person's whole account.
      await exec("chmod", ["600", path]).catch(() => {});
    } catch (e) {
      this.setup = { ...this.setup, busy: false, error: `Couldn't save ${path}: ${e?.message ?? e}` };
      return cx.notify();
    }
    this.cfg = { url, token, team: team.name };
    this.team = team;
    this.setup = null;
    this.tokenInput.set_value("");
    this.redraw(cx);
    await this.start(cx);
  }

  // Redraws the frame and both parts, since a part is only rebuilt when it is notified.
  redraw(cx) {
    if (!this.rhs) this.rhsExpanded = false;
    cx.notify();
    if (this.sidePart) {
      this.bindDrafts(cx);
      this.warm();
      cx.notify(this.sidePart);
      cx.notify(this.mainPart);
      for (const s of Object.values(this.suggesters)) if (s.isOpen()) cx.notify(s.part);
      for (const box of this.allBoxes()) cx.notify(box.part);
    }
    pruneLocal(this);
  }

  allBoxes() {
    return [...this.boxes, this.editBox];
  }

  // Each list is a retained part of its own, so moving through it doesn't rebuild the messages.
  newSuggest(cx, input, where, options) {
    const name = `suggest-${Object.keys(this.suggesters).length}`;
    const part = this.parts[name] = cx.new(Part, { owner: this.ownerKey, part: name });
    return this.suggesters[name] = new Suggest(this, input, where, part, name, options);
  }

  async close() {
    if (this.popup) {
      this.popup.closing?.();
      if (shared("mattermost.popup") === props().overlay) setShared("mattermost.popup", null);
      this.popup.closing?.();
      return;
    }
    if (this.solo) {
      // Whatever is left in the box is a filed draft now, and the panel has to know of it.
      for (const box of this.boxes) this.noteDraft(box);
      for (const d of this.drafts.values()) if (d.typing) { d.typing = false; this.draftsTouched = true; }
    }
    this.saveDrafts();
    OWNERS.delete(this.ownerKey);
    if (this.solo) setShared(requestKey(), null);
    else if (!props()?.demo && ![...OWNERS.values()].some((o) => !o.cfg?.demo && !o.solo)) setShared("mattermost.alive", null);
    await Promise.allSettled([localStorage.flush(), this.ws?.close()]);
  }

  async api(cx, path, { method = "GET", body, attempts = ATTEMPTS, timeout = TIMEOUT } = {}) {
    if (this.cfg.demo) return demoApi(path, method, body);
    let res;
    // Some routes to a server drop TLS handshakes now and then; a fresh attempt usually gets through.
    for (let attempt = 1; ; attempt++) {
      try {
        res = await timed(cx, fetch(`${this.cfg.url}/api/v4${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.cfg.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
          body: body && JSON.stringify(body),
        }), timeout);
        break;
      } catch (e) {
        if (attempt >= attempts) throw new Error(`${method} ${path.split("?")[0]}: ${e?.message ?? e}`);
      }
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw Object.assign(new Error(`${method} ${path.split("?")[0]}: HTTP ${res.status}`), { status: res.status, id: body?.id, text: body?.message });
    }
    return res.json();
  }

  // The demo leaves the shared header and badge to a real panel running beside it.
  publishHeader() {
    if (this.cfg?.demo || this.solo) return;
    const team = this.team?.display_name || this.team?.name || "";
    const reconnecting = !this.live && Boolean(this.wsError);
    const head = { name: "Mattermost", detail: reconnecting ? `${team} · reconnecting` : team, icon: "mods/mattermost/icons/logo.svg", tint: true, loading: !this.live || this.busy > 0 };
    // Shared state re-renders every mod, so publish only real changes. Compare with what is stored,
    // not with this copy's last write: a closed pane or an old build may have written since.
    if (JSON.stringify(head) === JSON.stringify(shared("pane-header:mattermost"))) return;
    setShared("pane-header:mattermost", head);
  }

  // What the tab bar's Mattermost button shows, like the desktop app's badge: mentions as a count, else a
  // dot when channels that aren't muted, or followed threads, have unread messages.
  publishBadge() {
    if (!this.me || this.cfg?.demo || this.solo) return;
    let mentions = this.threadTotals.total_unread_mentions ?? 0;
    let unread = (this.threadTotals.total_unread_threads ?? 0) > 0;
    for (const cat of this.categories) {
      for (const id of cat.channel_ids) {
        const c = this.channels.get(id), m = this.members.get(id);
        if (!c || !m) continue;
        mentions += m.mention_count_root ?? m.mention_count ?? 0;
        if (!cat.muted && !this.muted(c) && c.total_msg_count_root > m.msg_count_root) unread = true;
      }
    }
    const badge = { mentions, unread };
    if (JSON.stringify(badge) === JSON.stringify(shared("mattermost.badge"))) return;
    setShared("mattermost.badge", badge);
  }

  async working(fn) {
    this.busy++;
    this.publishHeader();
    try {
      return await fn();
    } finally {
      this.busy--;
      this.publishHeader();
    }
  }

  async load(cx) {
    return this.working(() => this.loadNow(cx));
  }

  async loadNow(cx) {
    this.me = await this.api(cx, "/users/me");
    this.addUser(this.me);
    if (!this.team || !this.teams) {
      this.teams = await this.api(cx, "/users/me/teams");
      this.team ??= this.teams.find((t) => t.name === this.cfg.team) ?? this.teams[0];
    }
    this.publishHeader();
    try {
      this.clientConfig ??= await this.api(cx, "/config/client?format=old");
    } catch {}
    await this.loadSidebar(cx);
    await this.loadMentionKeys(cx);
    try {
      const flagged = await this.api(cx, "/users/me/preferences/flagged_post");
      this.saved = new Set(flagged.filter((x) => x.value === "true").map((x) => x.name));
    } catch {}
    if (this.solo) {
      await this.loadDrafts(cx);
      return loadPopout(this, cx);
    }
    // The section stays across restarts, and the prop may be gone since. The `channel` prop picks what opens
    // first only until the panel has a place of its own.
    const wanted = props()?.channel;
    if (wanted && !this.selected && localStorage.getItem("section") == null) {
      if ([THREADS, DRAFTS, JIRA, "find", "me"].includes(wanted)) this.section = wanted;
      else this.selected = [...this.channels.values()].find((c) => c.name === wanted || c.display_name === wanted)?.id ?? null;
    }
    if (this.section === JIRA && !this.jira) this.section = "chats";
    await this.loadDrafts(cx);
    if (this.section === DRAFTS && !this.selectedDraft()) this.draftSel = this.filedDrafts()[0] ? draftKey(this.filedDrafts()[0]) : null;
    if (props()?.thread && !this.thread) await this.openThread(props().thread, cx);
    if (this.section === THREADS) await this.loadThreads(cx);
    if (this.selected && this.channels.has(this.selected)) await this.open(this.selected, cx, false);
  }

  async loadSidebar(cx) {
    const base = `/users/me/teams/${this.team.id}/channels`;
    const [channels, members, categories, prefs] = await Promise.all([
      this.api(cx, base), this.api(cx, `${base}/members`), this.api(cx, `${base}/categories`), this.api(cx, "/users/me/preferences"),
    ]);
    // Closed conversations stay members of their channel; Mattermost hides them by preference.
    const joinLeave = prefs.find((x) => x.category === "advanced_settings" && x.name === "join_leave")?.value;
    this.showJoinLeave = (joinLeave ?? this.clientConfig?.EnableJoinLeaveMessageByDefault ?? "true") === "true";
    this.draftsSynced = this.clientConfig?.AllowSyncedDrafts === "true" && prefs.find((x) => x.category === "advanced_settings" && x.name === "sync_drafts")?.value !== "false";
    this.dmLimit = Number(prefs.find((x) => x.category === "sidebar_settings" && x.name === "limit_visible_dms_gms")?.value) || DM_LIMIT;
    this.teamsOrder = prefs.find((x) => x.category === "teams_order")?.value ?? "";
    this.skinTone = prefs.find((x) => x.category === "emoji" && x.name === "emoji_skintone")?.value ?? "default";
    this.autoResetPref = prefs.find((x) => x.category === "auto_reset_manual_status" && x.name === this.me.id)?.value ?? "";
    try {
      this.recentEmoji = new Set(JSON.parse(prefs.find((x) => x.category === "recent_emojis" && x.name === this.me.id)?.value ?? "[]").map((r) => r.name));
    } catch {}
    // Mattermost's switcher takes a channel's last view as the latest of the member's last_viewed_at
    // and these two preferences, since the server moves last_viewed_at only when posts arrive.
    try {
      const bg = JSON.parse(prefs.find((x) => x.category === "theme" && !x.name)?.value ?? "{}").mentionHighlightBg;
      if (/^#[0-9a-f]{6}$/i.test(bg ?? "") && bg !== this.mentionBg) { this.mentionBg = bg; this.textRev++; }
    } catch {}
    try {
      this.recentStatuses = JSON.parse(prefs.find((x) => x.category === "custom_status" && x.name === "recent_custom_statuses")?.value ?? "[]");
    } catch {}
    this.viewTimes = new Map();
    for (const x of prefs) {
      if (x.category !== "channel_open_time" && x.category !== "channel_approximate_view_time") continue;
      this.viewTimes.set(x.name, Math.max(this.viewTimes.get(x.name) ?? 0, Number(x.value) || 0));
    }
    const closed = new Set(prefs.filter((x) => (x.category === "direct_channel_show" || x.category === "group_channel_show") && x.value === "false").map((x) => x.name));
    this.channels = new Map(channels.filter((c) => !c.delete_at && !(c.type === "D" ? closed.has(this.dmPeer(c)) : c.type === "G" && closed.has(c.id))).map((c) => [c.id, slimChannel(c)]));
    // The mention filters offer closed conversations too, which the sidebar drops.
    this.filterable = new Map(channels.map((c) => [c.id, slimChannel(c)]));
    this.members = new Map(members.map((m) => [m.channel_id, slimMember(m)]));
    this.categories = categories.order.map((id) => categories.categories.find((c) => c.id === id)).filter(Boolean);
    await this.fetchUsers(cx, [...this.channels.values()].filter((c) => c.type === "D").map((c) => this.dmPeer(c)));
    await this.loadGroups(cx);
    await this.loadStatuses(cx);
    await this.loadThreadTotals(cx);
    this.rows = null;
    this.error = null;
    this.redraw(cx);
  }

  // A group conversation is named after its members' full names; the channel itself only knows usernames.
  async loadGroups(cx) {
    await Promise.all([...this.channels.values()].filter((c) => c.type === "G").map(async (c) => {
      try {
        const users = await this.api(cx, `/users?in_channel=${c.id}&per_page=20`);
        users.forEach((u) => this.addUser(u));
        this.gmMembers.set(c.id, users.sort((a, b) => a.username.localeCompare(b.username)).map((u) => u.id));
      } catch {}
    }));
  }

  // Mattermost's own client polls the statuses it shows each minute besides taking status_change events.
  async loadStatuses(cx, only) {
    const ids = only ?? [...new Set([...this.channels.values()].filter((c) => c.type === "D").map((c) => this.dmPeer(c)).concat([...this.authors], this.me.id))];
    if (!ids.length) return;
    try {
      for (const st of await this.api(cx, "/users/status/ids", { method: "POST", body: ids })) {
        this.statuses.set(st.user_id, st.status);
        if (st.user_id === this.me.id) this.dndEnd = st.dnd_end_time ?? 0;
      }
      for (const id of ids) {
        const emoji = liveStatus(this.users.get(id)?.custom)?.emoji;
        if (emoji) await this.ensureEmoji(cx, emoji);
      }
    } catch {}
  }

  async loadCategories(cx) {
    const categories = await this.api(cx, `/users/me/teams/${this.team.id}/channels/categories`);
    this.categories = categories.order.map((id) => categories.categories.find((c) => c.id === id)).filter(Boolean);
  }

  threadsPath(query) {
    return `/users/${this.me.id}/teams/${this.team.id}/threads?${query}`;
  }

  async loadThreadTotals(cx) {
    this.threadTotals = await this.api(cx, this.threadsPath("totalsOnly=true"));
  }

  async loadThreads(cx) {
    return this.working(() => this.loadThreadsNow(cx));
  }

  async loadThreadsNow(cx) {
    const tab = this.threadTab;
    try {
      const page = await this.api(cx, this.threadsPath(`per_page=${THREAD_PAGE}&extended=true${tab === "unread" ? "&unread=true" : ""}`));
      for (const th of page.threads) for (const u of th.participants ?? []) if (u?.id) this.addUser(u);
      await this.ingest(cx, page.threads.map((th) => th.post));
      this.threads[tab] = page.threads;
      this.threadTotals = page;
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
    this.redraw(cx);
  }

  async fetchUsers(cx, ids) {
    const missing = [...new Set(ids)].filter((id) => id && !this.users.has(id));
    if (!missing.length) return;
    for (const u of await this.api(cx, "/users/ids", { method: "POST", body: missing })) this.addUser(u);
  }

  addUser(u) {
    u = slimUser(u);
    this.users.set(u.id, u);
    this.byUsername.set(u.username.toLowerCase(), u);
    this.textRev++;
  }

  mentionLabel(name) {
    const n = name.toLowerCase();
    if (SPECIAL.has(n)) return n;
    const u = this.byUsername.get(n);
    return u ? this.userName(u.id) : null;
  }

  // Everything a batch of posts needs drawn: authors, reacting users, mentioned users, custom emoji.
  async ingest(cx, posts) {
    const ids = [], names = new Set();
    for (const p of posts) {
      ids.push(p.user_id);
      if (!fromWebhook(p) && !this.authors.has(p.user_id)) {
        // Bounded so a long session doesn't poll every author it ever scrolled past.
        if (this.authors.size >= 300) this.authors.delete(this.authors.values().next().value);
        this.authors.add(p.user_id);
      }
      for (const r of p.metadata?.reactions ?? []) ids.push(r.user_id);
      for (const u of p.participants ?? []) if (u?.id) ids.push(u.id);
      for (const e of p.metadata?.emojis ?? []) this.customEmoji.set(e.name, e.id);
      const quoted = (p.metadata?.embeds ?? []).map((e) => e.data?.post).filter(Boolean);
      for (const q of quoted) ids.push(q.user_id);
      this.textRev++;
      for (const text of [p.message ?? "", ...quoted.map((q) => q.message ?? "")]) {
        for (const n of mentionNames(text)) if (!this.byUsername.has(n)) names.add(n);
        for (const [, n] of text.matchAll(SHORTCODES)) await this.ensureEmoji(cx, n.toLowerCase());
      }
    }
    await this.fetchUsers(cx, ids);
    if (names.size) {
      try {
        for (const u of await this.api(cx, "/users/usernames", { method: "POST", body: [...names] })) this.addUser(u);
      } catch {}
    }
  }

  async ensureEmoji(cx, name) {
    if (this.emoji[name] || this.customEmoji.has(name) || this.missingEmoji.has(name)) return;
    try {
      this.customEmoji.set(name, (await this.api(cx, `/emoji/name/${encodeURIComponent(name)}`)).id);
      this.textRev++;
    } catch {
      this.missingEmoji.add(name);
    }
  }

  dmPeer(c) {
    const [a, b] = c.name.split("__");
    return a === this.me?.id ? b : a;
  }

  userName(id) {
    const u = this.users.get(id);
    if (!u) return "…";
    const full = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();
    return full || u.username;
  }

  channelName(c) {
    if (!c) return "";
    if (c.type === "D") return this.dmPeer(c) === this.me?.id ? `${this.userName(this.me.id)} (you)` : this.userName(this.dmPeer(c));
    if (c.type === "G" && this.gmMembers.has(c.id)) return this.gmMembers.get(c.id).filter((id) => id !== this.me?.id).map((id) => this.userName(id)).join(", ");
    return c.display_name || c.name;
  }

  muted(c) {
    return this.members.get(c.id)?.notify_props?.mark_unread === "mention";
  }

  // Counts are worked out once per change: whatever changes them clears `rows`.
  unread(c) {
    if (!this.rows) {
      this.unreadMemo = new Map();
      this.rows = true;
    }
    let u = this.unreadMemo.get(c.id);
    if (u) return u;
    const m = this.members.get(c.id);
    u = !m ? { count: 0, mentions: 0 } : {
      count: this.muted(c) ? 0 : Math.max(0, c.total_msg_count_root - m.msg_count_root),
      mentions: m.mention_count_root ?? m.mention_count,
    };
    this.unreadMemo.set(c.id, u);
    return u;
  }

  // The categories with their conversations in the order they're sorted by, the direct messages cut to the limit.
  sidebar() {
    return this.categories.map((cat) => {
      let chans = cat.channel_ids.map((id) => this.channels.get(id)).filter(Boolean);
      if (cat.sorting === "alpha") chans.sort((a, b) => this.channelName(a).localeCompare(this.channelName(b)));
      else if (cat.sorting !== "manual") chans.sort((a, b) => lastPost(b) - lastPost(a));
      const wanted = (c) => c.id === this.selected || this.unread(c).count > 0 || this.unread(c).mentions > 0;
      if (cat.type === "direct_messages") chans = chans.filter((c, i) => i < this.dmLimit || wanted(c));
      return { cat, chans };
    });
  }

  select(id) {
    if (id !== this.selected) this.rhsExpanded = false;
    this.selected = id;
    this.rows = null;
    this.resetScroll();
    localStorage.setItem("selected", id);
  }

  resetScroll() {
    this.offset = 0;
    this.shown = WINDOW;
    this.heights.clear();
  }

  // A channel whose posts aren't here yet leaves the one on screen up for a moment while they load, so
  // the messages don't blink out in between; the sidebar marks the new one at once.
  // `show` brings Chats up; a load in the background opens the channel without leaving the section.
  async open(id, cx, show = true) {
    if (this.solo) return toPanel({ action: "open", channel: id });
    if (show && this.section !== "chats") {
      this.section = "chats";
      localStorage.setItem("section", "chats");
      this.rhsExpanded = false;
    }
    const loading = this.working(() => this.fetchChannel(id, cx));
    if (!this.posts.has(id)) {
      this.opening = id;
      this.redraw(cx);
      await Promise.race([loading, sleep(cx, OPEN_WAIT)]);
      if (this.opening !== id) return;
    }
    this.opening = null;
    // Over the messages, the side view would hide the conversation that was just asked for.
    if (!this.rhsBeside()) {
      this.rhs = null;
      this.rhsFrom = null;
    }
    this.select(id);
    if (show) this.input.focus();
    this.redraw(cx);
    this.loadStats(cx, id);
    if (this.rhs) this.loadRhs(cx);
    await loading;
    this.redraw(cx);
  }

  loadStats(cx, id) {
    cx.spawn(async (cx) => {
      try {
        this.stats.set(id, await this.api(cx, `/channels/${id}/stats`));
        this.redraw(cx);
      } catch {}
    });
  }

  // `from` is the view that led here (Info's rows), which the side view's back button returns to.
  openRhs(kind, cx, from = null) {
    this.rhs = this.rhs === kind && !from ? null : kind;
    this.rhsFrom = this.rhs ? from : null;
    this.redraw(cx);
    if (this.rhs) this.loadRhs(cx);
  }

  loadRhs(cx) {
    const id = this.selected, kind = this.rhs, c = this.channels.get(id);
    if (!c || kind === "info" || kind === "thread") return;
    cx.spawn(async (cx) => {
      try {
        if (kind === "members") {
          const users = await this.api(cx, `/users?in_channel=${id}&active=true&per_page=200`);
          users.forEach((u) => this.addUser(u));
          remember(this.rhsData.members, id, users.map((u) => u.id));
        } else if (kind === "pinned") {
          const page = await this.api(cx, `/channels/${id}/pinned`);
          const posts = page.order.map((pid) => page.posts[pid]).sort((a, b) => b.create_at - a.create_at);
          await this.ingest(cx, posts);
          remember(this.rhsData.pinned, id, posts);
        } else if (kind === "files") {
          // Mattermost's own Files view is a file search scoped to the channel.
          const where = c.type === "D" ? `@${this.users.get(this.dmPeer(c))?.username ?? ""}` : c.name;
          const res = await this.api(cx, `/teams/${this.team.id}/files/search`, { method: "POST", body: { terms: `in:${where}`, is_or_search: false, page: 0, per_page: 50 } });
          remember(this.rhsData.files, id, res.order.map((fid) => pick(res.file_infos[fid], ["id", "name", "size", "create_at", "extension", "has_preview_image", "post_id"])));
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.redraw(cx);
    });
  }

  channelOf(id) {
    return this.channels.get(id) ?? this.extraChannels.get(id);
  }

  // What notifies you, as Mattermost's getCurrentUserMentionKeys and getMyGroupMentionKeys build it.
  async loadMentionKeys(cx) {
    await this.keys.load(cx);
    this.mentionKeysChanged();
  }

  // A parsed message holds its highlights, so it has to be parsed again.
  mentionKeysChanged() {
    this.textRev++;
  }

  async fetchExtraChannels(cx, posts) {
    const missing = [...new Set(posts.map((p) => p.channel_id))].filter((id) => !this.channelOf(id));
    await Promise.all(missing.map(async (id) => {
      try {
        this.extraChannels.set(id, slimChannel(await this.api(cx, `/channels/${id}`)));
      } catch {}
    }));
    const peers = missing.map((id) => this.extraChannels.get(id)).filter((c) => c?.type === "D").map((c) => this.dmPeer(c));
    if (peers.length) await this.fetchUsers(cx, peers);
  }

  // A post that's anywhere the panel keeps one: a post can be in a channel, a thread and a list at once.
  copiesOf(id) {
    const lists = [...this.posts.values(), ...this.threadPosts.values()];
    return lists.map((list) => list?.find((p) => p.id === id)).filter(Boolean);
  }

  // Where Mattermost's /pl/ link goes: a reply opens beside its channel, and a root post shows in its channel.
  // A permalink clicked in a message opens a reply's thread beside the channel already open, as the web
  // app's focusPost does with skipRedirectReplyPermalink. False when the post went to `away` instead.
  async jump(p, cx, { beside = false, away = openLink } = {}) {
    if (this.solo) return toPanel({ action: "jump", post: pick(p, ["id", "root_id", "channel_id"]) });
    this.rhsExpanded = false;
    try {
      if (!(await this.reachable(p, cx, away))) return false;
      if (!(beside && p.root_id)) await this.open(p.channel_id, cx);
      if (p.root_id) { this.openReply(p.root_id, cx, p.id); return true; }
      const list = this.posts.get(p.channel_id);
      if (!list?.some((x) => x.id === p.id)) await this.loadAround(p, cx);
      const posts = this.posts.get(p.channel_id) ?? [];
      this.shown = Math.max(this.shown, posts.length - posts.findIndex((x) => x.id === p.id) + WINDOW);
      this.focusOn(p.id, this, cx);
    } catch (e) {
      this.error = e?.text ?? String(e?.message ?? e);
      this.redraw(cx);
    }
    return true;
  }

  // Anything out of reach is left to the browser, where Mattermost asks about joining.
  async reachable(p, cx, away = openLink) {
    const c = this.extraChannels.get(p.channel_id);
    if (await this.reveal(c ?? { id: p.channel_id }, cx)) return true;
    away(this.postLink(p.id, c?.team_id || this.team.id));
    return false;
  }

  // A closed direct or group message is shown again by its preference, as Mattermost does before going to it.
  async reveal(c, cx) {
    if (this.channels.has(c.id)) return true;
    if (c.type === "D" || c.type === "G") {
      await this.api(cx, `/users/${this.me.id}/preferences`, { method: "PUT", body: [{ user_id: this.me.id, category: c.type === "D" ? "direct_channel_show" : "group_channel_show", name: c.type === "D" ? this.dmPeer(c) : c.id, value: "true" }] });
    }
    // A conversation started elsewhere since the sidebar loaded is new to it.
    await this.loadSidebar(cx);
    return this.channels.has(c.id);
  }

  // Posts between this one and the newest may number in the thousands, too many to page through and keep.
  async loadAround(p, cx) {
    const id = p.channel_id;
    const side = (where) => this.api(cx, `/channels/${id}/posts?${where}=${p.id}&per_page=${AROUND}&collapsedThreads=true`);
    const [before, after] = await Promise.all([side("before"), side("after")]);
    const list = [...this.rootPosts(before), p, ...this.rootPosts(after)];
    await this.ingest(cx, list);
    this.posts.set(id, list);
    if (before.order.length < AROUND) this.exhausted.add(id);
    else this.exhausted.delete(id);
    this.detached = after.order.length < AROUND ? null : id;
  }

  rootPosts(page) {
    return page.order.map((id) => page.posts[id]).filter((p) => !p.root_id).sort((a, b) => a.create_at - b.create_at);
  }

  loadNewer(cx) {
    const id = this.selected, posts = this.posts.get(id);
    if (this.detached !== id || !posts?.length || this.loadingNewer) return;
    this.loadingNewer = true;
    cx.spawn(async (cx) => {
      try {
        const page = await this.api(cx, `/channels/${id}/posts?per_page=${PAGE}&after=${posts.at(-1).id}&collapsedThreads=true`);
        const newer = this.rootPosts(page);
        await this.ingest(cx, newer);
        if (this.posts.get(id) === posts && this.selected === id) {
          this.posts.set(id, [...posts, ...newer]);
          if (page.order.length < PAGE) this.detached = null;
          this.shown += newer.length;
          // They land under the view, and each counts as EST_ROW until drawn, so this keeps what's on screen in place.
          this.offset += newer.length * EST_ROW;
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loadingNewer = false;
      this.redraw(cx);
    });
  }

  // Rows near the post report their height only once drawn, so the aim settles over a few renders.
  focusOn(id, sc, cx) {
    sc.aim = id;
    this.highlighted = id;
    this.redraw(cx);
    for (const ms of [50, 150, 300, 500]) cx.timer.after(ms, (cx) => cx.notify(this.mainPart));
    cx.timer.after(800, () => { sc.aim = null; });
    cx.timer.after(HIGHLIGHT, (cx) => {
      if (this.highlighted !== id) return;
      this.highlighted = null;
      cx.notify(this.mainPart);
    });
  }

  emojiImage(name) {
    const tok = this.emojiToken(name);
    return { path: tok.custom ? this.media.emoji(this.customEmoji.get(tok.custom)) : tok.emoji && this.cfg ? this.media.standard(this.cfg.url, tok.emoji) : null, char: tok.emoji ?? "" };
  }

  async openStatusDialog(cx) {
    const custom = liveStatus(this.users.get(this.me.id)?.custom);
    const current = custom && {
      emoji: custom.emoji, text: custom.text, duration: custom.duration === "dont_clear" ? "" : custom.duration,
      expires_at: Number.isFinite(custom.expires) ? new Date(custom.expires).toISOString() : "", until: until(custom),
    };
    const recent = this.recentStatuses;
    const names = [...new Set([current?.emoji, ...recent.map((s) => s.emoji), ...SUGGESTIONS.map((s) => s.emoji), "speech_balloon"].filter(Boolean))];
    for (const name of names) await this.ensureEmoji(cx, name);
    openOverlay({
      mod: "mattermost", kind: "dialog", width: STATUS_W, height: STATUS_H,
      props: { demo: this.cfg?.demo, statusDialog: { current, recent, me: this.me.id, team: this.team.name, glyphs: Object.fromEntries(names.map((name) => [name, this.emojiImage(name)])) } },
    });
  }

  openDndDialog() {
    openOverlay({ mod: "mattermost", kind: "dialog", width: DND_W, height: DND_H, props: { demo: this.cfg?.demo, dndDialog: { me: this.me.id } } });
  }

  // Mattermost mounts its ResetStatusModal when a channel view starts and when a status change wants confirming.
  async checkStatus(cx, newStatus) {
    const resetStatus = await resetCheck(this, cx, newStatus);
    if (!this.me) return;
    this.redraw(cx);
    if (resetStatus) openOverlay({ mod: "mattermost", kind: "dialog", width: RESET_W, height: resetHeight(resetStatus), props: { demo: this.cfg?.demo, resetStatus } });
  }

  openProfile(tab = null) {
    openProfileDialog({ demo: this.cfg?.demo, profile: { user: this.me, config: this.clientConfig, avatar: this.media.avatar(this.users.get(this.me.id)), ...(tab ? { tab } : {}) } });
  }

  customEnabled() {
    return this.clientConfig?.EnableCustomUserStatuses !== "false";
  }

  // Deletes the saved login only: the token itself stays valid until it's revoked on the server.
  async logOut(cx) {
    if (this.cfg?.demo) return;
    this.session++;
    this.cfg = null;
    this.media.authed = null;
    await this.ws?.close().catch(() => {});
    await exec("rm", ["-f", loginPath(), `${appHome()}/data/mattermost/private/curl.conf`]).catch(() => {});
    for (const box of this.boxes) {
      box.key = null;
      box.input.set_value("");
      box.shown = "";
    }
    localStorage.removeItem("selected");
    localStorage.removeItem(this.draftStore());
    forgetStart(false);
    Object.assign(this, {
      autoResetPref: "",
      me: null, team: null, teams: null, clientConfig: null, selected: null, thread: null, rhs: null, rhsFrom: null, rhsThread: null, rows: null, error: null,
      rhsExpanded: false, rhsLast: null, section: "chats", thread: null, draftSel: null, previews: new Map(), wantedPreviews: new Set(),
      opening: null, editing: null, detached: null, highlighted: null, live: false, wsError: null, recentStatuses: [], dndEnd: 0,
      categories: [], threads: { all: null, unread: null }, threadTotals: { total_unread_threads: 0, total_unread_mentions: 0 }, draftsTouched: false,
      channels: new Map(), members: new Map(), users: new Map(), byUsername: new Map(), posts: new Map(), threadPosts: new Map(), statuses: new Map(), gmMembers: new Map(),
      following: new Map(), drafts: new Map(), stats: new Map(), extraChannels: new Map(), saved: new Set(), authors: new Set(), directory: new Directory(this),
      rhsData: { members: new Map(), pinned: new Map(), files: new Map() },
    });
    this.keys = new HighlightKeys(this);
    setShared("mattermost.badge", { mentions: 0, unread: false });
    this.setup = { step: "login" };
    this.redraw(cx);
  }

  // Channel posts don't say whether you follow their thread; the thread itself exists for you only if you do.
  loadFollowing(cx, posts) {
    const roots = posts.filter((p) => p.reply_count > 0 && !this.following.has(p.id));
    if (!roots.length) return;
    cx.spawn(async (cx) => {
      for (const p of roots) {
        try {
          const th = await this.api(cx, `/users/${this.me.id}/teams/${this.team.id}/threads/${p.id}`);
          this.following.set(p.id, th.is_following !== false);
        } catch (e) {
          if (String(e?.message).includes("HTTP 404")) this.following.set(p.id, false);
        }
      }
      this.redraw(cx);
    });
  }

  toggleFollow(p, cx) {
    const follow = !this.following.get(p.id);
    this.following.set(p.id, follow);
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        await this.api(cx, `/users/${this.me.id}/teams/${this.team.id}/threads/${p.id}/following`, { method: follow ? "PUT" : "DELETE" });
      } catch (e) {
        this.following.set(p.id, !follow);
        this.error = String(e?.message ?? e);
        this.redraw(cx);
      }
    });
  }

  editChannel(c, field) {
    openOverlay({
      mod: "mattermost", kind: "dialog", width: 640, height: 370,
      props: { demo: this.cfg?.demo, edit: { field, value: c[field] ?? "", channel: { id: c.id, type: c.type, display: this.channelName(c) } } },
    });
  }

  toggleMute(c, cx) {
    const member = this.members.get(c.id);
    if (!member) return;
    const mark = this.muted(c) ? "all" : "mention";
    member.notify_props = { ...member.notify_props, mark_unread: mark };
    this.rows = null;
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        await this.api(cx, `/channels/${c.id}/members/${this.me.id}/notify_props`, { method: "PUT", body: { channel_id: c.id, user_id: this.me.id, mark_unread: mark } });
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.redraw(cx);
      }
    });
  }

  toggleFavorite(c, cx) {
    const from = this.categoryOf(c.id), favorites = this.categories.find((x) => x.type === "favorites");
    const to = from === favorites ? this.categories.find((x) => x.type === (c.type === "D" || c.type === "G" ? "direct_messages" : "channels")) : favorites;
    if (!from || !to) return;
    const changed = [
      { ...from, channel_ids: from.channel_ids.filter((id) => id !== c.id) },
      { ...to, channel_ids: [c.id, ...to.channel_ids.filter((id) => id !== c.id)] },
    ];
    this.categories = this.categories.map((x) => changed.find((u) => u.id === x.id) ?? x);
    this.rows = null;
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        await this.api(cx, `/users/${this.me.id}/teams/${this.team.id}/channels/categories`, { method: "PUT", body: changed });
      } catch (e) {
        this.error = String(e?.message ?? e);
        await this.loadCategories(cx);
        this.redraw(cx);
      }
    });
  }

  async fetchChannel(id, cx) {
    try {
      const page = await this.api(cx, `/channels/${id}/posts?per_page=${PAGE}&collapsedThreads=true`);
      const fetched = page.order.map((pid) => page.posts[pid]).reverse();
      await this.ingest(cx, fetched);
      remember(this.posts, id, fetched);
      if (this.detached === id) this.detached = null;
      this.loadFollowing(cx, fetched);
      const unknown = [...new Set(fetched.map((p) => p.user_id))].filter((u) => !this.statuses.has(u) && this.authors.has(u));
      if (unknown.length) await this.loadStatuses(cx, unknown);
      await this.markRead(cx, id);
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
  }

  openThreads(cx) {
    this.showSection(THREADS, cx);
  }

  async openThread(id, cx) {
    if (this.section !== THREADS) this.showSection(THREADS, cx);
    this.thread = id;
    this.threadScroll = scrollState();
    this.redraw(cx);
    await this.working(() => this.fetchThread(id, cx));
    this.loadFollowing(cx, this.threadPosts.get(id)?.slice(0, 1) ?? []);
    this.redraw(cx);
    this.threadInput.focus();
  }

  openDrafts(cx) {
    this.showSection(DRAFTS, cx);
  }

  // Mentions and custom emoji in a draft need the same lookups as a post's.
  ingestDrafts(cx) {
    return this.ingest(cx, this.filedDrafts().map((d) => ({ user_id: this.me.id, message: d.message })));
  }

  readDrafts() {
    try {
      // Whatever was still being typed when the panel last closed counts as left behind now.
      return new Map(JSON.parse(localStorage.getItem(this.draftStore()) ?? "[]").map((d) => [draftKey(d), { ...d, typing: false }]));
    } catch {
      return new Map();
    }
  }

  draftStore() {
    return props()?.demo ? "demo-drafts" : "drafts";
  }

  // Writing holds every draft, so the second-long timer does it rather than each key press.
  saveDrafts() {
    if (!this.draftsTouched) return;
    this.draftsTouched = false;
    if (this.solo) return handDrafts(this);
    localStorage.setItem(this.draftStore(), JSON.stringify([...this.drafts.values()]));
  }

  // Mattermost files a draft when you leave it: until then it isn't counted or sent to the server.
  filedDrafts() {
    return [...this.drafts.values()].filter((d) => !d.typing && !draftEmpty(d) && this.channels.has(d.channel_id)).sort((a, b) => b.update_at - a.update_at);
  }

  // Every view change comes through redraw, so this is the one place a box's text follows what it shows.
  bindDrafts(cx) {
    const kind = this.mainKind();
    // The Drafts reader edits a draft in the box its conversation would.
    const d = kind === "drafts" ? this.selectedDraft() : null;
    const keys = [
      kind === "chat" ? this.selected : d && !d.root_id ? d.channel_id : null,
      this.rhs === "thread" && (kind === "chat" || this.solo) ? this.rhsThread : null,
      kind === "thread" ? this.thread : d?.root_id || null,
    ];
    this.boxes.forEach((box, i) => {
      if (box.key === keys[i]) return;
      this.leaveDraft(box, cx);
      this.fill(box, keys[i], this.drafts.get(keys[i])?.message ?? "");
    });
  }

  // `shown` tells text put here from an edit, so only an edit counts as a change to the draft.
  fill(box, key, text) {
    box.key = null;
    box.input.set_value(text);
    box.shown = box.before = box.now = box.input.value();
    box.suggest.reset();
    box.key = key;
    box.empty = !box.now.trim();
  }

  leaveDraft(box, cx) {
    this.noteDraft(box);
    const d = this.drafts.get(box.key);
    if (!d) return;
    d.typing = false;
    this.draftsTouched = true;
    this.pushDraft(box.key, cx);
  }

  noteDraft(box) {
    if (!box.key || box.edit) return;
    const value = box.input.value(), message = value.trim() ? value : "";
    if (value === box.shown) return;
    const old = this.drafts.get(box.key);
    const channel_id = old?.channel_id ?? (box.thread ? this.threadPosts.get(box.key)?.[0]?.channel_id : box.key);
    if (!channel_id) return;
    box.shown = value;
    if ((old?.message ?? "") === message) return;
    const next = { ...old, channel_id, root_id: box.thread ? box.key : "", message, dirty: true, update_at: Date.now() };
    next.typing = !draftEmpty(next) && (!old || draftEmpty(old) || Boolean(old.typing));
    if (draftEmpty(next) && !old?.remote) this.drafts.delete(box.key);
    else this.drafts.set(box.key, next);
    this.draftsTouched = true;
  }

  // One request per draft at a time, so a slow save can't land after the delete that followed it.
  // `remote` goes up before the save leaves: a delete issued while it's away still has to reach the server.
  pushDraft(key, cx) {
    if (!this.draftsSynced || this.pushing.has(key)) return;
    this.pushing.add(key);
    cx.spawn(async (cx) => {
      try {
        for (let d = this.drafts.get(key); d?.dirty && !d.typing; d = this.drafts.get(key)) {
          const empty = draftEmpty(d);
          if (empty) await this.api(cx, `/users/me/channels/${d.channel_id}/drafts${d.root_id ? `/${d.root_id}` : ""}`, { method: "DELETE" });
          else {
            d.remote = true;
            await this.api(cx, "/drafts", { method: "POST", body: { channel_id: d.channel_id, root_id: d.root_id, message: d.message, file_ids: d.file_ids ?? [], props: d.props ?? {}, priority: d.priority } });
          }
          // Every edit replaces the entry, so a different one means this request is already out of date.
          if (this.drafts.get(key) !== d) continue;
          if (empty) this.drafts.delete(key);
          else d.dirty = false;
          this.draftsTouched = true;
        }
      } catch {
        // It stays dirty, and the next load tries again.
      } finally {
        this.pushing.delete(key);
      }
    });
  }

  async loadDrafts(cx) {
    if (this.draftsSynced) {
      try {
        const list = await this.api(cx, `/users/me/teams/${this.team.id}/drafts`);
        const onServer = new Set(list.map(draftKey));
        for (const key of [...this.drafts.keys()]) if (!onServer.has(key)) this.dropDraft(key);
        for (const s of list) this.takeDraft(s);
        for (const [key, d] of this.drafts) if (d.dirty && !d.typing) this.pushDraft(key, cx);
      } catch {}
    }
    await this.ingestDrafts(cx);
  }

  // Text typed here and not yet saved outranks the server's, so nobody's typing gets replaced under them.
  takeDraft(s) {
    const key = draftKey(s), old = this.drafts.get(key);
    if (old?.dirty) {
      old.remote = true;
      return;
    }
    this.drafts.set(key, serverDraft(s));
    this.draftsTouched = true;
    this.fillBox(key, s.message);
  }

  dropDraft(key) {
    if (this.drafts.get(key)?.dirty) return;
    if (this.drafts.delete(key)) this.draftsTouched = true;
    this.fillBox(key, "");
  }

  fillBox(key, text) {
    const box = this.boxes.find((b) => b.key === key);
    if (box && box.shown !== text) this.fill(box, key, text);
  }

  clearDraft(key, cx, keepFiles = false) {
    const d = this.drafts.get(key);
    if (d?.remote || (keepFiles && d?.file_ids?.length)) {
      this.drafts.set(key, { ...d, message: "", file_ids: keepFiles ? d.file_ids : [], priority: undefined, typing: false, dirty: true, update_at: Date.now() });
      this.pushDraft(key, cx);
    } else this.drafts.delete(key);
    this.draftsTouched = true;
    this.fillBox(key, "");
  }

  // A post the server refuses goes back to being a draft, ahead of anything typed since.
  sendDraft(d, cx) {
    const key = draftKey(d);
    // A second Enter on a command the server doesn't know sends it as text, as its error says.
    const command = d.message.startsWith("/") && this.notCommand !== d.message;
    this.notCommand = null;
    this.error = null;
    // A command takes no files, so they stay in the draft for the next message.
    this.clearDraft(key, cx, command);
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        if (command) await this.runCommand(d, cx);
        else await this.api(cx, "/posts", { method: "POST", body: {
          channel_id: d.channel_id, root_id: d.root_id, message: d.message.trim(), file_ids: d.file_ids ?? [], props: d.props ?? {},
          ...(hasPriority(d.priority) ? { metadata: { priority: d.priority } } : {}),
        } });
      } catch (e) {
        const now = this.drafts.get(key), bound = this.boxes.some((b) => b.key === key);
        const message = now?.message ? `${d.message} ${now.message}` : d.message;
        this.drafts.set(key, { ...d, remote: Boolean(now?.remote || d.remote), message, typing: bound, dirty: true });
        this.draftsTouched = true;
        this.fillBox(key, message);
        this.pushDraft(key, cx);
        if (e?.id === NO_SUCH_COMMAND && message === d.message) this.notCommand = message;
        this.error = e?.text ?? String(e?.message ?? e);
        this.redraw(cx);
      }
    });
  }

  // Commands with a screen of their own in Mattermost open the matching one here; the rest are the server's.
  async runCommand(d, cx) {
    const c = this.channels.get(d.channel_id), space = d.message.indexOf(" ");
    const end = space < 0 ? d.message.length : space, name = d.message.slice(0, end).toLowerCase();
    const command = `${name} ${d.message.slice(end).trim()}`;
    const bare = d.message.trimEnd() === name;
    const newStatus = statusFromCommand(d.message);
    if (newStatus && this.statuses.get(this.me.id) === "ooo") return this.checkStatus(cx, newStatus);
    if (name === "/leave" && c) {
      if (d.root_id) return this.addEphemeral(d, "/leave is not supported in reply threads. Use it in the center channel instead.", cx);
      if (c.type === "P") return this.channelMenu(c, null, "leave");
      if (c.type === "D" || c.type === "G") {
        await this.api(cx, `/users/${this.me.id}/preferences`, { method: "PUT", body: [{ user_id: this.me.id, category: c.type === "D" ? "direct_channel_show" : "group_channel_show", name: c.type === "D" ? this.dmPeer(c) : c.id, value: "false" }] });
        return;
      }
    }
    if (c && bare && (name === "/header" || (name === "/purpose" && c.type !== "D" && c.type !== "G"))) {
      const field = name.slice(1);
      openOverlay({ mod: "mattermost", kind: "dialog", width: 640, height: 370, props: { demo: this.cfg?.demo, edit: { field, value: c[field] ?? "", channel: { id: c.id, type: c.type, name: c.name, display: this.channelName(c), header: c.header ?? "", purpose: c.purpose ?? "" } } } });
      return;
    }
    const res = await this.api(cx, "/commands/execute", { method: "POST", body: { command, channel_id: d.channel_id, team_id: this.team.id, root_id: d.root_id }, attempts: 1, timeout: COMMAND_TIMEOUT });
    // The demo has no websocket to bring the answer.
    if (this.cfg.demo && res.text) this.addEphemeral(d, res.text, cx);
    // The command has run by now, so failing to get there mustn't put it back in the box to run again.
    if (res.goto_location) await this.goTo(res.goto_location, cx).catch((e) => {
      this.error = String(e?.message ?? e);
      this.redraw(cx);
    });
  }

  follow(url, cx) {
    cx.spawn(async (cx) => this.goTo(url, cx));
  }

  // Mattermost's handleFormattedTextClick and its router: a link to a conversation on this server opens
  // here, and any other link, or a conversation the panel can't show, goes to `away` (the browser).
  // True when it opened here.
  async goTo(url, cx, away = openLink) {
    let sent = false;
    const out = (link) => { sent = true; away(link); };
    const path = serverPath(url, this.cfg?.url);
    const full = url.startsWith("/") ? `${this.cfg?.url ?? ""}${url}` : url;
    const [, team, kind, id] = (path !== null && CONVERSATION.exec(path)) || [];
    let ident = null;
    try { ident = id && decodeURIComponent(id).toLowerCase(); } catch {}
    if (!kind || (kind !== "threads" && !ident)) { out(full); return false; }
    if (this.solo) { toPanel({ action: "link", url: full }); return true; }
    try {
      if (!(await this.route(team.toLowerCase(), kind, ident, out, cx)) && !sent) out(full);
    } catch (e) {
      // Not there or not yours: the web app shows its error page, and the browser does as well.
      if (e?.status === 403 || e?.status === 404) out(full);
      else {
        this.error = e?.text ?? String(e?.message ?? e);
        this.redraw(cx);
      }
    }
    return !sent;
  }

  // False when the link is for the browser. A post out of reach goes to `away` from jump, at its own team.
  async route(teamName, kind, ident, away, cx) {
    const team = this.teams?.find((t) => t.name === teamName && !t.delete_at);
    if (!team || !this.me) return false;
    if (kind === "threads" && !ident) {
      if (team.id !== this.team.id) return false;
      this.openThreads(cx);
      return true;
    }
    if (kind === "pl" || kind === "threads") {
      const p = await this.api(cx, `/posts/${encodeURIComponent(ident)}`);
      await this.fetchExtraChannels(cx, [p]);
      if (kind === "pl") return this.jump(p, cx, { beside: true, away });
      if (!(await this.reachable(p, cx, away))) return false;
      this.openThreads(cx);
      await this.openThread(p.root_id || p.id, cx);
      return true;
    }
    const c = await this.conversation(team, kind, ident, cx);
    if (!c || !(await this.reveal(c, cx))) return false;
    await this.open(c.id, cx);
    return true;
  }

  // Mattermost's getPathFromIdentifier: after /channels/ a channel's name or id, a group's name or a pair
  // of user ids; after /messages/ @username, an email, a user id or a group's name. A direct message is
  // started if there's none yet, as the web app does.
  async conversation(team, kind, ident, cx) {
    const known = () => [...this.channels.values(), ...this.extraChannels.values()].find((c) => c.name === ident || c.id === ident);
    const direct = async (user) => user && this.api(cx, "/channels/direct", { method: "POST", body: [this.me.id, user.id] });
    const pair = /^([a-z0-9]{26})__([a-z0-9]{26})$/.exec(ident);
    if (kind === "messages") {
      if (ident.startsWith("@")) return direct(await this.api(cx, `/users/username/${encodeURIComponent(ident.slice(1))}`));
      if (ident.includes("@")) return direct(await this.api(cx, `/users/email/${encodeURIComponent(ident)}`));
      if (ident.length === 26) return direct(await this.api(cx, `/users/${ident}`));
      if (ident.length !== 40) return null;
    } else if (pair) {
      if (pair[1] !== this.me.id && pair[2] !== this.me.id) return null;
      return direct({ id: pair[1] === this.me.id ? pair[2] : pair[1] });
    }
    if (known()) return known();
    if (ident.length === 26) return this.api(cx, `/channels/${ident}`).catch((e) => (e?.status === 404 ? null : Promise.reject(e)))
      .then((c) => c ?? this.api(cx, `/teams/${team.id}/channels/name/${encodeURIComponent(ident)}?include_deleted=true`));
    return this.api(cx, `/teams/${team.id}/channels/name/${encodeURIComponent(ident)}?include_deleted=true`);
  }

  // `herdr-app do 'mattermost.open-link [--reply ID] URL'`, sent by the handler for mattermost:// links.
  // Herdr hands a mod only the command's name, so the address travels in it. Every copy on screen hears
  // it, and the first panel answers. With --reply the browser isn't a way out, since a redirect rule there
  // may be what sent the link: the answer goes to data/mattermost/links/ID and the handler decides.
  command(c, cx) {
    const [name, ...args] = c.trim().split(/\s+/);
    if (!this.lead()) return;
    if (name === "jira-open") return this.jira?.openFromNotification(args[0], args[1], cx);
    if (name !== "open-link") return;
    const reply = args[0] === "--reply" && LINK_ID.test(args[1] ?? "") ? args.splice(0, 2)[1] : null;
    const answer = (word) => reply && exec("sh", ["-c", 'mkdir -p "$1" && printf %s "$3" > "$1/.$2" && mv -f "$1/.$2" "$1/$2"', "sh", `${appHome()}/data/mattermost/links`, reply, word]).catch(() => {});
    answer("received");
    cx.spawn(async (cx) => {
      for (let i = 0; i < 40 && !(this.me && this.team); i++) await sleep(cx, 250);
      let opened = false;
      if (this.me && this.team && args.length === 1) opened = await this.goTo(args[0], cx, reply ? () => {} : openLink);
      else if (!reply && args.length === 1) openLink(args[0]);
      // Herdr's own command for this raises the window it is already running in.
      if (opened) exec("herdr-app", []).catch(() => {});
      await answer(opened ? "opened" : "declined");
    });
  }

  // The copy that answers commands and posts notifications, so several on screen act once.
  lead() {
    return [...OWNERS.values()].find((o) => !o.solo && !o.cfg?.demo) === this;
  }

  // Mattermost's web app rules for a desktop notification (sendDesktopNotification): none for your own or system
  // posts, while do not disturb or out of office, in a muted channel, or for the conversation you're looking at.
  // The channel's desktop setting, else yours, says whether every post or only mentions; direct messages always
  // count (the server lists a group message's members as mentioned). With collapsed threads, which the panel always
  // uses, a reply notifies only when it mentions you or is in a thread you follow with desktop_threads on.
  notifyPost(post, data) {
    if (!this.lead() || !this.me || post.user_id === this.me.id || isSystem(post) || isEphemeral(post)) return;
    if (["dnd", "ooo"].includes(this.statuses.get(this.me.id))) return;
    // A closed direct message isn't among the panel's channels; the event names it.
    const c = this.channels.get(post.channel_id)
      ?? { id: post.channel_id, type: data.channel_type, name: data.channel_name ?? "", display_name: data.channel_display_name ?? "", team_id: data.team_id ?? "" };
    if (this.muted(c)) return;
    const own = this.members.get(c.id)?.notify_props?.desktop;
    const level = own && own !== "default" ? own : this.me.notify_props?.desktop ?? "mention";
    if (level === "none") return;
    const ids = (key) => { try { return JSON.parse(data[key] ?? "[]") ?? []; } catch { return []; } };
    const mentioned = c.type === "D" || ids("mentions").includes(this.me.id);
    const reply = Boolean(post.root_id);
    const wanted = reply
      ? mentioned || (ids("followers").includes(this.me.id) && this.me.notify_props?.desktop_threads === "all")
      : mentioned || level === "all";
    if (!wanted) return;
    const reading = this.mainKind() === "chat";
    const looking = reply
      ? (this.mainKind() === "thread" && this.thread === post.root_id) || (reading && this.rhs === "thread" && this.rhsThread === post.root_id)
      : reading && this.selected === c.id;
    if (looking && appWindow().active) return;
    const author = this.authorName(post);
    const text = notificationText(post.message) || (postFileIds(post).length ? "sent an attachment" : "");
    notify({
      title: reply ? `Reply in ${this.channelName(c)}` : this.channelName(c) || data.channel_display_name || "Mattermost",
      body: c.type === "D" ? text : `${author}: ${text}`,
      icon: (!fromWebhook(post) && this.media.avatar(this.users.get(post.user_id))) || undefined,
      action: { name: `mattermost.open-link ${this.postLink(post.id, c.team_id || this.team.id)}` },
    });
  }

  addEphemeral(d, message, cx) {
    const post = { id: `ephemeral-${Date.now()}`, channel_id: d.channel_id, root_id: d.root_id, user_id: this.me.id, create_at: Date.now(), type: "system_ephemeral", message, props: {} };
    (d.root_id ? this.threadPosts.get(d.root_id) : this.posts.get(d.channel_id))?.push(post);
    this.redraw(cx);
  }

  // Leaves the Drafts page for the conversation, whose box then holds the draft.
  async editDraft(d, cx) {
    this.draftAsk = null;
    await this.open(d.channel_id, cx);
    if (d.root_id) this.openReply(d.root_id, cx);
  }

  async fetchThread(id, cx) {
    try {
      const page = await this.api(cx, `/posts/${id}/thread?collapsedThreads=true`);
      const posts = Object.values(page.posts).sort((a, b) => a.create_at - b.create_at);
      await this.ingest(cx, posts);
      remember(this.threadPosts, id, posts);
      const unknown = [...new Set(posts.map((p) => p.user_id))].filter((u) => !this.statuses.has(u) && this.authors.has(u));
      if (unknown.length) await this.loadStatuses(cx, unknown);
      await this.markThreadRead(cx, id);
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
  }

  async markThreadRead(cx, id) {
    for (const list of Object.values(this.threads)) {
      const th = list?.find((x) => x.id === id);
      if (th) Object.assign(th, { unread_replies: 0, unread_mentions: 0, last_viewed_at: Date.now() });
    }
    try {
      await this.api(cx, `/users/${this.me.id}/teams/${this.team.id}/threads/${id}/read/${Date.now()}`, { method: "PUT" });
    } catch (e) {
      // A thread you never replied to or followed has no membership, so there is no read state to move.
      if (e.status === 404) return;
      throw e;
    }
    await this.loadThreadTotals(cx);
  }

  // Reply opens the thread beside the channel, as Mattermost's right-hand side does.
  openReply(id, cx, aim = null) {
    // From the pinned messages, the back button returns to them.
    this.rhsFrom = this.rhs === "pinned" ? "pinned" : this.rhs === "thread" && this.rhsFrom === "pinned" ? "pinned" : null;
    this.rhs = "thread";
    this.rhsThread = id;
    this.rhsScroll.offset = 0;
    this.rhsScroll.heights.clear();
    this.redraw(cx);
    cx.spawn(async (cx) => {
      await this.fetchThread(id, cx);
      this.loadFollowing(cx, this.threadPosts.get(id)?.slice(0, 1) ?? []);
      if (aim) this.focusOn(aim, this.rhsScroll, cx);
      else this.redraw(cx);
      this.replyInput.focus();
    });
  }

  async onRequest(req, cx) {
    if (this.solo && (req.action === "open" || req.action === "threads")) return toPanel(req);
    if (req.action === "reply") this.openReply(req.post, cx);
    else if (req.action === "jump") await this.jump(req.post, cx);
    else if (req.action === "link") await this.goTo(req.url, cx);
    else if (req.action === "drafts") takeDrafts(this, req.changes, cx);
    else if (req.action === "threads") this.openThreads(cx);
    else if (req.action === "info" && this.rhs !== "info") this.openRhs("info", cx);
    else if (req.action === "edit") this.startEdit(req.post, req.scope, cx);
    else if (req.action === "agent") {
      const p = this.findAnyPost(req.post), agent = agentSpec();
      if (p && agent) this.sendToAgent(p, agent, cx);
    }
    else if (req.action === "insert-emoji") {
      const box = this.allBoxes().find((b) => b.name === req.box);
      if (box) { insertAtCaret(this, box, req.text); cx.notify(box.part); }
    }
    else if (req.action === "image") handleImageRequest(this, req, cx);
    else if (req.action === "jira-read-all") this.jira?.markAll(req.category, cx);
    else if (req.action === "status-dialog") await this.openStatusDialog(cx);
    else if (req.action === "profile-dialog") this.openProfile();
    else if (req.action === "dnd-dialog") this.openDndDialog();
    else if (req.action === "reset-status") await this.checkStatus(cx, req.newStatus);
    else if (req.action === "reset-status-answer") await answerReset(this, req, cx);
    else if (req.action === "logout") await this.logOut(cx);
    else if (req.action === "status") {
      this.statuses.set(this.me.id, req.status);
      this.dndEnd = req.dndEnd ?? 0;
      this.redraw(cx);
    } else if (req.action === "custom-status") {
      const u = this.users.get(this.me.id);
      if (u) u.custom = req.status ? customStatus(JSON.stringify(req.status)) : null;
      if (req.status) {
        await this.ensureEmoji(cx, req.status.emoji);
        this.recentStatuses = [req.status, ...this.recentStatuses.filter((s) => s.text !== req.status.text)].slice(0, 5);
      }
      this.redraw(cx);
    } else if (req.action === "recent-status-removed") {
      this.recentStatuses = this.recentStatuses.filter((s) => s.text !== req.status.text || s.emoji !== req.status.emoji);
    } else if (req.action === "profile") {
      if (req.patch.username && req.patch.username !== this.me.username) this.byUsername.delete(this.me.username.toLowerCase());
      this.me = { ...this.me, ...req.patch };
      this.addUser(this.me);
      if (req.picture) (this.media.demoPictures ??= new Map()).set(this.me.id, req.picture);
      this.keys.rebuild();
      this.mentionKeysChanged();
      this.redraw(cx);
    } else if (req.action === "relogin") {
      // The token was replaced in the login file. Closing the websocket makes it reconnect with the new one.
      this.cfg = await config();
      this.media.authed = null;
      await this.ws?.close().catch(() => {});
    }
    else if (req.action === "open") {
      // A conversation opened from a menu may be new to the sidebar.
      if (!this.channels.has(req.channel)) { await this.loadSidebar(cx); this.rows = null; }
      if (this.channels.has(req.channel)) await this.open(req.channel, cx);
    }
  }

  openLightbox(p, items, index) {
    const c = this.channels.get(p.channel_id);
    openOverlay({ mod: "mattermost", kind: "dialog", frame: "none", width: 1, height: 1, props: { demo: this.cfg?.demo, lightbox: {
      items, index, author: this.userName(p.user_id), avatar: this.media.avatar(this.users.get(p.user_id)), channel: c ? this.channelName(c) : "",
      publicLink: this.clientConfig?.EnablePublicLink === "true",
    } } });
  }

  // Attachments open outside the panel: Herdr has no video element, and other files need their own apps.
  openImageMenu(picture, at) {
    this.popupOpened(openImageMenu({ image: picture }, at));
  }

  openFile(f, cx) {
    if (this.fileState.get(f.id) === "Downloading…") return;
    this.fileState.set(f.id, "Downloading…");
    this.redraw(cx);
    cx.spawn(async (cx) => {
      const rel = await this.media.download(this.cfg, f, (ms) => sleep(cx, ms)).catch(() => null);
      if (rel) {
        this.fileState.delete(f.id);
        const path = `${appHome()}/${rel}`;
        await (/^(video|audio)\//.test(f.mime_type ?? "") ? playExternally(path) : openExternally(path)).catch(() => {});
      } else this.fileState.set(f.id, "Download failed");
      this.redraw(cx);
    });
  }

  playFileAnimation(f, cx) {
    if (this.playing?.key === f.id) return this.stopAnimation(cx);
    if (this.fileState.get(f.id) === "Downloading…") return;
    this.fileState.set(f.id, "Downloading…");
    this.redraw(cx);
    cx.spawn(async (cx) => {
      const rel = await this.media.download(this.cfg, f, (ms) => sleep(cx, ms)).catch(() => null);
      if (rel) {
        this.fileState.delete(f.id);
        await this.playAnimation(f.id, rel, cx);
      } else this.fileState.set(f.id, "Download failed");
      this.redraw(cx);
    });
  }

  playRemoteAnimation(key, rel, cx) {
    if (this.playing?.key === key) return this.stopAnimation(cx);
    cx.spawn(async (cx) => { await this.playAnimation(key, rel, cx); this.redraw(cx); });
  }

  stopAnimation(cx) {
    this.playing = null;
    this.redraw(cx);
  }

  // One at a time: each playing animation redraws the window on every frame.
  async playAnimation(key, rel, cx) {
    if (!this.animationCost.has(rel)) {
      const cost = (await this.media.animationBytes(rel)) ?? UNKNOWN_ANIMATION;
      const spent = [...this.animationCost.values()].reduce((a, b) => a + b, 0);
      if (spent + cost > ANIMATION_BUDGET) {
        await playExternally(`${appHome()}/${rel}`).catch(() => {});
        return;
      }
      this.animationCost.set(rel, cost);
    }
    this.playing = { key, rel };
  }

  gutter() {
    return POST_GUTTER;
  }

  // The room for an image in a post.
  contentWidth(scope) {
    // Pinned posts aren't in a timeline, so nothing measures them, but their panel has a known width.
    const sc = { c: this, t: this.threadScroll, r: this.rhsScroll, k: this.peekScroll }[scope];
    const room = sc?.viewW || (scope === "p" ? CONTEXT_W[this.mode()] ?? CONTEXT_W.m : 480);
    const g = this.gutter();
    return Math.max(120, Math.min(room, CONVERSATION_W) - g.col - g.pad - g.right);
  }

  // Mattermost edits in place, in the one spot it was asked from: the message becomes its editor until saved
  // or cancelled. Mattermost counts a reply, or a post in the right-hand side, as the RHS's editor, whose bar
  // has its own "edit" preference; a root post in the centre shares the message box's.
  startEdit(id, scope, cx) {
    const p = this.findAnyPost(id);
    if (!p) return;
    const box = this.editBox;
    const text = p.message ?? "";
    this.editing = id;
    this.editScope = scope ?? null;
    for (const f of p.metadata?.files ?? []) this.fileInfos.set(f.id, f);
    Object.assign(box, {
      key: `${EDIT_KEY}${id}`, channel: p.channel_id,
      fileIds: postFileIds(p), error: null, saving: false,
      before: text, now: text, empty: !text.trim(),
    });
    this.editInput.set_value(text);
    this.editInput.set_selected_range({ start: text.length, end: text.length });
    box.suggest.reset(text.length);
    this.redraw(cx);
    this.editInput.focus();
    cx.spawn(async (cx) => {
      await this.directory.loadRoles(cx, p.channel_id);
      cx.notify(box.part);
    });
  }

  isEditing(p, scope) {
    return this.editing === p.id && (!this.editScope || !scope || this.editScope === scope);
  }

  findAnyPost(id) {
    for (const list of [...this.posts.values(), ...this.threadPosts.values()]) {
      const p = list?.find((x) => x.id === id);
      if (p) return p;
    }
    return null;
  }

  cancelEdit(cx) {
    this.editing = null;
    this.editBox.key = null;
    this.editBox.suggest.reset();
    this.redraw(cx);
  }

  // Mattermost keeps the editor open until the server has taken the edit, shows its error in place, and
  // takes an edit left with neither text nor files as asking to delete the post.
  saveEdit(cx) {
    const box = this.editBox, id = this.editing;
    const p = this.findAnyPost(id);
    if (!p || box.saving || this.uploads.get(box.key)?.length) return;
    const message = this.editInput.value().trim(), file_ids = box.fileIds;
    if (!message && !file_ids.length) {
      this.deleteAsk = this.postMenu(p, null, { mode: "delete-post" });
      return;
    }
    const was = postFileIds(p);
    if (message === (p.message ?? "") && file_ids.length === was.length && file_ids.every((f, i) => f === was[i])) return this.cancelEdit(cx);
    box.saving = true;
    box.error = null;
    cx.spawn(async (cx) => {
      try {
        const post = await this.api(cx, `/posts/${id}/patch`, { method: "PUT", body: { id, message, file_ids } });
        Object.assign(p, post?.id ? post : {
          message, file_ids, edit_at: Date.now(),
          metadata: { ...p.metadata, files: file_ids.map((f) => this.fileInfos.get(f)).filter(Boolean) },
        });
        const shown = this.previews.get(p.channel_id);
        if (shown?.id === p.id) this.previews.set(p.channel_id, { ...shown, ...previewOf(p), at: shown.at });
        if (this.editing === id) this.cancelEdit(cx);
        else this.redraw(cx);
      } catch (e) {
        box.error = String(e?.text || e?.message || e);
        cx.notify(box.part);
      } finally {
        box.saving = false;
      }
    });
  }

  buildEditBox(t) {
    const box = this.editBox;
    const p = this.editing && this.findAnyPost(this.editing);
    if (!p) return div();
    // Mattermost takes the paperclip and the files' remove buttons away from those who can't edit attachments.
    const mayEditFiles = this.directory.can(p.channel_id, "edit_file_attachment");
    box.canAttach = mayEditFiles && canUpload(this.clientConfig);
    box.keepFiles = !mayEditFiles;
    box.files = box.fileIds.length;
    box.uploading = Boolean(this.uploads.get(box.key)?.length);
    const button = (id, label, primary, onClick) => div().id(id).h(32).px(16).flex().flex_none().items_center().rounded(4).cursor_pointer()
      .text_size(12).font_semibold()
      .bg(primary ? t.accent : alpha(t.accent, 0.08)).text_color(primary ? t.accent_foreground : t.accent)
      .hover((s) => s.bg(primary ? t.accent : alpha(t.accent, 0.12)))
      .on_click(onClick).child(label);
    const footer = [
      ...(this.editInput.value().includes("@") ? [h_flex().pt(6).gap(4).items_center().text_size(12).text_color(alpha(t.foreground, 0.75))
        .child(svg("mods/mattermost/icons/info.svg").size(12)).child("Editing this message with an '@mention' will not notify the recipient.")] : []),
      h_flex().my(8).gap(8).items_center().text_size(12).text_color(alpha(t.foreground, 0.75))
        .child(button("edit-save", "Save", true, (_e, cx) => this.saveEdit(cx)))
        .child(button("edit-cancel", "Cancel", false, (_e, cx) => this.cancelEdit(cx)))
        // Mattermost's hint is one run of text, so a narrow box wraps it word by word rather than cutting it off.
        .child(h_flex().flex_1().min_w(0).flex_wrap().items_center().gap_x(4)
          .children(["*ENTER", "to", "Save,", "*ESC", "to", "Cancel"].map((w) => div().when(w[0] === "*", (el) => el.font_bold()).child(w.replace("*", ""))))),
    ];
    return v_flex().on_key_down((e, cx) => { if (e.keystroke === "escape") this.cancelEdit(cx); })
      .child(composerView(this, box, t, { placeholder: "Edit the post...", error: box.error, files: filePreviews(this, box, t), footer }));
  }

  closeThread() {
    this.thread = null;
    this.resetScroll();
  }

  // Parsing a message is the costliest part of drawing it, and a render past Herdr's 50 ms is cut off,
  // so the messages about to be drawn are parsed before a redraw is asked for rather than during it.
  warm() {
    const warmAll = (posts) => { for (const p of posts ?? []) if (!isSystem(p)) this.parsed(p.id, p.message ?? "", p.edit_at > 0, this.keys.forPost(p)); };
    warmAll((this.shownPosts() ?? []).slice(-this.shown));
    if (this.thread) warmAll(this.threadPosts.get(this.thread));
    if (this.rhsThread) warmAll(this.threadPosts.get(this.rhsThread));
    if (this.peekId) warmAll(this.posts.get(this.peekId)?.slice(-WINDOW));
  }

  shownPosts() {
    return this.posts.get(this.selected);
  }

  // A channel is bottom-anchored, because GPUI's scroll areas start at the top and the newest
  // post belongs at the bottom; a thread reads from its first message down.
  // `sc` is the scroll state: the panel's own fields for the messages, rhsScroll for a thread beside them.
  scrollBy(dy, cx, sc = this, top = false) {
    const posts = this.shownPosts() ?? [];
    const max = Math.max(0, sc.contentH - sc.viewH);
    sc.offset = Math.min(max, Math.max(0, sc.offset + (top ? -dy : dy)));
    sc.aim = null;
    if (sc === this && this.offset >= max - 200) {
      if (this.shown < posts.length) this.shown += WINDOW;
      else if (dy > 0) this.loadOlder(cx);
    }
    if (sc === this && dy < 0 && this.offset <= 200) this.loadNewer(cx);
    // Only the messages move; the wheel handler's cx is the messages part's own.
    cx.notify();
  }

  loadOlder(cx) {
    const id = this.selected, posts = this.posts.get(id);
    if (!posts?.length || this.loadingOlder || this.exhausted.has(id)) return;
    this.loadingOlder = true;
    cx.spawn(async (cx) => {
      try {
        const page = await this.api(cx, `/channels/${id}/posts?per_page=${PAGE}&before=${posts[0].id}&collapsedThreads=true`);
        const older = page.order.map((pid) => page.posts[pid]).reverse();
        if (older.length < PAGE) this.exhausted.add(id);
        await this.ingest(cx, older);
        this.posts.set(id, [...older, ...this.posts.get(id)]);
        if (id === this.selected) this.shown += older.length;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loadingOlder = false;
      this.redraw(cx);
    });
  }

  applyReaction(r, added) {
    for (const p of this.copiesOf(r.post_id)) {
      p.metadata ??= {};
      const list = (p.metadata.reactions ?? []).filter((x) => !(x.user_id === r.user_id && x.emoji_name === r.emoji_name));
      p.metadata.reactions = added ? [...list, r] : list;
    }
  }

  toggleReaction(p, name, mine, cx) {
    const r = { user_id: this.me.id, post_id: p.id, emoji_name: name, channel_id: p.channel_id };
    this.applyReaction(r, !mine);
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        if (mine) await this.api(cx, `/users/${this.me.id}/posts/${p.id}/reactions/${encodeURIComponent(name)}`, { method: "DELETE" });
        else await this.api(cx, "/reactions", { method: "POST", body: { user_id: r.user_id, post_id: r.post_id, emoji_name: name } });
      } catch (e) {
        this.applyReaction(r, mine);
        this.error = String(e?.message ?? e);
        this.redraw(cx);
      }
    });
  }

  async markRead(cx, id) {
    const c = this.channels.get(id), m = this.members.get(id);
    if (m && c) Object.assign(m, { msg_count: c.total_msg_count, msg_count_root: c.total_msg_count_root, mention_count: 0, mention_count_root: 0, last_viewed_at: Date.now() });
    this.rows = null;
    await this.api(cx, "/channels/members/me/view", { method: "POST", body: { channel_id: id } });
  }

  send(box, cx) {
    if (this.uploads.get(box.key)?.length) return;
    this.noteDraft(box);
    const d = this.drafts.get(box.key);
    if (!d || draftEmpty(d)) return;
    // The new post wouldn't show among older ones, so sending goes back to the newest, as in Mattermost.
    if (this.detached === d.channel_id && !d.root_id) cx.spawn(async (cx) => this.open(d.channel_id, cx));
    this.sendDraft(d, cx);
  }

  connect(cx) {
    if (this.cfg.demo) {
      this.live = true;
      return;
    }
    const session = this.session;
    cx.spawn(async (cx) => {
      for (let delay = 2000; session === this.session; delay = Math.min(delay * 2, 60e3)) {
        try {
          this.ws = await timed(cx, WebSocket.connect(`${this.cfg.url.replace(/^http/, "ws")}/api/v4/websocket`));
          await this.ws.write(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token: this.cfg.token } }));
          for (;;) {
            const msg = await this.ws.read();
            if (typeof msg !== "string") continue;
            const ev = JSON.parse(msg);
            if (ev.event === "hello") {
              // Events missed while disconnected are gone; reload to catch up.
              if (!this.live && (delay > 2000 || !this.team)) await this.load(cx);
              this.live = true;
              this.wsError = null;
              this.bannerHidden = false;
              this.publishHeader();
              delay = 2000;
            }
            if (await this.onEvent(ev, cx)) {
              this.rows = null;
              this.redraw(cx);
            }
          }
        } catch (e) {
          this.wsError = String(e?.message ?? e);
        }
        this.live = false;
        this.publishHeader();
        this.redraw(cx);
        await sleep(cx, delay);
      }
    });
  }

  async onEvent(ev, cx) {
    const data = ev.data ?? {};
    const channelId = ev.broadcast?.channel_id || data.channel_id;
    switch (ev.event) {
      case "posted": {
        const post = JSON.parse(data.post);
        const c = this.channels.get(post.channel_id);
        if (!c) return this.loadSidebar(cx).then(() => { this.notifyPost(post, data); return true; });
        const root = !post.root_id;
        // The server leaves join and leave posts out of the message counts, so they never make a channel unread.
        const counted = !JOIN_LEAVE.has(post.type);
        c.last_post_at = post.create_at;
        if (counted) c.total_msg_count++;
        if (root) {
          c.last_root_post_at = post.create_at;
          if (counted) c.total_msg_count_root++;
        }
        await this.ingest(cx, [post]);
        if (root) {
          if (this.detached !== c.id) this.posts.get(c.id)?.push(post);
          if (!this.hiddenPost(post)) this.previews.set(c.id, { ...previewOf(post), stale: lastPost(c) });
        } else {
          const parent = this.posts.get(c.id)?.find((p) => p.id === post.root_id);
          if (parent) parent.reply_count = (parent.reply_count ?? 0) + 1;
          const thread = this.threadPosts.get(post.root_id);
          if (thread) {
            thread.push(post);
            if (thread[0]) thread[0].reply_count = (thread[0].reply_count ?? 0) + 1;
            const open = this.thread === post.root_id || (this.rhs === "thread" && this.rhsThread === post.root_id);
            if (open && post.user_id !== this.me.id) await this.markThreadRead(cx, post.root_id);
          }
        }
        const m = this.members.get(c.id);
        if (post.user_id === this.me.id || c.id === this.selected) {
          if (m) Object.assign(m, { msg_count: c.total_msg_count, msg_count_root: c.total_msg_count_root });
          if (c.id === this.selected && post.user_id !== this.me.id) await this.markRead(cx, c.id);
        } else if (m && root && (c.type === "D" || JSON.parse(data.mentions ?? "[]").includes(this.me.id))) {
          m.mention_count++;
          m.mention_count_root = (m.mention_count_root ?? 0) + 1;
        }
        this.notifyPost(post, data);
        return true;
      }
      case "ephemeral_message": {
        const post = JSON.parse(data.post);
        await this.ingest(cx, [post]);
        (post.root_id ? this.threadPosts.get(post.root_id) : this.posts.get(post.channel_id))?.push(post);
        return true;
      }
      case "post_edited": {
        const post = JSON.parse(data.post);
        for (const posts of [this.posts.get(post.channel_id), this.threadPosts.get(post.root_id || post.id)]) {
          const i = posts?.findIndex((p) => p.id === post.id) ?? -1;
          if (i >= 0) posts[i] = { ...posts[i], ...post };
        }
        const shown = this.previews.get(post.channel_id);
        if (shown?.id === post.id) this.previews.set(post.channel_id, { ...shown, ...previewOf(post) });
        return true;
      }
      case "post_deleted": {
        const post = JSON.parse(data.post);
        if (this.editing === post.id) this.cancelEdit(cx);
        const posts = this.posts.get(post.channel_id);
        if (posts) this.posts.set(post.channel_id, posts.filter((p) => p.id !== post.id));
        const thread = this.threadPosts.get(post.root_id);
        if (thread) this.threadPosts.set(post.root_id, thread.filter((p) => p.id !== post.id));
        if (this.previews.get(post.channel_id)?.id === post.id) {
          this.previews.delete(post.channel_id);
          this.wantedPreviews.add(post.channel_id);
        }
        return true;
      }
      case "reaction_added":
      case "reaction_removed": {
        const r = JSON.parse(data.reaction);
        await this.ensureEmoji(cx, r.emoji_name);
        await this.fetchUsers(cx, [r.user_id]);
        this.applyReaction(r, ev.event === "reaction_added");
        return true;
      }
      case "channel_viewed": {
        const c = this.channels.get(channelId), m = this.members.get(channelId);
        if (c && m) Object.assign(m, { msg_count: c.total_msg_count, msg_count_root: c.total_msg_count_root, mention_count: 0, mention_count_root: 0, last_viewed_at: Date.now() });
        return true;
      }
      case "multiple_channels_viewed":
        for (const id of Object.keys(data.channel_times ?? {})) await this.onEvent({ event: "channel_viewed", data: { channel_id: id } }, cx);
        return true;
      case "channel_member_updated": {
        const m = JSON.parse(data.channelMember ?? "null");
        if (m?.channel_id) this.members.set(m.channel_id, slimMember(m));
        return true;
      }
      case "thread_updated":
      case "thread_read_changed":
      case "thread_follow_changed":
        // Only a follow change says whether you follow; the others carry no state.
        if (ev.event === "thread_follow_changed") this.following.set(data.thread_id, Boolean(data.state));
        if (this.section === THREADS) await this.loadThreads(cx);
        else await this.loadThreadTotals(cx);
        return true;
      case "draft_created":
      case "draft_updated":
        this.takeDraft(JSON.parse(data.draft));
        return true;
      case "draft_deleted":
        this.dropDraft(draftKey(JSON.parse(data.draft)));
        return true;
      case "channel_created":
      case "direct_added":
      case "group_added":
      case "user_added":
      case "channel_updated":
      case "sidebar_category_updated": {
        // The event carries the categories as saved, which spares a full sidebar reload per click.
        const updated = JSON.parse(data.updatedCategories ?? "[]");
        if (!updated.length) await this.loadCategories(cx);
        for (const cat of updated) {
          const i = this.categories.findIndex((c) => c.id === cat.id);
          if (i >= 0) this.categories[i] = cat;
        }
        return true;
      }
      case "status_change":
        this.statuses.set(data.user_id, data.status);
        // The event doesn't say when do not disturb ends.
        if (data.user_id === this.me?.id) await this.loadStatuses(cx, [data.user_id]);
        return true;
      case "user_updated":
        if (data.user?.id) this.addUser(data.user);
        if (data.user?.id === this.me?.id) {
          this.me = { ...this.me, ...data.user, notify_props: Object.keys(data.user.notify_props ?? {}).length ? data.user.notify_props : this.me.notify_props };
          await this.loadMentionKeys(cx);
        }
        if (liveStatus(this.users.get(data.user?.id)?.custom)?.emoji) await this.ensureEmoji(cx, liveStatus(this.users.get(data.user.id).custom).emoji);
        return true;
      case "sidebar_category_created":
      case "sidebar_category_deleted":
      case "sidebar_category_order_updated":
        await this.loadCategories(cx);
        return true;
      case "preferences_changed":
      case "preferences_deleted": {
        const prefs = JSON.parse(data.preferences ?? "[]");
        const flagged = prefs.filter((x) => x.category === "flagged_post");
        for (const x of flagged) {
          if (ev.event === "preferences_changed" && x.value === "true") this.saved.add(x.name);
          else this.saved.delete(x.name);
        }
        if (flagged.length < prefs.length) await this.loadSidebar(cx);
        return true;
      }
      case "post_unread":
      case "user_removed":
        await this.loadSidebar(cx);
        return true;
    }
    return false;
  }

  // An overlay's `at` and the pointer's bounds are window pixels, but its width and height grow with the
  // app's zoom, so placement works with the zoomed size.
  zoom() {
    return Number(settings()?.zoom) || 1;
  }

  // Where a popup `height` window pixels tall goes next to an anchor: `prefer` side first, then the other, else as low
  // as the panel allows. The panel's bottom stands in for the window's, which a mod can't see.
  place(box, height, prefer) {
    const bottom = this.box ? this.box.y + this.box.height : Infinity;
    const below = box.y + box.height + 4, above = box.y - height - 4;
    const fitsBelow = below + height <= bottom, fitsAbove = above >= 4;
    if (prefer === "above" ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove) return fitsAbove ? above : Math.max(4, bottom - height);
    return fitsBelow ? below : Math.max(4, bottom - height);
  }

  // `box` is the anchor: the menu opens under it, or over it when the panel has no room below.
  openMenu(spec, box = null) {
    const menu = { ...spec, me: this.me.id, team: { id: this.team.id, name: this.team.name }, categories: this.categories, dmLimit: this.dmLimit ?? DM_LIMIT };
    const { width, height } = Menu.size(menu);
    const z = this.zoom();
    let at = null;
    if (box) {
      // Right-aligned menus keep their own card's right edge on the button's and open submenus leftward.
      const x = spec.alignRight ? box.x + box.width - width * z : box.x;
      const y = this.place(box, height * z, "below");
      at = { x: Math.max(4, x), y };
      menu.layout = { up: y < box.y, flip: Boolean(spec.alignRight) };
    }
    return this.popupOpened(openOverlay({ mod: "mattermost", kind: "popup", frame: "none", width, height, ...(at ? { at } : {}), props: { menu, demo: this.cfg?.demo } }));
  }

  // The popup closes in its own copy of the mod, which says so here: a post keeps its hover bar only
  // while its popup is open.
  popupOpened(id) {
    this.keepHover = this.hoverPost;
    setShared("mattermost.popup", id);
    return id;
  }

  openPicker(p, box) {
    const z = this.zoom();
    const room = this.box ? (this.box.height - 8) / z : PICKER_H;
    const height = Math.min(PICKER_H, room);
    this.popupOpened(openOverlay({
      mod: "mattermost", kind: "popup", frame: "none", width: PICKER_W, height,
      at: box ? { x: Math.max(4, box.x + box.width - PICKER_W * z), y: this.place(box, height * z, "above") } : "pointer",
      props: { demo: this.cfg?.demo, picker: { post: p.id, me: this.me.id, team: this.team.name, height } },
    }));
  }

  postLink(id, teamId = this.team.id) {
    return `${this.cfg.url}/${(this.teams?.find((x) => x.id === teamId) ?? this.team).name}/pl/${id}`;
  }

  // The agent gets the first message on its command line, so it can't be lost while it boots. Later ones
  // are typed in only once it has finished the turn before, as a person would.
  sendToAgent(p, agent, cx) {
    const link = this.postLink(p.id, this.channelOf(p.channel_id)?.team_id || this.team.id);
    const [first, ...rest] = agent.messages.map((m) => m.replaceAll("{link}", link));
    const name = `mm-${p.id.slice(0, 12)}`;
    const json = async (args) => {
      const r = await hc([args[0], "--json", ...args.slice(1)]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `hc ${args[0]} failed`);
      return JSON.parse(r.stdout);
    };
    if (agent.chat) return this.sendToChat(p, agent, first ? [first, ...rest] : [link], cx);
    cx.spawn(async (cx) => {
      try {
        // A second click on the same post goes to the agent it already started.
        const old = await json(["get", name]).catch(() => null);
        if (old?.state === "live") return command("agent.focus", { terminal: old.address });
        const t = await json(["run", "--bg", "--no-parent", "--name", name, "--cwd", agent.folder, "--", ...agent.argv, ...(first ? [first] : [])]);
        // Herdr hears of a new terminal from the core a moment after hc does, and can't give it a tab before.
        for (let i = 0; i < 50 && !terminals().some((x) => x.address === t.address); i++) await sleep(cx, 100);
        // terminal.keep makes its tab in the space on screen.
        const space = agentSpace(agent.folder);
        if (space) command("space.select", { id: space.id });
        else command("space.new", { name: agent.folder.split("/").pop(), folder: agent.folder });
        command("terminal.keep", { terminal: t.address, place: "tab" });
        let turn = first ? 1 : 0;
        const until = Date.now() + AGENT_PATIENCE;
        for (const text of rest) {
          for (;;) {
            if (Date.now() > until) return;
            const w = await json(["wait", t.address, "--timeout", "20"]);
            // `ended` only says the wait ended. Blocked means a dialog is up, and typing would answer it.
            if (w.exit_code != null || w.signal != null || w.status === "blocked") return;
            if ((w.status === "done" || w.status === "idle") && w.turn >= turn) break;
          }
          await json(["send", t.address, text]);
          turn++;
        }
      } catch (e) {
        this.showError(`${agent.label}: ${String(e?.message ?? e)}`, cx);
      }
    });
  }

  toggleSave(p, cx) {
    const saved = this.saved.has(p.id);
    if (saved) this.saved.delete(p.id);
    else this.saved.add(p.id);
    this.redraw(cx);
    const pref = [{ user_id: this.me.id, category: "flagged_post", name: p.id, value: "true" }];
    cx.spawn(async (cx) => {
      try {
        if (saved) await this.api(cx, `/users/${this.me.id}/preferences/delete`, { method: "POST", body: pref });
        else await this.api(cx, `/users/${this.me.id}/preferences`, { method: "PUT", body: pref });
        this.redraw(cx);
      } catch (e) {
        if (saved) this.saved.add(p.id);
        else this.saved.delete(p.id);
        this.error = String(e?.message ?? e);
        this.redraw(cx);
      }
    });
  }

  postMenu(p, box, { scope = null, mode = undefined } = {}) {
    return this.openMenu({
      kind: "post", alignRight: true, scope, mode,
      post: pick(p, ["id", "root_id", "channel_id", "message", "is_pinned", "user_id"]),
      saved: this.saved.has(p.id),
      following: this.following.get(p.root_id || p.id),
      link: this.postLink(p.id, this.channelOf(p.channel_id)?.team_id || this.team.id),
      own: p.user_id === this.me.id,
      agent: agentSpec()?.label ?? null,
    }, box);
  }

  // The post under the pointer, tracked in script: its action bar, add-reaction button and last-reply
  // time all show on hover, and GPUI has no group hover to reveal them natively. Every move over the panel
  // decides it afresh, so a leave event that never came can't leave a bar behind. A post whose popup is
  // open keeps its bar until the pointer reaches another post.
  setHover(key, cx) {
    if (key === this.hoverPost) return;
    if (!key && this.keepHover && this.keepHover === this.hoverPost && shared("mattermost.popup")) return;
    this.hoverPost = key;
    this.keepHover = null;
    cx.notify(this.mainPart);
  }

  categoryOf(channelId) {
    return this.categories.find((c) => c.channel_ids.includes(channelId));
  }

  link(c) {
    const base = `${this.cfg.url}/${this.team.name}`;
    if (c.type === "D") return `${base}/messages/@${this.users.get(this.dmPeer(c))?.username ?? ""}`;
    if (c.type === "G") return `${base}/messages/${c.name}`;
    return `${base}/channels/${c.name}`;
  }

  // A layer over the row that shows on hover: the row's own hover can't reach a child, and
  // tracking the pointer in script would redraw the whole panel on every row crossed.
  // An invisible layer over the whole row, so hovering anywhere on it shows ⋮; tracking the pointer
  // in script instead would redraw the panel on every row crossed.
  hoverDots(id, t, onClick, bg) {
    return h_flex().absolute().inset_0().justify_end().opacity(0).hover((s) => s.opacity(1))
      .child(h_flex().id(id).w(30).h_full().pr(8).justify_end().items_center().bg(bg).text_color(t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); onClick(e, cx); })
        .child(svg("mods/mattermost/icons/dots.svg").size(14)));
  }

  // The frame lays out the columns, which depend on the width; the list and the reader are retained parts, so an
  // event in one of them redraws it without the other. Herdr re-renders this root on every live-data change, so
  // what it draws itself (the rail) stays small.
  render(cx) {
    if (this.popup) return this.popup.render(cx);
    const t = theme();
    // Requests are seen here but handled from a timer: render can't create state such as the edit box.
    const req = shared(requestKey());
    if (req?.id && req.id !== this.seenRequest) {
      this.seenRequest = req.id;
      cx.timer.after(0, (cx) => cx.spawn(async (cx) => this.onRequest(req, cx)));
    }
    // The question takes the keyboard, and a "no" leaves the edit where it was.
    if (this.deleteAsk && shared("mattermost.popup") !== this.deleteAsk) {
      this.deleteAsk = null;
      cx.timer.after(0, () => { if (this.editing) this.editInput.focus(); });
    }
    return h_flex().id("root").size_full().font_family(FONT).text_color(t.foreground).text_size(13)
      // The panel's place in the window, for placing popups; stored only, so moving the pointer redraws nothing.
      .on_mouse_move((e, cx) => {
        if (e.bounds) this.box = e.bounds;
        const on = this.moveOn ?? null;
        this.moveOn = null;
        this.setHover(on, cx);
      })
      .on_hover((on, cx) => { if (!on) this.setHover(null, cx); })
      .when(!this.solo, (el) => el.on_key_down((e, cx) => {
        if (this.jira?.onKey(e, cx)) return;
        if (isExpandKey(e.keystroke)) rhsExpandKey(this, cx);
      }))
      .when(this.frame, (el) => el.rounded(10).overflow_hidden().bg(t.background).border_1()
        .border_color(this.typing ? t.accent : t.border).track_focus(this.focus).focus((s) => s.border_color(t.accent))
        // A press that reaches the frame focuses the panel, as a pane takes the keyboard when clicked;
        // text boxes stop their presses so they keep it, and a message box that has the keyboard keeps it,
        // as in Mattermost. The press stops here: the block around the panel takes the keyboard on a press
        // that reaches it, which blinked the panel's border off until the click gave it back.
        .on_mouse_down("left", (_e, cx) => {
          if (!this.typing) this.focus.focus();
          cx.stop_propagation();
        }))
      // A layout block paints its own rounded background, and nothing here can clip to its corners.
      .when(!this.frame && this.solo, (el) => el.bg(t.background))
      .on_size_change((size, cx) => {
        this.width = size.width;
        this.height = size.height;
        const shape = this.shape();
        if (shape !== this.layoutShape) {
          this.layoutShape = shape;
          this.redraw(cx);
        }
      })
      .when(Boolean(this.setup), (el) => el.child(this.setupView(t)))
      .when(!this.setup && this.solo, (el) => el.child(this.mainPart))
      .when(!this.setup && !this.solo, (el) => el.child(this.columns(t)));
  }

  // Widths here are layout units, the mock's pixels; sizes arrive in window pixels.
  units() {
    return (this.width || 1000) / this.zoom();
  }

  mode() {
    return modeOf(this.units());
  }

  // What decides the columns, so a resize that changes none of it redraws nothing.
  shape() {
    const w = this.units(), mode = modeOf(w);
    return `${mode}:${listWidth(mode, w)}:${contextBeside(mode, w)}:${Math.round((this.height || 0) / this.zoom() / 50)}`;
  }

  sections() {
    return SECTIONS.filter(([key]) => key !== "jira" || this.jira);
  }

  // A section's count on its tab: mentions and unread threads in red, which want you; Jira's Direct and drafts in blue.
  sectionBadge(key) {
    if (key === "chats") {
      let mentions = 0, dot = false;
      for (const c of this.channels.values()) {
        const u = this.unread(c);
        mentions += u.mentions ?? 0;
        if (u.count > 0) dot = true;
      }
      return { count: mentions, red: true, dot };
    }
    if (key === "threads") return { count: this.threadTotals.total_unread_threads ?? 0, red: true };
    if (key === "jira") return { count: this.jira?.counts().direct ?? 0, red: false };
    if (key === "drafts") return { count: this.filedDrafts().length, red: false };
    return { count: 0, red: false };
  }

  showSection(key, cx) {
    if (key === "jira" && !this.jira) return;
    if (key !== this.section) this.rhsExpanded = false;
    this.section = key;
    this.opening = null;
    localStorage.setItem("section", key);
    if (key === "threads") cx.spawn(async (cx) => this.loadThreads(cx));
    if (key === "drafts") {
      this.draftAsk = null;
      if (!this.selectedDraft()) this.draftSel = this.filedDrafts()[0] ? draftKey(this.filedDrafts()[0]) : null;
      cx.spawn(async (cx) => { await this.ingestDrafts(cx); this.redraw(cx); });
    }
    if (key === "jira") this.jira.open(cx);
    if (key === "find") this.find.focus();
    if (key === "chats" && this.selected) this.input.focus();
    this.redraw(cx);
  }

  // Herdr sizes the block, not the panel, so the panel finds the layout block it sits in. In a tab there's none.
  unfold(key, cx) {
    this.showSection(key, cx);
    const find = (node) => node?.content?.mod === "mattermost" ? node : (node?.children ?? []).map(find).find(Boolean);
    const block = find(layout());
    if (block?.id) command("layout.resize", { id: block.id, px: UNFOLD_W });
  }

  columns(t) {
    const mode = this.mode(), w = this.units();
    if (mode === "r") return foldedRail(this, t);
    const banner = !this.live && this.wsError && !this.bannerHidden
      ? [h_flex().h(26).flex_none().px(11).gap(8).items_center().bg(alpha(AMBER, 0.14)).text_size(12).text_color(AMBER)
        .child(svg("mods/mattermost/icons/info.svg").size(13).flex_none())
        .child(div().flex_1().min_w(0).truncate().child("Reconnecting. What you see may be out of date."))
        .child(div().id("banner-hide").flex_none().font_semibold().cursor_pointer().hover((s) => s.underline())
          .on_click((_e, cx) => { this.bannerHidden = true; cx.notify(); }).child("Dismiss"))]
      : [];
    if (mode === "n") {
      const z = this.zoom(), h = (this.height || 900) / z;
      const most = Math.max(110, h - 300);
      return v_flex().size_full().children(banner)
        .child(v_resizable("mm-stack").flex_1().min_h(0).w_full()
          .child(resizable_panel().size(Math.min(460, most) * z).size_range(110 * z, most * z).child(this.sidePart))
          .child(resizable_panel().child(this.mainPart)));
    }
    return v_flex().size_full().children(banner)
      .child(h_flex().flex_1().min_h(0).w_full()
        .when(mode === "f", (el) => el.child(rail(this, t)))
        .child(div().w(listWidth(mode, w)).flex_none().h_full().border_r_1().border_color(t.border).child(this.sidePart))
        .child(div().flex_1().min_w(0).h_full().child(this.mainPart)));
  }

  setupView(t) {
    const s = this.setup;
    const link = (id, label, url) => h_flex().child(div().id(id).cursor_pointer().text_color(t.accent).hover((st) => st.underline())
      .on_click(() => exec("xdg-open", [url])).child(label));
    const field = (id, label, input, ...hint) => v_flex().gap(4)
      .child(div().text_size(12).text_color(t.muted).child(label))
      .child(div().id(id).on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); input.focus(); })
        .child(Input.new(input).h(34).px(10).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(13)))
      .child(v_flex().gap(2).text_size(12).text_color(t.muted).children(hint));
    const form = s.step === "team"
      ? v_flex().gap(8)
        .child(div().text_size(12).text_color(t.muted).child(`Your account is in ${s.teams.length} teams. Which one should the panel show?`))
        .children(s.teams.map((team) => h_flex().id(`team-${team.id}`).h(36).px(12).gap(8).items_center().rounded(6).cursor_pointer()
          .border_1().border_color(t.border).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => cx.spawn(async (cx) => this.saveLogin({ url: s.url, token: s.token, team }, cx)))
          .child(div().flex_1().truncate().child(team.display_name)).child(div().text_color(t.dim).child(team.name))))
        .child(h_flex().pt(4).child(button("setup-back", t, "Back", (_e, cx) => { this.setup = { step: "login" }; cx.notify(); })))
      : v_flex().gap(13)
        .child(field("setup-url", "Server URL", this.urlInput, "The address you open Mattermost at in a browser."))
        .child(field("setup-token", "Personal access token", this.tokenInput,
          "In Mattermost: Profile → Security → Personal Access Tokens → Create Token.", link("setup-docs", "How to create one", TOKEN_DOCS)))
        .child(h_flex().pt(2).child(button("setup-connect", t, s.busy ? "Connecting…" : "Connect", (_e, cx) => cx.spawn(async (cx) => this.connectLogin(cx)), { primary: true })))
        .child(div().text_size(12).text_color(t.muted).child("No Personal Access Tokens section? An admin has to turn them on in System Console → Integrations → Integration Management and allow your account to create them."))
        .child(div().text_size(12).text_color(t.dim).child(`Saved to ${loginPath().replace(home(), "~")}, readable only by you.`));
    return v_flex().id("setup").size_full().overflow_y_scrollbar().items_center().p(20)
      .child(v_flex().w_full().max_w(380).my_auto().gap(16)
        .child(h_flex().gap(10).items_center()
          .child(image("mods/mattermost/icons/logo.svg").size(24))
          .child(div().text_size(18).line_height("24px").font_semibold().child("Connect to Mattermost")))
        .child(form)
        .when(Boolean(s.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(s.error))));
  }

  mainKind() {
    if (this.solo) return null;
    if (this.section === "threads") return this.thread ? "thread" : "threads";
    if (this.section === "drafts") return "drafts";
    if (this.section === "jira") return this.jira ? "jira" : null;
    if (this.section === "me") return "me";
    return this.selected && this.channels.has(this.selected) ? "chat" : null;
  }

  // A render cut off at the time limit leaves a part on its last good frame until something notifies
  // it, and a part is notified far less often than the root; the timer retries parts left unfinished.
  // Rows cost about a millisecond each, more while the script is cold or collecting garbage, so a render
  // that runs long leaves the furthest rows out and asks for another; a few short ones in a row and the
  // next builds everything, so a slow machine can't loop.
  renderPart(part, cx) {
    this.unfinished.add(part);
    if (this.suggesters[part]) {
      const list = this.suggesters[part].list(theme());
      this.unfinished.delete(part);
      return list;
    }
    const box = this.allBoxes().find((b) => b.part === this.parts[part]);
    if (box) {
      const el = box.edit ? this.buildEditBox(theme()) : this.buildComposer(theme(), box);
      this.unfinished.delete(part);
      return el;
    }
    this.renderStart = Date.now();
    this.shortened = false;
    this.rowBudget = (this.shortRuns ?? 0) < 4;
    const el = this.buildPart(part);
    this.unfinished.delete(part);
    this.shortRuns = this.shortened ? (this.shortRuns ?? 0) + 1 : 0;
    if (this.shortened) cx.timer.after(16, (cx) => cx.notify());
    return el;
  }

  buildPart(part) {
    const t = theme();
    if (this.solo) return v_flex().size_full().bg(t.background).child(this.rhs ? this.rhsView(t, this.channels.get(this.selected), true) : div());
    const mode = this.mode();
    if (part === "side") {
      // In medium the list ends at the panel's bottom corner, where a square row highlight would show past the rounding.
      return v_flex().size_full().when(mode === "m", (el) => el.pb(10))
        .when(mode !== "f", (el) => el.child(sectionTabs(this, t, mode)))
        .child(this.sectionList(t, mode));
    }
    return this.reader(t, mode);
  }

  sectionList(t, mode) {
    const titled = (title, list) => v_flex().flex_1().min_h(0).when(mode === "f", (el) => el.child(header(t, title))).child(list);
    if (this.section === "find") return this.find.render(t);
    if (this.section === "threads") return this.threadsList(t);
    if (this.section === "jira" && this.jira) return this.jira.list(t, mode);
    if (this.section === "drafts") return titled("Drafts", draftsList(this, t));
    if (this.section === "me") return titled("You", meList(this, t));
    return this.chatsList(t);
  }

  reader(t, mode) {
    const kind = this.mainKind();
    if (kind === "chat") return this.chat(t, mode);
    let reader, context = null;
    if (kind === "thread") {
      reader = this.threadView(t);
      const root = this.threadPosts.get(this.thread)?.[0];
      if (mode === "f" && root) context = this.peek(t, root.channel_id);
    } else if (kind === "threads") {
      reader = this.threads[this.threadTab]?.length === 0 ? empty(t, "check", "No followed threads", "Replies to threads you follow will show here.") : nothingPicked(t);
    } else if (kind === "drafts") {
      reader = draftReader(this, t);
      const d = this.selectedDraft();
      if (mode === "f" && d) context = this.peek(t, d.channel_id);
    } else if (kind === "jira") reader = this.jira.reader(t, mode);
    else if (kind === "me") reader = meReader(this, t);
    else if (this.error && !this.channels.size) reader = empty(t, "circle-alert", "Couldn't load", this.error);
    else reader = this.channels.size ? nothingPicked(t) : div();
    return h_flex().size_full()
      .child(v_flex().flex_1().min_w(0).h_full().child(reader))
      .when(Boolean(context), (el) => el.child(v_flex().w(CONTEXT_W.f).flex_none().h_full().border_l_1().border_color(t.border).child(context)));
  }

  // Chats: the folder strip over the conversations. All Chats is every one, newest first; a folder is a sidebar
  // category, in its own order.
  chatsList(t) {
    const cats = this.sidebar();
    const unreadIn = (chans) => chans.filter((c) => !this.muted(c) && this.unread(c).count > 0).length;
    const everyone = [...new Map(cats.flatMap(({ chans }) => chans.map((c) => [c.id, c]))).values()];
    const tabs = [{ key: "all", label: "All Chats", short: "All", count: unreadIn(everyone) },
      ...cats.map(({ cat, chans }) => ({
        key: cat.id, label: cat.display_name, count: unreadIn(chans),
        menu: (e) => this.openMenu({ kind: "category", cat, unreadIds: chans.filter((c) => this.unread(c).count > 0 || this.unread(c).mentions > 0).map((c) => c.id) },
          e.bounds ?? { ...e.position, width: 0, height: 0 }),
      }))];
    const folder = tabs.some((x) => x.key === this.chatFolder) ? this.chatFolder : "all";
    const list = folder === "all" ? everyone.sort((a, b) => lastPost(b) - lastPost(a)) : cats.find(({ cat }) => cat.id === folder).chans;
    const mutedCats = new Set(cats.filter(({ cat }) => cat.muted).flatMap(({ chans }) => chans.map((c) => c.id)));
    return v_flex().flex_1().min_h(0)
      .child(strip(this, t, { id: "chats", tabs, current: folder, stretch: true, onPick: (key, cx) => {
        this.chatFolder = key;
        localStorage.setItem("folder", key);
        cx.notify(this.sidePart);
      } }))
      .when(Boolean(this.error) && !this.channels.size, (el) => el.child(div().p(12).text_size(12).text_color(t.blocked).child(this.error)))
      .child(list.length ? scrollList(`chats-${folder}`, list.map((c) => this.chatRow(c, t, mutedCats.has(c.id))))
        : this.channels.size ? empty(t, "check", "No chats in this folder") : div().flex_1());
  }

  chatRow(c, t, catMuted) {
    const { count, mentions } = this.unread(c);
    const sel = this.section === "chats" && c.id === (this.opening ?? this.selected);
    const menu = () => this.channelMenu(c);
    return listRow({
      id: `ch-${c.id}`, icon: this.chatIcon(c, t), title: this.channelName(c), time: shortTime(lastPost(c)), preview: this.channelPreview(c),
      unread: count > 0, badge: mentions, dot: count > 0, muted: catMuted || this.muted(c), selected: sel,
      onClick: (_e, cx) => cx.spawn(async (cx) => this.open(c.id, cx)), onMenu: menu,
      extra: [this.hoverDots(`chm-${c.id}`, t, menu, sel ? t.selected : t.hover)],
    }, t);
  }

  chatIcon(c, t) {
    if (c.type === "D") {
      const peer = this.dmPeer(c);
      return this.withStatus(peer, this.avatar(peer, 36, t), 36, 15, 11, 23, t);
    }
    const others = c.type === "G" ? this.gmMembers.get(c.id)?.filter((id) => id !== this.me?.id) : null;
    if (others) return div().size(36).flex_none().rounded_full().bg(alpha(t.foreground, 0.08)).flex().items_center().justify_center().text_size(13).font_semibold().text_color(t.muted).child(String(others.length));
    return iconTile(c.type === "P" ? "lock" : c.type === "G" ? "users" : "globe", t);
  }

  lastActivity(c) {
    return lastPost(c);
  }

  // The newest root post as a line of text: what's loaded when the conversation is, else a small fetch for the rows
  // drawn. A live post replaces it directly.
  channelPreview(c) {
    const posts = this.posts.get(c.id);
    const latest = posts && [...posts].reverse().find((p) => !p.root_id && !this.hiddenPost(p) && !isEphemeral(p));
    let hit = this.previews.get(c.id);
    if (latest && latest.create_at >= (hit?.at ?? 0)) hit = previewOf(latest);
    else if (!hit || hit.stale < lastPost(c)) this.wantedPreviews.add(c.id);
    if (!hit?.at) return "";
    const text = this.preview(hit.text ?? "") || (hit.files ? "sent an attachment" : "");
    if (hit.system) return text;
    const who = hit.user === this.me?.id ? "You" : c.type === "D" ? null : this.userName(hit.user).split(" ")[0];
    return who ? `${who}: ${text}` : text;
  }

  async loadPeek(id, cx) {
    this.peekLoad = null;
    try {
      const page = await this.api(cx, `/channels/${id}/posts?per_page=${PAGE}&collapsedThreads=true`);
      const fetched = page.order.map((pid) => page.posts[pid]).reverse();
      await this.ingest(cx, fetched);
      if (!this.posts.has(id)) remember(this.posts, id, fetched);
    } catch {}
    this.peeking = false;
    this.redraw(cx);
  }

  async fetchPreviews(cx) {
    this.fetchingPreviews = true;
    const ids = [...this.wantedPreviews].slice(0, 4);
    for (const id of ids) this.wantedPreviews.delete(id);
    try {
      await Promise.all(ids.map(async (id) => {
        const c = this.channels.get(id);
        if (!c) return;
        const stale = lastPost(c);
        try {
          const page = await this.api(cx, `/channels/${id}/posts?per_page=5&collapsedThreads=true`, { attempts: 1 });
          const p = page.order.map((pid) => page.posts[pid]).find((x) => !x.root_id && !this.hiddenPost(x));
          if (p) await this.fetchUsers(cx, [p.user_id]).catch(() => {});
          this.previews.set(id, p ? { ...previewOf(p), stale } : { at: 0, stale });
        } catch {
          this.previews.set(id, { ...(this.previews.get(id) ?? { at: 0 }), stale });
        }
      }));
    } finally {
      this.fetchingPreviews = false;
    }
    cx.notify(this.sidePart);
  }

  threadsList(t) {
    const list = this.threads[this.threadTab];
    const unreadCount = this.threadTotals.total_unread_threads ?? 0;
    const right = this.confirmMarkAll
      ? [div().text_size(12).text_color(t.muted).child("Mark all read?"),
        button("mark-all-no", t, "Cancel", (_e, cx) => { this.confirmMarkAll = false; this.redraw(cx); }),
        button("mark-all-yes", t, "Mark read", (_e, cx) => this.markAllRead(cx), { primary: true })]
      : [barButton("mark-all", t, "mark-read", "Mark all threads as read", (_e, cx) => { this.confirmMarkAll = true; this.redraw(cx); })];
    const empties = this.threadTab === "unread" ? ["No unread threads", "You're all caught up."] : ["No followed threads", "Threads you start, reply to or follow will show here."];
    return v_flex().flex_1().min_h(0)
      .child(strip(this, t, { id: "threads", current: this.threadTab, right,
        tabs: [{ key: "all", label: "Followed threads" }, { key: "unread", label: "Unreads", count: unreadCount }],
        onPick: (key, cx) => {
          this.threadTab = key;
          this.confirmMarkAll = false;
          this.redraw(cx);
          cx.spawn(async (cx) => this.loadThreads(cx));
        } }))
      .when(Boolean(this.error), (el) => el.child(div().px(12).py(6).text_size(12).text_color(t.blocked).child(this.error)))
      .child(!list ? div().flex_1() : !list.length ? empty(t, "check", ...empties) : scrollList(`threads-${this.threadTab}`, list.map((th) => this.threadRow(th, t))));
  }

  threadRow(th, t) {
    const p = th.post, c = this.channels.get(p.channel_id);
    const unread = th.unread_replies > 0;
    const menu = () => this.openMenu({
      kind: "thread", saved: this.saved.has(th.id), link: this.postLink(th.id),
      thread: { id: th.id, channel_id: p.channel_id, unread, following: th.is_following !== false },
    });
    const sel = this.thread === th.id;
    const icon = fromWebhook(p) ? this.postAvatar(p, 36, t) : this.withStatus(p.user_id, this.postAvatar(p, 36, t), 36, 15, 11, 23, t);
    return listRow({
      id: `th-${th.id}`, icon, title: c ? this.channelName(c) : this.authorName(p), time: shortTime(th.last_reply_at || p.create_at),
      preview: `${this.authorName(p).split(" ")[0]}: ${this.preview(p.message || "")}`, unread, badge: th.unread_mentions, dot: unread, selected: sel,
      onClick: (_e, cx) => cx.spawn(async (cx) => this.openThread(th.id, cx)), onMenu: menu,
      extra: [this.hoverDots(`thm-${th.id}`, t, menu, sel ? t.selected : t.hover)],
    }, t);
  }

  draftKeyOf(d) {
    return draftKey(d);
  }

  selectedDraft() {
    return this.filedDrafts().find((d) => draftKey(d) === this.draftSel) ?? null;
  }

  selectDraft(key, cx) {
    this.draftSel = key;
    this.draftAsk = null;
    this.redraw(cx);
  }

  // A conversation shown for context beside what's read in full width: its posts without marking it read, and no box.
  peek(t, id) {
    const c = this.channels.get(id);
    if (!c) return null;
    const posts = this.posts.get(id);
    if (this.peekId !== id) {
      this.peekId = id;
      this.peekScroll = scrollState();
    }
    if (!posts && !this.peeking) {
      this.peeking = true;
      this.peekLoad = id;
    }
    return v_flex().size_full()
      .child(header(t, this.channelGlyph(c, t), div().min_w(0).truncate().child(this.channelName(c)), div().flex_1(),
        barButton("peek-open", t, "external-link", "Open in Chats", (_e, cx) => cx.spawn(async (cx) => this.open(id, cx)))))
      .child(posts ? this.timeline(`peek-${id}`, this.channelRows(c, posts, t, WINDOW, "k"), t, false, this.peekScroll) : div().flex_1());
  }

  channelGlyph(c, t) {
    if (c.type === "D") {
      const peer = this.dmPeer(c);
      return this.withStatus(peer, this.avatar(peer, 20, t), 20, 11, 8, 12, t);
    }
    return svg(`mods/mattermost/icons/${c.type === "P" ? "lock" : c.type === "G" ? "users" : "globe"}.svg`).size(14).flex_none().text_color(t.muted);
  }

  // A layer over the row that shows ⋮ on hover: the row's own hover can't reach a child, and tracking the pointer in
  // script would redraw the list on every row crossed.
  hoverDots(id, t, onClick, bg) {
    return h_flex().absolute().inset_0().justify_end().opacity(0).hover((s) => s.opacity(1))
      .child(h_flex().id(id).w(34).h_full().pr(10).justify_end().items_center().bg(bg).text_color(t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); onClick(e, cx); })
        .child(svg("mods/mattermost/icons/dots.svg").size(14)));
  }

  myCustomStatus() {
    return this.me ? liveStatus(this.users.get(this.me.id)?.custom) : null;
  }

  statusUntil(custom) {
    return until(custom);
  }

  // As Mattermost's getSecondaryLabel words it.
  dndNote() {
    const end = this.dndEnd;
    if (!end) return "Until indefinitely";
    const when = new Date(end * 1000), time = clock(when.getTime());
    const days = Math.round((new Date(when).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400e3);
    if (days === 0) return `Until ${time}`;
    if (days === 1) return `Until tomorrow ${time}`;
    return `Until ${MONTHS[when.getMonth()]} ${when.getDate()}, ${when.getFullYear()} ${time}`;
  }

  dndPresets() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const at = (ms) => Math.floor(ms / 1000);
    return [["Don't clear", 0], ["30 mins", at(Date.now() + 30 * 60e3)], ["1 hour", at(Date.now() + 3600e3)], ["2 hours", at(Date.now() + 2 * 3600e3)], ["Tomorrow", at(tomorrow.getTime())]];
  }

  // Out of office with no "Do not ask me again" on file, Mattermost confirms any status change first.
  setMyStatus(status, dndEnd, cx) {
    if (this.autoResetPref === "" && this.statuses.get(this.me.id) === "ooo") return cx.spawn(async (cx) => this.checkStatus(cx, status));
    cx.spawn(async (cx) => {
      try {
        await this.api(cx, `/users/${this.me.id}/status`, { method: "PUT", body: { user_id: this.me.id, status, ...(status === "dnd" ? { dnd_end_time: dndEnd } : {}) } });
        this.statuses.set(this.me.id, status);
        this.dndEnd = status === "dnd" ? dndEnd : 0;
      } catch (e) {
        this.error = e?.text ?? String(e?.message ?? e);
      }
      this.redraw(cx);
    });
  }

  clearCustomStatus(cx) {
    cx.spawn(async (cx) => {
      try {
        await this.api(cx, "/users/me/status/custom", { method: "DELETE" });
        const u = this.users.get(this.me.id);
        if (u) u.custom = null;
      } catch (e) {
        this.error = e?.text ?? String(e?.message ?? e);
      }
      this.redraw(cx);
    });
  }

  // Mattermost's status icons and its dark themes' colors; offline is the same in every theme.
  statusMark(status, size = 10) {
    const [icon, color] = STATUS[status] ?? ["offline", "#afb3c0bf"];
    return svg(`mods/mattermost/icons/status-${icon}.svg`).size(size).flex_none().text_color(color);
  }

  // An avatar with its status ring cut out of the background; bots, System among them, have no presence.
  withStatus(id, avatar, size, ring, icon, at, t) {
    return div().relative().size(size).flex_none().child(avatar)
      .when(!this.users.get(id)?.is_bot, (el) => el.child(div().absolute().left(at).top(at).size(ring).flex().items_center().justify_center()
        .rounded_full().bg(t.background).child(this.statusMark(this.statuses.get(id), icon))));
  }

  statusEmoji(id, custom, size, t) {
    return div().id(id).flex_none()
      .on_mouse_move((e) => this.showStatus(custom, e.bounds ?? { ...e.position, width: 0, height: 0 }))
      .on_hover((hovered) => { if (!hovered) this.hideStatus(); })
      .child(custom.emoji ? this.emojiEl(this.emojiToken(custom.emoji), size, t) : div());
  }

  // Herdr's tooltip takes only text, so the custom status card, with its large emoji, is a popup of its own.
  showStatus(custom, box) {
    if (this.statusCard) return;
    const { path, char } = this.emojiImage(custom.emoji);
    // Text can't be measured from here, so the popup is a generous transparent box and the card sizes
    // itself inside it, pinned to the side facing the emoji.
    const lines = [custom.text, until(custom)].filter(Boolean).reduce((n, l) => n + Math.ceil([...l].length / 24), 0);
    const width = 260, height = 16 + 42 + lines * 18 + 24;
    const z = this.zoom();
    const above = box.y - height * z - 6 >= 0;
    this.statusCard = openOverlay({
      mod: "mattermost", kind: "popup", frame: "none", width, height,
      at: { x: Math.max(4, box.x + box.width / 2 - (width * z) / 2), y: above ? box.y - height * z - 6 : box.y + box.height + 6 },
      props: { statusCard: { image: path, char, text: custom.text, until: until(custom), above } },
    });
  }

  hideStatus() {
    if (!this.statusCard) return;
    closeOverlay(this.statusCard);
    this.statusCard = null;
  }

  channelMenu(c, box = null, mode = null) {
    const { count, mentions } = this.unread(c);
    this.openMenu({
      kind: box ? "header" : "channel",
      mode,
      channel: { id: c.id, type: c.type, name: c.name, display: this.channelName(c), header: c.header ?? "", purpose: c.purpose ?? "" },
      cat: this.categoryOf(c.id) ?? this.categories[0],
      muted: this.muted(c),
      unread: count > 0 || mentions > 0,
      link: this.link(c),
      peer: c.type === "D" ? this.dmPeer(c) : null,
    }, box);
  }

  // Each box is a part of its own, notified by its own events and by every redraw.
  composer(_t, input = this.input) {
    return this.boxes.find((b) => b.input === input).part;
  }

  buildComposer(t, box) {
    const d = this.drafts.get(box.key);
    box.files = d?.file_ids?.length ?? 0;
    box.uploading = Boolean(this.uploads.get(box.key)?.length);
    box.canAttach = canUpload(this.clientConfig);
    const c = this.channels.get(this.boxChannel(box));
    return composerView(this, box, t, {
      placeholder: box.thread || !c ? "Reply to this thread..." : `Write to ${this.channelName(c)}`,
      error: this.error,
      files: filePreviews(this, box, t),
      boxed: this.section === "drafts" && !this.solo,
    });
  }

  boxChannel(box) {
    if (box.edit) return box.channel;
    return this.drafts.get(box.key)?.channel_id ?? (box.thread ? this.threadPosts.get(box.key)?.[0]?.channel_id : box.key);
  }

  showError(text, cx) {
    this.error = text;
    this.redraw(cx);
  }

  composerChanged(key, cx) {
    for (const box of this.allBoxes()) if (box.key === key) cx.notify(box.part);
    pruneLocal(this);
  }

  fileIdsOf(key) {
    return key === this.editBox.key ? this.editBox.fileIds : this.drafts.get(key)?.file_ids ?? [];
  }

  // An upload that finishes after its edit was closed has no post to join, and must not become a draft.
  attachFile(key, channel_id, root_id, id, cx) {
    if (key?.startsWith(EDIT_KEY)) {
      if (key === this.editBox.key) this.editBox.fileIds = [...this.editBox.fileIds, id];
      return this.composerChanged(key, cx);
    }
    const d = this.drafts.get(key);
    const bound = this.boxes.some((b) => b.key === key);
    this.drafts.set(key, { message: "", ...d, channel_id, root_id, file_ids: [...(d?.file_ids ?? []), id], typing: d ? d.typing : bound, dirty: true, update_at: Date.now() });
    this.draftsTouched = true;
    this.composerChanged(key, cx);
  }

  // Taking a file off leaves it on the server, as Mattermost does; the post simply doesn't claim it.
  detachFile(key, id, cx) {
    if (key === this.editBox.key) {
      this.editBox.fileIds = this.editBox.fileIds.filter((x) => x !== id);
      return this.composerChanged(key, cx);
    }
    const d = this.drafts.get(key);
    if (!d) return;
    const next = { ...d, file_ids: (d.file_ids ?? []).filter((x) => x !== id), dirty: true, update_at: Date.now() };
    if (draftEmpty(next) && !d.remote) this.drafts.delete(key);
    else this.drafts.set(key, next);
    this.draftsTouched = true;
    this.composerChanged(key, cx);
  }

  // A draft from the web app names its files by id only, so their names are asked for once, after the render.
  fileInfo(id) {
    if (!this.fileInfos.has(id)) {
      this.fileInfos.set(id, null);
      this.wantedInfos.add(id);
    }
    return this.fileInfos.get(id);
  }

  async loadFileInfos(cx) {
    const ids = [...this.wantedInfos];
    this.wantedInfos.clear();
    if (this.cfg?.demo) return;
    for (const id of ids) {
      try { this.fileInfos.set(id, await this.api(cx, `/files/${id}/info`)); } catch {}
    }
    this.redraw(cx);
  }

  sendBox(box, cx) {
    box.input.focus();
    box.suggest.submit(null, cx, (cx) => this.send(box, cx));
  }

  // The picker inserts at the caret, which the box keeps while the picker has the keyboard.
  openComposerPicker(box) {
    if (!this.me) return;
    const z = this.zoom(), b = box.pickerAt ?? this.box;
    const room = this.box ? (this.box.height - 8) / z : PICKER_H;
    const height = Math.min(PICKER_H, room);
    this.popupOpened(openOverlay({
      mod: "mattermost", kind: "popup", frame: "none", width: PICKER_W, height,
      at: b ? { x: Math.max(4, b.x + b.width - PICKER_W * z), y: this.place(b, height * z, "above") } : "pointer",
      props: { demo: this.cfg?.demo, picker: { insert: box.name, me: this.me.id, team: this.team.name, height } },
    }));
  }

  // Rows are [key, build]. Every row scrolled past stays in the timeline, and building them all made
  // renders slow enough to be interrupted, so rows away from the screen are spacers of their last
  // measured height (or EST_ROW before their first draw), walked from the anchored edge. Sizes arrive in
  // window pixels and spacers are drawn in layout units: left unconverted, a row leaving the screen became a
  // taller spacer, and the view jumped against the wheel.
  timeline(key, rows, t, top, sc = this) {
    const view = sc.viewH || 1000;
    if (sc.aim) this.aimAt(sc, top ? rows : [...rows].reverse(), view);
    // Each row built costs about a millisecond, so little beyond the view is: scrolling renders again anyway.
    const near = (from, h) => from + h > sc.offset - view / 4 && from < sc.offset + 1.25 * view;
    const out = [];
    let from = 0, gap = 0, built = 0;
    for (const [rowKey, build] of top ? rows : [...rows].reverse()) {
      const h = sc.heights.get(rowKey) ?? EST_ROW;
      if (!near(from, h)) gap += h;
      else if (built && this.rowBudget && Date.now() - this.renderStart > ROW_BUDGET) {
        gap += h;
        this.shortened = true;
      } else {
        built++;
        if (gap) out.push(div().h(gap).flex_none());
        gap = 0;
        out.push(div().id(`row-${rowKey}`).on_size_change((size) => { sc.heights.set(rowKey, size.height / this.zoom()); }).child(build()));
      }
      from += h;
    }
    if (gap) out.push(div().h(gap).flex_none());
    // A conversation wider than its column is centered in it.
    const inset = Math.max(0, ((sc.viewW || 0) - CONVERSATION_W) / 2);
    const content = v_flex().id(`content-${key}`).absolute().left(inset).right(inset).pb(8)
      .on_size_change((size) => { sc.contentH = size.height / this.zoom(); })
      .children(top ? out : out.reverse());
    return div().id(`viewport-${key}`).relative().flex_1().min_h(0).overflow_hidden()
      .on_size_change((size, cx) => {
        // Images are sized from the width, so they have to be drawn again. Known heights stay: a drawn row
        // whose size didn't change never reports it again, and would fall back to the estimate.
        const width = size.width / this.zoom();
        const resized = width !== sc.viewW;
        sc.viewW = width;
        sc.viewH = size.height / this.zoom();
        if (resized) cx.notify(this.mainPart);
      })
      .on_scroll_wheel((e, cx) => this.scrollBy(e.delta.y, cx, sc, top))
      .child(top ? content.top(-sc.offset) : content.bottom(-sc.offset));
  }

  // Centers the row `sc.aim` names. Rows out of view keep their height from one render to the next, so this
  // adds up to the same place as the walk in timeline.
  aimAt(sc, rows, view) {
    let total = 0, center = null;
    for (const [rowKey] of rows) {
      const h = sc.heights.get(rowKey) ?? EST_ROW;
      if (rowKey === sc.aim || rowKey.startsWith(`${sc.aim}-`)) center = total + h / 2;
      total += h;
    }
    if (center !== null) sc.offset = Math.max(0, Math.min(total - view, center - view / 2));
  }

  separator(label, t) {
    const line = () => div().h(1).flex_1().bg(alpha(t.foreground, 0.12));
    return h_flex().pt(8).h(26).items_center()
      .child(line()).child(div().px(13).h(18).flex().items_center().text_size(13).font_bold().text_color(t.foreground).child(label)).child(line());
  }

  // Webhook posts show the name and icon they were sent with, as Mattermost does, not the account that posted them.
  authorName(p) {
    return (fromWebhook(p) && p.props.override_username) || (isEphemeral(p) ? "System" : this.userName(p.user_id));
  }

  isBot(p) {
    return fromWebhook(p) || isEphemeral(p) || p.props?.from_bot === "true" || Boolean(this.users.get(p.user_id)?.is_bot);
  }

  authorKey(p) {
    return fromWebhook(p) ? `hook:${p.props.override_username ?? ""}:${p.props.override_icon_url ?? ""}` : isEphemeral(p) ? "system" : p.user_id;
  }

  postAvatar(p, size, t) {
    if (isEphemeral(p) && !fromWebhook(p)) return image("mods/mattermost/icons/logo.svg").size(size).flex_none();
    if (fromWebhook(p) && p.props.override_icon_url) {
      const path = this.media.external(p.props.override_icon_url);
      if (path) return image(path).size(size).flex_none().rounded_full();
    }
    if (fromWebhook(p) && p.props.override_username) {
      return div().size(size).flex_none().rounded_full().bg(alpha(t.foreground, 0.08)).flex().items_center().justify_center()
        .text_size(Math.round(size * 0.4)).text_color(t.muted).child(p.props.override_username.slice(0, 2).toUpperCase());
    }
    return this.avatar(p.user_id, size, t);
  }

  grouped(p, prev) {
    return Boolean(prev) && !isSystem(prev) && !isSystem(p) && this.authorKey(prev) === this.authorKey(p) && p.create_at - prev.create_at < GROUP_GAP;
  }

  // Posts about you being added or removed stay, as in Mattermost.
  hiddenPost(p) {
    const me = this.me?.username;
    return !this.showJoinLeave && JOIN_LEAVE.has(p.type) && p.props?.addedUsername !== me && p.props?.removedUsername !== me;
  }

  channelRows(c, all, t, limit = this.shown, scope = "c") {
    const posts = this.showJoinLeave ? all : all.filter((p) => !this.hiddenPost(p));
    const rows = [];
    const from = Math.max(0, posts.length - limit);
    if (this.exhausted.has(c.id) && from === 0) rows.push(["start", () => div().px(this.gutter().pad).pt(10).text_size(12).text_color(t.dim).child("Start of channel")]);
    for (let i = from; i < posts.length; i++) {
      const p = posts[i], prev = posts[i - 1];
      const next = posts[i + 1];
      const newDay = !prev || day(prev.create_at) !== day(p.create_at);
      const beforeDate = Boolean(next) && day(next.create_at) !== day(p.create_at);
      const grouped = !newDay && this.grouped(p, prev);
      const date = newDay ? dateLabel(p.create_at) : null;
      rows.push([`${p.id}-${grouped}-${newDay}-${beforeDate}`, () => this.postRow(p, grouped, t, false, { date, beforeDate, scope })]);
    }
    return rows;
  }

  // Whether a thread or the details sit beside the conversation; otherwise they take its place, with a way back.
  rhsBeside() {
    return contextBeside(this.mode(), this.units());
  }

  rhsCovers() {
    return this.rhs && !this.rhsBeside();
  }

  // Mattermost's expanded panel lies over the messages at min(60vw, 960px), or 750px on a smaller screen.
  rhsExpandedW() {
    const w = this.units(), mode = this.mode();
    const reader = w - listWidth(mode, w) - (mode === "f" ? 220 : 0);
    return Math.min(w * 0.6, w >= RHS_WIDE_SCREEN ? 960 : 750, reader);
  }

  // The full panel keeps the details open beside a conversation, closable only once something else was asked for.
  chat(t, mode) {
    const c = this.channels.get(this.selected);
    const kind = this.rhs ?? (mode === "f" ? "info" : null);
    if (kind && !this.rhsBeside()) return this.rhsView(t, c, true);
    const messages = v_flex().flex_1().min_w(0).h_full()
      .child(this.channelHeader(t, c, kind))
      .child(this.posts.get(c.id) ? this.timeline(c.id, this.channelRows(c, this.posts.get(c.id), t), t, false) : div().flex_1())
      .when(this.detached === c.id, (el) => el.child(h_flex().h(32).flex_none().px(14).gap(8).items_center().border_t(1).border_color(t.border).text_size(12).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().child("Viewing message history"))
        .child(div().id("to-recents").flex_none().font_semibold().cursor_pointer().text_color(t.accent).hover((s) => s.underline())
          .on_click((_e, cx) => cx.spawn(async (cx) => this.open(c.id, cx))).child("Jump to recents"))))
      .child(this.composer(t));
    if (!kind) return messages;
    if (this.rhsExpanded && this.rhs) {
      return h_flex().relative().size_full()
        .child(messages)
        // Without the stops, a press or the wheel here would also act on the messages under it.
        .child(div().absolute().top(0).bottom(0).right(0).w(this.rhsExpandedW()).border_l(1).border_color(t.border).bg(t.background).shadow_lg()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_scroll_wheel((_e, cx) => cx.stop_propagation())
          .child(this.rhsView(t, c, false, kind)));
    }
    return h_flex().size_full()
      .child(messages)
      .child(v_flex().w(CONTEXT_W[mode] ?? CONTEXT_W.m).flex_none().h_full().border_l_1().border_color(t.border).child(this.rhsView(t, c, false, kind)));
  }

  // herdr-chat's own tab instead of a terminal: its `chat` mod takes the messages as a prop and sends them once,
  // each after the turn before.
  sendToChat(p, agent, prompt, cx) {
    const chat = chatId(p.id);
    cx.spawn(async (cx) => {
      // The chat's agent runs in a hidden pane of the chat's tab, labelled with the chat.
      const host = terminals().find((x) => x.state === "live" && x.labels?.["herdr-chat.chat"] === chat);
      const tab = host && panes().find((x) => x.terminal === host.address)?.tab;
      if (tab) {
        const space = spaces().find((s) => s.tabs?.some((x) => x.id === tab));
        if (space) command("space.select", { id: space.id });
        return command("tab.select", { id: tab });
      }
      let space = agentSpace(agent.folder);
      if (space) command("space.select", { id: space.id });
      else {
        command("space.new", { name: agent.folder.split("/").pop(), folder: agent.folder });
        for (let i = 0; i < 30 && !(space = agentSpace(agent.folder)); i++) await sleep(cx, 100);
      }
      command("tab.new", { name: agent.chat, ...(space ? { space: space.id } : {}), mod: "chat", props: { chat, provider: agent.chat, cwd: agent.folder, prompt } });
    });
  }

  backButton(id, t, tip, onClick) {
    return this.headerButton(id, t, false, tip, onClick, svg("mods/mattermost/icons/chevron-left.svg").size(16));
  }

  headerButton(id, t, on, tip, onClick, ...children) {
    return h_flex().id(id).min_w(26).h(26).px(4).gap(4).flex_none().items_center().justify_center().rounded(5).cursor_pointer()
      .text_size(11).font_normal().text_color(on ? t.accent : t.muted)
      .hover((s) => s.bg(t.hover).text_color(on ? t.accent : t.foreground))
      .tooltip(tip).on_click(onClick).children(children);
  }

  // The conversation's name opens its menu; the buttons open the details beside it on their tab.
  channelHeader(t, c, open) {
    const stats = this.stats.get(c.id);
    const custom = c.type === "D" ? liveStatus(this.users.get(this.dmPeer(c))?.custom) : null;
    const icon = (name) => svg(`mods/mattermost/icons/${name}.svg`).size(15);
    const tool = (kind, name, count, tip) => this.headerButton(`hd-${kind}`, t, open === kind, tip, (_e, cx) => this.openRhs(kind, cx),
      icon(name), ...(count != null ? [div().child(String(count))] : []));
    return h_flex().h(38).flex_none().px(11).gap(8).items_center().border_b_1().border_color(t.border)
      .child(h_flex().id("hd-name").min_w(0).h(28).px(4).ml(-4).gap(8).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (e) => this.channelMenu(c, e.bounds ?? { ...e.position, width: 0, height: 0 }))
        .child(this.channelGlyph(c, t))
        .child(div().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(this.channelName(c)))
        .child(svg("mods/mattermost/icons/chevron-down.svg").size(12).flex_none().text_color(t.muted)))
      // Only the emoji opens the status card, as in Mattermost; the text beside it already says it.
      .when(Boolean(custom), (el) => el.child(h_flex().min_w(0).gap(6).items_center().text_size(12).text_color(t.muted)
        .when(Boolean(custom.emoji), (el) => el.child(this.statusEmoji("hd-status", custom, 14, t)))
        .child(div().min_w(0).truncate().child(custom.text))))
      .child(div().flex_1())
      .child(h_flex().flex_none().gap(2).items_center()
        .when(c.type !== "D", (el) => el.child(tool("members", "users", stats?.member_count, "Members")))
        // Mattermost leaves the pin out until something is pinned; the details still list Pinned messages.
        .when(stats?.pinnedpost_count > 0, (el) => el.child(tool("pinned", "pin", stats.pinnedpost_count, "Pinned messages")))
        .child(tool("files", "file-doc", null, "Files"))
        .child(tool("info", "info", null, "Details")));
  }

  // A thread or the conversation's details, beside the messages or in their place. Info, Members, Pinned and Files
  // are tabs of one panel. `kind` is what shows when nothing was asked for, the full panel's details.
  rhsView(t, c, replacing, kind = this.rhs) {
    const thread = kind === "thread" ? this.threadPosts.get(this.rhsThread) : null;
    if (kind === "thread") c = this.channelOf(thread?.[0]?.channel_id) ?? c;
    const asked = Boolean(this.rhs);
    const close = (_e, cx) => { this.rhs = null; this.rhsFrom = null; this.redraw(cx); };
    const back = this.rhsFrom ? (_e, cx) => {
      this.rhs = this.rhsFrom;
      this.rhsFrom = null;
      this.redraw(cx);
      this.loadRhs(cx);
    } : replacing && !this.solo ? close : null;
    // A floating popped-out copy moves by any press that isn't stopped, and its header is what's left for that.
    const stopPress = (_e, cx) => cx.stop_propagation();
    const tab = (k, label) => div().id(`rhs-tab-${k}`).px(9).h(26).flex().flex_none().items_center().rounded(5).cursor_pointer().text_size(12)
      .text_color(kind === k ? t.foreground : t.muted).when(kind === k, (el) => el.bg(alpha(t.foreground, 0.08))).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { if (this.rhs !== k) this.openRhs(k, cx); })
      .child(label);
    const details = kind !== "thread";
    const buttons = asked || this.solo ? rhsButtons(this, t, c, thread, kind) : [];
    return v_flex().h_full().min_h(0).when(replacing, (el) => el.flex_1().min_w(0)).when(!replacing, (el) => el.size_full())
      .when(this.rhsExpanded, (el) => el.on_mouse_down_out((e, cx) => shrinkOnPress(this, e, cx)))
      .child(h_flex().h(38).flex_none().pl(back ? 6 : 11).pr(8).gap(8).items_center().border_b_1().border_color(t.border)
        .when(Boolean(back), (el) => el.child(this.backButton("rhs-back", t, BACK_TIPS[this.rhsFrom] ?? "Back", back)))
        .child(div().flex_none().text_size(14).font_semibold().child(details ? (c?.type === "D" ? "Person details" : "Channel details") : "Thread"))
        // Mattermost's thread header takes you to the thread's root post in its channel.
        .when(kind === "thread" && Boolean(thread?.length), (el) => el.child(div().id("rhs-channel").min_w(0).h(24).px(6).flex().items_center().rounded(4).cursor_pointer()
          .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => cx.spawn(async (cx) => this.jump(thread[0], cx)))
          .child(div().min_w(0).truncate().child(this.channelName(c)))))
        .child(div().flex_1())
        .child(h_flex().flex_none().gap(2).items_center().children(buttons)))
      .when(details && !this.solo, (el) => el.child(h_flex().flex_none().px(7).py(4).gap(2).border_b_1().border_color(t.border)
        .child(tab("info", "Info"))
        .when(c?.type !== "D", (el) => el.child(tab("members", "Members")))
        .child(tab("pinned", "Pinned"))
        .child(tab("files", "Files"))))
      .child(v_flex().flex_1().min_h(0).when(this.solo, (el) => el.on_mouse_down("left", stopPress))
        .when(kind === "thread", (el) => el
          .child(thread?.length ? this.timeline(`rhs-${this.rhsThread}`, this.threadRows(thread, t, "r", Infinity), t, false, this.rhsScroll) : div().flex_1())
          .child(this.composer(t, this.replyInput)))
        .when(details && Boolean(c), (el) => el.child(v_flex().id(`rhs-${kind}`).flex_1().min_h(0).overflow_y_scrollbar().pb(8).children(this.rhsBody(t, c, kind)))));
  }

  followButton(p, following, t, id) {
    return div().id(id).h(24).px(8).flex().flex_none().items_center().rounded(4).cursor_pointer().text_size(12).font_semibold()
      .text_color(following ? t.accent : t.muted).when(following, (d) => d.bg(alpha(t.accent, 0.08)))
      .hover((s) => s.bg(alpha(following ? t.accent : t.foreground, 0.12)))
      .on_click((_e, cx) => this.toggleFollow(p, cx))
      .child(following ? "Following" : "Follow");
  }

  rhsBody(t, c, kind = this.rhs) {
    const stats = this.stats.get(c.id);
    const note = (text) => [div().p(16).text_size(13).text_color(t.dim).child(text)];
    const heading = (text) => div().px(16).pt(14).pb(6).text_size(11).font_semibold().text_color(t.dim).child(text.toUpperCase());
    if (kind === "info") {
      const favorite = this.categoryOf(c.id)?.type === "favorites", muted = this.muted(c);
      const tile = (id, icon, label, on, onClick) => v_flex().id(`info-${id}`).flex_1().h(66).gap(6).items_center().justify_center().rounded(4).cursor_pointer()
        .bg(on ? alpha(t.accent, 0.08) : alpha(t.foreground, 0.08)).text_color(on ? t.accent : t.foreground)
        .hover((s) => s.bg(on ? alpha(t.accent, 0.12) : alpha(t.foreground, 0.12))).on_click(onClick)
        .child(svg(`mods/mattermost/icons/${icon}.svg`).size(20)).child(div().text_size(12).font_semibold().child(label));
      const section = (title) => div().pt(16).pb(4).text_size(12).font_bold().text_color(alpha(t.foreground, 0.75)).child(title.toUpperCase());
      const md = (id, text) => TextView.markdown(id, prepare(text, this.text)).selectable(true)
        .on_link_click((url, cx) => this.follow(url, cx));
      // Mattermost shows a pencil while the pointer is over the field; an empty field is itself the way to add one.
      const editable = (field) => {
        const pencil = this.editHover === field ? [svg("mods/mattermost/icons/pencil.svg").size(14).flex_none().mt(3).text_color(t.muted)] : [];
        const hover = (hovered, cx) => {
          const next = hovered ? field : this.editHover === field ? null : this.editHover;
          if (next !== this.editHover) { this.editHover = next; cx.notify(); }
        };
        if (!c[field]) {
          return h_flex().id(`info-${field}`).gap(6).items_start().cursor_pointer().text_color(t.muted).on_hover(hover)
            .on_click(() => this.editChannel(c, field)).child(div().child(`Add a channel ${field}`)).children(pencil);
        }
        return h_flex().id(`info-${field}`).gap(6).items_start().on_hover(hover)
          .child(div().flex_1().min_w(0).child(md(`info-${field}-${c.id}`, c[field])))
          .children(pencil.map((p) => div().id(`info-${field}-edit`).cursor_pointer().on_click(() => this.editChannel(c, field)).child(p)));
      };
      const row = (kind, icon, label, count) => h_flex().id(`info-${kind}`).h(40).px(20).gap(12).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.openRhs(kind, cx, "info"))
        .child(svg(`mods/mattermost/icons/${icon}.svg`).size(16).text_color(t.muted)).child(div().flex_1().text_size(14).child(label))
        .child(div().text_size(12).text_color(t.muted).child(count == null ? "" : String(count)))
        .child(svg("mods/mattermost/icons/chevron-right.svg").size(14).text_color(t.muted));
      const dm = c.type === "D", peer = dm ? this.dmPeer(c) : null;
      return [
        h_flex().px(24).pt(24).gap(8)
          .child(tile("favorite", favorite ? "star-filled" : "star", favorite ? "Favorited" : "Favorite", favorite, (_e, cx) => this.toggleFavorite(c, cx)))
          .child(tile("mute", muted ? "bell-off" : "bell", muted ? "Muted" : "Mute", muted, (_e, cx) => this.toggleMute(c, cx)))
          .when(!dm, (el) => el.child(tile("link", "link", "Copy Link", false, (_e, cx) => cx.write_to_clipboard(this.link(c))))),
        dm
          ? v_flex().px(24).text_size(14)
            .child(h_flex().pt(24).pb(20).gap(12).items_center()
              .child(this.withStatus(peer, this.avatar(peer, 50, t), 50, 18, 14, 36, t))
              .child(v_flex().min_w(0).gap(2)
                .child(div().truncate().text_size(18).font_semibold().child(this.userName(peer)))
                .when(Boolean(this.users.get(peer)?.position), (el) => el.child(div().truncate().child(this.users.get(peer).position)))))
            .child(editable("header"))
          : v_flex().px(24).text_size(14)
          .child(section("Channel purpose"))
          .child(editable("purpose"))
          .child(section("Channel header"))
          .child(editable("header"))
          .child(div().pt(10).text_size(11).text_color(t.muted).child(TextView.markdown(`info-id-${c.id}`, `ID: ${c.id}`).selectable(true))),
        div().mx(24).my(16).h(1).bg(t.border),
        ...(c.type !== "D" ? [row("members", "account", "Members", stats?.member_count)] : []),
        row("pinned", "pin", "Pinned messages", stats?.pinnedpost_count),
        row("files", "file-doc", "Files", stats?.files_count),
      ];
    }
    if (kind === "members") {
      const ids = this.rhsData.members.get(c.id);
      if (!ids) return note("Loading…");
      return [
        div().px(16).pt(14).text_size(14).font_semibold().child(`${ids.length} ${ids.length === 1 ? "member" : "members"}`),
        heading("Members"),
        ...ids.map((id) => h_flex().id(`member-${id}`).h(40).px(16).gap(10).items_center().hover((s) => s.bg(t.hover))
          .child(this.avatar(id, 24, t))
          .child(div().min_w(0).truncate().text_size(13).child(this.userName(id)))
          .child(div().flex_none().text_size(12).text_color(t.dim).child(`@${this.users.get(id)?.username ?? ""}`))),
      ];
    }
    if (kind === "pinned") {
      const posts = this.rhsData.pinned.get(c.id);
      if (!posts) return note("Loading…");
      if (!posts.length) return note("No pinned messages yet");
      return posts.flatMap((p, i) => [
        ...(i === 0 || day(posts[i - 1].create_at) !== day(p.create_at) ? [this.separator(dateLabel(p.create_at), t)] : []),
        this.postRow(p, false, t, true, { scope: "p" }),
      ]);
    }
    const files = this.rhsData.files.get(c.id);
    if (!files) return note("Loading…");
    if (!files.length) return note("No files yet");
    return [
      div().px(16).pt(14).pb(6).text_size(14).font_semibold().child("Recent files"),
      ...files.map((f) => {
        const thumb = f.has_preview_image && this.media.thumb(f.id);
        return h_flex().id(`file-${f.id}`).mx(12).my(4).px(12).py(10).gap(12).items_center().rounded(6).border_1().border_color(t.border)
          .cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.follow(`${this.cfg.url}/${this.team.name}/pl/${f.post_id}`, cx))
          .child(thumb ? image(thumb).size(40).flex_none().rounded(4)
            : div().size(40).flex_none().rounded(4).bg(alpha(t.foreground, 0.08)).flex().items_center().justify_center().text_size(10).font_semibold().text_color(t.muted).child((f.extension || "file").toUpperCase().slice(0, 4)))
          .child(v_flex().min_w(0).gap(2)
            .child(div().truncate().text_size(13).font_semibold().child(f.name))
            .child(div().text_size(12).text_color(t.dim).child(`${fileSize(f.size)} • ${fileTime(f.create_at)}`)));
      }),
    ];
  }

  markAllRead(cx) {
    this.confirmMarkAll = false;
    for (const list of Object.values(this.threads)) for (const th of list ?? []) Object.assign(th, { unread_replies: 0, unread_mentions: 0 });
    this.threads.unread = [];
    this.threadTotals = { ...this.threadTotals, total_unread_threads: 0, total_unread_mentions: 0 };
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        await this.api(cx, `/users/${this.me.id}/teams/${this.team.id}/threads/read`, { method: "PUT" });
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      await this.loadThreads(cx);
    });
  }

  preview(text) {
    return text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__|~~|`+/g, "")
      .replace(SHORTCODES, (whole, name) => this.emoji[name.toLowerCase()] ?? whole)
      .replace(/(^|\s)@([a-z0-9._\-]+)/gi, (whole, before, name) => { const label = this.mentionLabel(name); return label ? `${before}@${label}` : whole; })
      .replace(/\s+/g, " ").slice(0, 240);
  }

  threadRows(posts, t, scope = "t", limit = this.shown) {
    const [root, ...rest] = posts;
    const rows = [[root.id, () => this.postRow(root, false, t, true, { scope })]];
    // Mattermost's reply count: a short line under the avatar, the count where the author's text starts.
    const g = this.gutter();
    rows.push(["replies", () => h_flex().pl(g.pad + g.inset).pt(12).pb(2).items_center()
      .child(div().h(1).w(g.col - g.inset - 13).flex_none().bg(t.border))
      .child(div().ml(13).mr(10).text_size(12).font_semibold().text_color(t.muted).child(replies(rest.filter((p) => !isEphemeral(p)).length)))
      .child(div().h(1).flex_1().bg(t.border))]);
    const upto = Math.min(rest.length, limit);
    for (let i = 0; i < upto; i++) {
      const grouped = this.grouped(rest[i], rest[i - 1]);
      rows.push([`${rest[i].id}-${grouped}`, () => this.postRow(rest[i], grouped, t, true, { scope })]);
    }
    return rows;
  }

  // The Threads section's reader: the thread pinned to the bottom like a channel, the reply box under the newest reply.
  threadView(t) {
    const posts = this.threadPosts.get(this.thread);
    const c = this.channels.get(posts?.[0]?.channel_id);
    const following = this.following.get(this.thread);
    return v_flex().flex_1().min_w(0).h_full()
      .child(header(t, div().flex_none().child("Thread"), ...(c ? [headerNote(t, this.channelName(c))] : []), div().flex_1(),
        ...(following !== undefined && posts?.length ? [this.headerButton("thread-follow", t, following, following ? "Following" : "Follow",
          (_e, cx) => this.toggleFollow(posts[0], cx), svg(`mods/mattermost/icons/${following ? "check" : "bell"}.svg`).size(15))] : []),
        this.headerButton("thread-popout", t, false, POPOUT_TIP, (_e, cx) => openPopout(this, { popout: "thread", thread: this.thread }, cx), svg("mods/mattermost/icons/dock-window.svg").size(15)),
        ...(posts?.length ? [this.threadMenuButton(t, "thread-menu", this.thread, posts, following)] : [])))
      .child(posts?.length ? this.timeline(`thread-${this.thread}`, this.threadRows(posts, t, "t", Infinity), t, false, this.threadScroll) : div().flex_1())
      .child(this.composer(t, this.threadInput));
  }

  threadMenuButton(t, id, root, posts, following) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (e) => this.openMenu({
        kind: "thread", saved: this.saved.has(root), link: this.postLink(root, this.channelOf(posts[0].channel_id)?.team_id || this.team.id), alignRight: true,
        thread: { id: root, channel_id: posts[0].channel_id, unread: false, following: Boolean(following) },
      }, e.bounds))
      .child(svg("mods/mattermost/icons/dots.svg").size(16));
  }

  avatar(userId, size, t) {
    const u = this.users.get(userId);
    const path = this.media.avatar(u);
    if (path) return image(path).size(size).flex_none().rounded_full();
    const initials = (u ? this.userName(u.id) : "?").split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
    return div().size(size).flex_none().rounded_full().bg(alpha(t.foreground, 0.08)).flex().items_center().justify_center()
      .text_size(Math.round(size * 0.4)).text_color(t.muted).child(initials);
  }

  emojiToken(name) {
    return this.customEmoji.has(name) ? { custom: name } : this.emoji[name] ? { emoji: this.emoji[name] } : { text: `:${name}:` };
  }

  emojiEl(tok, size, t) {
    if (tok.custom) {
      const path = this.media.emoji(this.customEmoji.get(tok.custom));
      return path ? image(path).size(size).flex_none() : div().text_color(t.dim).child(`:${tok.custom}:`);
    }
    const path = tok.emoji && this.cfg && this.media.standard(this.cfg.url, tok.emoji);
    return path ? image(path).size(size).flex_none() : div().text_size(Math.round(size * 0.85)).child(tok.emoji ?? tok.text);
  }

  // Turning a message into its parts is regex work that made up most of a render, so it is done once
  // per message text and redone only when the names or emoji it depends on change.
  parsed(cacheKey, message, edited = false, keys = NO_KEYS) {
    const key = `${this.textRev}:${edited}:${keys.id}:${message}`;
    let hit = this.parsedCache.get(cacheKey);
    if (hit?.key === key) return hit;
    // warm() runs this ahead of every redraw, so a message it can't handle comes out as plain text instead of
    // stopping them all.
    let big = null, parts;
    try {
      big = jumbo(message, this.text);
      parts = big ? null : segments(message, this.text, edited, keys);
    } catch {
      parts = [{ md: message }];
    }
    hit = { key, big, parts };
    if (this.parsedCache.size >= PARSED) this.parsedCache.clear();
    this.parsedCache.set(cacheKey, hit);
    return hit;
  }

  emojiLine(key, line, t, label = null) {
    const scale = line.heading ? [0, 24, 20, 18, 16, 14, 14][line.heading] : 14;
    // Mattermost's .mention--highlight: 1px of padding and a 4px radius, which TextView's <mark> can't have.
    const lit = (el) => el.bg(this.mentionBg).px(1).rounded(4);
    const words = line.tokens.map((tok, i) => {
      if (tok.space) return div().w(4).h(tok.lit ? 20 : 4).flex_none().when(Boolean(tok.lit), (el) => el.bg(this.mentionBg));
      if (tok.custom || tok.emoji) return tok.lit ? lit(div()).child(this.emojiEl(tok, Math.round(scale * 1.3), t)) : this.emojiEl(tok, Math.round(scale * 1.3), t);
      if (tok.mention) return div().text_color(t.accent).when(Boolean(tok.lit), lit).child(tok.mention);
      const card = tok.issue && this.jira?.issueCard(`${key}-w${i}`, tok.issue, t, (cx) => this.follow(tok.link, cx));
      if (card) return card;
      return div().id(`${key}-w${i}`).when(Boolean(tok.lit), lit).when(tok.bold || line.heading > 0, (el) => el.font_bold()).when(tok.italic, (el) => el.italic()).when(tok.strike, (el) => el.line_through())
        .when(Boolean(tok.code), (el) => el.px(4).rounded(4).bg(alpha(t.foreground, 0.08)).font_family(settings()?.font_family ?? "monospace").text_size(12))
        .when(Boolean(tok.link), (el) => el.text_color(t.accent).cursor_pointer().on_click((_e, cx) => this.follow(tok.link, cx)))
        .child(tok.text);
    });
    return h_flex().flex_wrap().items_center().min_h(20).my(2).pl(line.indent * 6).text_size(scale)
      .when(line.quote, (el) => el.pl(12).border_l_2().border_color(alpha(t.foreground, 0.2)))
      .when(Boolean(line.marker), (el) => el.child(div().w(18).flex_none().child(line.marker)))
      .children(words)
      .when(Boolean(label), (el) => el.child(div().w(4).h(4).flex_none()).child(label));
  }

  // Mattermost's indicator: a 12px pencil and 11px italic text at 75%, with when in its tooltip.
  editedLabel(p, t) {
    const when = fileTime(p.edit_at).replace(/^(Today|Yesterday)/, (word) => word.toLowerCase());
    return h_flex().id(`edited-${p.id}`).flex_none().gap(2).items_center().text_size(11).text_color(alpha(t.foreground, 0.75))
      .tooltip(`Edited ${when}`)
      .child(svg("mods/mattermost/icons/pencil.svg").size(12))
      .child(div().italic().child("Edited"));
  }

  richText(key, message, t, p, maxW, keys = this.keys.forPost(p)) {
    const edited = p.edit_at > 0;
    const { big, parts } = this.parsed(key, message, edited, keys);
    if (big) return [h_flex().gap(4).py(2).items_center().children(big.map((tok) => this.emojiEl(tok, 32, t))).when(edited, (el) => el.child(this.editedLabel(p, t)))];
    const rows = parts.map((part, i) => {
      const id = i ? `${key}-${i}` : key;
      if (part.line) return this.emojiLine(id, part.line, t, part.labelled ? this.editedLabel(p, t) : null);
      if (part.image) return div().py(2).child(remoteImage(this, id, part.image.url, p, { ...part.image, maxW }, t));
      const text = TextView.markdown(`md-${id}`, part.md).selectable(true).on_link_click((url, cx) => this.follow(url, cx));
      // A TextView in a row is as wide as its text, so the label follows the line, and wraps under it when the line fills the row.
      return part.labelled ? h_flex().flex_wrap().items_center().gap_x(4).when(part.gap, (el) => el.mt(PARAGRAPH_GAP))
        .child(div().max_w_full().child(text)).child(this.editedLabel(p, t)) : text;
    });
    return edited && !parts.at(-1)?.labelled ? [...rows, h_flex().h(20).items_center().child(this.editedLabel(p, t))] : rows;
  }

  reactions(p, t, hovered) {
    const groups = new Map();
    for (const r of p.metadata?.reactions ?? []) {
      const g = groups.get(r.emoji_name) ?? { name: r.emoji_name, count: 0, mine: false, users: [] };
      g.count++;
      g.mine ||= r.user_id === this.me?.id;
      g.users.push(r.user_id);
      groups.set(r.emoji_name, g);
    }
    return h_flex().flex_wrap().gap(4).pt(4).children([...groups.values()].map((g) =>
      h_flex().id(`rx-${p.id}-${g.name}`).h(24).px(6).gap(4).items_center().rounded(6).border_1().cursor_pointer()
        .border_color(g.mine ? t.accent : t.border).bg(g.mine ? t.selected : alpha(t.foreground, 0.08)).hover((s) => s.border_color(t.accent))
        .tooltip(`${g.users.map((id) => this.userName(id)).join(", ")} reacted with :${g.name}:`)
        .on_click((_e, cx) => this.toggleReaction(p, g.name, g.mine, cx))
        .child(this.emojiEl(this.emojiToken(g.name), 16, t))
        .child(div().text_size(11.5).font_semibold().text_color(g.mine ? t.accent : t.muted).child(String(g.count)))))
      .when(hovered, (el) => el.child(div().id(`rx-add-${p.id}`).size(24).flex().items_center().justify_center().rounded(4).cursor_pointer()
        .bg(alpha(t.foreground, 0.08)).text_color(alpha(t.foreground, 0.56)).hover((s) => s.bg(alpha(t.foreground, 0.16)).text_color(t.foreground))
        .tooltip("Add a reaction")
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.openPicker(p, e.bounds); })
        .child(svg("mods/mattermost/icons/smile-plus.svg").size(16))));
  }

  // Mattermost's post menu: over the post's top right corner, above the text rather than beside it.
  postActions(p, t, key, scope, date) {
    const agent = agentSpec();
    const button = (id, icon, tip, color, handler) => div().id(`pa-${id}`).size(26).flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(color ?? t.muted).hover((s) => s.bg(t.hover).text_color(color ?? t.foreground))
      .tooltip(tip)
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); handler(e, cx); })
      .child(svg(`mods/mattermost/icons/${icon}.svg`).size(16));
    const popup = (open) => (e) => open(e.bounds);
    // A post shown beside a thread for context replies in the Threads section, where its thread then opens.
    const reply = scope === "k" ? (_e, cx) => cx.spawn(async (cx) => this.openThread(p.root_id || p.id, cx)) : (_e, cx) => this.openReply(p.root_id || p.id, cx);
    // The bar sticks out over the post above, which would otherwise take the hover from under it; its
    // moves come before that post's.
    return h_flex().id(`pa-bar-${p.id}`).on_mouse_move(() => { this.moveOn ??= key; }).absolute().top(date ? DATE_HALF - 6 : -8).right(10).p(2).gap(1).rounded(6)
      .bg(t.raised).border_1().border_color(t.border).shadow_md()
      .child(button("emoji", "smile-plus", "Add Reaction", null, popup((box) => this.openPicker(p, box))))
      .when(Boolean(agent), (el) => el.child(button("agent", "claude-code", agent.label, VIOLET, (_e, cx) => this.sendToAgent(p, agent, cx))))
      .when(scope === "c" || scope === "k", (el) => el.child(button("reply", "reply", "Reply", null, reply)))
      .child(button("more", "ellipsis", "Message actions", null, popup((box) => this.postMenu(p, box, { scope }))));
  }

  postRow(p, grouped, t, inThread, options) {
    // A throw from a row would stop the whole part from rendering for as long as that post is on screen.
    try {
      return this.drawPost(p, grouped, t, inThread, options);
    } catch {
      return div().id(`post-${p.id}`).pl(this.gutter().pad + this.gutter().col).py(2).text_size(13).text_color(t.muted).child("This message can't be shown.");
    }
  }

  // Mattermost's date line lies on the boundary between two posts instead of in a row of its own, so a
  // hovered post's highlight reaches from the line above it to the line below.
  drawPost(p, grouped, t, inThread, { date = null, beforeDate = false, scope = null } = {}) {
    const key = scope && `${scope}:${p.id}`;
    const hovered = Boolean(key) && this.hoverPost === key;
    const row = h_flex().id(`post-${p.id}`).relative().items_start().pl(this.gutter().pad).pr(this.gutter().right)
      .pt(date ? 8 + DATE_HALF : grouped ? 0 : 8).pb(beforeDate ? 6 + DATE_HALF : 3)
      .text_size(14).line_height("20px")
      // The expanded panel lies over these rows without blocking the pointer from them.
      .when(!(this.rhsExpanded && (scope === "c" || scope === "t")), (el) => el.hover((s) => s.bg(alpha(t.foreground, 0.04))))
      .when(this.highlighted === p.id, (el) => el.bg(alpha(this.mentionBg, 0.5)))
      .when(Boolean(key), (el) => el.on_mouse_move(() => { this.moveOn ??= key; }));
    return row.children(isSystem(p) ? this.systemPost(p, t) : this.userPost(p, grouped, t, inThread, hovered, scope))
      .when(Boolean(date), (el) => el.child(this.dateLine(date, t)))
      .when(hovered && !isSystem(p) && !isEphemeral(p) && !this.isEditing(p, scope), (el) => el.child(this.postActions(p, t, key, scope, date)));
  }

  // Mattermost's thread footer: who replied, latest first, the reply count, and following the thread.
  threadFooter(p, t, hovered) {
    const people = (p.participants ?? []).map((u) => u.id).filter(Boolean).reverse();
    const shown = people.slice(0, 3);
    const following = this.following.get(p.id);
    return h_flex().pt(6).gap(8).items_center().text_size(12)
      .when(shown.length > 0, (el) => el.child(h_flex().items_center()
        .children(shown.map((id, i) => div().when(i > 0, (d) => d.ml(-6)).rounded_full().border_2().border_color(t.background).child(this.avatar(id, 22, t))))
        .when(people.length > shown.length, (el) => el.child(div().ml(-6).size(26).rounded_full().border_2().border_color(t.background).bg(alpha(t.foreground, 0.08))
          .flex().items_center().justify_center().text_size(10).font_semibold().text_color(t.muted).child(`+${people.length - shown.length}`)))))
      .child(h_flex().id(`replies-${p.id}`).h(24).px(6).gap(4).items_center().rounded(4).cursor_pointer().font_semibold().text_color(t.accent)
        .hover((s) => s.bg(alpha(t.accent, 0.08)))
        .on_click((_e, cx) => this.openReply(p.id, cx))
        .child(svg("mods/mattermost/icons/reply.svg").size(14)).child(replies(p.reply_count)))
      .when(following !== undefined, (el) => el.child(this.followButton(p, following, t, `follow-${p.id}`)))
      // Mattermost shows when the last reply came only while the post is hovered.
      .when(hovered && Boolean(p.last_reply_at), (el) => el.child(div().pl(8).text_color(alpha(t.foreground, 0.75)).child(`Last reply ${ago(p.last_reply_at)}`)));
  }

  dateLine(label, t) {
    const line = () => div().h(1).flex_1().bg(alpha(t.foreground, 0.12));
    return h_flex().absolute().left(0).right(0).top(-DATE_HALF).h(2 * DATE_HALF).items_center()
      .child(line())
      .child(div().h_full().px(13).flex().items_center().rounded(DATE_HALF).text_size(13).font_bold().text_color(t.foreground).child(label))
      .child(line());
  }

  systemPost(p, t) {
    return [div().w(this.gutter().col).flex_none(), div().flex_1().min_w(0).py(1).text_color(alpha(t.foreground, 0.75)).child(p.message)];
  }

  userPost(p, grouped, t, inThread, hovered = false, scope = null) {
    const threadRoot = !inThread && !p.root_id && (p.reply_count ?? 0) > 0;
    const time = inThread ? stamp(p.create_at) : clock(p.create_at);
    const person = !fromWebhook(p) && !isEphemeral(p);
    const custom = person && !grouped ? liveStatus(this.users.get(p.user_id)?.custom) : null;
    // Mattermost's post avatar ring: 15px at right -3, bottom -4 of the 32px avatar, an 11px icon.
    const avatar = person ? this.withStatus(p.user_id, this.postAvatar(p, 32, t), 32, 15, 11, 20, t) : this.postAvatar(p, 32, t);
    const saved = scope !== "p" && this.saved.has(p.id);
    // Mattermost's pre-header: the bookmark at the avatar column's edge, "Saved" over the name.
    return [
      v_flex().w(this.gutter().col).flex_none()
        .when(saved, (el) => el.child(h_flex().h(20).mb(5).pr(6).justify_end().items_center()
          .child(svg("mods/mattermost/icons/bookmark-filled.svg").size(12).text_color(t.accent))))
        .when(!grouped, (el) => el.child(div().pt(2).pl(this.gutter().inset).child(avatar))),
      v_flex().flex_1().min_w(0)
        .when(saved, (el) => el.child(div().h(20).mb(5).flex().items_center().text_size(12).text_color(t.accent).child("Saved")))
        .when(!grouped, (el) => el.child(h_flex().mb(1).gap(7).items_baseline()
          .child(div().font_semibold().text_color(t.foreground).child(this.authorName(p)))
          .when(Boolean(custom?.emoji), (el) => el.child(this.statusEmoji(`ps-${p.id}`, custom, 16, t).ml(-4)))
          .when(this.isBot(p), (el) => el.child(div().h(16).px(4).rounded(4).flex().items_center().bg(alpha(t.foreground, 0.08))
            .text_size(10).line_height("12px").font_semibold().text_color(t.foreground).child("BOT")))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(time))
          .when(!p.root_id && priorityEnabled(this.clientConfig) && Boolean(priorityTag(p.metadata?.priority?.priority, t)), (el) => el.child(priorityTag(p.metadata.priority.priority, t)))))
        .children(this.isEditing(p, scope) ? [this.editBox.part] : [v_flex().w_full().max_w(TEXT_W).children(this.richText(p.id, p.message ?? "", t, p, this.contentWidth(scope)))])
        // The files are in the editor while it's open.
        .children(this.isEditing(p, scope) ? [] : postFiles(this, p, t, scope))
        .children(postAttachments(this, p, t, scope))
        .children(postEmbeds(this, p, t, scope))
        .when(isEphemeral(p), (el) => el.child(div().text_size(12).text_color(alpha(t.foreground, 0.56)).child("(Only visible to you)")))
        .when((p.metadata?.reactions ?? []).length > 0, (el) => el.child(this.reactions(p, t, hovered)))
        .when(threadRoot, (el) => el.child(this.threadFooter(p, t, hovered))),
    ];
  }

}
