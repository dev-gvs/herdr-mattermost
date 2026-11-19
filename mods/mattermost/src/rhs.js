// The right-hand panel's header: expanding it over the messages and popping what it shows out of the panel.
// A popped-out copy of this mod (props `popout`) draws only the right-hand panel, with what it was given.
// Mattermost's popouts are browser windows. Here one is a new pane beside the focused one when the layout shows
// panes, since a pane can be resized and doesn't cover the terminals, and a floating window otherwise.
import { svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, shared, setShared, run, panes, focused, layout, openOverlay, closeOverlay } from "herdr";
import { panelRequestKey, requestKey } from "../main.js";

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
  if (open && panes().some((p) => p.pane === open)) return run("pane.focus", { pane: open });
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
export function currentPopout(panel, c, kind = panel.rhs) {
  if (kind === "thread") return { popout: kind, thread: panel.rhsThread };
  return { popout: kind, channel: c?.name };
}

export async function loadPopout(panel, cx) {
  const p = props(), kind = p.popout;
  if (kind === "thread") return panel.openReply(p.thread, cx);
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

// Mattermost's RhsHeaderPost and its other side views' headers, each in its own order.
export function rhsButtons(panel, t, c, thread, kind = panel.rhs) {
  const button = (id, tip, name, onClick, on = false) => panel.headerButton(id, t, on, tip, onClick, icon(name));
  const expanded = panel.rhsExpanded;
  const expand = button("rhs-expand", expanded ? COLLAPSE_TIP : EXPAND_TIP, expanded ? "arrow-collapse" : "arrow-expand", (_e, cx) => {
    panel.rhsExpanded = !expanded;
    panel.redraw(cx);
  });
  const popout = button("rhs-popout", POPOUT_TIP, "dock-window", (_e, cx) => openPopout(panel, currentPopout(panel, c, kind), cx));
  const close = (handler) => button("rhs-close", "Close", "x", handler);
  const closing = (_e, cx) => {
    panel.rhsLast = { rhs: panel.rhs, from: panel.rhsFrom, thread: panel.rhsThread };
    panel.rhs = null;
    panel.rhsFrom = null;
    panel.redraw(cx);
  };
  if (isPopout()) {
    const following = kind === "thread" ? panel.following.get(panel.rhsThread) : undefined;
    return [
      ...(following !== undefined && thread?.length ? [panel.followButton(thread[0], following, t, "rhs-follow")] : []),
      ...(kind === "thread" && thread?.length ? [panel.threadMenuButton(t, "rhs-menu", panel.rhsThread, thread, following)] : []),
      button("rhs-close", "Close", "x", () => closePopout()),
    ];
  }
  // Over the messages it already has their width, as on Mattermost's small screens.
  const canExpand = panel.rhsBeside();
  if (kind === "thread") {
    const following = panel.following.get(panel.rhsThread);
    return [
      ...(following !== undefined && thread?.length ? [button("rhs-follow", following ? "Following" : "Follow", following ? "bell" : "bell-off", (_e, cx) => panel.toggleFollow(thread[0], cx), following)] : []),
      popout,
      ...(canExpand ? [expand] : []),
      close(closing),
    ];
  }
  if (kind === "info" || kind === "members") return [close(closing)];
  return [...(canExpand ? [expand] : []), popout, close(closing)];
}

export const BACK_TIPS = { pinned: "Back to pinned messages" };
