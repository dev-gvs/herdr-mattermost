// The Profile Picture section, with choosing and uploading a file. fetch() sends only text, so the upload goes through curl with the token in its private config. A mod has no file picker:
// Herdr's is frame-only and pickFolder takes folders, so Select runs the desktop's own dialog (kdialog or
// zenity), and a picture can be dropped on the section or its path typed where neither is installed.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, home, readTextFile } from "herdr";
import { alpha } from "../main.js";
import { MAX_PIXELS } from "./media.js";
import { button, errorRow, Field, icon, hint } from "./setting_item.js";

const DIR = "data/mattermost";
const PRIVATE = `${DIR}/private`;
const SIZE = 128;
const POLL = 300;
const UPLOAD_SECONDS = 600;
const VALID_IMAGE = "Only BMP, JPG or PNG images may be used for profile pictures";
const TOO_LARGE = "Unable to upload profile image. File is too large.";
const HANDLED_EXTERNALLY = "This field is handled through your login provider. If you want to change it, you need to do so through your login provider.";
const ADMIN_MANAGED = "This field is managed by your System Admin. Contact them to request a change.";
// By the file's first bytes: a browser goes by its extension, and here that would only move the refusal to the server.
const TYPES = [["ffd8ff", "image/jpeg", "jpg"], ["89504e47", "image/png", "png"], ["424d", "image/bmp", "bmp"]];

export const FIND_CHOOSER = "command -v kdialog >/dev/null && echo kdialog || { command -v zenity >/dev/null && echo zenity; }";
// exec cuts a program off after 30s and people take longer than that in a file dialog, so it starts detached
// and leaves its answer in a file.
const CHOOSE = `nohup sh -c '[ -d "$2" ] || set -- "$1" "$HOME"
case "$0" in
  kdialog) kdialog --title Select --getopenfilename "$2" "Images (*.jpeg *.jpg *.png *.bmp)" ;;
  zenity) zenity --file-selection --title=Select --filename="$2/" "--file-filter=Images | *.jpeg *.jpg *.png *.bmp *.JPEG *.JPG *.PNG *.BMP" ;;
esac > "$1.part" 2>/dev/null
mv "$1.part" "$1"' "$1" "$2" "$3" >/dev/null 2>&1 &`;
const INSPECT = `[ -f "$1" ] && [ -r "$1" ] || exit 1
wc -c < "$1"
head -c 8 "$1" | od -An -tx1 | tr -d ' \\n'
echo
command -v ffprobe >/dev/null && ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$1" 2>/dev/null
exit 0`;
// Detached for the same reason: a large picture on a slow line outlasts exec. Never with -L, so the token
// doesn't follow a redirect.
const UPLOAD = `nohup sh -c 'curl -sS --config "$0" -m ${UPLOAD_SECONDS} -o "$1.body" -w "%{http_code}" -F "$2" "$3" > "$1.part" 2>"$1.err"
mv "$1.part" "$1"' "$1" "$2" "$3" "$4" >/dev/null 2>&1 &`;

export function fileSize(bytes) {
  for (const [unit, size] of [["TB", 1024 ** 4], ["GB", 1024 ** 3], ["MB", 1024 ** 2]]) {
    if (bytes > size) return `${bytes < size * 10 ? Math.round((bytes / size) * 10) / 10 : Math.round(bytes / size)}${unit}`;
  }
  return bytes > 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`;
}

const sleep = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
const remove = (...paths) => exec("rm", ["-f", ...paths]).catch(() => {});
// curl reads ; and , in a -F value as its own syntax, unless the value is quoted.
const formPart = (path, mime) => {
  const quoted = (text) => `"${text.replace(/["\\]/g, "\\$&")}"`;
  return `image=@${quoted(path)};type=${mime};filename=${quoted(path.split("/").pop())}`;
};

export class PictureSection {
  constructor(dialog) {
    this.d = dialog;
    this.pathField = null;
    this.reset();
  }

  reset() {
    this.file = null;
    this.setDefault = false;
    this.submitActive = false;
    this.loading = false;
    this.choosing = false;
    this.clientError = "";
    this.serverError = "";
  }

  leave() {
    if (this.file?.preview) remove(`${appHome()}/${this.file.preview}`);
    this.pathField?.dispose();
    this.pathField = null;
    this.reset();
  }

  async ensurePrivate() {
    await exec("mkdir", ["-p", "-m", "700", `${appHome()}/${PRIVATE}`]);
  }

