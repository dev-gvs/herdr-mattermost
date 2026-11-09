// Made-up Jira and Confluence notifications for the demo, answering the same operations the panel sends to
// Atlassian's gateway. Nothing here reaches the network: icons and pictures resolve to the demo's own files.

const NOW = Date.now();
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const SITE = "https://acme.atlassian.net";

const text = (t, bold) => ({ type: "text", text: t, ...(bold ? { marks: [{ type: "strong" }] } : {}) });
// A comment as Jira sends it: a paragraph with bold runs, then a list whose item is a link.
const adf = (runs, link) => JSON.stringify({ type: "doc", version: 1, content: [
  { type: "paragraph", content: runs.map(([t, bold]) => text(t, bold)) },
  ...(link ? [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [
    { type: "text", text: link.label, marks: [{ type: "link", attrs: { href: link.href } }] },
  ] }] }] }] : []),
] });

const PEOPLE = {
  "Priya Nair": "u-priya.png", "Jamie Chen": "u-jamie.png", "Tom Becker": "u-tom.png", "Inês Duarte": "u-ines.png",
  "Marco Silva": "u-marco.png", "Lena Novak": "u-lena.png", "Alex Rivera": "u-alex.png",
};
const person = (name) => ({ displayName: name, avatarURL: PEOPLE[name] ? `${SITE}/avatars/${PEOPLE[name]}` : null });

let seq = 0;
// `where` is an issue { key, type, title, status } or a page { space, id, title }.
const note = ({ category, ago, read, actor, message, where, body, comment }) => {
  const id = `n${++seq}`;
  const page = Boolean(where.space);
  const base = page ? `${SITE}/wiki/spaces/${where.space.slice(0, 2).toUpperCase()}/pages/${where.id}` : `${SITE}/browse/${where.key}`;
  const url = comment ? `${base}?focusedCommentId=10${seq}#comment-10${seq}` : base;
  return {
    notificationId: id,
    category,
    readState: read ? "read" : "unread",
    timestamp: new Date(NOW - ago).toISOString(),
    content: {
      type: "created",
      message: `${actor} ${message}`,
      url,
      actor: person(actor),
      entity: { title: where.title, url, contentSubtype: null, status: where.status ?? null,
        iconUrl: page ? `${SITE}/assets/page.svg` : `${SITE}/images/icons/issuetypes/${where.type}.svg` },
      path: [{ title: page ? where.space : where.key, url: page ? `${SITE}/wiki/spaces/${where.space.slice(0, 2).toUpperCase()}` : base }],
      bodyItems: body ? [{ type: "PRIMARY", appearance: "PRIMARY", document: { format: "ADF", data: adf(body.runs, body.link) } }] : [],
    },
  };
};

const MOB142 = { key: "MOB-142", type: "task", title: "Empty states for the new settings screens", status: "In Review" };
const MOB139 = { key: "MOB-139", type: "story", title: "Biometric login on Android: fall back to the PIN screen when the fingerprint sensor is busy or the person cancels the system prompt twice in a row", status: "In Progress" };
const RELEASE = { space: "Mobile Engineering", id: "40211", title: "Release checklist for 2.4" };
const OFFLINE = { space: "Mobile Engineering", id: "40388", title: "Offline mode: design notes" };

