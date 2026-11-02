// A made-up team that answers the panel's API calls, for screenshots and for trying the mod without a
// server: open the panel with props { demo: true }. Nothing here reaches the network.
import { ACCOUNT_USER, ACCOUNT_CONFIG, accountApi } from "./account.js";

const NOW = Date.now();
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const today = (h, m) => { const d = new Date(NOW); d.setHours(h, m, 0, 0); return Math.min(d.getTime(), NOW - MIN); };
const daysAgo = (n, h, m) => today(h, m) - n * DAY;

const ME = "u-alex";
let dndEnd = 0;
let manualStatus = false;
let autoReset = null;
const TEAM = { id: "t-acme", name: "acme", display_name: "Acme" };

const PEOPLE = [
  [ME, "alex", "Alex", "Rivera", "Mobile lead"],
  ["u-sam", "sam", "Sam", "Okafor", "Backend"],
  ["u-priya", "priya", "Priya", "Nair", "Design"],
  ["u-jamie", "jamie", "Jamie", "Chen", "QA"],
  ["u-lena", "lena", "Lena", "Novak", "Android"],
  ["u-marco", "marco", "Marco", "Silva", "iOS"],
  ["u-ines", "ines", "Inês", "Duarte", "Product"],
  ["u-tom", "tom", "Tom", "Becker", "Platform"],
  ["u-ci", "ci-bot", "", "", ""],
];
const USERS = PEOPLE.map(([id, username, first_name, last_name, position]) => ({
  id, username, first_name, last_name, position, nickname: "", last_picture_update: 0, is_bot: id === "u-ci", email: `${username}@acme.example`,
  notify_props: id === ME ? { mention_keys: "@alex,@release-team,staging,payments service", first_name: "true", channel: "true", highlight_keys: "regression,dry-run" } : {},
  props: id === "u-lena" ? { customStatus: JSON.stringify({ emoji: "palm_tree", text: "On holiday until Monday", duration: "dont_clear" }) }
    : id === "u-sam" ? { customStatus: JSON.stringify({ emoji: "calendar", text: "In a meeting", duration: "dont_clear" }) }
      : id === ME ? { customStatus: JSON.stringify({ emoji: "house", text: "Working from home", duration: "" }) } : {},
  ...(id === ME ? ACCOUNT_USER : {}),
}));
const RECENT_STATUSES = [{ emoji: "house", text: "Working from home", duration: "" }, { emoji: "hamburger", text: "Out for lunch", duration: "thirty_minutes" }, { emoji: "palm_tree", text: "On leave until July", duration: "this_week" }];
// Props demoStatus and demoAutoReset start the demo as someone coming back: "ooo", or a status set by hand.
export function demoStatus(status, reset) {
  STATUS[ME] = status;
  manualStatus = status !== "online";
  autoReset = reset ?? null;
}
const STATUS = { "u-alex": "online", "u-sam": "dnd", "u-priya": "online", "u-jamie": "away", "u-lena": "offline", "u-marco": "online", "u-ines": "away", "u-tom": "offline" };

