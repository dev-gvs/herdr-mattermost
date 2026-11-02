// An opened image, as Mattermost's file preview modal draws it, and what the desktop app's right-click menu does
// to a picture: Save Image lands in the downloads folder under a name that's free, and Copy Image puts a bitmap on
// the clipboard.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, openOverlay, closeOverlay, exec, appHome, notify, readTextFile, run, settings, shared, spaces } from "herdr";
import { FONT, requestKey, sleep } from "../main.js";
import { FF_FORMATS, Media } from "./media.js";
import { Menu, request } from "./menu.js";
import { FIND_CHOOSER } from "./picture.js";

const WHITE = "#ffffff";
const HEADER_H = 72, CONTENT_PAD = 48, NAME_SHARE = 0.3;
const POLL = 300;
const FOCUS_LATER = 100;
const PRIVATE = "data/mattermost/private";
// Characters, not bytes: at three bytes each, with a counter added, this still fits a file name's 255 bytes.
const MAX_NAME = 80;
const OWN_REQUESTS = "mattermost.image-request";

const FIND_DOWNLOADS = `dir=$(xdg-user-dir DOWNLOAD 2>/dev/null)
dir=\${dir%/}
[ -n "$dir" ] && [ "$dir" != "$HOME" ] || dir=$HOME/Downloads`;
const DOWNLOADS = `${FIND_DOWNLOADS}
printf %s "$dir"`;
const SAVE = `${FIND_DOWNLOADS}
mkdir -p "$dir" || exit 1
case "$2" in
  ?*.*) base=\${2%.*}; ext=.\${2##*.} ;;
  *) base=$2; ext= ;;
esac
path=$dir/$2
n=0
while [ -e "$path" ]; do
  n=$((n + 1))
  path="$dir/$base ($n)$ext"
done
cp -- "$1" "$path" && printf %s "$path"`;
// exec cuts a program off after 30s and people take longer than that in a file dialog, so it starts detached
// and leaves its answer in a file.
const CHOOSE = `nohup sh -c 'case "$0" in
  kdialog) kdialog --title "Save Image As" --getsavefilename "$2" ;;
  zenity) zenity --file-selection --save --confirm-overwrite --title="Save Image As" --filename="$2" ;;
esac > "$1.part" 2>/dev/null
mv "$1.part" "$1"' "$1" "$2" "$3" >/dev/null 2>&1 &`;
// Chromium-based apps read only image/png from the clipboard, so a JPEG copied as it is wouldn't paste there.
// From stdin, because a file named .jpg would be read through ffmpeg's image2 format, which the list leaves out.
const COPY = `[ -f "$1" ] || exit 1
if command -v ffmpeg >/dev/null; then
  tmp=$(mktemp --suffix=.png) || exit 1
  if ffmpeg -nostdin -loglevel error -y -protocol_whitelist pipe ${FF_FORMATS} -i pipe:0 -frames:v 1 "$tmp" < "$1"; then
    wl-copy --type image/png < "$tmp" >/dev/null 2>&1
    got=$?
    rm -f "$tmp"
    exit $got
  fi
  rm -f "$tmp"
fi
wl-copy < "$1" >/dev/null 2>&1`;

// CSS's text-transform: capitalize, which Mattermost gives the line under the file name.
const capitalize = (text) => text.replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_m, before, letter) => before + letter.toUpperCase());

