// What hangs off a message besides its text: attached files, images, bot attachments and link previews.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { alpha, fileSize } from "../main.js";
import { MAX_PIXELS } from "./media.js";
import { imageName } from "./image.js";

// Mattermost's limit for an image in the timeline; several in one post share the row at a smaller size.
const MAX_H = 350;
const MANY_W = 240, MANY_H = 180;
const THUMB = 75;
// A post's props may hold 800,000 characters, far more than a render has time to parse and draw.
const MAX_ATTACHMENTS = 20, MAX_FIELDS = 40, MAX_TEXT = 16383;
// Used until a picture's real shape is known, so the row doesn't jump when it arrives.
const DEFAULT_W = 400, DEFAULT_H = 225;
const COLORS = { good: "#339970", success: "#339970", warning: "#CC8F00", danger: "#D24B4E", primary: "#166DE0", default: "#3F4350" };
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Herdr throws on anything but a real colour, and the server sends an attachment without one as "".
const barColor = (color, t) => (Object.hasOwn(COLORS, color) ? COLORS[color] : HEX.test(color) ? color : alpha(t.foreground, 0.2));

const isGif = (f) => f.mime_type === "image/gif" || f.extension?.toLowerCase() === "gif";
const isVideo = (f) => f.mime_type?.startsWith("video/");
const isAudio = (f) => f.mime_type?.startsWith("audio/");
const isPicture = (f) => f.has_preview_image || isGif(f);
const isAnimated = (view, url, rel, meta) => meta?.frame_count > 1 || /\.gif(\?|$)/i.test(url) || view.media.animated(rel);

function fit(w, h, maxW, maxH) {
  const scale = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function frame(id, box, t) {
  return div().id(id).relative().w(box.w).max_w_full().h(box.h).flex_none().rounded(4).overflow_hidden().border_1().border_color(alpha(t.foreground, 0.16))
    .bg(alpha(t.foreground, 0.06)).flex().items_center().justify_center().text_size(12).text_color(t.muted);
}

function playBadge(t, label) {
  return h_flex().absolute().left(8).bottom(8).h(24).px(8).gap(4).items_center().rounded(12).bg("#000000b3").text_color("#ffffff").text_size(11).font_semibold()
    .child(svg("mods/mattermost/icons/play.svg").size(12)).child(label);
}

// A still until it's clicked: an animation costs CPU on every frame, and memory for as long as Herdr runs.
function animation(view, key, still, box, t, play) {
  const on = view.playing?.key === key;
  return frame(`anim-${key}`, box, t).cursor_pointer().on_click((_e, cx) => play(cx))
    .when(on, (el) => el.child(image(view.playing.rel).size_full()))
    .when(!on && Boolean(still), (el) => el.child(image(still).size_full()))
    .when(!on, (el) => el.child(playBadge(t, view.fileState.get(key) ?? "GIF")));
}

function fileRow(view, f, t) {
  const state = view.fileState.get(f.id);
  return h_flex().id(`file-${f.id}`).w(320).max_w_full().mt(4).px(12).py(8).gap(12).items_center().rounded(4).border_1().border_color(alpha(t.foreground, 0.16))
    .cursor_pointer().hover((s) => s.bg(alpha(t.foreground, 0.04)))
    .on_click((_e, cx) => view.openFile(f, cx))
    .child(svg(`mods/mattermost/icons/${isAudio(f) ? "play" : "file-doc"}.svg`).size(20).flex_none().text_color(t.muted))
    .child(v_flex().min_w(0).flex_1()
      .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(f.name ?? "File"))
      .child(div().text_size(12).text_color(state === "Download failed" ? t.blocked : t.dim).child(state ?? `${(f.extension ?? "").toUpperCase()} ${fileSize(f.size ?? 0)}`.trim())));
}

function videoCard(view, f, t, maxW, maxH) {
  const box = fit(DEFAULT_W, DEFAULT_H, maxW, maxH);
  const poster = view.media.poster(f.id);
  return v_flex().mt(4).w(box.w).max_w_full()
    .child(frame(`video-${f.id}`, box, t).cursor_pointer().on_click((_e, cx) => view.openFile(f, cx))
      .when(Boolean(poster), (el) => el.child(image(poster).size_full()))
      .child(div().absolute().size(48).rounded_full().bg("#000000b3").flex().items_center().justify_center().text_color("#ffffff")
        .child(svg("mods/mattermost/icons/play.svg").size(22))))
    .child(div().pt(2).truncate().text_size(12).text_color(t.dim)
      .child(view.fileState.get(f.id) ?? `${f.name ?? "Video"} • ${fileSize(f.size ?? 0)}`));
}

const withImageMenu = (el, view, picture) => el.on_mouse_down("right", (e, cx) => { cx.stop_propagation(); view.openImageMenu(picture, e.position); });

const fileImage = (view, f) => ({
  file: { id: f.id, name: f.name, extension: f.extension, mime_type: f.mime_type },
  name: f.name, path: view.media.preview(f.id), w: f.width, h: f.height,
});