const channel = (id, type, name, display_name, last, extra = {}) => ({
  id, team_id: type === "D" || type === "G" ? "" : TEAM.id, type, name, display_name, purpose: "", header: "", create_at: daysAgo(400, 9, 0), delete_at: 0,
  last_post_at: last, last_root_post_at: last, total_msg_count: 40, total_msg_count_root: 40, ...extra,
});
const CHANNELS = [
  channel("c-eng", "O", "engineering", "engineering", today(11, 42), { header: "Builds, releases and the on-call rota", purpose: "Everything engineering" }),
  channel("c-mobile", "P", "mobile-team", "mobile-team", today(10, 5)),
  channel("c-town", "O", "town-square", "Town Square", daysAgo(1, 16, 0)),
  channel("c-design", "O", "design", "design", today(9, 30), { total_msg_count_root: 42 }),
  channel("c-releases", "O", "releases", "releases", today(8, 15), { total_msg_count_root: 41 }),
  channel("c-random", "O", "random", "random", daysAgo(2, 13, 0)),
  channel("c-dm-sam", "D", `${ME}__u-sam`, "", today(11, 10)),
  channel("c-dm-priya", "D", `${ME}__u-priya`, "", daysAgo(1, 18, 20)),
  channel("c-dm-lena", "D", `${ME}__u-lena`, "", daysAgo(3, 12, 0)),
  channel("c-gm", "G", "gm-acme-1", "jamie, marco, sam", today(9, 50), { total_msg_count_root: 41 }),
];
const MEMBERS = CHANNELS.map((c) => ({
  channel_id: c.id, msg_count: 40, msg_count_root: 40,
  mention_count: c.id === "c-releases" ? 1 : 0, mention_count_root: c.id === "c-releases" ? 1 : 0,
  last_viewed_at: c.id === "c-eng" ? NOW : c.last_post_at - (c.total_msg_count_root > 40 ? HOUR : 0),
  notify_props: { mark_unread: c.id === "c-random" ? "mention" : "all" },
}));
const CATEGORIES = [
  { id: "cat-fav", type: "favorites", display_name: "Favorites", channel_ids: ["c-eng", "c-mobile"], sorting: "", collapsed: false, muted: false },
  { id: "cat-ch", type: "channels", display_name: "Channels", channel_ids: ["c-town", "c-design", "c-releases", "c-random"], sorting: "alpha", collapsed: false, muted: false },
  { id: "cat-dm", type: "direct_messages", display_name: "Direct Messages", channel_ids: ["c-dm-sam", "c-gm", "c-dm-priya", "c-dm-lena"], sorting: "recent", collapsed: false, muted: false },
];
const GM_MEMBERS = { "c-gm": [ME, "u-jamie", "u-marco", "u-sam"] };
const OUTSIDE_CHANNELS = [channel("c-hiring", "O", "hiring", "Hiring", daysAgo(5, 10, 0)), channel("c-offsite", "O", "offsite-2026", "Offsite 2026", daysAgo(9, 10, 0))];
const GROUPS = [{ id: "g-mobile", name: "mobile", display_name: "Mobile engineers", member_count: 4, source: "custom" }, { id: "g-oncall", name: "oncall", display_name: "On call", member_count: 2, source: "custom" }];
const COMMANDS = [
  ["away", "", "Set your status away"], ["call", "[start|join]", "Start or join a call"], ["dnd", "", "Do not disturb disables desktop and mobile push notifications"], ["echo", "'message' [delay in seconds]", "Echo back text from your account"],
  ["header", "[text]", "Edit the channel header"], ["help", "", "Open the Mattermost help page"], ["invite", "@[username] ~[channel]", "Invite a user to a channel"], ["join", "~[channel]", "Join the open channel"], ["leave", "", "Leave the current channel"],
  ["me", "[message]", "Do an action"], ["msg", "@[username] [message]", "Send Direct Message to a user"], ["mute", "~[channel]", "Turns off desktop, email and push notifications for the current channel or the [channel] specified."], ["offline", "", "Set your status offline"], ["online", "", "Set your status online"],
  ["shrug", "[message]", "Adds ¯\\_(ツ)_/¯ to your message"],
].map(([name, Hint, Description]) => ({ Complete: name, Suggestion: name, Hint, Description, IconData: "" }));

let seq = 0;
const post = (channel_id, user_id, create_at, message, extra = {}) => ({
  id: `p-${++seq}`, channel_id, user_id, create_at, update_at: create_at, edit_at: 0, delete_at: 0, root_id: "", type: "",
  message, props: {}, reply_count: 0, last_reply_at: 0, participants: null, metadata: {}, ...extra,
});
const reactions = (postId, list) => list.flatMap(([emoji_name, users]) => users.map((user_id) => ({ user_id, post_id: postId, emoji_name, create_at: NOW })));