// Each head, newest first in its group, with the older items Jira folds under it.
const GROUPS = [
  [note({ category: "direct", ago: 12 * MIN, actor: "Priya Nair", message: "commented on a work item", where: MOB142, comment: true,
    body: { runs: [["@Alex Rivera can you check the copy on the "], ["offline state", true], [" before Friday? Mockups for build "], ["2.4.0-311", true], [" are here:"]],
      link: { label: "Settings mockups", href: "https://www.figma.com/file/acme-settings-empty-states/Settings?node-id=311-2048" } } }),
   note({ category: "direct", ago: 40 * MIN, actor: "Jamie Chen", message: "updated a work item", where: MOB142 }),
   note({ category: "direct", ago: 3 * HOUR, read: true, actor: "Priya Nair", message: "commented on a work item", where: MOB142, comment: true })],
  [note({ category: "direct", ago: 2 * HOUR, actor: "Automation for Jira", message: "assigned a work item to you", where: { key: "PAY-88", type: "bug", title: "Backfill leaves currency empty for refunds", status: "To Do" } })],
  [note({ category: "direct", ago: 5 * HOUR, actor: "Jamie Chen", message: "changed the status of a work item", where: MOB139 })],
  [note({ category: "direct", ago: DAY + 2 * HOUR, read: true, actor: "Inês Duarte", message: "replied to your comment", where: { key: "MOB-120", type: "epic", title: "Settings redesign", status: "In Progress" }, comment: true,
    body: { runs: [["Agreed, let's ship the toggles first and keep the rest for 2.4."]] } })],
  [note({ category: "direct", ago: 4 * DAY, read: true, actor: "Lena Novak", message: "assigned a work item to you", where: { key: "MOB-118", type: "task", title: "Update the Android screenshots", status: "To Do" } })],
  [note({ category: "watching", ago: 1 * HOUR, actor: "Tom Becker", message: "updated a page", where: RELEASE }),
   ...[2, 3, 5, 7, 9].map((h, i) => note({ category: "watching", ago: h * HOUR, read: i > 1, actor: i % 2 ? "Lena Novak" : "Tom Becker", message: "updated a page", where: RELEASE }))],
  [note({ category: "watching", ago: 3 * HOUR, actor: "Marco Silva", message: "commented on a page", where: OFFLINE, comment: true,
    body: { runs: [["Rough, since there's no design yet. We should keep the queue on the device and replay it on reconnect."]] } }),
   note({ category: "watching", ago: 6 * HOUR, actor: "Inês Duarte", message: "commented on a page", where: OFFLINE, comment: true })],
  [note({ category: "watching", ago: DAY + 6 * HOUR, actor: "Marco Silva", message: "changed the status of a work item", where: { key: "MOB-131", type: "bug", title: "Crash when rotating on the photo picker", status: "Done" } })],
  [note({ category: "watching", ago: 3 * DAY, actor: "Automation for Jira", message: "created a task", where: { key: "OPS-311", type: "task", title: "Rotate the staging certificates", status: "Waiting for review" } })],
  [note({ category: "watching", ago: 6 * DAY, read: true, actor: "Sam Okafor", message: "created a work item", where: { key: "PAY-80", type: "story", title: "Show the refund status in the order history", status: "Backlog" } })],
];

const unread = (n) => n.readState === "unread";

const feed = (pick) => ({
  nodes: GROUPS.filter(([head]) => pick(head)).sort(([a], [b]) => b.timestamp.localeCompare(a.timestamp)).map((g) => {
    const [head, ...rest] = g;
    const actors = [...new Set(rest.map((n) => n.content.actor.displayName))];
    return { groupId: `group-${head.notificationId}`, groupSize: g.length, additionalActors: actors.map(person), readStates: [...new Set(g.map((n) => n.readState))], headNotification: head };
  }),
  pageInfo: { hasNextPage: false },
});

export const JIRA_DEMO_SITE = SITE;

export function jiraDemo(operationName, variables) {
  const v = variables ?? {};
  const all = GROUPS.flat();
  if (operationName === "JiraFeed") {
    return {
      notifications: {
        direct: feed((n) => n.category === "direct" && unread(n)),
        watching: feed((n) => n.category === "watching" && unread(n)),
        ...(v.all ? { all: feed((n) => n.category === v.category) } : {}),
      },
    };
  }
  if (operationName === "JiraGroup") {
    const g = GROUPS.find(([head]) => `group-${head.notificationId}` === v.groupId) ?? [];
    return { notifications: { notificationGroup: { nodes: g } } };
  }
  if (operationName === "JiraRead" || operationName === "JiraUnread") {
    for (const n of all) if (v.ids.includes(n.notificationId)) n.readState = operationName === "JiraRead" ? "read" : "unread";
    return { notifications: { [operationName === "JiraRead" ? "markNotificationsByIdsAsRead" : "markNotificationsByIdsAsUnread"]: "OK" } };
  }
  if (operationName === "JiraReadAll") {
    for (const n of all) if (n.category === v.category) n.readState = "read";
    return { notifications: { markNotificationsAsRead: "OK" } };
  }
  throw new Error(`The Jira demo has no ${operationName}`);
}
