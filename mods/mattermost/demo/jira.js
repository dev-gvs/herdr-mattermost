// Made-up Jira notifications for the demo, answering the same operations the panel sends to Atlassian's
// gateway. Nothing here reaches the network.

const NOW = Date.now();
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const SITE = "https://acme.atlassian.net";

const adf = (text) => JSON.stringify({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

const note = (id, category, ago, read, actor, message, key, type, title, comment) => ({
  notificationId: id,
  category,
  readState: read ? "read" : "unread",
  timestamp: new Date(NOW - ago).toISOString(),
  content: {
    type: "jira",
    message,
    url: `${SITE}/browse/${key}${comment ? "?focusedCommentId=10" + id.slice(1) : ""}`,
    actor: { displayName: actor, avatarURL: null },
    entity: { title, url: `${SITE}/browse/${key}`, contentSubtype: type },
    bodyItems: comment ? [{ type: "comment", document: { format: "ADF", data: adf(comment) } }] : [],
  },
});

const NOTES = [
  note("n1", "direct", 12 * MIN, false, "Priya Nair", "mentioned you in a comment", "MOB-142", "Task", "Empty states for the new settings screens", "@Alex Rivera can you check the copy on the offline state before Friday?"),
  note("n2", "direct", 2 * HOUR, false, "Sam Okafor", "assigned you", "PAY-88", "Bug", "Backfill leaves currency empty for refunds"),
  note("n3", "direct", 5 * HOUR, false, "Jamie Chen", "changed the status to In Review", "MOB-139", "Story", "Biometric login on Android"),
  note("n4", "watching", 3 * HOUR, false, "Tom Becker", "commented", "OPS-311", "Task", "Rotate the staging certificates", "Done for api and web, the ws host is next."),
  note("n5", "direct", DAY + 2 * HOUR, true, "Inês Duarte", "replied to your comment", "MOB-120", "Epic", "Settings redesign", "Agreed, let's ship the toggles first and keep the rest for 2.4."),
  note("n6", "watching", DAY + 6 * HOUR, false, "Marco Silva", "changed the status to Done", "MOB-131", "Bug", "Crash when rotating on the photo picker"),
  note("n7", "direct", 4 * DAY, true, "Lena Novak", "assigned you", "MOB-118", "Subtask", "Update the Android screenshots"),
  note("n8", "watching", 6 * DAY, true, "Sam Okafor", "created", "PAY-80", "Story", "Show the refund status in the order history"),
];

const feed = (pick) => ({ nodes: NOTES.filter(pick).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map((n) => ({ headNotification: n })) });

export const JIRA_DEMO_SITE = SITE;

export function jiraDemo(operationName, variables) {
  const v = variables ?? {};
  if (operationName === "JiraFeed") {
    return {
      notifications: {
        direct: feed((n) => n.category === "direct" && n.readState === "unread"),
        watching: feed((n) => n.category === "watching" && n.readState === "unread"),
        ...(v.all ? { all: feed((n) => n.category === v.category) } : {}),
      },
    };
  }
  if (operationName === "JiraRead" || operationName === "JiraUnread") {
    for (const n of NOTES) if (v.ids.includes(n.notificationId)) n.readState = operationName === "JiraRead" ? "read" : "unread";
    return { notifications: { [operationName === "JiraRead" ? "markNotificationsByIdsAsRead" : "markNotificationsByIdsAsUnread"]: "OK" } };
  }
  throw new Error(`The Jira demo has no ${operationName}`);
}
