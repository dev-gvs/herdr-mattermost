// The Profile modal, drawn by a dialog copy of this mod: a sidebar with Profile Settings and Security, and a
// list of sections that open one at a time. This file has the modal and Profile Settings; security.js has the
// other tab and picture.js the picture section. The panel gets what changed through a request, the same way as from the server's user_updated event. A request
// is written to shared state, which Herdr keeps on disk, so a password or token never goes in one.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { props, closeOverlay, openOverlay, theme, exec, appHome } from "herdr";
import { FONT, alpha } from "../main.js";
import { request } from "./menu.js";
import { Media } from "./media.js";
import { PictureSection } from "./picture.js";
import { SecurityTab } from "./security.js";
import { icon, errorText, shortDate, sectionMin, sectionMax, formRow, Field, selectBox, confirmLayer, closeButton, dividerDark, dividerLight, tabHeader } from "./setting_item.js";

const PROFILE_W = 800, PROFILE_H = 0.9;
const DEFAULT_MAX_FILE = 100 * 1024 * 1024;
const OAUTH_SERVICES = ["gitlab", "google", "office365", "openid"];
const RESERVED_USERNAMES = ["valet", "all", "channel", "here", "matterbot", "system"];
const MIN_USERNAME = 3, MAX_USERNAME = 22, MAX_NAME = 64, MAX_NICKNAME = 64, MAX_POSITION = 128, MAX_EMAIL = 128, MAX_ATTRIBUTE = 64;
const ENTERPRISE_SKUS = ["enterprise", "E20", "advanced", "entry"];
const PATCHED = ["username", "first_name", "last_name", "nickname", "position", "email", "last_picture_update"];
const WRONG_PASSWORD = "api.user.check_user_password.invalid.app_error";
const GROUP_CONFLICT = "app.user.group_name_conflict";

const HANDLED_EXTERNALLY = "This field is handled through your login provider. If you want to change it, you need to do so through your login provider.";
const ADMIN_MANAGED = "This field is managed by your System Admin. Contact them to request a change.";
const EMAIL_VERIFICATION_REQUIRED = "Check your email inbox to verify the address.";
const USERNAME_RESERVED = "This username is reserved, please choose a new one.";
const USERNAME_RULES = `Username must begin with a letter, and contain between ${MIN_USERNAME} to ${MAX_USERNAME} lowercase characters made up of numbers, letters, and the symbols '.', '-', and '_'.`;
const VALID_EMAIL = "Please enter a valid email address.";
const VALID_URL = "Please enter a valid url.";
const PROVIDERS = { gitlab: "GitLab", google: "Google", office365: "Entra ID", openid: "OpenID Connect", ldap: "AD/LDAP", saml: "SAML" };

