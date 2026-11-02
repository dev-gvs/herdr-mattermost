// The Profile modal's Security tab, with Active Sessions, Access History and the multi-factor setup that
// Mattermost keeps on a page of its own. The panel signs in with a personal access token, and the server treats
// that session like a browser's for all of this: its handlers refuse only OAuth sessions. What differs is that
// the token can end its own session, so the token section says which one the panel uses and handles losing it.
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, TextView } from "gpui-base";
import { exec, appHome, closeOverlay, props, readTextFile, writeTextFile } from "herdr";
import { alpha, clock, openLink, loginPath } from "../main.js";
import { request } from "./menu.js";
import { DateTimeInput } from "./datetime.js";
import { button, textLink, errorRow, sectionMin, sectionMax, formRow, Field, selectBox, stackedModal, alertBox, icon, errorText, shortDate, longDate, dividerDark, dividerLight, tabHeader } from "./setting_item.js";

const DAY = 24 * 60 * 60 * 1000;
const APPROACHING_EXPIRY_DAYS = 7;
const PRIVATE = "data/mattermost/private";
const MIN_PASSWORD = 5, MAX_PASSWORD = 72;
const MAX_DESCRIPTION = 64;
const AUDIT_ROW = 56;
const TOKEN_TYPE = "UserAccessToken";
const BAD_MFA_CODE = "ent.mfa.activate.authenticate.app_error";
const TOKEN_DOCS = "https://mattermost.com/pl/personal-access-tokens";
const API_DOCS = "https://api.mattermost.com/#tag/authentication";
const PRESET_DAYS = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };
const PRESET_NAMES = { none: "No expiry", "7d": "7 days", "30d": "30 days", "90d": "90 days", "1y": "1 year", custom: "Custom date…" };

const PASSWORD_RULES = {
  "": "", L: " and include lowercase letters", LN: " and include lowercase letters and numbers", LNS: " and include lowercase letters, numbers, and special characters", LS: " and include lowercase letters and special characters",
  LU: " and include both lowercase and uppercase letters", LUN: " and include both lowercase and uppercase letters, and numbers", LUNS: " and include both lowercase and uppercase letters, numbers, and special characters", LUS: " and include both lowercase and uppercase letters, and special characters",
  N: " and include numbers", NS: " and include numbers and special characters", S: " and include special characters",
  U: " and include uppercase letters", UN: " and include uppercase letters, and numbers", UNS: " and include uppercase letters, numbers, and special characters", US: " and include uppercase letters, and special characters",
};
const PASSWORD_ELSEWHERE = {
  gitlab: "Login occurs through GitLab. Password cannot be updated.",
  ldap: "Login occurs through AD/LDAP. Password cannot be updated.",
  saml: "This field is handled through your login provider. If you want to change it, you need to do so through your login provider.",
  google: "Login occurs through Google Apps. Password cannot be updated.",
  office365: "Login occurs through Entra ID. Password cannot be updated.",
  magic_link: "Login occurs via magic link. Password cannot be updated.",
};
const LOGIN_DONE = { gitlab: "GitLab", ldap: "AD/LDAP", saml: "SAML", google: "Google Apps", office365: "Entra ID", magic_link: "Magic Link" };
const METHODS = { gitlab: "GitLab", google: "Google", office365: "Entra ID", openid: "OpenID", ldap: "AD/LDAP", saml: "SAML", magic_link: "Magic Link" };

const pad = (n) => String(n).padStart(2, "0");
const isoDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const endOfDay = (ms) => { const d = new Date(ms); d.setHours(23, 59, 59, 999); return d.getTime(); };
const inDays = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.getTime(); };
const titleCase = (text) => text.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
const hasRole = (user, role) => (user.roles ?? "").split(" ").includes(role);

function presetAllowed(preset, maxDays) {
  return preset === "none" || preset === "custom" || maxDays <= 0 || PRESET_DAYS[preset] <= maxDays;
}

// A configured maximum lifetime means tokens must expire, so "No expiry" isn't offered and the default is bounded.
function defaultPreset(maxDays) {
  if (maxDays <= 0) return "none";
  return ["30d", "7d"].find((p) => presetAllowed(p, maxDays)) ?? "custom";
}

function resolveExpiry(exp) {
  if (exp.preset === "none") return 0;
  return endOfDay(exp.preset === "custom" ? exp.when.value : inDays(PRESET_DAYS[exp.preset]));
}

const tooFar = (days) => `Expiry can be at most ${days} ${days === 1 ? "day" : "days"} from now.`;

function expiryProblem(exp, maxDays) {
  const at = resolveExpiry(exp);
  if ((exp.preset === "custom" || maxDays > 0) && at <= 0) return "An expiry date is required.";
  if (at > 0 && at <= Date.now()) return "Expiry must be in the future.";
  if (at > 0 && maxDays > 0 && at > endOfDay(inDays(maxDays))) return tooFar(maxDays);
  return null;
}

// End-of-day presets can sit past the server's cap of exactly now + the maximum, so what's sent is cut back to it.
const clampExpiry = (at, maxDays) => (at > 0 && maxDays > 0 ? Math.min(at, Date.now() + maxDays * DAY) : at);

function tokenStatus(token) {
  if (!token.is_active) return "inactive";
  return token.expires_at > 0 && token.expires_at < Date.now() ? "expired" : "active";
}