const ENG = [];
const add = (p) => { ENG.push(p); return p; };
add(post("c-eng", "u-tom", daysAgo(1, 10, 2), "Heads up: the staging database moves to the new cluster tonight at 22:00. Expect ~10 minutes of read-only."));
const migration = add(post("c-eng", "u-sam", daysAgo(1, 15, 40), "Migration plan for the payments service is up for review. The risky part is the backfill, so I split it into batches of 5k rows:\n\n```sql\nUPDATE payments SET currency = 'EUR'\nWHERE currency IS NULL AND id BETWEEN :from AND :to;\n```\n\nComments welcome before Thursday."));
add(post("c-eng", "u-lena", daysAgo(1, 15, 52), "Looks good. Can we add a dry-run flag so QA can try it on a copy first?"));
const release = add(post("c-eng", "u-ci", today(9, 12), "**Release 4.18.0** is out on both stores :rocket:\n\n- Faster cold start on Android\n- New onboarding flow\n- 14 fixes", { props: { from_bot: "true" }, edit_at: today(9, 20) }));
const standup = add(post("c-eng", "u-priya", today(10, 21), "The new settings screens are ready in Figma. @alex could you check the empty states before we hand them over?"));
add(post("c-eng", "u-marco", today(10, 34), "iOS build is green again, it was a stale cache on the runner.", { edit_at: today(10, 36) }));
add(post("c-eng", "u-marco", today(10, 35), "Cleaned it up and pinned the Xcode version :white_check_mark:"));
add(post("c-eng", "u-tom", today(11, 5), "Alex, the staging runbook moved to [the staging guide](https://example.com/staging), also at https://example.com/staging/runbook. Not your name: alex, `staging` in code, #staging, staging@acme.dev."));
add(post("c-eng", "u-sam", today(11, 8), "@channel staging is frozen until the dry-run is done, thanks for the heads up @alex :party_parrot:", { metadata: { emojis: [{ name: "party_parrot", id: "e-party" }] } }));
add(post("c-eng", "u-ines", today(11, 12), "@channel a post from someone who can't notify everyone: staging stays dark here, and @alex too, but a dry-run still shows.", { props: { mentionHighlightDisabled: true } }));
const lunch = add(post("c-eng", "u-jamie", today(11, 42), "Regression run finished: 412 passed, 0 failed. Ship it :tada:"));

const REPLIES = {
  [migration.id]: [
    post("c-eng", "u-tom", daysAgo(1, 16, 5), "Batches of 5k are fine on the new cluster.", { root_id: migration.id }),
    post("c-eng", "u-jamie", daysAgo(1, 16, 30), "I can run the dry run tomorrow morning.", { root_id: migration.id }),
    post("c-eng", "u-sam", today(9, 2), "Dry-run flag added, thanks both!", { root_id: migration.id }),
    post("c-eng", "u-tom", today(9, 40), "@alex can you sign off the rollback plan?", { root_id: migration.id }),
  ],
  [standup.id]: [
    post("c-eng", ME, today(10, 40), "On it, I'll leave comments in the file.", { root_id: standup.id }),
  ],
};
const thread = (root, unread = 0) => {
  const replies = REPLIES[root.id];
  root.reply_count = replies.length;
  root.last_reply_at = replies[replies.length - 1].create_at;
  root.participants = [...new Set(replies.map((r) => r.user_id))].map((id) => ({ id }));
  for (const r of replies) r.reply_count = replies.length;
  return { id: root.id, reply_count: root.reply_count, last_reply_at: root.last_reply_at, last_viewed_at: NOW - (unread ? DAY : 0),
    participants: root.participants.map(({ id }) => USERS.find((u) => u.id === id)), post: root, unread_replies: unread, unread_mentions: 0, is_following: true };
}
const THREADS = [thread(migration, 1), thread(standup)];
release.metadata = { reactions: reactions(release.id, [["rocket", ["u-sam", "u-priya", "u-tom"]], ["+1", [ME, "u-lena"]]]) };
lunch.metadata = { reactions: reactions(lunch.id, [["tada", [ME, "u-marco", "u-priya", "u-ines"]], ["heart", ["u-tom"]]]) };
standup.metadata = { reactions: reactions(standup.id, [["eyes", [ME]]]) };