function usernameProblem(name) {
  if (!name || name.length < MIN_USERNAME || name.length > MAX_USERNAME || !/^[a-z0-9.\-_]+$/.test(name) || !/[a-z]/.test(name.charAt(0))) return USERNAME_RULES;
  return RESERVED_USERNAMES.includes(name) ? USERNAME_RESERVED : null;
}
const isEmail = (text) => /^[^ ,@]+@[^ ,@]+$/.test(text);
const httpUrl = (text) => {
  const link = /^!?[a-z0-9+.-]+:/i.test(text) ? text : `https://${text}`;
  return /^https?:\/\//i.test(link) ? link : null;
};
const joined = (names) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`);
const attributeLabel = (f) => f.attrs?.display_name?.trim() || f.name;
const hasOptions = (f) => f.type === "select" || f.type === "multiselect";
const optionName = (f, id) => f.attrs?.options?.find((o) => o.id === id)?.name ?? id;

// Modal, so a stray click beside it can't lose a new token that's only shown once.
export const openProfileDialog = (spec) => openOverlay({ mod: "mattermost", kind: "dialog", modal: true, width: PROFILE_W, height: PROFILE_H, props: spec });

class GeneralTab {
  constructor(dialog) {
    this.d = dialog;
    this.fields = {};
    this.saving = false;
    this.serverError = "";
    this.picture = new PictureSection(dialog);
    this.attributes = [];
    this.values = {};
    this.draft = null;
    this.menuOpen = false;
  }

  enter(section) {
    const u = this.d.user;
    const submit = (cx) => this.submit(section, cx);
    const lock = this.nameLocks();
    if (section === "name" && !lock.external && !(lock.first && lock.last)) {
      this.fields = {
        first: new Field({ value: u.first_name ?? "", max: MAX_NAME, disabled: lock.first, onSubmit: submit }),
        last: new Field({ value: u.last_name ?? "", max: MAX_NAME, disabled: lock.last, onSubmit: submit }),
      };
      (lock.first ? this.fields.last : this.fields.first).focus();
    } else if (section === "username" && !this.d.isLocked("username") && u.auth_service === "") {
      this.fields = { username: new Field({ value: u.username ?? "", max: MAX_USERNAME, validate: usernameProblem, onSubmit: submit }) };
      this.fields.username.focus();
    } else if (section === "nickname" && !this.externalAttribute("Nickname") && !this.d.isLocked("nickname")) {
      this.fields = { nickname: new Field({ value: u.nickname ?? "", max: MAX_NICKNAME, onSubmit: submit }) };
      this.fields.nickname.focus();
    } else if (section === "position" && !this.externalAttribute("Position") && !this.d.isLocked("position")) {
      this.fields = { position: new Field({ value: u.position ?? "", max: MAX_POSITION, onSubmit: submit }) };
      this.fields.position.focus();
    } else if (section === "email" && u.auth_service === "") {
      this.fields = {
        email: new Field({ max: MAX_EMAIL, onSubmit: submit, validate: (v) => (v === "" || !isEmail(v) ? VALID_EMAIL : null) }),
        confirm: new Field({ max: MAX_EMAIL, onSubmit: submit, validate: (v) => (this.fields.email.value !== v ? "The new emails you entered do not match." : null) }),
        password: new Field({ masked: true, onSubmit: submit, validate: (v) => (v === "" ? "Please enter your current password." : null) }),
      };
      this.fields.email.focus();
    } else if (section.startsWith("attr-")) {
      const f = this.attributes.find((a) => `attr-${a.id}` === section);
      if (f && !this.attributeReadOnly(f)) {
        this.draft = this.values[f.id] ?? (f.type === "multiselect" ? [] : "");
        if (!hasOptions(f)) {
          this.fields = { value: new Field({ value: String(this.draft), max: MAX_ATTRIBUTE, onSubmit: submit, validate: (v) => this.attributeProblem(f, v) }) };
          this.fields.value.focus();
        }
      }
    }
  }

  leave() {
    for (const field of Object.values(this.fields)) field.dispose();
    this.fields = {};
    this.saving = false;
    this.serverError = "";
    this.draft = null;
    this.menuOpen = false;
    this.picture.leave();
  }

  nameLocks() {
    const u = this.d.user, c = this.d.config, lock = this.d.isLocked("name");
    return {
      first: lock && u.first_name !== "",
      last: lock && u.last_name !== "",
      external: (u.auth_service === "ldap" && (c.LdapFirstNameAttributeSet === "true" || c.LdapLastNameAttributeSet === "true"))
        || (u.auth_service === "saml" && (c.SamlFirstNameAttributeSet === "true" || c.SamlLastNameAttributeSet === "true"))
        || OAUTH_SERVICES.includes(u.auth_service),
    };
  }

  externalAttribute(name) {
    const u = this.d.user, c = this.d.config;
    return (u.auth_service === "ldap" && c[`Ldap${name}AttributeSet`] === "true") || (u.auth_service === "saml" && c[`Saml${name}AttributeSet`] === "true");
  }

  submit(section, cx) {
    const u = this.d.user, f = this.fields;
    if (section === "name") return this.patch(cx, { first_name: f.first.value.trim(), last_name: f.last.value.trim() });
    if (section === "username") return this.patch(cx, { username: f.username.value.trim().toLowerCase() });
    if (section === "nickname") return this.patch(cx, { nickname: f.nickname.value.trim() });
    if (section === "position") return this.patch(cx, { position: f.position.value.trim() });
    if (section === "email") {
      const email = f.email.value.trim().toLowerCase(), confirm = f.confirm.value.trim().toLowerCase();
      if (email === u.email && (confirm === "" || confirm === u.email)) return this.d.openSection("", cx);
      return this.patch(cx, { email, password: f.password.value }, true);
    }
    if (section.startsWith("attr-")) return this.saveAttribute(this.attributes.find((a) => `attr-${a.id}` === section), cx);
    return undefined;
  }

  // Only what changed goes to the server, which is what Mattermost's whole-user patch comes to, since the
  // server leaves alone every field that matches.
  patch(cx, body, emailUpdated = false) {
    if (this.saving) return;
    const u = this.d.user;
    if (!emailUpdated && Object.keys(body).every((k) => (u[k] ?? "") === body[k])) {
      this.d.openSection("", cx);
      return;
    }
    this.saving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        const saved = await this.d.view.api(cx, "/users/me/patch", { method: "PUT", body });
        this.d.applyUser(saved);
        if (emailUpdated && this.d.config.RequireEmailVerification === "true") this.d.notice = EMAIL_VERIFICATION_REQUIRED;
        this.d.openSection("", cx);
      } catch (e) {
        this.serverError = e?.id === WRONG_PASSWORD ? "Your password is incorrect."
          : e?.id === GROUP_CONFLICT ? "This username conflicts with an existing group name." : errorText(e);
        this.saving = false;
        cx.notify();
      }
    });
  }

  section(t, id, title, describe, max) {
    if (this.d.section === id) return max(t);
    return sectionMin(t, id, {
      title, describe,
      hovered: this.d.hover === id,
      onHover: (on, cx) => this.d.setHover(id, on, cx),
      onOpen: (_e, cx) => this.d.openSection(id, cx),
    });
  }

  max(t, id, title, options) {
    return sectionMax(t, id, {
      title,
      saving: this.saving,
      error: this.serverError,
      cancel: (cx) => this.d.openSection("", cx),
      ...options,
    });
  }

  nameMax(t) {
    const lock = this.nameLocks();
    if (lock.external) return this.max(t, "name", "Full Name", { extra: HANDLED_EXTERNALLY });
    if (lock.first && lock.last) return this.max(t, "name", "Full Name", { extra: ADMIN_MANAGED });
    return this.max(t, "name", "Full Name", {
      inputs: [formRow(t, "First Name", this.fields.first?.draw(t, "pf-first")), formRow(t, "Last Name", this.fields.last?.draw(t, "pf-last"))],
      // Mattermost links Notifications to its tab, which the panel doesn't have.
      extra: lock.first || lock.last ? ADMIN_MANAGED : "By default, you will receive mention notifications when someone types your first name. Go to Notifications settings to change this default.",
      submit: (cx) => this.submit("name", cx),
    });
  }

  usernameMax(t) {
    const u = this.d.user;
    if (this.d.isLocked("username")) return this.max(t, "username", "Username", { extra: ADMIN_MANAGED });
    if (u.auth_service !== "") return this.max(t, "username", "Username", { extra: HANDLED_EXTERNALLY });
    return this.max(t, "username", "Username", {
      inputs: [formRow(t, "Username", this.fields.username?.draw(t, "pf-username"))],
      extra: "Pick something easy for teammates to recognize and recall.",
      valid: this.fields.username ? usernameProblem(this.fields.username.value) === null : true,
      submit: (cx) => this.submit("username", cx),
    });
  }

  simpleMax(t, id, title, external, extra) {
    if (external) return this.max(t, id, title, { extra: HANDLED_EXTERNALLY });
    if (this.d.isLocked(id)) return this.max(t, id, title, { extra: ADMIN_MANAGED });
    return this.max(t, id, title, { inputs: [formRow(t, title, this.fields[id]?.draw(t, `pf-${id}`))], extra, submit: (cx) => this.submit(id, cx) });
  }

  emailValid() {
    const f = this.fields;
    if (!f.email) return false;
    const email = f.email.value.trim().toLowerCase();
    return email !== "" && isEmail(email) && email === f.confirm.value.trim().toLowerCase() && f.password.value !== "";
  }

  emailMax(t) {
    const u = this.d.user;
    const help = this.d.config.RequireEmailVerification === "true"
      ? "Email is used for sign-in, notifications, and password reset. Email requires verification if changed."
      : "Email is used for sign-in, notifications, and password reset.";
    if (u.auth_service !== "") {
      const name = PROVIDERS[u.auth_service];
      const cant = name ? `Login occurs through ${name}. Email cannot be updated. Email address used for notifications is ${u.email}.` : null;
      return this.max(t, "email", "Email", { inputs: cant ? [div().w_full().child(cant)] : [], extra: u.auth_service === "ldap" ? null : help, valid: false });
    }
    const f = this.fields;
    return this.max(t, "email", "Email", {
      inputs: [
        formRow(t, "Current Email", div().w_full().pt(7).font_semibold().child(u.email ?? "")),
        formRow(t, "New Email", f.email?.draw(t, "pf-email")),
        formRow(t, "Confirm Email", f.confirm?.draw(t, "pf-confirm-email")),
        formRow(t, "Current Password", f.password?.draw(t, "pf-password")),
      ],
      extra: help,
      valid: this.emailValid(),
      submit: (cx) => this.submit("email", cx),
    });
  }

  attributeReadOnly(f) {
    const a = f.attrs ?? {};
    if (f.type === "graph") return "This field can't be edited here.";
    if (["ldap", "saml", "openid"].some((source) => source === this.d.user.auth_service && typeof a[source] === "string" && a[source] !== "")) return HANDLED_EXTERNALLY;
    if (a.owners?.length) return "This field is managed by an external integration and cannot be edited here.";
    if (a.protected) return `This field is managed by a plugin and cannot be edited.${a.source_plugin_id ? ` (${a.source_plugin_id})` : ""}`;
    if (a.managed === "admin") return "This field can only be changed by an administrator.";
    if (a.options_omitted) return "This field has too many options to be edited here.";
    return null;
  }

  attributeProblem(f, value) {
    if (f.attrs?.value_type === "email" && value && !isEmail(value)) return VALID_EMAIL;
    if (f.attrs?.value_type === "url" && value && !httpUrl(value)) return VALID_URL;
    return null;
  }

  saveAttribute(f, cx) {
    if (this.saving || !f) return;
    let value = hasOptions(f) ? this.draft : this.fields.value?.value ?? "";
    if (typeof value === "string" && this.attributeProblem(f, value)) { this.serverError = ""; cx.notify(); return; }
    if (f.attrs?.value_type === "url" && value) value = httpUrl(value).replace(/\/$/, "");
    if (f.type === "multiselect" && !value) value = [];
    this.saving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        const saved = await this.d.view.api(cx, `/users/${this.d.user.id}/custom_profile_attributes`, { method: "PATCH", body: { [f.id]: value || "" } });
        this.values = { ...this.values, ...saved };
        this.d.openSection("", cx);
      } catch (e) {
        this.serverError = errorText(e);
        this.saving = false;
        cx.notify();
      }
    });
  }

  attributeDescribe(f) {
    const v = this.values[f.id];
    if (Array.isArray(v) && v.length) return joined(v.map((id) => optionName(f, id)));
    if (typeof v === "string" && v) return hasOptions(f) ? optionName(f, v) : v;
    return "Click 'Edit' to add your custom attribute";
  }

  attributeMax(t, f) {
    const readOnly = this.attributeReadOnly(f), id = `attr-${f.id}`, label = attributeLabel(f);
    if (readOnly) return this.max(t, id, label, { extra: readOnly });
    const options = (f.attrs?.options ?? []).map((o) => [o.id, o.name]);
    const multi = f.type === "multiselect";
    const control = !hasOptions(f) ? this.fields.value?.draw(t, `pf-${id}`) : selectBox(t, `pf-${id}`, {
      label: (multi ? joined((this.draft ?? []).map((v) => optionName(f, v))) : this.draft && optionName(f, this.draft)) || "Select",
      open: this.menuOpen,
      width: 240,
      onToggle: (cx) => { this.menuOpen = !this.menuOpen; cx.notify(); },
      items: multi ? options : [["", "Select"], ...options],
      picked: (value) => (multi ? this.draft?.includes(value) : this.draft === value && value !== ""),
      onPick: (value, cx) => {
        if (multi) this.draft = this.draft.includes(value) ? this.draft.filter((x) => x !== value) : [...this.draft, value];
        else { this.draft = value; this.menuOpen = false; }
        cx.notify();
      },
    });
    return this.max(t, id, label, {
      inputs: [formRow(t, label, control)],
      extra: "This will be shown in your profile popover.",
      valid: hasOptions(f) || !this.fields.value || !this.attributeProblem(f, this.fields.value.value),
      submit: (cx) => this.submit(id, cx),
    });
  }

  closeMenus() {
    const open = this.menuOpen;
    this.menuOpen = false;
    return open;
  }

  draw(t) {
    const u = this.d.user;
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || "Click 'Edit' to add your full name";
    const external = (service) => `Login done through ${PROVIDERS[service]} (${u.email})`;
    const picture = u.last_picture_update > 0 ? `Image last updated ${shortDate(u.last_picture_update)}` : "Click 'Edit' to upload an image.";
    const rule = () => dividerLight(t);
    return v_flex().w_full()
      .child(tabHeader("Profile Settings"))
      .child(dividerDark(t))
      .child(this.section(t, "name", "Full Name", name, (t) => this.nameMax(t)))
      .child(rule())
      .child(this.section(t, "username", "Username", u.username, (t) => this.usernameMax(t)))
      .child(rule())
      .child(this.section(t, "nickname", "Nickname", u.nickname || "Click 'Edit' to add a nickname", (t) => this.simpleMax(t, "nickname", "Nickname", this.externalAttribute("Nickname"), "Use Nickname for a name you might be called that is different from your first name and username. This is most often used when two or more people have similar sounding names and usernames.")))
      .child(rule())
      .child(this.section(t, "position", "Position", u.position || "Click 'Edit' to add your job title / position", (t) => this.simpleMax(t, "position", "Position", this.externalAttribute("Position"), "Use Position for your role or job title. This will be shown in your profile popover.")))
      .child(rule())
      .child(this.section(t, "email", "Email", u.auth_service === "" ? u.email : PROVIDERS[u.auth_service] ? external(u.auth_service) : "", (t) => this.emailMax(t)))
      .child(rule())
      .children(this.attributes.flatMap((f) => [
        this.section(t, `attr-${f.id}`, attributeLabel(f), this.attributeDescribe(f), (t) => this.attributeMax(t, f)),
        dividerDark(t),
      ]))
      .child(this.d.section === "picture" ? this.picture.draw(t) : this.section(t, "picture", "Profile Picture", picture, null))
      .child(dividerDark(t));
  }
}

export class ProfileDialog {
  constructor(view, cx) {
    this.view = view;
    const spec = props().profile;
    this.user = { ...spec.user, auth_service: spec.user.auth_service ?? "" };
    this.config = spec.config ?? {};
    this.demoAvatar = spec.avatar;
    this.license = {};
    this.canEditOtherUsers = false;
    this.tab = "profile";
    this.section = "";
    this.hover = null;
    this.confirm = null;
    this.notice = null;
    this.closed = false;
    // Set while a new token is on screen: leaving asks first, because it can't be shown again.
    this.pendingCopy = false;
    this.media = new Media();
    this.media.demo = Boolean(props().demo);
    this.general = new GeneralTab(this);
    this.security = new SecurityTab(this);
    if (spec.shownToken) {
      this.tab = "security";
      this.section = "tokens";
      this.security.resumeShowing(spec.shownToken, cx);
    }
    cx.spawn(async (cx) => this.load(cx));
  }

  async load(cx) {
    await this.view.cfgReady;
    await this.media.scan();
    // A window closed in the middle of something can't clean up after itself, and an MFA code's picture is a secret.
    exec("sh", ["-c", 'rm -f "$1"/choose-* "$1"/upload-* "$1"/picture-* "$1"/mfa-*', "sh", `${appHome()}/data/mattermost/private`]).catch(() => {});
    const api = (path) => this.view.api(cx, path).catch(() => null);
    const [user, config, license] = await Promise.all([api("/users/me"), api("/config/client?format=old"), api("/license/client?format=old")]);
    // The demo's made-up server lives in each copy of the mod, so the panel's copy knows what was changed before.
    if (user && !this.view.cfg?.demo) this.user = { ...user, auth_service: user.auth_service ?? "" };
    if (config) this.config = config;
    if (license) this.license = license;
    if ((this.config.LockProfileFieldsForEmailUsers ?? "none") !== "none") {
      const roles = await this.view.api(cx, "/roles/names", { method: "POST", body: (this.user.roles ?? "").split(" ").filter(Boolean) }).catch(() => []);
      this.canEditOtherUsers = roles.some((r) => r.permissions?.includes("edit_other_users"));
    }
    if (ENTERPRISE_SKUS.includes(this.license.SkuShortName)) {
      const fields = await api("/custom_profile_attributes/fields");
      this.general.values = (await api(`/users/${this.user.id}/custom_profile_attributes`)) ?? {};
      this.general.attributes = (fields ?? []).filter((f) => f.attrs?.access_mode !== "source_only").sort((a, b) => (a.attrs?.sort_order ?? 0) - (b.attrs?.sort_order ?? 0));
    }
    await this.security.load(cx);
    if (!this.closed) cx.notify();
  }

  maxFileSize() {
    return parseInt(this.config.MaxFileSize, 10) || DEFAULT_MAX_FILE;
  }

  isLocked(field) {
    if (this.user.auth_service !== "" || this.canEditOtherUsers) return false;
    const setting = this.config.LockProfileFieldsForEmailUsers;
    return setting === "name_and_username" ? field === "name" || field === "username" : setting === "all";
  }

  applyUser(saved) {
    this.user = { ...this.user, ...saved, auth_service: saved.auth_service ?? this.user.auth_service };
    request("profile", { patch: Object.fromEntries(PATCHED.filter((k) => saved[k] !== undefined).map((k) => [k, saved[k]])) });
  }

  // In the demo the panel draws `demo` as your picture, since it has no server to fetch one from.
  pictureChanged(stamp, cx, demo) {
    this.user = { ...this.user, last_picture_update: stamp };
    if (this.view.cfg?.demo) this.demoAvatar = demo ?? `mods/mattermost/demo/avatars/${this.user.id}.png`;
    request("profile", { patch: { last_picture_update: stamp }, ...(this.view.cfg?.demo ? { picture: this.demoAvatar } : {}) });
    this.openSection("", cx);
  }

  setHover(id, on, cx) {
    const next = on ? id : this.hover === id ? null : this.hover;
    if (next === this.hover) return;
    this.hover = next;
    cx.notify();
  }

  ask(spec, cx) {
    this.confirm = spec;
    cx.notify();
  }

  answered(cx) {
    this.confirm = null;
    cx.notify();
  }

  // Whatever leaves the section first asks about a token still on screen.
  leaving(then, cx) {
    if (this.pendingCopy) this.security.confirmCopy(then, cx);
    else then(cx);
  }

  tabObject() {
    return this.tab === "profile" ? this.general : this.security;
  }

  openSection(section, cx) {
    this.leaving((cx) => {
      this.tabObject().leave(this.section);
      this.section = section;
      this.hover = null;
      if (section) this.notice = null;
      this.tabObject().enter(section);
      cx.notify();
    }, cx);
  }

  openTab(tab, cx) {
    if (tab === this.tab) return;
    this.leaving((cx) => {
      this.tabObject().leave(this.section);
      this.tab = tab;
      this.section = "";
      this.hover = null;
      this.notice = null;
      cx.notify();
    }, cx);
  }

  hide(cx) {
    this.leaving(() => closeOverlay(props().overlay), cx);
  }

  // Herdr's Esc closes a dialog before the mod hears of it, and a token on screen can't be shown again, so the
  // dialog comes back at once and asks, which is what Mattermost's Esc does.
  closing() {
    this.closed = true;
    const token = this.pendingCopy ? this.security.newToken : null;
    this.tabObject().leave(this.section);
    if (token) openProfileDialog({ demo: props().demo, profile: { user: this.user, config: this.config, avatar: this.demoAvatar, shownToken: token } });
  }

  // The dialog's own copy of the picture downloads, asked for while drawing and run outside it.
  pump(cx) {
    if (this.pumping || !this.media.pending() || !this.view.cfg) return;
    this.pumping = true;
    cx.timer.after(0, (cx) => cx.spawn(async (cx) => {
      const landed = await this.media.flush(this.view.cfg).catch(() => false);
      this.pumping = false;
      if (landed && !this.closed) cx.notify();
    }));
  }

  sidebarTab(t, id, label, name) {
    const on = this.tab === id;
    return h_flex().id(`pf-tab-${id}`).w_full().h(32).flex_none().px(12).mb(8).gap(8).items_center().rounded(4).cursor_pointer().font_semibold()
      .text_color(on ? t.accent : alpha(t.foreground, 0.75))
      .when(on, (el) => el.bg(alpha(t.accent, 0.08)))
      .when(!on, (el) => el.hover((s) => s.bg(alpha(t.foreground, 0.04)).text_color(alpha(t.foreground, 0.8))))
      .on_click((_e, cx) => this.openTab(id, cx))
      .child(svg(icon(name)).size(16).flex_none().text_color(on ? t.accent : alpha(t.foreground, 0.64)))
      .child(div().min_w(0).truncate().child(label));
  }

  render(cx) {
    const t = theme();
    const content = this.tab === "profile" ? this.general.draw(t) : this.security.draw(t);
    this.pump(cx);
    return v_flex().id("mm-profile").relative().size_full().bg(t.popover).font_family(FONT).text_size(14).text_color(t.foreground)
      .on_mouse_down("left", (_e, cx) => {
        if (this.general.closeMenus() | this.security.closeMenus()) cx.notify();
      })
      .child(h_flex().flex_none().h(76).pl(32).pr(18).items_center().gap(12).border_b_1().border_color(alpha(t.foreground, 0.08))
        .child(div().flex_1().min_w(0).truncate().text_size(22).font_semibold().child("Profile"))
        .child(closeButton(t, "pf-close", (_e, cx) => this.hide(cx))))
      .child(h_flex().flex_1().min_h(0).w_full().items_start()
        .child(v_flex().w(232).h_full().flex_none().p(16).border_r_1().border_color(alpha(t.foreground, 0.08)).bg(alpha(t.foreground, 0.04))
          .child(this.sidebarTab(t, "profile", "Profile Settings", "settings"))
          .child(this.sidebarTab(t, "security", "Security", "lock")))
        .child(div().relative().flex_1().h_full().min_w(0)
          .child(div().id(`pf-content-${this.tab}`).size_full().overflow_y_scroll().child(v_flex().w_full().px(30).py(20)
            .when(Boolean(this.notice), (el) => el.child(h_flex().w_full().mb(16).px(12).py(8).gap(8).items_center().rounded(4).bg(alpha("#3db887", 0.16))
              .child(svg(icon("check")).size(16).flex_none().text_color("#3db887"))
              .child(div().flex_1().min_w(0).child(this.notice))))
            .child(content)))
          .child(Scrollbar.vertical(`pf-content-${this.tab}`).mode("always").absolute().inset_0())))
      .when(Boolean(this.security.layerOpen()), (el) => el.child(this.security.drawLayer(t)))
      .when(Boolean(this.confirm), (el) => el.child(confirmLayer(t, {
        title: this.confirm.title,
        body: this.confirm.body?.(t) ?? [],
        confirmLabel: this.confirm.confirmLabel,
        confirmEnabled: this.confirm.enabled?.() ?? true,
        hideCancel: this.confirm.hideCancel,
        onConfirm: (cx) => this.confirm.onConfirm(cx),
        onCancel: (cx) => this.answered(cx),
      })));
  }
}
