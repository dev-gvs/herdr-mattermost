// The right-hand panel's header: expanding it over the messages and popping what it shows out of the panel.
// A popped-out copy of this mod (props `popout`) draws only the right-hand panel, with what it was given.
// Mattermost's popouts are browser windows. Here one is a new pane beside the focused one when the layout shows
// panes, since a pane can be resized and doesn't cover the terminals, and a floating window otherwise.
import { svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, shared, setShared, run, panes, focused, layout, openOverlay, closeOverlay } from "herdr";
import { alpha, panelRequestKey, requestKey } from "../main.js";
import { NO_FILTERS, FILTERS_W, FILTERS_SPARE, filtersFromProps, filtersToProps, filtersHeight, countMentionFilters } from "./mentions.js";

export const EXPAND_TIP = "Expand the right sidebar  Ctrl+Shift+.";
export const COLLAPSE_TIP = "Collapse the right sidebar  Ctrl+Shift+.";
export const POPOUT_TIP = "Open in new window";
// The `mattermost.alive` stamp is older than this when no panel is running.
const ALIVE_FOR = 40e3;

const icon = (name, size = 14) => svg(`mods/mattermost/icons/${name}.svg`).size(size);

export const isPopout = () => Boolean(props()?.popout);
export const popoutName = (p = props()) => [p.popout, p.thread ?? p.channel].filter(Boolean).join("-");

// A popped-out copy's own popups answer to it, not to the panel.
export const openOwnOverlay = (spec) => openOverlay(isPopout() ? { ...spec, props: { ...spec.props, requestTo: requestKey() } } : spec);

// The layout's blocks showing the active tab are where a pane would appear.
function showsPanes(node) {
  return Boolean(node?.content?.tab) || (node?.children ?? []).some(showsPanes);
}

export function openPopout(panel, spec, cx) {
  const popped = { ...spec, demo: panel.cfg?.demo };
  const name = popoutName(popped);
  const open = panel.popouts.get(name);
  if (open && panes().some((p) => p.pane === open)) {
    // Mattermost reuses the window and shows in it what was asked for now.
    if (popped.popout === "mentions") setShared(`${panelRequestKey()}.${name}`, { id: `${Date.now()}-${Math.random()}`, action: "mention-filters", filters: { ...NO_FILTERS, ...filtersFromProps(popped) }, team: popped.mentionTeam ?? null });
    return run("pane.focus", { pane: open });
  }
  if (panel.splitting) return;
  if (focused()?.pane && showsPanes(layout())) {
    const before = new Set(panes().map((p) => p.pane));
    panel.splitting = true;
    run("pane.split", { direction: "right", mod: "mattermost", props: popped });
    // The new pane is only listed once the app has run the split, after this handler.
    cx.timer.after(150, () => {
      panel.splitting = false;
      const made = panes().find((p) => !before.has(p.pane) && p.mod === "mattermost");
      if (made) panel.popouts.set(name, made.pane);
    });
    return;
  }
  openOwnOverlay({ mod: "mattermost", kind: "window", key: `mattermost-${name}`, width: 0.6, height: 0.8, props: popped });
}

// What's showing, in the props that bring it back the same way.
export function currentPopout(panel, c) {
  const kind = panel.rhs;
  if (kind === "thread") return { popout: kind, thread: panel.rhsThread };
  if (kind === "mentions") return { popout: kind, ...filtersToProps(panel.mentionFilters), ...(panel.mentionTeam ? { mentionTeam: panel.mentionTeam } : {}) };
  if (kind === "saved") return { popout: kind };
  return { popout: kind, channel: c?.name };
}

export async function loadPopout(panel, cx) {
  const p = props(), kind = p.popout;
  if (kind === "thread") return panel.openReply(p.thread, cx);
  if (kind === "mentions") {
    panel.mentionFilters = { ...NO_FILTERS, ...filtersFromProps(p) };
    panel.mentionTeam = typeof p.mentionTeam === "string" ? p.mentionTeam : null;
  }
  if (kind === "pinned" || kind === "files") panel.selected = [...panel.channels.values()].find((c) => c.name === p.channel)?.id ?? null;
  panel.rhs = kind;
  panel.redraw(cx);
  panel.loadRhs(cx);
}

export function closePopout() {
  if (props()?.overlay) return closeOverlay(props().overlay);
  // A pane isn't told its own id, but the press on this button has just focused it. pane.close ends a terminal's
  // pane, so it only ever goes to a mod's.
  const own = panes().find((p) => p.focused && p.mod === "mattermost");
  if (own) run("pane.close", { pane: own.pane });
}