const file = (id, name, mime_type, extension, size, width = 0, height = 0) => ({ id, name, mime_type, extension, size, width, height, has_preview_image: Boolean(width) });
const media = (name) => `https://demo.invalid/media/${name}`;
const DESIGN = [
  post("c-design", "u-priya", daysAgo(1, 11, 0), "New icon set is in the shared library.", { metadata: { files: [file("f-dashboard", "usage-dashboard.jpg", "image/jpeg", "jpg", 41000, 800, 450)] } }),
  post("c-design", "u-priya", daysAgo(1, 11, 4), "Both layouts side by side:", { metadata: { files: [file("f-dashboard", "wide.jpg", "image/jpeg", "jpg", 41000, 800, 450), file("f-mobile", "narrow.jpg", "image/jpeg", "jpg", 30000, 600, 800)] } }),
  post("c-design", "u-marco", daysAgo(1, 14, 10), `A chart inline, between two lines of text:\n\n![Usage](${media("banner.png")} =320x180)\n\nAnd the loop it animates to:\n\n![Loop](${media("anim.gif")} =240x135)`, { metadata: { images: { [media("banner.png")]: { width: 640, height: 360, format: "png", frame_count: 0 }, [media("anim.gif")]: { width: 240, height: 135, format: "gif", frame_count: 24 } } } }),
  post("c-design", "u-tom", daysAgo(1, 15, 30), "Walkthrough of the new flow, with sound:", { metadata: { files: [file("f-walkthrough", "walkthrough.mp4", "video/mp4", "mp4", 62000)] } }),
  post("c-design", "u-jamie", daysAgo(1, 15, 42), "Spinner from the prototype, and the spec:", { metadata: { files: [file("f-loop", "spinner.gif", "image/gif", "gif", 90000, 240, 135), file("f-spec", "spec.txt", "text/plain", "txt", 24)] } }),
  post("c-design", "u-lena", daysAgo(1, 16, 0), "# Review notes\n\n## Done\n\n- [x] ~~old tokens~~ removed\n- [ ] Empty states, see [the guide](https://example.com/guide)\n\n| Screen | Status |\n|---|:-:|\n| Settings | **ready** |\n| Profile | *draft* |\n\n> Keep the `surface` token for cards.\n\nShipping this feels great :party_parrot: **really** `great`, thanks @alex!\n\n1. Spacing\n2. Colour\n\n---\n\nhttps://example.com/guide", { metadata: { emojis: [{ name: "party_parrot", id: "e-party" }] } }),
  post("c-design", "u-sam", daysAgo(1, 16, 20), "The guide everyone keeps asking for: https://example.com/guide", { metadata: { images: { [media("og-guide.png")]: { width: 640, height: 320, format: "png" } }, embeds: [{ type: "opengraph", url: "https://example.com/guide", data: { title: "Design system guide", description: "Tokens, spacing and the rules for empty states.", site_name: "Example", images: [{ secure_url: media("og-guide.png"), width: 640, height: 320 }] } }] } }),
  post("c-design", "u-ci", daysAgo(1, 17, 0), "", { type: "slack_attachment", props: { from_bot: "true", attachments: [{ color: "good", pretext: "Nightly **screenshot tests** finished", title: "Build #1842", title_link: "https://example.com/builds/1842", text: "All screens match. See the `settings` diff below.", fields: [{ title: "Passed", value: "412", short: true }, { title: "Failed", value: "0", short: true }, { title: "Branch", value: "`main`", short: false }], image_url: media("banner.png"), footer: "CI" }, { color: "", title: "Screenshots", text: "Kept for 30 days.", fields: null }] }, metadata: { images: { [media("banner.png")]: { width: 640, height: 360, format: "png" } } } }),
  post("c-design", "u-ines", today(9, 25), "Quoting this one: https://demo.invalid/acme/pl/p-quoted", { metadata: { embeds: [{ type: "permalink", data: { team_name: "acme", channel_display_name: "engineering", post: { id: "p-quoted", user_id: "u-sam", message: "Migration plan is **up for review**." } } }] } }),
  post("c-design", "u-priya", today(9, 30), "New icon set is live."),
];

const OTHER = {
  "c-mobile": [post("c-mobile", "u-lena", today(10, 5), "Who is on release duty next week?")],
  "c-town": [post("c-town", "u-ines", daysAgo(1, 16, 0), "Welcome to the team, @marco! :wave:")],
  "c-design": DESIGN,
  "c-releases": [post("c-releases", "u-ines", today(8, 15), "@alex can you confirm the 4.18 release notes?")],
  "c-random": [post("c-random", "u-tom", daysAgo(2, 13, 0), "Coffee machine on the 3rd floor is fixed :coffee:")],
  "c-dm-sam": [post("c-dm-sam", "u-sam", today(11, 10), "Got a minute after lunch for the migration?")],
  "c-dm-priya": [post("c-dm-priya", "u-priya", daysAgo(1, 18, 20), "Thanks for the review!")],
  "c-dm-lena": [post("c-dm-lena", "u-lena", daysAgo(3, 12, 0), "See you after the holiday :palm_tree:")],
  "c-gm": [post("c-gm", "u-jamie", today(9, 50), "Bug bash at 15:00, bring snacks")],
};