// Going through a post's files stops at its pictures: other files open in their own apps here, and a GIF plays in place.
function openPicture(view, p, f) {
  const pictures = (p.metadata?.files ?? []).filter((x) => isPicture(x) && !isGif(x)).map((x) => fileImage(view, x)).filter((x) => x.path);
  view.openLightbox(p, pictures, pictures.findIndex((x) => x.file.id === f.id));
}

function pictureFile(view, f, p, t, maxW, maxH) {
  const box = fit(f.width || DEFAULT_W, f.height || DEFAULT_H, maxW, maxH);
  const still = view.media.preview(f.id);
  if (isGif(f)) {
    return div().mt(4).child(withImageMenu(animation(view, f.id, still, box, t, (cx) => view.playFileAnimation(f, cx)), view, fileImage(view, f)));
  }
  return div().mt(4).child(withImageMenu(frame(`pic-${f.id}`, box, t).cursor_pointer(), view, fileImage(view, f))
    .on_click(() => still && openPicture(view, p, f))
    .when(Boolean(still), (el) => el.child(image(still).size_full())));
}

export function postFiles(view, p, t, scope) {
  const files = p.metadata?.files ?? [];
  if (!files.length) return [];
  const pictures = files.filter((f) => isPicture(f) || isVideo(f));
  const others = files.filter((f) => !isPicture(f) && !isVideo(f));
  const maxW = view.contentWidth(scope);
  const many = pictures.length > 1;
  const w = many ? Math.min(MANY_W, maxW) : maxW, h = many ? MANY_H : MAX_H;
  const drawn = pictures.map((f) => (isVideo(f) ? videoCard(view, f, t, w, h) : pictureFile(view, f, p, t, w, h)));
  return [
    ...(drawn.length ? [h_flex().flex_wrap().gap(8).children(drawn)] : []),
    ...others.map((f) => fileRow(view, f, t)),
  ];
}

// An image from a message's own text or a link preview, on another host.
export function remoteImage(view, key, url, p, { w, h, link, maxW }, t) {
  const meta = p.metadata?.images?.[url];
  const box = fit(w || (h && meta ? (meta.width * h) / meta.height : meta?.width) || DEFAULT_W, h || (w && meta ? (meta.height * w) / meta.width : meta?.height) || DEFAULT_H, maxW, MAX_H);
  // The server's word saves the download; the file's own size decides when the server didn't look.
  const declared = meta?.width * meta?.height > MAX_PIXELS;
  const rel = declared ? null : view.media.remote(url);
  const huge = declared || Boolean(rel && view.media.oversized(rel));
  const picture = { url, rel, name: imageName(url), path: rel, w: meta?.width, h: meta?.height };
  if (rel && !huge && isAnimated(view, url, rel, meta)) {
    return withImageMenu(animation(view, key, view.media.still(rel), box, t, (cx) => view.playRemoteAnimation(key, rel, cx)), view, picture);
  }
  return frame(`img-${key}`, box, t).cursor_pointer()
    .on_click((_e, cx) => (link || huge ? view.follow(link ?? url, cx) : rel && view.openLightbox(p, [picture], 0)))
    .when(huge, (el) => el.child("Too large to show here"))
    .when(Boolean(rel) && !huge, (el) => withImageMenu(el, view, picture).child(image(rel).size_full()));
}

// For pictures too small to offer a play button: an animation stays on its first frame.
function smallPicture(view, url) {
  const rel = url && view.media.remote(url);
  if (!rel || view.media.oversized(rel)) return null;
  return isAnimated(view, url, rel) ? view.media.still(rel) : rel;
}

function thumbnail(view, key, url, path) {
  return withImageMenu(div().id(`${key}-thumb`).size(THUMB).flex_none(), view, { url, rel: view.media.remote(url), name: imageName(url), path })
    .child(image(path).size_full().rounded(4));
}

function card(color, t, children) {
  return h_flex().mt(6).max_w(700).items_stretch().rounded(4).overflow_hidden().border_1().border_color(alpha(t.foreground, 0.16)).bg(alpha(t.foreground, 0.02))
    .child(div().w(4).flex_none().bg(color))
    .child(v_flex().flex_1().min_w(0).p(12).gap(6).children(children));
}

function linkText(view, id, text, url, t, size = 14) {
  return div().id(id).font_semibold().text_size(size).text_color(url ? t.accent : t.foreground)
    .when(Boolean(url), (el) => el.cursor_pointer().on_click((_e, cx) => view.follow(url, cx))).child(text);
}

function small(icon, text, view, t) {
  const path = smallPicture(view, icon);
  return h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
    .when(Boolean(path), (el) => el.child(image(path).size(16).flex_none().rounded(2))).child(text);
}

