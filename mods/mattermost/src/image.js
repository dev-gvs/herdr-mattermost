// An opened image, as Mattermost's file preview modal draws it, and what the desktop app's right-click menu does
// to a picture: Save Image lands in the downloads folder under a name that's free, and Copy Image puts a bitmap on
// the clipboard.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, openOverlay, closeOverlay, exec, appHome, notify, readTextFile, run, settings, shared, spaces, theme } from "herdr";
import { FONT, alpha, fileSize, requestKey, sleep } from "../main.js";
import { FF_FORMATS, Media, openExternally, playExternally } from "./media.js";
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
// Mattermost's CODE_PREVIEW_MAX_FILE_SIZE, and MAX_HIGHLIGHTED_LENGTH, past which a file's language goes unnamed.
export const CODE_MAX_BYTES = 500000;
const NAMED_MAX = 5000;
const CODE_FONT = 13, CODE_LINE = "19px";
// Mattermost's FileInfoPreview: two 320×270 halves on white, whatever the theme.
const INFO_W = 320, INFO_H = 270, INFO_ICON = 80, NARROW = 768;

// Mattermost's HighlightedLanguages: the files its preview shows as code, and the name it gives each language.
const LANGUAGES = [
["1C:Enterprise", ["bsl", "os"]],
["ActionScript", ["as"]],
["AppleScript", ["applescript", "osascript", "scpt"]],
["Bash", ["sh"]],
["Clojure", ["clj", "boot", "cl2", "cljc", "cljs", "cljs.hl", "cljscm", "cljx", "hic"]],
["CoffeeScript", ["coffee", "_coffee", "cake", "cjsx", "cson", "iced"]],
["C/C++", ["cpp", "c", "cc", "h", "c++", "h++", "hpp"]],
["C#", ["cs", "csharp"]],
["CSS", ["css"]],
["D", ["d", "di"]],
["Dart", ["dart"]],
["Delphi", ["delphi", "dpr", "dfm", "pas", "pascal", "freepascal", "lazarus", "lpr", "lfm"]],
["Diff", ["diff", "patch"]],
["Django", ["django", "jinja"]],
["Dockerfile", ["dockerfile", "docker"]],
["Elixir", ["ex", "exs"]],
["Erlang", ["erl"]],
["Fortran", ["f90", "f95"]],
["F#", ["fsharp", "fs"]],
["G-Code", ["gcode", "nc"]],
["Go", ["go"]],
["Groovy", ["groovy"]],
["Handlebars", ["handlebars", "hbs", "html.hbs", "html.handlebars"]],
["Haskell", ["hs"]],
["Haxe", ["hx"]],
["Java", ["java", "jsp"]],
["JavaScript", ["js", "jsx"]],
["JSON", ["json"]],
["Julia", ["jl"]],
["Kotlin", ["kt", "ktm", "kts"]],
["LaTeX", ["tex"]],
["Less", ["less"]],
["Lisp", ["lisp"]],
["Lua", ["lua"]],
["Makefile", ["mk", "mak"]],
["Markdown", ["md", "mkdown", "mkd"]],
["Matlab", ["matlab", "m"]],
["Objective C", ["mm", "objc", "obj-c"]],
["OCaml", ["ml"]],
["Perl", ["perl", "pl"]],
["PostgreSQL", ["pgsql", "postgres", "postgresql"]],
["PHP", ["php", "php3", "php4", "php5", "php6"]],
["PowerShell", ["ps", "ps1"]],
["Puppet", ["pp"]],
["Python", ["py", "gyp"]],
["R", ["r"]],
["Ruby", ["ruby", "rb", "gemspec", "podspec", "thor", "irb"]],
["Rust", ["rs"]],
["Scala", ["scala"]],
["Scheme", ["scm", "sld"]],
["SCSS", ["scss"]],
["Smalltalk", ["st"]],
["SQL", ["sql"]],
["Stylus", ["styl"]],
["Swift", ["swift"]],
["Text", ["txt", "log"]],
["TypeScript", ["ts", "tsx"]],
["VB.Net", ["vbnet", "vb", "bas"]],
["VBScript", ["vbs"]],
["Verilog", ["v", "veo", "sv", "svh"]],
["VHDL", ["vhd", "vhdl"]],
["WebVTT", ["vtt"]],
["HTML, XML", ["xml", "html", "xhtml", "rss", "atom", "xsl", "plist"]],
["YAML", ["yaml"]]

];
export const codeLanguage = (ext) => LANGUAGES.find(([, list]) => list.includes((ext ?? "").toLowerCase()))?.[0] ?? null;

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
      if (what === "open") await openOriginal(panel, picture, cx);
      else if (what === "copy") await copyImage(panel, picture, cx);
      else if (what === "saveAs") await saveImageAs(panel, picture, cx);
      else await saveImage(panel, picture, cx);
    } catch (e) {
      const failed = { copy: "Couldn't copy the image", open: "Couldn't open the file" }[what] ?? (picture.kind && picture.kind !== "image" ? "Couldn't save the file" : "Couldn't save the image");
      notify({ title: failed, body: String(e?.message ?? e), level: "error" });
    }
  });
}