function auditDescription(audit) {
  const url = audit.action.replace(/\/api\/v[1-9]/, "");
  const extra = audit.extra_info ?? "";
  const info = extra.split(" "), first = info[0] ?? "";
  let desc = "";
  if (url.startsWith("/channels")) {
    const name = first.split("=")[0] === "name" ? first.split("=")[1] : first.split("=")[0] === "id" ? first.split("=")[1] : first;
    const user = info[1]?.startsWith("user_id=") ? info[1].split("=")[1] : "";
    if (url === "/channels/create") desc = `Created the ${name} channel`;
    else if (url === "/channels/create_direct") desc = `Established a direct message channel with ${name}`;
    else if (url === "/channels/update") desc = `Updated the ${name} channel name`;
    else if (url === "/channels/update_desc" || url === "/channels/update_header") desc = `Updated the ${name} channel header`;
    else if (/\/channels\/[A-Za-z0-9]+\/delete/.test(url)) desc = `Archived the channel with the URL ${name}`;
    else if (/\/channels\/[A-Za-z0-9]+\/add/.test(url)) desc = `Added ${user} to the ${name} channel`;
    else if (/\/channels\/[A-Za-z0-9]+\/remove/.test(url)) desc = `Removed ${user} from the ${name} channel`;
  } else if (url.startsWith("/users")) {
    const value = first.split("=")[1] ?? "";
    if (url === "/users/login") desc = first === "attempt" ? "Attempted to login" : first === "success" ? "Successfully logged in" : first === "authenticated" ? "Successfully authenticated" : first ? "FAILED login attempt" : "";
    else if (url === "/users/revoke_session") desc = `The session with id ${value} was revoked`;
    else if (url === "/users/newimage") desc = "Updated your profile picture";
    else if (url === "/users/update" || url === "/users/newpassword") desc = "Updated the general settings of your account";
    else if (url === "/users/update_roles") desc = `Updated user role(s) to ${value.trim() || "member"}`;
    else if (url === "/users/update_active" && first.startsWith("active=")) desc = value === "true" ? "Account activated" : value === "false" ? "Account deactivated" : "";
    else if (url === "/users/update_active" && first.startsWith("session_id=")) desc = `The session with id ${value} was revoked`;
    else if (url === "/users/send_password_reset") desc = `Sent an email to ${value} to reset your password`;
    else if (url === "/users/reset_password") desc = first === "attempt" ? "Attempted to reset password" : first === "success" ? "Successfully reset password" : "";
    else if (url === "/users/update_notify") desc = "Updated your global notification settings";
  } else if (url === "/oauth/register" && first.startsWith("client_id=")) desc = `Attempted to register a new OAuth Application with ID ${first.split("=")[1]}`;
  else if (url === "/oauth/allow") desc = first === "attempt" ? "Attempted to allow a new OAuth service access" : first === "success" ? "Successfully gave a new OAuth service access" : "";
  else if (url === "/oauth/access_token") desc = first === "attempt" ? "Attempted to get an OAuth access token" : first === "success" ? "Successfully added a new OAuth service" : first.startsWith("fail") ? `Failed to get an OAuth access token - ${first.split("-")[1]?.trim() ?? ""}` : "";
  else if (url === "/hooks/incoming/create") desc = extra === "attempt" ? "Attempted to create a webhook" : extra === "success" ? "Successfully created a webhook" : extra === "fail - bad channel permissions" ? "Failed to create a webhook - bad channel permissions" : "";
  else if (url === "/hooks/incoming/delete") desc = extra === "attempt" ? "Attempted to delete a webhook" : extra === "success" ? "Successfully deleted a webhook" : extra === "fail - inappropriate conditions" ? "Failed to delete a webhook - inappropriate conditions" : "";
  else if (url === "/license/add") desc = extra === "attempt" ? "Attempted to add new license" : extra === "success" ? "Successfully added new license" : extra === "failed - expired or non-started license" ? "Failed to add a new license as it has either expired or not yet been started" : extra === "failed - invalid license" ? "Failed to add an invalid license" : "";
  else if (url === "/license/remove") desc = "Successfully removed a license";
  else if (url.startsWith("/admin/download_compliance_report")) desc = titleCase(extra);
  else if (url === "/logout") desc = "Logged out of your account";
  else if (url === "/verify_email") desc = "Successfully verified your email address";
  if (desc) return desc;
  if (extra.includes("revoked_all=")) return "Revoked all current sessions for the team";
  const action = url.includes("/") ? titleCase(url.slice(url.lastIndexOf("/") + 1).replace("_", " ")) : "";
  return `${action} ${extra.includes("=") ? extra.slice(extra.indexOf("=") + 1) : extra}`;
}

function sessionDevice(session) {
  const p = session.props ?? {}, device = session.device_id ?? "";
  const iPhoneNative = device.includes("apple_rn"), iPhoneClassic = device.includes("apple") && !iPhoneNative;
  const androidNative = device.includes("android_rn"), androidClassic = device.includes("android") && !androidNative;
  const android = p.os?.includes("Android");
  const linux = p.platform === "Linux" || p.os?.includes("Linux");
  const name = iPhoneClassic ? "iPhone Native Classic App" : iPhoneNative ? "iPhone Native App" : androidClassic ? "Android Native Classic App"
    : androidNative ? "Android Native App" : android ? "Android" : p.browser?.includes("Desktop App") ? "Native Desktop App" : p.platform;
  const phone = p.platform === "iPhone" || iPhoneNative || iPhoneClassic || android || androidNative || androidClassic;
  const known = phone || p.platform === "Macintosh" || p.platform === "Windows" || linux;
  return { name, icon: !known ? null : phone ? "smartphone" : "monitor" };
}

export class SecurityTab {
  constructor(dialog) {
    this.d = dialog;
    this.fields = {};
    this.serverError = "";
    this.savingPassword = false;
    this.authorizedApps = [];
    this.tokens = [];
    this.mine = null;
    this.layer = null;
    this.sessions = null;
    this.moreInfo = new Set();
    this.layerError = "";
    this.audits = null;
    this.resetTokenState();
    this.mfa = null;
  }

  resetTokenState() {
    this.tokenStage = "idle";
    this.newToken = null;
    this.copied = false;
    this.tokenError = "";
    this.tokenServerError = "";
    this.saving = false;
    this.description?.dispose();
    this.description = null;
    this.expiry = null;
    this.regen = null;
  }

  get config() {
    return this.d.config;
  }

  get api() {
    return this.d.view.api.bind(this.d.view);
  }

  canUseTokens() {
    const u = this.d.user;
    return this.config.EnableUserAccessTokens === "true" && (hasRole(u, "system_user_access_token") || hasRole(u, "system_admin"));
  }

  oauthEnabled() {
    return this.config.EnableOAuthServiceProvider === "true";
  }

  maxDays() {
    const days = parseInt(this.config.MaximumPersonalAccessTokenLifetimeDays || "0", 10);
    return Number.isFinite(days) ? days : 0;
  }

  mfaEnforced() {
    const l = this.d.license;
    return l.IsLicensed === "true" && l.MFA === "true" && this.config.EnforceMultifactorAuthentication === "true";
  }

  mfaAvailable() {
    const service = this.d.user.auth_service;
    return this.config.EnableMultifactorAuthentication === "true" && (service === "" || service === "ldap");
  }

  async load(cx) {
    const id = this.d.user.id;
    if (this.oauthEnabled()) {
      try {
        this.authorizedApps = await this.api(cx, `/users/${id}/oauth/apps/authorized`);
      } catch (e) {
        this.serverError = errorText(e);
      }
    }
    if (this.canUseTokens()) {
      this.tokens = await this.api(cx, `/users/${id}/tokens?page=0&per_page=200`).catch((e) => { this.tokenServerError = errorText(e); return []; });
      await this.findOwnToken(cx);
    }
  }

  // The token's secret is never listed, but every token in use has a session naming it, and this panel's
  // requests run on one of those. So a token without a session can't be the panel's, and a lone one must be.
  async findOwnToken(cx) {
    const sessions = await this.api(cx, `/users/${this.d.user.id}/sessions`).catch(() => null);
    if (!sessions) { this.mine = null; return; }
    this.mine = new Set(sessions.filter((s) => s.props?.type === TOKEN_TYPE && s.props?.user_access_token_id).map((s) => s.props.user_access_token_id));
  }