// Long enough that a post from weeks ago isn't among the 60 a channel opens with.
const RANDOM = Array.from({ length: 200 }, (_, i) => post("c-random", ["u-tom", "u-lena", "u-jamie"][i % 3], daysAgo(2, 13, 0) - (200 - i) * 6 * HOUR, `Message number ${i + 1} in the long history of random.`));
OTHER["c-random"].unshift(...RANDOM);
const OLD_SAVED = RANDOM[40];
OLD_SAVED.message = "Keep this one: the **wifi password** for the 3rd floor changed.";
const MENTIONS = [OTHER["c-releases"][0], standup, REPLIES[migration.id][3], DESIGN[5],
  post("c-releases", "u-tom", daysAgo(2, 9, 30), "@release-team the 4.18 branch is cut, please stop merging to it."),
  post("c-town", "u-ines", daysAgo(12, 14, 5), "@alex welcome to the new office!")];
const saved = new Set([release.id, REPLIES[migration.id][0].id, OLD_SAVED.id]);

const DRAFTS = [
  { channel_id: "c-design", root_id: "", message: "Can we keep the **old tokens** until the release is out?", update_at: NOW - 3 * MIN },
  { channel_id: "c-eng", root_id: migration.id, message: "I can take the staging backfill on Thursday.", update_at: NOW - 2 * HOUR },
  { channel_id: "c-dm-sam", root_id: "", message: "After lunch works, I'll grab a room.", update_at: NOW - 2 * DAY },
];

const page = (posts) => ({ order: [...posts].reverse().map((p) => p.id), posts: Object.fromEntries(posts.map((p) => [p.id, p])) });
const postsOf = (id) => (id === "c-eng" ? ENG : OTHER[id] ?? []);
const allPosts = () => [...ENG, ...Object.values(OTHER).flat(), ...Object.values(REPLIES).flat()];
const findPost = (id) => allPosts().find((p) => p.id === id);
const newestFirst = (posts) => [...posts].sort((a, b) => b.create_at - a.create_at);
const pageOf = (posts) => ({ order: posts.map((p) => p.id), posts: Object.fromEntries(posts.map((p) => [p.id, p])) });