// A popped-out copy has no sidebar to file a draft in, so the panel keeps them: only one copy may write the store.
export function handDrafts(panel) {
  const seen = panel.handed ??= new Map();
  const changes = [];
  for (const [key, d] of panel.drafts) {
    const text = JSON.stringify(d);
    if (seen.get(key) === text) continue;
    seen.set(key, text);
    if (d.dirty) changes.push([key, d]);
  }
  for (const key of seen.keys()) {
    if (panel.drafts.has(key)) continue;
    seen.delete(key);
    changes.push([key, null]);
  }
  if (!changes.length) return;
  if (panel.cfg?.demo || Date.now() - (shared("mattermost.alive") ?? 0) < ALIVE_FOR) {
    setShared(panelRequestKey(), { id: `${Date.now()}-${Math.random()}`, action: "drafts", changes });
    return;
  }
  const stored = new Map(JSON.parse(localStorage.getItem(panel.draftStore()) ?? "[]").map((d) => [d.root_id || d.channel_id, d]));
  for (const [key, d] of changes) {
    if (d) stored.set(key, d);
    else stored.delete(key);
  }
  localStorage.setItem(panel.draftStore(), JSON.stringify([...stored.values()]));
}

export function takeDrafts(panel, changes, cx) {
  for (const [key, d] of changes) {
    if (d) panel.drafts.set(key, d);
    else panel.drafts.delete(key);
    const box = panel.boxes.find((b) => b.key === key);
    if (box) panel.fill(box, key, d?.message ?? "");
    if (d && !d.typing) panel.pushDraft(key, cx);
  }
  panel.draftsTouched = true;
  panel.redraw(cx);
}

// What only the panel can do goes to it; a popped-out copy has no channel to show.
export function toPanel(req) {
  setShared(panelRequestKey(), { ...req, id: `${Date.now()}-${Math.random()}` });
}

// Mattermost's Ctrl+Shift+.: expand or shrink an open panel, or open it where it was.
export function isExpandKey(keystroke) {
  return /^(ctrl|cmd)-(shift-(\.|>)|>)$/.test(keystroke);
}

export function rhsExpandKey(panel, cx) {
  if (panel.rhs) {
    panel.rhsExpanded = !panel.rhsExpanded;
    return panel.redraw(cx);
  }
  const last = panel.rhsLast;
  if (!last) return;
  if (last.rhs === "thread") {
    panel.openReply(last.thread, cx);
    panel.rhsFrom = last.from;
    return panel.redraw(cx);
  }
  panel.openRhs(last.rhs, cx, last.from);
}

// Mattermost's handleClickOutside: a press anywhere else in the panel shrinks it. Popups aren't part of the panel.
export function shrinkOnPress(panel, e, cx) {
  const b = panel.box, p = e.position;
  if (!panel.rhsExpanded || shared("mattermost.popup")) return;
  if (b && (p.x < b.x || p.x > b.x + b.width || p.y < b.y || p.y > b.y + b.height)) return;
  panel.rhsExpanded = false;
  panel.redraw(cx);
}

// Mattermost's SearchResultsHeader and RhsHeaderPost, each in its own order.
export function rhsButtons(panel, t, c, thread) {
  const button = (id, tip, name, onClick, on = false) => panel.headerButton(id, t, on, tip, onClick, icon(name));
  const expanded = panel.rhsExpanded;
  const expand = button("rhs-expand", expanded ? COLLAPSE_TIP : EXPAND_TIP, expanded ? "arrow-collapse" : "arrow-expand", (_e, cx) => {
    panel.rhsExpanded = !expanded;
    panel.redraw(cx);
  });
  const popout = button("rhs-popout", POPOUT_TIP, "dock-window", (_e, cx) => openPopout(panel, currentPopout(panel, c), cx));
  const close = (handler) => button("rhs-close", "Close", "x", handler);
  const closing = (_e, cx) => {
    panel.rhsLast = { rhs: panel.rhs, from: panel.rhsFrom, thread: panel.rhsThread };
    panel.rhs = null;
    panel.rhsFrom = null;
    panel.redraw(cx);
  };
  if (isPopout()) {
    const following = panel.rhs === "thread" ? panel.following.get(panel.rhsThread) : undefined;
    return [
      ...(following !== undefined && thread?.length ? [panel.followButton(thread[0], following, t, "rhs-follow")] : []),
      ...(panel.rhs === "thread" && thread?.length ? [panel.threadMenuButton(t, "rhs-menu", panel.rhsThread, thread, following)] : []),
      button("rhs-close", "Close", "x", () => closePopout()),
    ];
  }
  // Over the messages it already has their width, as on Mattermost's small screens.
  const canExpand = panel.rhsBeside();
  if (panel.rhs === "thread") {
    const following = panel.following.get(panel.rhsThread);
    return [
      ...(following !== undefined && thread?.length ? [button("rhs-follow", following ? "Following" : "Follow", following ? "bell" : "bell-off", (_e, cx) => panel.toggleFollow(thread[0], cx), following)] : []),
      popout,
      ...(canExpand ? [expand] : []),
      close(closing),
    ];
  }
  if (panel.rhs === "info" || panel.rhs === "members") return [close(closing)];
  return [...(canExpand && panel.rhsFrom !== "info" ? [expand] : []), popout, close(closing)];
}