// Bot and webhook messages: Mattermost's attachment card, a coloured bar beside its parts.
export function postAttachments(view, p, t, scope) {
  const list = p.props?.attachments;
  if (!Array.isArray(list)) return [];
  const maxW = Math.min(700, view.contentWidth(scope)) - 40;
  let room = MAX_TEXT;
  const clip = (text) => {
    const kept = String(text ?? "").slice(0, Math.max(0, room));
    room -= kept.length;
    return kept;
  };
  return list.slice(0, MAX_ATTACHMENTS).flatMap((a, i) => {
    const key = `${p.id}-a${i}`;
    const parts = [];
    if (a.author_name) parts.push(a.author_link ? linkText(view, `${key}-author`, clip(a.author_name), a.author_link, t, 12) : small(a.author_icon, clip(a.author_name), view, t));
    if (a.title) parts.push(linkText(view, `${key}-title`, clip(a.title), a.title_link, t));
    const thumb = smallPicture(view, a.thumb_url);
    const text = a.text ? view.richText(key, clip(a.text), t, p, maxW - (a.thumb_url ? THUMB + 12 : 0), view.keys.forText()) : null;
    if (text || thumb) {
      parts.push(h_flex().items_start().gap(12)
        .child(v_flex().flex_1().min_w(0).children(text ?? []))
        .when(Boolean(thumb), (el) => el.child(thumbnail(view, key, a.thumb_url, thumb))));
    }
    const fields = (a.fields ?? []).slice(0, MAX_FIELDS).filter((f) => f.title || f.value);
    if (fields.length) parts.push(attachmentFields(view, key, fields, t, p, maxW, clip));
    if (a.image_url) parts.push(remoteImage(view, `${key}-image`, a.image_url, p, { maxW }, t));
    if (a.footer) parts.push(small(a.footer_icon, clip(a.footer), view, t));
    const pretext = a.pretext ? view.richText(`${key}-pre`, clip(a.pretext), t, p, maxW, view.keys.forText()) : [];
    return [...pretext, card(barColor(a.color, t), t, parts)];
  });
}

// Short fields sit two to a row, long ones take the whole width, in the order they were given.
function attachmentFields(view, key, fields, t, p, maxW, clip) {
  const rows = [];
  for (const f of fields) {
    const last = rows[rows.length - 1];
    if (f.short && last?.length === 1 && last[0].short) last.push(f);
    else rows.push([f]);
  }
  return v_flex().gap(8).children(rows.map((row, r) => h_flex().items_start().gap(12).children(row.map((f, c) => v_flex().flex_1().min_w(0)
    .child(div().text_size(12).font_semibold().text_color(t.muted).child(clip(f.title)))
    .children(view.richText(`${key}-f${r}-${c}`, clip(f.value), t, p, maxW / row.length, view.keys.forText()))))));
}

// Link previews, images linked in a message and quoted posts, which the server works out and sends along.
export function postEmbeds(view, p, t, scope) {
  const maxW = Math.min(700, view.contentWidth(scope)) - 40;
  return (p.metadata?.embeds ?? []).flatMap((e, i) => {
    const key = `${p.id}-e${i}`;
    if (e.type === "image") return [div().mt(4).child(remoteImage(view, key, e.url, p, { maxW: view.contentWidth(scope) }, t))];
    if (e.type === "opengraph") return linkPreview(view, key, e, t, p, maxW);
    if (e.type === "permalink") return quotedPost(view, key, e.data, t, p, maxW);
    return [];
  });
}

function linkPreview(view, key, e, t, p, maxW) {
  const { title, description, site_name: site, images } = e.data ?? {};
  const picture = images?.[0], url = picture && (picture.secure_url || picture.url);
  if (!title && !description && !url) return [];
  const meta = url ? p.metadata?.images?.[url] ?? picture : null;
  const large = (meta?.width ?? 0) >= 480;
  const thumb = !large && smallPicture(view, url);
  return [card(alpha(t.foreground, 0.2), t, [
    ...(site ? [div().text_size(12).text_color(t.muted).child(site)] : []),
    h_flex().items_start().gap(12)
      .child(v_flex().flex_1().min_w(0).gap(4)
        .when(Boolean(title), (el) => el.child(linkText(view, `${key}-title`, title, e.url, t)))
        .when(Boolean(description), (el) => el.child(div().text_size(13).text_color(t.foreground).child(description))))
      .when(Boolean(thumb), (el) => el.child(thumbnail(view, key, url, thumb))),
    ...(url && large ? [remoteImage(view, `${key}-image`, url, p, { maxW }, t)] : []),
  ])];
}

function quotedPost(view, key, data, t, p, maxW) {
  const quoted = data?.post;
  if (!quoted) return [];
  const where = data.channel_display_name ? `Originally posted in ~${data.channel_display_name}` : "Originally posted";
  return [card(alpha(t.foreground, 0.2), t, [
    h_flex().gap(8).items_center().child(view.avatar(quoted.user_id, 20, t)).child(div().font_semibold().child(view.userName(quoted.user_id))),
    ...view.richText(key, quoted.message ?? "", t, p, maxW, view.keys.forPost(quoted)),
    div().id(`${key}-link`).text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.accent))
      .on_click((_e, cx) => view.follow(`${view.cfg.url}/${data.team_name ?? view.team.name}/pl/${quoted.id}`, cx)).child(where),
  ])];
}