function fit(w, h, maxW, maxH) {
  const scale = Math.min(1, maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

// The name comes from whoever posted the file, and it's about to become a path.
function safeName(name) {
  const clean = String(name ?? "").replace(/[\/\\\u0000-\u001f]+/g, "_").replace(/^[.\s]+/, "").trim() || "image";
  if (clean.length <= MAX_NAME) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : "";
  return clean.slice(0, MAX_NAME - ext.length) + ext;
}

// The last part of the address, also through the server's image proxy, which keeps the real one in `url=`.
export function imageName(url) {
  const decode = (text) => { try { return decodeURIComponent(text); } catch { return text; } };
  const proxied = /\/api\/v4\/image\?url=([^&]+)/.exec(url);
  const address = proxied ? decode(proxied[1]) : url;
  return decode(address.split(/[?#]/)[0].split("/").pop()) || "image";
}

export function imageEntries(spec, close) {
  const { image: picture, viewer } = spec;
  const ask = (what) => () => {
    request("image", { what, image: picture, viewer: viewer?.spec.id });
    close();
  };
  const items = [
    { label: "Save Image", run: ask("save") },
    { label: "Save Image As…", run: ask("saveAs") },
    { label: "Copy Image", run: ask("copy") },
  ];
  // The desktop app adds these for a link to its own server, and only the modal's picture sits inside one.
  if (viewer && picture.file) {
    items.push("sep",
      // A tab has to go in a space, and a layout of nothing but this panel has none.
      { label: "Open in new tab", disabled: !spaces().length, run: () => { openElsewhere("tab", viewer); close(); } },
      { label: "Open in new window", run: () => { openElsewhere("window", viewer); close(); } });
  }
  return items;
}

function openElsewhere(where, { overlay, spec }) {
  const item = spec.items[spec.index];
  const shown = { demo: props().demo, requestTo: OWN_REQUESTS, lightbox: { ...spec, id: `${Date.now()}-${Math.random()}`, window: where === "window" } };
  if (where === "tab") run("tab.new", { name: item.name, mod: "mattermost", props: shown });
  else openOverlay({ mod: "mattermost", kind: "window", key: `mattermost-image-${item.file.id}`, width: 0.7, height: 0.8, props: shown });
  if (overlay) closeOverlay(overlay);
}

// The panel does this for its popups and the modal, because a download outlives them.
export function handleImageRequest(panel, { what, image: picture }, cx) {
  cx.spawn(async (cx) => {
    try {
      await panel.cfgReady;
      if (what === "copy") await copyImage(panel, picture, cx);
      else if (what === "saveAs") await saveImageAs(panel, picture, cx);
      else await saveImage(panel, picture, cx);
    } catch (e) {
      notify({ title: what === "copy" ? "Couldn't copy the image" : "Couldn't save the image", body: String(e?.message ?? e), level: "error" });
    }
  });
}

// The whole file rather than what's on screen, which for an attachment is the server's smaller preview.
async function original(panel, picture, cx) {
  const rel = picture.file ? await panel.media.download(panel.cfg, picture.file, (ms) => sleep(cx, ms)).catch(() => null) : picture.rel;
  if (!rel) throw new Error("The download failed.");
  return `${appHome()}/${rel}`;
}

async function saveImage(panel, picture, cx, title = "Download Complete", note = null) {
  const source = await original(panel, picture, cx);
  const r = await exec("sh", ["-c", SAVE, "sh", source, safeName(picture.name)]);
  if (r.code !== 0 || !r.stdout) throw new Error(r.stderr?.trim() || "The copy to the downloads folder failed.");
  notify({ title, body: note ?? r.stdout, level: "success" });
}

async function saveImageAs(panel, picture, cx) {
  const tool = (await exec("sh", ["-c", FIND_CHOOSER]).catch(() => null))?.stdout.trim();
  // A toast shows one line of its body, so the reason takes the place of the path.
  if (!tool) return saveImage(panel, picture, cx, "Saved to the downloads folder", "Neither kdialog nor zenity is installed");
  await exec("mkdir", ["-p", "-m", "700", `${appHome()}/${PRIVATE}`]);
  const out = `${appHome()}/${PRIVATE}/save-${Date.now()}`;
  const dir = (await exec("sh", ["-c", DOWNLOADS])).stdout;
  await exec("sh", ["-c", CHOOSE, "sh", tool, out, `${dir}/${safeName(picture.name)}`]);
  for (;;) {
    await sleep(cx, POLL);
    const answer = await readTextFile(out).catch(() => null);
    if (answer === null) continue;
    await exec("rm", ["-f", out]).catch(() => {});
    const path = answer.trim();
    if (!path) return;
    const source = await original(panel, picture, cx);
    const r = await exec("cp", ["--", source, path]);
    if (r.code !== 0) throw new Error(r.stderr?.trim() || `The copy to ${path} failed.`);
    notify({ title: "Download Complete", body: path, level: "success" });
    return;
  }
}

async function copyImage(panel, picture, cx) {
  const source = await original(panel, picture, cx);
  const r = await exec("sh", ["-c", COPY, "sh", source]);
  if (r.code !== 0) throw new Error(r.stderr?.trim() || "wl-copy failed.");
}

// At the press rather than at "pointer", which Herdr doesn't update while a dialog covers the window.
export function openImageMenu(spec, at) {
  const menu = { kind: "image", ...spec };
  const { width, height } = Menu.size(menu);
  return openOverlay({ mod: "mattermost", kind: "popup", frame: "none", width, height, at, props: { demo: props()?.demo, requestTo: requestKey(), menu } });
}

export class Lightbox {
  constructor(view, cx) {
    this.view = view;
    this.spec = props().lightbox;
    this.index = this.spec.index ?? 0;
    this.size = null;
    this.focus = cx.focus_handle();
    this.focus.focus();
    // A floating window doesn't take the keyboard when it opens, and the menu that opened it is still closing.
    if (this.spec.window) cx.timer.after(FOCUS_LATER, () => this.focus.focus());
    // A tab or window outlives the modal, and the panel may be in a layout that isn't showing.
    this.standalone = Boolean(this.spec.id);
    if (!this.standalone) return;
    view.media = new Media();
    view.media.demo = Boolean(props().demo);
    this.seenRequest = shared(requestKey())?.id;
  }

  save(item, cx) {
    if (this.standalone) handleImageRequest(this.view, { what: "save", image: item }, cx);
    else request("image", { what: "save", image: item });
  }

  close() {
    closeOverlay(props().overlay);
  }

  step(by, cx) {
    const total = this.spec.items.length;
    if (total < 2) return;
    this.index = (this.index + by + total) % total;
    cx.notify();
  }

  copyPublicLink(cx) {
    const { file } = this.spec.items[this.index];
    cx.spawn(async (cx) => {
      try {
        await this.view.cfgReady;
        const { link } = await this.view.api(cx, `/files/${file.id}/link`);
        cx.write_to_clipboard(link);
        // Mattermost says this in the button's tooltip, but one already showing doesn't change here.
        notify({ title: "Public link copied", level: "success" });
      } catch (e) {
        notify({ title: "Couldn't get a public link", body: e?.text ?? String(e?.message ?? e), level: "error" });
      }
    });
  }

  // A button acts on the press: a floating window drags by any press that isn't stopped, and a stopped press
  // never becomes a click.
  button(id, icon, tip, act) {
    return div().id(id).size(40).flex().flex_none().items_center().justify_center().rounded(4).cursor_pointer().text_color(WHITE)
      .hover((s) => s.bg("#ffffff29")).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.focus.focus(); act(cx); })
      .child(svg(`mods/mattermost/icons/${icon}.svg`).size(24));
  }

  header(item, width) {
    const { author, avatar, channel, items, publicLink } = this.spec;
    const shared = channel ? `Shared in ~${channel}` : "";
    const limit = (el) => (width > 0 ? el.max_w(width * NAME_SHARE) : el);
    return h_flex().flex_none().w_full().h(HEADER_H).p(16).items_center().bg("#000000").text_color(WHITE)
      .child(h_flex().flex_1().min_w(0).items_center()
        .when(Boolean(avatar), (el) => el.child(image(avatar).size(40).flex_none().rounded_full()))
        .child(v_flex().min_w(0).ml(12)
          .child(limit(div()).truncate().text_size(16).font_semibold().line_height("24px").child(item.name ?? ""))
          .child(limit(h_flex()).overflow_hidden().text_size(14)
            .child(div().flex_none().child(capitalize(author ?? "")))
            .when(Boolean(shared), (el) => el.child(div().ml(8).min_w(0).truncate().text_color("#ffffffbf").child(capitalize(shared)))))))
      .when(items.length > 1, (el) => el.child(h_flex().flex_none().items_center().text_size(16).font_semibold()
        .child(this.button("box-prev", "chevron-left", "Previous", (cx) => this.step(-1, cx)).mr(12))
        .child(`${this.index + 1} of ${items.length}`)
        .child(this.button("box-next", "chevron-right", "Next", (cx) => this.step(1, cx)).ml(12))))
      .child(h_flex().flex_1().min_w(0).justify_end().items_center().gap(8)
        .when(Boolean(publicLink && item.file), (el) => el.child(this.button("box-link", "link-variant", "Get a public link", (cx) => this.copyPublicLink(cx))))
        .child(this.button("box-download", "download-outline", "Download", (cx) => this.save(item, cx)))
        // In a tab, the tab bar closes it.
        .when(Boolean(props().overlay), (el) => el.child(this.button("box-close", "x", "Close", () => this.close()))));
  }

  picture(item, maxW, maxH) {
    const box = item.w && item.h && maxW > 0 && maxH > 0 ? fit(item.w, item.h, maxW, maxH) : null;
    const viewer = { overlay: this.spec.window ? null : props().overlay ?? null, spec: { ...this.spec, index: this.index } };
    return div().id(`box-${this.index}`).flex_none()
      .when(Boolean(box), (el) => el.w(box.w).h(box.h))
      .when(!box, (el) => el.size_full())
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.focus.focus(); })
      .on_mouse_down("right", (e, cx) => { cx.stop_propagation(); openImageMenu({ image: item, viewer }, e.position); })
      .child(image(item.path).size_full().rounded(8));
  }

  render(cx) {
    if (this.standalone) {
      const req = shared(requestKey());
      if (req?.id && req.id !== this.seenRequest) {
        this.seenRequest = req.id;
        if (req.viewer === this.spec.id) cx.timer.after(0, (cx) => handleImageRequest(this.view, req, cx));
      }
    }
    const item = this.spec.items[this.index];
    const zoom = Number(settings()?.zoom) || 1;
    const width = (this.size?.width ?? 0) / zoom, height = (this.size?.height ?? 0) / zoom;
    // Only the modal closes on a click beside the picture.
    const closes = Boolean(props().overlay) && !this.spec.window;
    return v_flex().id("mm-lightbox").size_full().font_family(FONT).text_size(14).text_color(WHITE)
      .track_focus(this.focus)
      .on_mouse_down("left", () => this.focus.focus())
      .on_size_change((size, cx) => {
        if (size.width === this.size?.width && size.height === this.size?.height) return;
        this.size = size;
        cx.notify();
      })
      .on_key_down((e, cx) => {
        if (e.keystroke === "right") this.step(1, cx);
        else if (e.keystroke === "left") this.step(-1, cx);
        else if (e.keystroke === "escape" && this.spec.window) this.close();
      })
      .child(this.header(item, width))
      .child(div().id("box-content").flex_1().min_h(0).w_full().flex().items_center().justify_center().p(CONTENT_PAD).bg("#000000e6")
        .when(closes, (el) => el.on_click(() => this.close()))
        .child(this.picture(item, width - 2 * CONTENT_PAD, height - HEADER_H - 2 * CONTENT_PAD)));
  }
}