  ownership(tokenId) {
    if (!this.mine) return "maybe";
    if (!this.mine.has(tokenId)) return "no";
    return this.mine.size === 1 ? "yes" : "maybe";
  }

  ownershipWarning(tokenId, ifMine) {
    const own = this.ownership(tokenId);
    if (own === "no") return null;
    return own === "yes" ? `This panel signs in with this token. ${ifMine}` : `This panel signs in with a personal access token, and it may be this one. If it is: ${ifMine.charAt(0).toLowerCase()}${ifMine.slice(1)}`;
  }

  enter(section) {
    if (section === "password" && this.d.user.auth_service === "") {
      const submit = (cx) => this.submitPassword(cx);
      this.fields = {
        current: new Field({ masked: true, onSubmit: submit, validate: (v) => (v === "" ? "Please enter your current password." : null) }),
        next: new Field({ masked: true, onSubmit: submit, validate: (v) => this.passwordProblem(v) }),
        confirm: new Field({ masked: true, onSubmit: submit, validate: (v) => (this.fields.next.value !== v ? "The new passwords you entered do not match." : null) }),
      };
      this.fields.current.focus();
    }
  }

  leave(section) {
    for (const field of Object.values(this.fields)) field.dispose();
    this.fields = {};
    this.savingPassword = false;
    if (section) this.serverError = "";
    if (section === "tokens") this.resetTokenState();
    if (section === "mfa") this.endMfaSetup();
  }

  closeMenus() {
    let open = false;
    for (const exp of [this.expiry, this.regen]) {
      if (!exp) continue;
      open = open || exp.open || Boolean(exp.when.open);
      exp.open = false;
      exp.when.closeMenus();
    }
    return open;
  }

  passwordConfig() {
    const c = this.config;
    return {
      min: parseInt(c.PasswordMinimumLength, 10) || MIN_PASSWORD,
      lower: c.PasswordRequireLowercase === "true",
      upper: c.PasswordRequireUppercase === "true",
      number: c.PasswordRequireNumber === "true",
      symbol: c.PasswordRequireSymbol === "true",
    };
  }

  passwordProblem(password) {
    const p = this.passwordConfig();
    const ok = password.length >= p.min && password.length <= MAX_PASSWORD
      && (!p.lower || /[a-z]/.test(password)) && (!p.upper || /[A-Z]/.test(password)) && (!p.number || /[0-9]/.test(password))
      && (!p.symbol || /[ !"\\#$%&'()*+,\-./:;<=>?@[\]^_`|~]/.test(password));
    if (ok) return null;
    const key = `${p.lower ? "L" : ""}${p.upper ? "U" : ""}${p.number ? "N" : ""}${p.symbol ? "S" : ""}`;
    return `Your password must be ${p.min}-${MAX_PASSWORD} characters long${PASSWORD_RULES[key]}.`;
  }

  passwordValid() {
    const f = this.fields;
    return Boolean(f.current) && f.current.value !== "" && !this.passwordProblem(f.next.value) && f.next.value === f.confirm.value;
  }

  submitPassword(cx) {
    if (this.savingPassword || !this.passwordValid()) return;
    const f = this.fields;
    const body = { current_password: f.current.value, new_password: f.next.value };
    this.savingPassword = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        await this.api(cx, `/users/${this.d.user.id}/password`, { method: "PUT", body });
        this.d.user = { ...this.d.user, last_password_update: Date.now() };
        this.d.openSection("", cx);
      } catch (e) {
        this.serverError = errorText(e);
        this.savingPassword = false;
        for (const field of Object.values(this.fields)) { field.state.set_value(""); field.error = null; }
        this.fields.current?.focus();
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

  closeSection(cx) {
    this.d.openSection("", cx);
  }

  passwordSection(t) {
    const u = this.d.user;
    const describe = u.auth_service === "" ? `Last updated ${shortDate(u.last_password_update ?? 0)} at ${clock(u.last_password_update ?? 0)}`
      : LOGIN_DONE[u.auth_service] ? `Login done through ${LOGIN_DONE[u.auth_service]}` : "";
    return this.section(t, "password", "Password", describe, (t) => {
      const f = this.fields;
      const elsewhere = PASSWORD_ELSEWHERE[u.auth_service];
      return sectionMax(t, "password", {
        title: "Password",
        inputs: u.auth_service === "" ? [
          formRow(t, "Current Password", f.current?.draw(t, "pf-current-password")),
          formRow(t, "New Password", f.next?.draw(t, "pf-new-password")),
          formRow(t, "Retype New Password", f.confirm?.draw(t, "pf-retype-password")),
        ] : elsewhere ? [div().w_full().pb(12).child(elsewhere)] : [],
        submit: u.auth_service === "" ? (cx) => this.submitPassword(cx) : null,
        saving: this.savingPassword,
        error: this.serverError,
        valid: this.passwordValid(),
        cancel: (cx) => this.closeSection(cx),
      });
    });
  }

  removeMfa(cx) {
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        await this.api(cx, `/users/${this.d.user.id}/mfa`, { method: "PUT", body: { activate: false } });
        this.d.user = { ...this.d.user, mfa_active: false };
        this.serverError = "";
        // On a server that enforces it, nearly every other call now answers 403 until it's set up again.
        if (this.mfaEnforced()) this.startMfaSetup(cx);
        else this.d.openSection("", cx);
      } catch (e) {
        this.serverError = errorText(e);
        cx.notify();
      }
    });
  }