export const BACK_TIPS = { mentions: "Back to search results", saved: "Back to saved messages", pinned: "Back to pinned messages" };

// Compass's small quaternary button, in the position and padding the mention filters give it.
export function filtersButton(panel, t) {
  const count = countMentionFilters(panel.mentionFilters, panel.mentionTeam);
  const open = Boolean(panel.filtersOpen);
  // Mattermost has 12 of padding and 8 of gap in a panel 400 wide; this one starts at 293 of these units.
  return h_flex().id("rhs-filters").flex_none().ml(-2).h(28).px(8).gap(6).items_center().rounded(4).cursor_pointer()
    .text_size(12).line_height("16px").font_semibold().text_color(t.accent)
    .when(open, (el) => el.bg(alpha(t.accent, 0.12)))
    .hover((s) => s.bg(alpha(t.accent, open ? 0.12 : 0.08)))
    .on_mouse_down("left", (e, cx) => {
      cx.stop_propagation();
      openFilters(panel, e.bounds ?? { ...e.position, width: 0, height: 0 }, cx);
    })
    .child(icon("filter-variant", 12))
    .child(count > 0 ? `Filters (${count})` : "Filters");
}

// Group mentions need custom groups or an LDAP groups license: without either there are no group keys,
// and the option could only narrow the list to nothing.
async function groupMentionsAvailable(panel, cx) {
  if (panel.clientConfig?.EnableCustomGroups === "true") return true;
  const dir = panel.directory;
  dir.license ??= await panel.api(cx, "/license/client?format=old").catch(() => ({}));
  return dir.license.IsLicensed === "true" && dir.license.LDAPGroups === "true";
}

// The team's channels sorted by name, then the conversations that belong to no team, whichever team is chosen.
async function filterableChannels(panel, cx) {
  const list = [...panel.filterable.values()].filter((c) => !c.delete_at);
  const peers = list.filter((c) => c.type === "D").map((c) => panel.dmPeer(c)).filter((id) => !panel.users.has(id));
  if (peers.length) await panel.fetchUsers(cx, peers);
  const row = (c) => ({ id: c.id, label: panel.channelName(c), name: c.name, team: c.team_id ?? "" });
  const byLabel = (a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase());
  const rows = list.map(row);
  return [...rows.filter((c) => c.team).sort(byLabel), ...rows.filter((c) => !c.team).sort(byLabel)];
}

// Mattermost's filterAndSortTeamsByDisplayName: the person's own team order, then by name.
function sortedTeams(panel) {
  const order = (panel.teamsOrder ?? "").split(",");
  const rank = (t) => order.indexOf(t.id);
  const own = panel.teams.filter((t) => rank(t) >= 0).sort((a, b) => rank(a) - rank(b));
  const rest = panel.teams.filter((t) => rank(t) < 0).sort((a, b) => a.display_name.toLowerCase().localeCompare(b.display_name.toLowerCase()));
  return [...own, ...rest].filter((t) => !t.delete_at && t.display_name != null);
}

function openFilters(panel, box, cx) {
  // A press on the button while its popover is open is closing it, and which of the two arrives first varies.
  if (panel.filtersOpen || Date.now() - (panel.filtersClosed ?? 0) < 250) return;
  cx.spawn(async (cx) => {
    const showTeams = panel.clientConfig?.EnableCrossTeamSearch === "true" && (panel.teams?.length ?? 0) > 1;
    const groups = await groupMentionsAvailable(panel, cx);
    if (showTeams) {
      const all = await panel.api(cx, "/users/me/channels").catch(() => []);
      for (const c of all) panel.filterable.set(c.id, c);
    }
    const channels = await filterableChannels(panel, cx);
    const z = panel.zoom(), base = filtersHeight(showTeams, groups);
    const y = panel.place(box, base * z, "below"), up = y < box.y;
    const bottom = panel.box ? panel.box.y + panel.box.height : Infinity, right = panel.box ? panel.box.x + panel.box.width : Infinity;
    const room = (bottom - y) / z;
    const short = room < base && y <= 4 + (panel.box?.y ?? 0);
    const height = up ? base : Math.min(base + FILTERS_SPARE, Math.max(short ? room : base, room));
    const id = openOwnOverlay({
      mod: "mattermost", kind: "popup", frame: "none", width: FILTERS_W, height, at: { x: Math.max(8, Math.min(box.x, right - FILTERS_W * z - 8)), y },
      props: { demo: panel.cfg?.demo, filtersMenu: {
        filters: panel.mentionFilters, team: panel.mentionTeam, showTeams, groups, height, up, short, channels,
        teams: (panel.teams ? sortedTeams(panel) : []).map((t) => ({ id: t.id, label: t.display_name })),
        teamNames: Object.fromEntries((panel.teams ?? []).map((t) => [t.id, t.display_name])),
      } },
    });
    panel.popupOpened(id);
    panel.filtersOpen = id;
    cx.notify(panel.mainPart);
  });
}