  select(cx) {
    if (this.choosing || this.loading) return;
    this.choosing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const tool = (await exec("sh", ["-c", FIND_CHOOSER]).catch(() => null))?.stdout.trim();
        if (!tool) {
          this.pathField ??= new Field({ placeholder: "/path/to/picture.png", onSubmit: (cx) => this.useTyped(cx) });
          this.pathField.focus();
          return;
        }
        await this.ensurePrivate();
        const out = `${appHome()}/${PRIVATE}/choose-${Date.now()}`;
        await exec("sh", ["-c", CHOOSE, "sh", tool, out, `${home()}/Pictures`]);
        while (!this.d.closed) {
          await sleep(cx, POLL);
          const answer = await readTextFile(out).catch(() => null);
          if (answer === null) continue;
          await remove(out);
          const path = answer.trim();
          if (path && !this.d.closed) await this.useFile(path, cx);
          return;
        }
      } finally {
        this.choosing = false;
        if (!this.d.closed) cx.notify();
      }
    });
  }

  useTyped(cx) {
    const typed = this.pathField.value.trim();
    if (!typed) return;
    cx.spawn(async (cx) => this.useFile(typed.replace(/^~(?=\/)/, home()), cx));
  }

  // The file is copied beside the login's other private files because image() draws only from the app's own
  // folder. Herdr keeps every decoded image until it quits, so one that would cost gigabytes shows no preview.
  async useFile(path, cx) {
    const r = await exec("sh", ["-c", INSPECT, "sh", path]).catch(() => null);
    if (!r || r.code !== 0) {
      this.clientError = "That file can't be read.";
      this.file = null;
      this.submitActive = false;
      cx.notify();
      return;
    }
    const [size, head, dims = ""] = r.stdout.split("\n");
    const type = TYPES.find(([magic]) => head.startsWith(magic));
    const [w, h] = dims.split(",").map(Number);
    let preview = null;
    if (type && !(w * h > MAX_PIXELS) && Number(size) <= this.d.maxFileSize()) {
      await this.ensurePrivate();
      preview = `${PRIVATE}/picture-${Date.now()}.${type[2]}`;
      if ((await exec("cp", [path, `${appHome()}/${preview}`]).catch(() => null))?.code !== 0) preview = null;
    }
    if (this.file?.preview) remove(`${appHome()}/${this.file.preview}`);
    this.file = { path, name: path.split("/").pop(), size: Number(size), mime: type?.[1] ?? null, ext: type?.[2], preview };
    this.submitActive = true;
    this.setDefault = false;
    this.clientError = "";
    this.serverError = "";
    cx.notify();
  }

  save(cx) {
    if (this.loading) return;
    if (this.setDefault) this.removePicture(cx);
    else this.submit(cx);
  }

  removePicture(cx) {
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        await this.d.view.api(cx, `/users/${this.d.user.id}/image`, { method: "DELETE" });
        this.d.pictureChanged(0, cx, null);
      } catch (e) {
        this.serverError = e?.text ?? String(e?.message ?? e);
        this.loading = false;
        cx.notify();
      }
    });
  }

  submit(cx) {
    if (!this.file || !this.submitActive) return;
    if (!this.file.mime) {
      this.clientError = VALID_IMAGE;
      this.serverError = "";
      cx.notify();
      return;
    }
    if (this.file.size > this.d.maxFileSize()) {
      this.clientError = TOO_LARGE;
      this.serverError = "";
      cx.notify();
      return;
    }
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        if (this.d.view.cfg.demo) {
          const kept = `${DIR}/avatars/demo-${Date.now()}.${this.file.ext}`;
          await exec("mkdir", ["-p", `${appHome()}/${DIR}/avatars`]);
          await exec("cp", [this.file.path, `${appHome()}/${kept}`]);
          this.d.pictureChanged(Date.now(), cx, kept);
          return;
        }
        await this.upload(cx);
        let stamp = Date.now();
        try { stamp = (await this.d.view.api(cx, "/users/me")).last_picture_update ?? stamp; } catch {}
        this.d.pictureChanged(stamp, cx, null);
      } catch (e) {
        const keep = e?.text ?? String(e?.message ?? e);
        if (this.file?.preview) remove(`${appHome()}/${this.file.preview}`);
        this.reset();
        this.serverError = keep;
        cx.notify();
      }
    });
  }

  async upload(cx) {
    const cfg = this.d.view.cfg;
    const auth = await this.d.media.auth(cfg);
    const out = `${appHome()}/${PRIVATE}/upload-${Date.now()}`;
    await exec("sh", ["-c", UPLOAD, "sh", auth, out, formPart(this.file.path, this.file.mime), `${cfg.url}/api/v4/users/${this.d.user.id}/image`]);
    const deadline = Date.now() + (UPLOAD_SECONDS + 60) * 1000;
    try {
      while (Date.now() < deadline) {
        await sleep(cx, POLL);
        const code = await readTextFile(out).catch(() => null);
        if (code === null) continue;
        if (code.trim() === "200") return;
        const body = await readTextFile(`${out}.body`).catch(() => null);
        let message = null;
        try { message = JSON.parse(body ?? "null")?.message; } catch {}
        const failed = message ?? (await readTextFile(`${out}.err`).catch(() => null))?.trim();
        throw new Error(failed || `Upload failed (HTTP ${code.trim()})`);
      }
      throw new Error("The upload timed out.");
    } finally {
      await remove(out, `${out}.body`, `${out}.err`);
    }
  }

  picture(t, canSubmit) {
    const u = this.d.user, media = this.d.media;
    const round = (path) => (path ? image(path).size(SIZE).flex_none().rounded_full() : div().size(SIZE).flex_none().rounded_full().bg(alpha(t.foreground, 0.08)));
    if (this.file) return round(this.file.preview);
    if (this.setDefault) return round(this.d.view.cfg?.demo ? `mods/mattermost/demo/avatars/${u.id}.png` : media.path(`${DIR}/avatars/${u.id}-default.png`, `/users/${u.id}/image/default`));
    const own = this.d.view.cfg?.demo ? this.d.demoAvatar : media.avatar(u);
    if (!canSubmit || !(u.last_picture_update > 0)) return round(own);
    return div().relative().size(SIZE).flex_none().child(round(own))
      .child(div().id("pf-picture-remove").absolute().top(4).right(8).size(26).flex().items_center().justify_center().rounded_full().cursor_pointer()
        .bg("#000000").text_color("#ffffff").tooltip("Remove Profile Picture")
        .hover((s) => s.bg(t.accent))
        .on_click((_e, cx) => { this.setDefault = true; cx.notify(); })
        .child(svg(icon("x")).size(16)));
  }

  draw(t) {
    const u = this.d.user;
    const lockedByProvider = (u.auth_service === "ldap" || u.auth_service === "saml") && this.d.config.LdapPictureAttributeSet === "true";
    const locked = !lockedByProvider && this.d.isLocked("picture");
    const canSubmit = !lockedByProvider && !locked;
    const help = lockedByProvider ? HANDLED_EXTERNALLY : locked ? ADMIN_MANAGED
      : `Upload a picture in BMP, JPG, JPEG, or PNG format. Maximum file size: ${fileSize(this.d.maxFileSize())}`;
    const canSave = this.submitActive || this.setDefault;
    const errors = [this.clientError, this.serverError].filter(Boolean);
    return v_flex().id("pf-max-picture").w_full().p(12).bg(alpha(t.foreground, 0.04))
      .when(canSubmit, (el) => el.on_drop((e, cx) => { if (e.paths[0] && !this.loading) cx.spawn(async (cx) => this.useFile(e.paths[0], cx)); }))
      .child(div().w_full().child("Profile Picture"))
      .child(v_flex().w_full().pt(20).pl(80)
        .child(div().w_full().mt(7).child(this.picture(t, canSubmit)))
        .when(Boolean(this.file), (el) => el.child(div().w_full().mt(8).text_size(12).truncate().text_color(alpha(t.foreground, 0.75)).child(this.file.name)))
        .child(div().w_full().mt(7).pt(12).child(help))
        .when(canSubmit, (el) => el.child(hint(t, this.pathField ? "Neither kdialog nor zenity is installed, so type the picture's path and press Enter, or drop it here." : "You can also drop a picture here.").mt(8).text_size(12)))
        .when(Boolean(this.pathField), (el) => el.child(div().w_full().mt(8).child(this.pathField.draw(t, "pf-picture-path"))))
        .child(div().w_full().h(1).my(24).bg(alpha(t.foreground, 0.12)))
        .when(errors.length > 0, (el) => el.child(v_flex().w_full().mb(16).gap(4).children(errors.map((text) => errorRow(t, text)))))
        .child(h_flex().w_full().gap(8)
          .when(canSubmit, (el) => el
            .child(button(t, "pf-picture-select", "Select", (_e, cx) => this.select(cx), { enabled: !this.loading && !this.choosing }))
            .child(button(t, "pf-picture-save", this.loading ? "Uploading..." : "Save", (_e, cx) => this.save(cx), { enabled: canSave && !this.loading })))
          .child(button(t, "pf-picture-cancel", "Cancel", (_e, cx) => this.d.openSection("", cx), { emphasis: "tertiary" }))));
  }
}