// The whole file rather than what's on screen, which for an attachment is the server's smaller preview.
async function original(panel, picture, cx) {
  const rel = picture.file ? await panel.media.download(panel.cfg, picture.file, (ms) => sleep(cx, ms)).catch(() => null) : picture.rel;
  if (!rel) throw new Error("The download failed.");
  return `${appHome()}/${rel}`;
}

async function openOriginal(panel, picture, cx) {
  const path = await original(panel, picture, cx);
  await (/^(video|audio)\//.test(picture.file?.mime_type ?? "") ? playExternally(path) : openExternally(path));
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
    this.texts = new Map();
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

  ask(what, item, cx) {
    if (this.standalone) handleImageRequest(this.view, { what, image: item }, cx);
    else request("image", { what, image: item });
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
        // The server refuses a public link to a file no post holds yet, such as one in a draft.
        .when(Boolean(publicLink && item.file && item.file.post_id !== ""), (el) => el.child(this.button("box-link", "link-variant", "Get a public link", (cx) => this.copyPublicLink(cx))))
        .child(this.button("box-download", "download-outline", "Download", (cx) => this.ask("save", item, cx)))
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

  // Mattermost's CodePreview, without the colours: the file's name and language over its lines and their numbers.
  code(item, maxW, maxH, cx) {
    const text = this.text(item, cx);
    if (text === undefined) return div().id(`box-${this.index}`).child("Loading");
    if (text === null) return this.info(item, maxW);
    const t = theme();
    const lines = text.split("\n").length;
    const title = text.length <= NAMED_MAX ? `${item.name} - ${item.lang}` : item.name;
    const mono = (el) => el.font_family(settings()?.font_family ?? "monospace").text_size(CODE_FONT).line_height(CODE_LINE).whitespace_nowrap();
    return v_flex().id(`box-${this.index}`).flex_none().min_w(330).max_w(Math.max(330, maxW)).max_h(Math.max(130, maxH)).rounded(8).overflow_hidden()
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.focus.focus(); })
      .on_click((_e, cx) => cx.stop_propagation())
      .child(div().flex_none().h(28).ml(4).px(8).py(4).rounded(4).truncate().text_center().text_size(14)
        .bg(alpha(t.foreground, 0.75)).text_color(t.background).child(title))
      .child(h_flex().id(`box-code-${this.index}`).flex_1().min_h(0).items_start().overflow_scroll().p(8.5).rounded(4)
        .border_1().border_color(alpha(t.foreground, 0.2)).bg(t.background).text_color(t.foreground)
        .child(mono(div()).flex_none().min_w(36).py(5).pr(8).mr(12).border_r_1().border_color("#cccccc3d").text_right().text_color("#cccccc")
          .child(Array.from({ length: lines }, (_v, i) => i + 1).join("\n")))
        .child(mono(div()).flex_none().py(5).child(text)));
  }

  // undefined while it's read, null when it can't be, which shows the file's details instead, as Mattermost does.
  text(item, cx) {
    const key = item.file.id;
    if (this.texts.has(key)) return this.texts.get(key);
    this.texts.set(key, undefined);
    cx.timer.after(0, (cx) => cx.spawn(async (cx) => {
      const text = await readTextFile(`${appHome()}/${item.rel}`).catch(() => null);
      this.texts.set(key, text === null ? null : text.replace(/\r\n/g, "\n"));
      cx.notify();
    }));
    return undefined;
  }

  // Mattermost's FileInfoPreview for what it can't show: the type's icon, which opens the file, then its name,
  // type and size. Below a phone's width the halves stack.
  info(item, width) {
    const narrow = width > 0 && width < NARROW;
    const facts = [item.extension ? `File type ${item.extension.toUpperCase()}` : "", item.size ? `Size ${fileSize(item.size)}` : ""].filter(Boolean).join(", ");
    const icon = div().id(`box-open-${this.index}`).flex().items_center().justify_center().flex_none().cursor_pointer()
      .when(narrow, (el) => el.w_full().h(150).border_b_1()).when(!narrow, (el) => el.w(INFO_W).h(INFO_H).border_r_1()).border_color("#3f43501f")
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.focus.focus(); })
      .on_click((_e, cx) => { cx.stop_propagation(); this.ask("open", item, cx); })
      .child(image(item.icon).w(narrow ? 64 : INFO_ICON).h((narrow ? 64 : INFO_ICON) * 1.25));
    return (narrow ? v_flex().w_full() : h_flex()).id(`box-${this.index}`).flex_none().bg(WHITE).text_size(14)
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.focus.focus(); })
      .on_click((_e, cx) => cx.stop_propagation())
      .child(icon)
      .child(div().flex_none().p(14).when(narrow, (el) => el.w_full()).when(!narrow, (el) => el.w(INFO_W).h(INFO_H))
        .child(div().my(5).text_size(16).text_color("#000000e6").child(item.name ?? ""))
        .child(div().text_color("#00000080").child(facts)));
  }

  content(item, maxW, maxH, width, cx) {
    if (item.kind === "code") return this.code(item, maxW, maxH, cx);
    if (item.kind === "info") return this.info(item, width - 2 * CONTENT_PAD);
    return this.picture(item, maxW, maxH);
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
        .child(this.content(item, width - 2 * CONTENT_PAD, height - HEADER_H - 2 * CONTENT_PAD, width, cx)));
  }
}