// Enough of the server's search for the filters: quoted words OR together, in: and dates AND with them.
const matchesSearch = (terms) => {
  const keys = [...terms.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
  const rest = terms.replace(/"[^"]+"/g, "").trim().split(/\s+/).filter(Boolean);
  const ins = rest.filter((w) => w.startsWith("in:")).map((w) => w.slice(3));
  const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const on = rest.find((w) => w.startsWith("on:"))?.slice(3), after = rest.find((w) => w.startsWith("after:"))?.slice(6);
  return (p) => (!keys.length || keys.some((k) => p.message.toLowerCase().includes(k)))
    && (!ins.length || ins.includes(p.channel_id)) && (!on || day(p.create_at) === on) && (!after || day(p.create_at) > after);
};

// Answers like the server would, or throws as a 404 does.
export async function demoApi(path, method, body) {
  const [route, query = ""] = path.split("?");
  const q = new URLSearchParams(query);
  const account = accountApi(route, method, body, USERS[0]);
  if (account !== undefined) return account;
  if (method !== "GET") {
    if (route === "/users/status/ids") return body.map((user_id) => ({ user_id, status: STATUS[user_id] ?? "offline", manual: user_id === ME && manualStatus, dnd_end_time: user_id === ME ? dndEnd : 0 }));
    if (route === `/users/${ME}/status`) { STATUS[ME] = body.status; manualStatus = body.status !== "online"; dndEnd = body.dnd_end_time ?? 0; return { ...body, manual: manualStatus }; }
    if (route === "/users/me/status/custom") {
      USERS[0].props.customStatus = method === "PUT" ? JSON.stringify(body) : "";
      if (method === "PUT") RECENT_STATUSES.splice(0, RECENT_STATUSES.length, body, ...RECENT_STATUSES.filter((s) => s.text !== body.text).slice(0, 4));
      return {};
    }
    if (route === "/users/me/status/custom/recent/delete") { RECENT_STATUSES.splice(0, RECENT_STATUSES.length, ...RECENT_STATUSES.filter((s) => s.text !== body.text)); return {}; }
    if (route === "/users/me/patch") { const { password, ...patch } = body; Object.assign(USERS[0], patch); return USERS[0]; }
    if (route === `/users/${ME}/preferences` && body[0]?.category === "flagged_post") { saved.add(body[0].name); return {}; }
    if (route === `/users/${ME}/preferences/delete` && body[0]?.category === "flagged_post") { saved.delete(body[0].name); return {}; }
    if (route === `/users/${ME}/preferences` && body[0]?.category === "auto_reset_manual_status") { autoReset = body[0].value; return {}; }
    if (route === `/teams/${TEAM.id}/posts/search`) {
      const from = (body.page ?? 0) * (body.per_page ?? 20);
      return { ...pageOf(newestFirst(MENTIONS.filter(matchesSearch(body.terms))).slice(from, from + (body.per_page ?? 20))), matches: {} };
    }
    if (route === "/users/ids") return USERS.filter((u) => body.includes(u.id));
    if (route === "/users/usernames") return USERS.filter((u) => body.includes(u.username));
    if (route === "/channels/direct") return CHANNELS.find((c) => c.type === "D" && c.name.includes(body.find((id) => id !== ME))) ?? { id: "c-dm-sam" };
    if (route.endsWith("/files/search")) return { order: [], file_infos: {} };
    if (route.endsWith("/channels/search")) return CHANNELS.filter((c) => c.type === "O" && c.name.includes(body.term ?? ""));
    if (route === "/roles/names") return body.map((name) => ({ name, permissions: ["use_channel_mentions", "use_group_mentions"] }));
    if (route === "/commands/execute") {
      const known = COMMANDS.some((c) => body.command.startsWith(`/${c.Suggestion}`));
      if (!known) throw Object.assign(new Error(`${method} ${route}: HTTP 404`), { status: 404, id: "api.command.execute_command.not_found.app_error", text: `Command with a trigger of '${body.command.split(" ")[0].slice(1)}' not found. To send a message beginning with "/", try adding an empty space at the beginning of the message.` });
      return { text: `This is the demo, so \`${body.command.trim()}\` did nothing.` };
    }
    return {};
  }
  let m;
  if (route === "/users/me") return USERS[0];
  if (route === "/users/me/teams") return [TEAM];
  if (route === "/config/client") return { EnableJoinLeaveMessageByDefault: "false", AllowSyncedDrafts: "true", EnableCustomGroups: "true", EnableCustomEmoji: "true", EnableCustomUserStatuses: "true", BuildEnterpriseReady: "true", EnablePublicLink: "true", ...ACCOUNT_CONFIG };
  if ((m = route.match(/^\/files\/([^/]+)\/link$/))) return { link: `https://demo.invalid/files/${m[1]}/public?h=demo` };
  if (route === `/users/me/teams/${TEAM.id}/drafts`) return DRAFTS;
  if (route === "/users/me/preferences/flagged_post") return [...saved].map((name) => ({ category: "flagged_post", name, value: "true" }));
  if (route === "/users/me/preferences") return [
    ...CHANNELS.filter((c) => c.type === "D").map((c) => ({ category: "direct_channel_show", name: c.name.split("__")[1], value: "true" })),
    { category: "custom_status", name: "recent_custom_statuses", value: JSON.stringify(RECENT_STATUSES) },
    ...(autoReset ? [{ category: "auto_reset_manual_status", name: ME, value: autoReset }] : []),
  ];
  if (route === `/users/${ME}/posts/flagged`) {
    const n = Number(q.get("per_page")) || 60, from = (Number(q.get("page")) || 0) * n;
    return pageOf(newestFirst([...saved].map(findPost)).slice(from, from + n));
  }
  if (route === `/users/me/teams/${TEAM.id}/channels`) return CHANNELS;
  if (route === `/users/me/teams/${TEAM.id}/channels/members`) return MEMBERS;
  if (route === `/users/me/teams/${TEAM.id}/channels/categories` || route.endsWith("/channels/categories")) return { order: CATEGORIES.map((c) => c.id), categories: CATEGORIES };
  if (route === "/users") {
    const id = q.get("in_channel");
    const ids = GM_MEMBERS[id] ?? (id?.startsWith("c-dm") ? [ME, `u-${id.slice(5)}`] : USERS.map((u) => u.id));
    return USERS.filter((u) => ids.includes(u.id));
  }
  if (route === "/users/autocomplete" && q.get("in_channel")) {
    const name = (q.get("name") ?? "").toLowerCase();
    const members = GM_MEMBERS[q.get("in_channel")] ?? USERS.map((u) => u.id).filter((id) => id !== "u-tom" && id !== "u-ines");
    const found = USERS.filter((u) => [u.username, u.first_name, u.last_name].some((s) => s.toLowerCase().startsWith(name)));
    return { users: found.filter((u) => members.includes(u.id)), out_of_channel: found.filter((u) => !members.includes(u.id)) };
  }
  if (route === "/users/autocomplete") return { users: USERS.filter((u) => u.username.includes(q.get("name") ?? "")) };
  if (route === "/users/me/teams/members") return [{ team_id: TEAM.id, roles: "team_user" }];
  if (route === "/license/client") return { IsLicensed: "true", SkuShortName: "professional" };
  if (route === "/groups" && q.get("filter_has_member")) return [{ name: "release-team", allow_reference: true, delete_at: 0, source: "custom" }];
  if (route === "/groups") return GROUPS.filter((g) => g.name.startsWith((q.get("q") ?? "").toLowerCase()));
  if (route.endsWith("/channels/autocomplete")) return [...CHANNELS, ...OUTSIDE_CHANNELS].filter((c) => (c.type === "O" || c.type === "P") && c.name.startsWith((q.get("name") ?? "").trim().toLowerCase()));
  if (route.endsWith("/commands/autocomplete_suggestions")) {
    const typed = (q.get("user_input") ?? "").replace(/^\//, "");
    if (typed.includes(" ")) return COMMANDS.some((c) => typed.startsWith(`${c.Suggestion} `)) ? [{ Complete: typed, Suggestion: "", Hint: "", Description: "" }] : [];
    return COMMANDS.filter((c) => c.Suggestion.startsWith(typed));
  }
  if (route === "/emoji/autocomplete") return [];
  if ((m = route.match(/^\/users\/[^/]+\/teams\/[^/]+\/threads$/))) {
    const list = q.get("unread") === "true" ? THREADS.filter((t) => t.unread_replies) : THREADS;
    const totals = { total: THREADS.length, total_unread_threads: 1, total_unread_mentions: 0 };
    return q.get("totalsOnly") === "true" ? totals : { threads: list, ...totals };
  }
  if ((m = route.match(/^\/users\/[^/]+\/teams\/[^/]+\/threads\/([^/]+)$/))) return THREADS.find((t) => t.id === m[1]) ?? { is_following: false };
  if ((m = route.match(/^\/channels\/([^/]+)\/posts$/))) {
    const all = postsOf(m[1]), n = Number(q.get("per_page")) || 60;
    const at = (id) => all.findIndex((p) => p.id === id);
    if (q.get("before")) return page(all.slice(Math.max(0, at(q.get("before")) - n), Math.max(0, at(q.get("before")))));
    if (q.get("after")) return page(all.slice(at(q.get("after")) + 1, at(q.get("after")) + 1 + n));
    return page(all.slice(-n));
  }
  if ((m = route.match(/^\/channels\/([^/]+)$/))) {
    const c = [...CHANNELS, ...OUTSIDE_CHANNELS].find((x) => x.id === m[1]);
    if (c) return c;
  }
  if ((m = route.match(/^\/channels\/([^/]+)\/stats$/))) return { channel_id: m[1], member_count: (GM_MEMBERS[m[1]] ?? USERS).length, pinnedpost_count: m[1] === "c-eng" ? 1 : 0, files_count: 3 };
  if ((m = route.match(/^\/channels\/([^/]+)\/pinned$/))) return m[1] === "c-eng" ? page([migration]) : page([]);
  if ((m = route.match(/^\/posts\/([^/]+)\/thread$/))) {
    const root = findPost(m[1]);
    return page(root ? [root, ...(REPLIES[root.id] ?? [])] : []);
  }
  if (route === "/emoji") return [];
  throw new Error(`${method} ${route}: HTTP 404`);
}

export const DEMO = { url: "https://demo.invalid", token: "", team: TEAM.name, demo: true };