  // The picture holds the secret too, so it's written to the private folder, and decoded from a file rather
  // than a command line.
  startMfaSetup(cx) {
    this.mfa = { secret: "", qr: null, error: "", code: new Field({ placeholder: "MFA Code", onSubmit: (cx) => this.activateMfa(cx) }), done: false };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        const secret = await this.api(cx, `/users/${this.d.user.id}/mfa/generate`, { method: "POST" });
        if (!this.mfa) return;
        this.mfa.secret = secret.secret;
        this.mfa.qr = await this.writeQr(secret.qr_code);
        this.mfa.code.focus();
      } catch (e) {
        if (this.mfa) this.mfa.error = errorText(e);
      }
      if (!this.d.closed) cx.notify();
    });
  }

  async writeQr(base64) {
    const stamp = Date.now(), dir = `${appHome()}/${PRIVATE}`, text = `${dir}/mfa-${stamp}.b64`, rel = `${PRIVATE}/mfa-${stamp}.png`;
    await exec("mkdir", ["-p", "-m", "700", dir]);
    await writeTextFile(text, base64, null);
    await exec("sh", ["-c", 'base64 -d "$1" > "$2"; rm -f "$1"', "sh", text, `${appHome()}/${rel}`]);
    return rel;
  }

  endMfaSetup() {
    if (this.mfa?.qr) exec("rm", ["-f", `${appHome()}/${this.mfa.qr}`]).catch(() => {});
    this.mfa?.code.dispose();
    this.mfa = null;
  }

  activateMfa(cx) {
    const code = this.mfa?.code.value.replace(/\s/g, "");
    if (!code) {
      this.mfa.error = "Please enter the code from your authenticator app.";
      this.mfa.code.focus();
      cx.notify();
      return;
    }
    this.mfa.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        await this.api(cx, `/users/${this.d.user.id}/mfa`, { method: "PUT", body: { activate: true, code } });
        this.d.user = { ...this.d.user, mfa_active: true };
        this.mfa.done = true;
      } catch (e) {
        this.mfa.error = e?.id === BAD_MFA_CODE ? "Invalid code. If this issue persists, contact your System Administrator." : errorText(e);
        this.mfa.code.focus();
      }
      cx.notify();
    });
  }

  mfaSetupContent(t) {
    const m = this.mfa;
    const copy = (text) => div().w_full().child(text);
    if (m.done) {
      return [
        div().w_full().font_semibold().child("Set up complete!"),
        div().w_full().mt(8).child("Your account is now secure. Next time you sign in, you will be asked to enter a code from your authenticator app on your phone."),
      ];
    }
    return [
      ...(this.mfaEnforced() ? [div().w_full().mb(8).font_semibold().child(`Multi-factor authentication is required on ${this.config.SiteName ?? "this server"}.`)] : []),
      copy("1. Scan the QR code below using an authenticator app of your choice, such as Google Authenticator, Microsoft Authenticator app, or 1Password."),
      div().w_full().mt(8).child("Alternatively, enter the secret key displayed below into the authenticator app manually."),
      div().w_full().mt(16).child(m.qr ? image(m.qr).size(170).flex_none() : div().size(170).flex_none().bg(alpha(t.foreground, 0.08))),
      div().w_full().mt(16).child(TextView.markdown("pf-mfa-secret", `Secret: ${m.secret}`).selectable(true)),
      div().w_full().mt(16).child("2. Enter the code generated by the authenticator app in the field below."),
      div().w_full().mt(8).child(m.code.draw(t, "pf-mfa-code")),
    ];
  }

  mfaSection(t) {
    if (!this.mfaAvailable()) return null;
    const u = this.d.user, enforced = this.mfaEnforced();
    return this.section(t, "mfa", "Multi-factor Authentication", u.mfa_active ? "Active" : "Inactive", (t) => {
      if (this.mfa) {
        // With MFA required and not set up, the server answers nothing else, so there's no going back to the panel.
        const stuck = enforced && !u.mfa_active;
        return sectionMax(t, "mfa", {
          title: "Multi-factor Authentication Setup",
          full: true,
          inputs: this.mfaSetupContent(t),
          error: this.mfa.error,
          submit: this.mfa.done ? null : (cx) => this.activateMfa(cx),
          cancelLabel: this.mfa.done ? "Okay" : stuck ? "Logout" : "Cancel",
          cancel: stuck ? () => { request("logout"); closeOverlay(props().overlay); } : (cx) => this.closeSection(cx),
        });
      }
      const label = !u.mfa_active ? "Add MFA to Account" : enforced ? "Reset MFA on Account" : "Remove MFA from Account";
      const help = !u.mfa_active ? "Adding multi-factor authentication will make your account more secure by requiring a code from your mobile phone each time you sign in."
        : enforced ? "Multi-factor authentication is required on this server. Resetting is only recommended when you need to switch code generation to a new mobile device. You will be required to set it up again immediately."
          : "Removing multi-factor authentication means you will no longer require a phone-based passcode to sign-in to your account.";
      return sectionMax(t, "mfa", {
        title: "Multi-factor Authentication",
        inputs: [h_flex().w_full().pt(8).child(button(t, "pf-mfa-action", label, (_e, cx) => (u.mfa_active ? this.removeMfa(cx) : this.startMfaSetup(cx))))],
        extra: help,
        error: this.serverError,
        cancel: (cx) => this.closeSection(cx),
      });
    });
  }

  deauthorize(app, cx) {
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        const cfg = this.d.view.cfg;
        // The one call here outside /api/v4.
        if (!cfg.demo) {
          const res = await fetch(`${cfg.url}/oauth/deauthorize`, {
            method: "POST",
            headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: app.id }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw Object.assign(new Error(`POST /oauth/deauthorize: HTTP ${res.status}`), { text: body?.message });
          }
        }
        this.authorizedApps = this.authorizedApps.filter((a) => a.id !== app.id);
        this.serverError = "";
      } catch (e) {
        this.serverError = errorText(e);
      }
      cx.notify();
    });
  }

  oauthSection(t) {
    if (!this.oauthEnabled()) return null;
    return this.section(t, "apps", "OAuth 2.0 Applications", "Click 'Edit' to manage your OAuth 2.0 Applications", (t) => {
      const apps = this.authorizedApps;
      const row = (app, i) => {
        const iconPath = this.d.media.external(app.icon_url);
        return h_flex().id(`pf-app-${app.id}`).w_full().gap(16).items_start().pb(12)
          .when(i < apps.length - 1, (el) => el.mb(10).border_b_1().border_color(alpha(t.foreground, 0.16)))
          .child(v_flex().flex_1().min_w(0).gap(5)
            .child(h_flex().w_full().flex_wrap().gap(4).items_baseline()
              .child(div().font_semibold().child(app.name))
              .child(div().text_size(13).child("-"))
              .when(Boolean(app.homepage), (el) => el.child(textLink(t, `pf-app-home-${app.id}`, app.homepage, () => openLink(app.homepage)).text_size(13))))
            .child(div().w_full().text_size(13).child(app.description ?? ""))
            .child(textLink(t, `pf-app-remove-${app.id}`, "Deauthorize", (_e, cx) => this.deauthorize(app, cx)).text_size(13)))
          .child(iconPath ? image(iconPath).size(50).flex_none() : svg(icon("logo")).size(50).flex_none().text_color(alpha(t.foreground, 0.32)));
      };
      const title = v_flex().w_full().child(div().child("OAuth 2.0 Applications"))
        .when(apps.length > 0, (el) => el.child(div().mt(7).text_size(13).child("Applications act on your behalf to access your data based on the permissions you grant them.")));
      return sectionMax(t, "apps", {
        title,
        full: true,
        inputs: [apps.length
          ? v_flex().w_full().py(10).children(apps.map(row))
          : div().w_full().pb(12).text_color(alpha(t.foreground, 0.75)).child("No OAuth 2.0 Applications are authorized.")],
        error: this.serverError,
        cancelLabel: "Close",
        cancel: (cx) => this.closeSection(cx),
      });
    });
  }

  newExpiry(preset = defaultPreset(this.maxDays())) {
    const when = new DateTimeInput("pf-expiry", endOfDay(inDays(this.maxDays() > 0 ? Math.max(1, Math.min(30, this.maxDays())) : 30)));
    if (this.maxDays() > 0) when.maxDay = isoDay(inDays(this.maxDays()));
    return { preset, when, open: false };
  }

  expiryPicker(t, id, exp) {
    const maxDays = this.maxDays();
    const presets = ["none", "7d", "30d", "90d", "1y", "custom"].filter((p) => (p === "none" ? maxDays <= 0 : presetAllowed(p, maxDays)));
    const note = (text) => div().w_full().pt(8).child(text);
    return h_flex().w_full().pt(12).items_start()
      .child(div().flex_none().pr(12).pt(7).font_semibold().child("Expires: "))
      .child(v_flex().w(240).flex_none()
        .child(selectBox(t, id, {
          label: PRESET_NAMES[exp.preset],
          open: exp.open,
          width: 240,
          items: presets.map((p) => [p, PRESET_NAMES[p]]),
          onToggle: (cx) => { exp.open = !exp.open; exp.when.closeMenus(); cx.notify(); },
          onPick: (value, cx) => { exp.preset = value; exp.open = false; this.tokenError = ""; cx.notify(); },
        }))
        .when(exp.preset === "custom", (el) => el.child(div().w_full().mt(12).child(exp.when.renderDate(t))))
        .when(maxDays > 0, (el) => el.child(note(`Tokens can be valid for up to ${maxDays} ${maxDays === 1 ? "day" : "days"}.`)))
        .when(maxDays > 0, (el) => el.child(note("Your administrator requires all personal access tokens to have an expiry date."))));
  }

  startCreatingToken(cx) {
    this.tokenStage = "creating";
    this.tokenError = "";
    this.expiry = this.newExpiry();
    this.description = new Field({ max: MAX_DESCRIPTION, onSubmit: (cx) => this.confirmCreateToken(cx) });
    this.description.focus();
    cx.notify();
  }

  stopCreatingToken(cx) {
    this.description?.dispose();
    this.description = null;
    this.expiry = null;
    this.tokenStage = "idle";
    this.saving = false;
    this.tokenError = "";
    cx.notify();
  }

  confirmCreateToken(cx) {
    if (!hasRole(this.d.user, "system_admin")) {
      this.createToken(cx);
      return;
    }
    this.d.ask({
      title: "Create System Admin Personal Access Token",
      body: (t) => [alertBox(t, t.blocked, [div().w_full().child("You are generating a personal access token with System Admin permissions. Are you sure want to create this token?")])],
      confirmLabel: "Yes, Create",
      onConfirm: (cx) => { this.d.answered(cx); this.createToken(cx); },
    }, cx);
  }

  createToken(cx) {
    if (this.saving || !this.description) return;
    const description = this.description.value.trim();
    if (!description) {
      this.tokenError = "Please enter a description.";
      cx.notify();
      return;
    }
    const maxDays = this.maxDays();
    const problem = expiryProblem(this.expiry, maxDays);
    if (problem) {
      this.tokenError = problem;
      cx.notify();
      return;
    }
    const expires = clampExpiry(resolveExpiry(this.expiry), maxDays);
    this.tokenError = "";
    this.tokenServerError = "";
    this.saving = true;
    this.d.pendingCopy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        // Sent once: a retry after a lost answer would leave a second token no one has seen.
        const token = await this.api(cx, `/users/${this.d.user.id}/tokens`, { method: "POST", attempts: 1, body: { description, ...(expires > 0 ? { expires_at: expires } : {}) } });
        this.tokens = [...this.tokens, token];
        this.tokenStage = "created";
        this.newToken = token;
        this.copied = false;
      } catch (e) {
        this.d.pendingCopy = false;
        const mapped = this.mappedExpiryError(e?.id, maxDays);
        if (mapped) this.tokenError = mapped;
        else this.tokenServerError = errorText(e);
      }
      this.saving = false;
      cx.notify();
    });
  }

  mappedExpiryError(id, maxDays) {
    if (id === "app.user_access_token.expires_at_required.app_error") return "An expiry date is required.";
    if (id === "app.user_access_token.expires_at_in_past.app_error") return "Expiry must be in the future.";
    if (id === "app.user_access_token.expires_at_too_far.app_error") return tooFar(maxDays);
    return null;
  }

  copyToken(cx) {
    cx.write_to_clipboard(this.newToken.token);
    this.copied = true;
    cx.notify();
  }

  tokenValue(t, id) {
    const token = this.newToken?.token ?? "";
    return h_flex().w_full().gap(8).items_center()
      .child(div().flex_1().min_w(0).child(TextView.markdown(id, `**Access Token: ${token}**`).selectable(true)))
      .child(div().id(`${id}-copy`).size(28).flex().flex_none().items_center().justify_center().rounded(4).cursor_pointer().tooltip("Copy Token")
        .text_color(this.copied ? t.accent : alpha(t.foreground, 0.64))
        .hover((s) => s.bg(alpha(t.foreground, 0.08)))
        .on_click((_e, cx) => this.copyToken(cx))
        .child(svg(icon(this.copied ? "check" : "copy")).size(16)));
  }

  resumeShowing(token, cx) {
    this.tokenStage = "created";
    this.newToken = token;
    this.d.pendingCopy = true;
    this.confirmCopy(() => closeOverlay(props().overlay), cx);
  }

  confirmCopy(then, cx) {
    this.d.ask({
      title: "Copied Your Token?",
      body: (t) => [
        div().w_full().child("Make sure you have copied and saved the access token below. You won't be able to see it again!"),
        this.newToken ? this.tokenValue(t, "pf-confirm-token") : div().w_full().font_semibold().child("Access Token: Loading..."),
      ],
      confirmLabel: "Yes, I have copied the token",
      hideCancel: true,
      enabled: () => Boolean(this.newToken),
      onConfirm: (cx) => {
        this.d.pendingCopy = false;
        this.d.answered(cx);
        then(cx);
      },
    }, cx);
  }

  setTokenActive(token, active, cx) {
    const verb = active ? "enable" : "disable";
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        await this.api(cx, `/users/tokens/${verb}`, { method: "POST", body: { token_id: token.id } });
        this.tokens = this.tokens.map((x) => (x.id === token.id ? { ...x, is_active: active } : x));
        if (!active) await this.afterTokenChange(cx);
      } catch (e) {
        this.tokenServerError = errorText(e);
      }
      cx.notify();
    });
  }

  // Disabling your own token shuts out the panel, which then can't turn it back on, so here it asks when
  // the token may be that one. Mattermost's browser session isn't at risk and disables at once.
  confirmDisableToken(token, cx) {
    const warning = this.ownershipWarning(token.id, "Disabling it logs the panel out, and only the web app or another login can turn it back on.");
    if (!warning) {
      this.setTokenActive(token, false, cx);
      return;
    }
    this.d.ask({
      title: "Disable Token?",
      body: (t) => [alertBox(t, t.blocked, [div().w_full().child(warning)])],
      confirmLabel: "Yes, Disable",
      onConfirm: (cx) => { this.d.answered(cx); this.setTokenActive(token, false, cx); },
    }, cx);
  }

  confirmDeleteToken(token, cx) {
    const warning = this.ownershipWarning(token.id, "Deleting it logs the panel out, and you'll need another token to log back in.");
    this.d.ask({
      title: "Delete Token?",
      body: (t) => [alertBox(t, t.blocked, [
        div().w_full().child("Any integrations using this token will no longer be able to access the Mattermost API. You cannot undo this action."),
        div().w_full().child(`Are you sure you want to delete the ${token.description} token?`),
        ...(warning ? [div().w_full().font_semibold().child(warning)] : []),
      ])],
      confirmLabel: "Yes, Delete",
      onConfirm: (cx) => {
        this.d.answered(cx);
        cx.spawn(async (cx) => {
          try {
            await this.d.view.cfgReady;
            await this.api(cx, "/users/tokens/revoke", { method: "POST", body: { token_id: token.id } });
            this.tokens = this.tokens.filter((x) => x.id !== token.id);
            await this.afterTokenChange(cx);
          } catch (e) {
            this.tokenServerError = errorText(e);
          }
          cx.notify();
        });
      },
    }, cx);
  }

  confirmRegenerateToken(token, cx) {
    const exp = this.regen = this.newExpiry();
    const warning = this.ownershipWarning(token.id, "It switches to the new secret by itself.");
    const maxDays = this.maxDays();
    this.d.ask({
      title: "Regenerate Token?",
      enabled: () => !expiryProblem(exp, maxDays),
      body: (t) => {
        const problem = expiryProblem(exp, maxDays);
        return [
          alertBox(t, t.blocked, [
            div().w_full().child("The current secret for this token will stop working immediately. Any integrations using it will need to be updated with the new secret. You cannot undo this action."),
            ...(warning ? [div().w_full().font_semibold().child(warning)] : []),
          ]),
          this.expiryPicker(t, "pf-regen-expiry", exp),
          ...(problem ? [div().w_full().text_color(t.blocked).child(problem)] : []),
          div().w_full().child(`Are you sure you want to regenerate the ${token.description} token?`),
        ];
      },
      confirmLabel: "Yes, Regenerate",
      onConfirm: (cx) => {
        const expires = clampExpiry(resolveExpiry(exp), maxDays);
        this.regen = null;
        this.d.answered(cx);
        this.regenerateToken(token, expires, cx);
      },
    }, cx);
  }

  regenerateToken(token, expires, cx) {
    this.d.pendingCopy = true;
    this.saving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        const rotated = await this.api(cx, "/users/tokens/rotate", { method: "POST", attempts: 1, body: { token_id: token.id, ...(expires > 0 ? { expires_at: expires } : {}) } });
        this.tokens = this.tokens.map((x) => (x.id === rotated.id ? rotated : x));
        this.tokenStage = "created";
        this.newToken = rotated;
        this.copied = false;
        await this.afterTokenChange(cx, rotated.token);
      } catch (e) {
        this.d.pendingCopy = false;
        this.tokenServerError = errorText(e);
      }
      this.saving = false;
      cx.notify();
    });
  }

  // A 401 now means that token was the panel's own. A new secret then takes the old one's place in the login
  // file, and without one the panel logs out, rather than going on failing every call behind this dialog.
  async afterTokenChange(cx, secret = null) {
    const cfg = this.d.view.cfg;
    if (cfg.demo) return;
    try {
      await this.api(cx, "/users/me", { attempts: 1 });
      await this.findOwnToken(cx);
      return;
    } catch (e) {
      if (e?.status !== 401) return;
    }
    if (secret) {
      const old = await readTextFile(loginPath());
      await writeTextFile(loginPath(), `${JSON.stringify({ ...JSON.parse(old), token: secret }, null, 2)}\n`, old);
      await exec("chmod", ["600", loginPath()]);
      cfg.token = secret;
      this.d.media.authed = null;
      this.mine = new Set([this.newToken.id]);
      request("relogin");
      return;
    }
    this.d.pendingCopy = false;
    request("logout");
    this.d.ask({
      title: "Logged Out",
      body: () => [div().w_full().child("That was the token this panel signs in with, so it's logged out. Log in again with another personal access token.")],
      confirmLabel: "OK",
      hideCancel: true,
      onConfirm: () => closeOverlay(props().overlay),
    }, cx);
  }

  tokenRow(t, token, last) {
    const status = tokenStatus(token);
    const badge = status === "active" ? ["Active", "#3db887"] : [status === "expired" ? "Expired" : "Disabled", t.blocked];
    const hasExpiry = token.expires_at > 0;
    const left = hasExpiry ? token.expires_at - Date.now() : Infinity;
    const approaching = status === "active" && hasExpiry && left > 0 && left < APPROACHING_EXPIRY_DAYS * DAY;
    const days = hasExpiry ? Math.max(0, Math.floor((token.expires_at - new Date().setHours(0, 0, 0, 0)) / DAY)) : 0;
    const own = this.ownership(token.id);
    const sep = () => div().child("-");
    return v_flex().id(`pf-token-${token.id}`).w_full()
      .child(h_flex().w_full().gap(4).items_center()
        .child(div().min_w(0).truncate().child(`Token Description: ${token.description}`))
        .child(div().flex_none().px(6).rounded(4).text_size(11).font_semibold().bg(alpha(badge[1], 0.16)).text_color(badge[1]).child(badge[0].toUpperCase())))
      .child(div().w_full().my(4).truncate().child(`Token ID: ${token.id}`))
      .child(h_flex().w_full().my(4).gap(4).items_center()
        .child(div().flex_none().child(`Expires: ${hasExpiry ? `${shortDate(token.expires_at)} ${clock(token.expires_at)}` : "Never"}`))
        .when(approaching, (el) => el.text_color("#f5ab00").child(svg(icon("triangle-alert")).size(14).flex_none().ml(4))
          .child(div().min_w(0).truncate().child(`Expires in ${days} ${days === 1 ? "day" : "days"}`))))
      .when(own === "yes", (el) => el.child(div().w_full().my(4).text_color(alpha(t.foreground, 0.75)).child("This panel signs in with this token.")))
      .child(h_flex().w_full().gap(4).items_center()
        .child(token.is_active
          ? textLink(t, `${token.id}_deactivate`, "Disable", (_e, cx) => this.confirmDisableToken(token, cx))
          : textLink(t, `${token.id}_activate`, "Enable", (_e, cx) => this.setTokenActive(token, true, cx)))
        .when(token.is_active, (el) => el.child(sep()).child(textLink(t, `${token.id}_regenerate`, "Regenerate", (_e, cx) => this.confirmRegenerateToken(token, cx))))
        .child(sep())
        .child(textLink(t, `${token.id}_delete`, "Delete", (_e, cx) => this.confirmDeleteToken(token, cx))))
      .when(!last, (el) => el.child(div().w_full().h(1).my(12).bg(alpha(t.foreground, 0.12))));
  }

  newTokenBox(t) {
    if (this.tokenStage === "creating") {
      const problem = expiryProblem(this.expiry, this.maxDays());
      const empty = this.description.value.trim() === "";
      return v_flex().w_full().p(20).rounded(4).border_1().border_color(alpha(t.foreground, 0.16)).bg(alpha(t.foreground, 0.04))
        .child(div().w_full().mb(16).font_semibold().child("Create New Token"))
        .child(h_flex().w_full().items_start()
          .child(div().flex_none().pr(12).pt(7).font_semibold().child("Token Description: "))
          .child(div().w(240).flex_none().child(this.description.draw(t, "pf-token-description"))))
        .child(this.expiryPicker(t, "pf-new-expiry", this.expiry))
        .child(div().w_full().pt(12).child("Enter a description for your token to remember what it does."))
        .when(Boolean(this.tokenError || problem), (el) => el.child(div().w_full().mt(8).text_color(t.blocked).child(this.tokenError || problem)))
        .child(h_flex().w_full().mt(12).gap(8)
          .child(button(t, "pf-token-save", "Save", (_e, cx) => this.confirmCreateToken(cx), { enabled: !empty && !problem && !this.saving }))
          .child(button(t, "pf-token-cancel", "Cancel", (_e, cx) => this.stopCreatingToken(cx), { emphasis: "tertiary" })));
    }
    if (this.tokenStage === "created") {
      return alertBox(t, "#f5ab00", [
        h_flex().w_full().gap(8).items_start()
          .child(svg(icon("triangle-alert")).size(16).flex_none().mt(2).text_color("#f5ab00"))
          .child(div().flex_1().min_w(0).child("Please copy the access token below. You won't be able to see it again!")),
        div().w_full().truncate().child(`Token Description: ${this.newToken.description}`),
        div().w_full().truncate().child(`Token ID: ${this.newToken.id}`),
        this.tokenValue(t, "pf-new-token"),
      ]);
    }
    return h_flex().w_full().child(button(t, "pf-token-create", "Create Token", (_e, cx) => this.startCreatingToken(cx)));
  }

  tokenSection(t) {
    if (!this.canUseTokens()) return null;
    return this.section(t, "tokens", "Personal Access Tokens", "Click 'Edit' to manage your personal access tokens", (t) => {
      const shown = this.tokens.filter((token) => token.id !== this.newToken?.id);
      const hideList = this.tokenStage === "created" && !shown.length;
      return sectionMax(t, "tokens", {
        title: "Personal Access Tokens",
        full: true,
        infoTop: true,
        extra: TextView.markdown("pf-token-help", `[Personal access tokens](${TOKEN_DOCS}) function similarly to session tokens and can be used by integrations to [authenticate against the REST API](${API_DOCS}).`).on_link_click((url) => openLink(url)),
        inputs: [v_flex().w_full().pt(8)
          .when(!hideList, (el) => el.child(v_flex().w_full().mb(20).px(12).py(8).rounded(4).border_1().border_color(alpha(t.foreground, 0.12)).bg(t.background)
            .when(shown.length === 0, (b) => b.child(div().w_full().child("No personal access tokens.")))
            .children(shown.map((token, i) => this.tokenRow(t, token, i === shown.length - 1)))))
          .child(this.newTokenBox(t))],
        error: this.tokenServerError,
        cancelLabel: "Close",
        cancel: (cx) => this.closeSection(cx),
      });
    });
  }

  signInSection(t) {
    const c = this.config, u = this.d.user;
    const allowedToSwitch = c.EnableSignUpWithEmail === "true" && (c.EnableSignInWithEmail === "true" || c.EnableSignInWithUsername === "true");
    const methods = [
      ["gitlab", "EnableSignUpWithGitLab", "Switch to Using GitLab SSO"], ["google", "EnableSignUpWithGoogle", "Switch to Using Google SSO"],
      ["office365", "EnableSignUpWithOffice365", "Switch to Using Entra ID SSO"], ["openid", "EnableSignUpWithOpenId", "Switch to Using OpenID SSO"],
      ["ldap", "EnableLdap", "Switch to Using AD/LDAP"], ["saml", "EnableSaml", "Switch to Using SAML SSO"],
    ].filter(([, key]) => c[key] === "true");
    if (!((allowedToSwitch || u.auth_service === "") && methods.length > 0 && c.ExperimentalEnableAuthenticationTransfer === "true")) return null;
    const email = encodeURIComponent(u.email ?? "");
    return this.section(t, "signin", "Sign-in Method", METHODS[u.auth_service] ?? "Email and Password", (t) => {
      // These are pages of the web app: they ask for your password and hand over to the SSO provider, so
      // they open in the browser.
      const go = (id, label, path) => h_flex().w_full().pb(12).child(button(t, `pf-signin-${id}`, label, () => openLink(`${this.d.view.cfg?.url}${path}`)));
      const buttons = u.auth_service === ""
        ? methods.map(([id, , label]) => go(id, label, id === "ldap" ? `/claim/email_to_ldap?email=${email}` : `/claim/email_to_oauth?email=${email}&old_type=&new_type=${id}`))
        : allowedToSwitch && u.auth_service !== "magic_link"
          ? [go("email", "Switch to Using Email and Password", u.auth_service === "ldap" ? `/claim/ldap_to_email?email=${email}` : `/claim/oauth_to_email?email=${email}&old_type=${u.auth_service}`)]
          : [];
      const note = u.auth_service === "magic_link" ? "Magic Link is the only sign-in method available for this account."
        : "You may only have one sign-in method at a time. Switching sign-in method will send an email notifying you if the change was successful.";
      const sso = u.auth_service === "google" ? [div().w_full().pt(8).child("Note: When using Google SSO, changes to your Google username or email do not automatically sync to Mattermost. To update your username, switch temporarily to email/password login, update your username, and then switch back to Google SSO.")] : [];
      return sectionMax(t, "signin", {
        title: "Sign-in Method",
        inputs: buttons,
        extra: v_flex().w_full().child(div().w_full().child(note)).children(sso),
        error: this.serverError,
        cancel: (cx) => this.closeSection(cx),
      });
    });
  }

  layerOpen() {
    return this.layer;
  }

  closeLayer(cx) {
    this.layer = null;
    cx.notify();
  }

  openSessions(cx) {
    this.layer = "sessions";
    this.sessions = null;
    this.moreInfo = new Set();
    this.layerError = "";
    this.reloadSessions(cx);
    cx.notify();
  }

  reloadSessions(cx) {
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        this.sessions = await this.api(cx, `/users/${this.d.user.id}/sessions`);
      } catch (e) {
        this.sessions ??= [];
        this.layerError = errorText(e);
      }
      cx.notify();
    });
  }

  revokeSession(session, cx) {
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        await this.api(cx, `/users/${this.d.user.id}/sessions/revoke`, { method: "POST", body: { session_id: session.id } });
        this.layerError = "";
      } catch (e) {
        this.layerError = errorText(e);
      }
      this.reloadSessions(cx);
    });
  }

  openHistory(cx) {
    this.layer = "history";
    this.audits = null;
    this.layerError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.d.view.cfgReady;
        const audits = await this.api(cx, `/users/${this.d.user.id}/audits?page=0&per_page=200`);
        this.audits = audits.map((a) => {
          const d = new Date(a.create_at);
          return { id: a.id, date: shortDate(d), time: clock(d.getTime()), desc: auditDescription(a), ip: a.ip_address ?? "", session: a.session_id ?? "" };
        });
      } catch (e) {
        this.audits = [];
        this.layerError = errorText(e);
      }
      cx.notify();
    });
  }

  sessionRow(t, session, first) {
    const device = sessionDevice(session);
    const at = (label, ms) => `${label}: ${longDate(ms)}, ${clock(ms)}`;
    const more = this.moreInfo.has(session.id);
    return h_flex().id(`pf-session-${session.id}`).w_full().py(15).items_start().gap(12)
      .when(!first, (el) => el.border_t_1().border_color(alpha(t.foreground, 0.12)))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(h_flex().w_full().gap(6).items_center().text_size(15).font_semibold()
          .when(Boolean(device.icon), (el) => el.child(svg(icon(device.icon)).size(16).flex_none()))
          .child(div().min_w(0).truncate().child(device.name ?? "")))
        .child(v_flex().w_full().gap(2).opacity(0.8)
          .child(div().w_full().child(at("Last activity", session.last_activity_at)))
          .when(more, (el) => el
            .child(div().w_full().child(at("First time active", session.create_at)))
            .child(div().w_full().child(`OS: ${session.props?.os ?? ""}`))
            .child(div().w_full().child(`Browser: ${session.props?.browser ?? ""}`))
            .child(div().w_full().child(`Session ID: ${session.id}`)))
          .when(!more, (el) => el.child(textLink(t, `pf-session-more-${session.id}`, "More info", (_e, cx) => { this.moreInfo.add(session.id); cx.notify(); })))))
      .child(button(t, `pf-session-revoke-${session.id}`, "Log Out", (_e, cx) => this.revokeSession(session, cx)));
  }

  sessionsLayer(t) {
    // A personal access token's session isn't listed, the panel's own among them: revoking one only makes
    // the server start another at its next request.
    const sessions = (this.sessions ?? []).filter((s) => s.props?.type !== TOKEN_TYPE);
    return stackedModal(t, "pf-sessions", "Active Sessions", (_e, cx) => this.closeLayer(cx),
      div().id("pf-sessions-list").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().w_full().p(24)
          .child(div().w_full().pb(20).child("Sessions are created when you log in through a new browser on a device. Sessions let you use Mattermost without having to log in again for a time period specified by the system administrator. To end the session sooner, use the 'Log Out' button."))
          .when(Boolean(this.layerError), (el) => el.child(div().w_full().mb(16).child(errorRow(t, this.layerError))))
          .when(this.sessions === null, (el) => el.child(div().w_full().text_color(alpha(t.foreground, 0.75)).child("Loading...")))
          .children(sessions.map((s, i) => this.sessionRow(t, s, i === 0)))));
  }

  // Up to 200 rows, and Herdr redraws a dialog on every live-data change, so only those on screen are built.
  historyLayer(t) {
    const audits = this.audits ?? [];
    const cols = (date, desc, ip, session) => h_flex().w_full().px(24).gap(12).items_center()
      .child(div().w(100).flex_none().child(date))
      .child(div().flex_1().min_w(0).child(desc))
      .child(div().w(120).flex_none().truncate().child(ip))
      .child(div().w(210).flex_none().truncate().child(session));
    const row = (a) => cols(v_flex().child(div().child(a.date)).child(div().child(a.time)), a.desc, a.ip, a.session)
      .h(AUDIT_ROW).border_t_1().border_color(alpha(t.foreground, 0.12)).overflow_hidden();
    return stackedModal(t, "pf-history", "Access History", (_e, cx) => this.closeLayer(cx),
      v_flex().flex_1().min_h(0)
        .when(Boolean(this.layerError), (el) => el.child(div().w_full().p(24).child(errorRow(t, this.layerError))))
        .when(this.audits === null, (el) => el.child(div().w_full().p(24).text_color(alpha(t.foreground, 0.75)).child("Loading...")))
        .when(this.audits !== null, (el) => el
          .child(cols("Timestamp", "Action", "IP Address", "Session ID").flex_none().h(40).font_semibold())
          .child(v_flex().relative().flex_1().min_h(0)
            .child(v_virtual_list("pf-audits", audits.length, AUDIT_ROW, (i) => audits[i].id, (range) => audits.slice(range.start, range.end).map(row)))
            .child(Scrollbar.vertical("pf-audits").absolute().inset_0()))));
  }

  drawLayer(t) {
    return this.layer === "sessions" ? this.sessionsLayer(t) : this.historyLayer(t);
  }

  draw(t) {
    const rule = () => dividerLight(t);
    const optional = [this.mfaSection(t), this.oauthSection(t), this.tokenSection(t), this.signInSection(t)].filter(Boolean);
    const link = (id, name, label, onClick, color = t.accent) => h_flex().id(id).flex_none().gap(6).items_center().cursor_pointer().text_color(color)
      .hover((s) => s.underline()).on_click(onClick)
      .child(svg(icon(name)).size(14).flex_none())
      .child(div().child(label));
    const deleteLink = this.config.DeleteAccountLink;
    return v_flex().w_full()
      .child(tabHeader("Security Settings"))
      .child(dividerDark(t))
      .child(this.passwordSection(t))
      .children(optional.flatMap((section) => [rule(), section]))
      .child(dividerDark(t))
      .child(v_flex().w_full().items_start().pt(20).gap(8)
        .child(link("pf-view-history", "clock", "View Access History", (_e, cx) => this.openHistory(cx)))
        .child(link("pf-view-sessions", "clock", "View and Log Out of Active Sessions", (_e, cx) => this.openSessions(cx)))
        .when(Boolean(deleteLink), (el) => el.child(link("pf-delete-account", "trash", "Delete Your Account", () => openLink(deleteLink), t.blocked))));
  }
}
