// The demo's account: what the Profile modal's Security tab reads and changes. Nothing here reaches the
// network, and revoking the demo's own token or session only takes it off these lists.

const NOW = Date.now();
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const ME = "u-alex";
const PASSWORD = "demo-password";
const MFA_CODE = "123456";
// Not a real code: a picture for the demo's setup screen.
const QR = "iVBORw0KGgoAAAANSUhEUgAAALkAAAC5AQAAAABc1qPxAAABcElEQVR42u2XPa6EMAyEvaJIyRFyE7gYEpG4GLlJjkBJgfCODU+P/WkzT3q7KRDR11gezxhE358kX/CPwSIiNzzC3GrRGbdABKNqXpoS9lY1ZJTEBIPgukW7xpAXiWywNIpe+NsfAPETlQ1Mj7Mlos9C1QY+iWPRHS+vI1oX+DE9bjq9mrMyQEHmwSg9mrPaRBABalk7cVG0rD2UYYIEPXBde8ykzm0SIjAbIHiKdAJReksBIhj1CIDOXNihKiooBmADK00uLSEA3awalAb7xXD1IAFY+uwyYBgwiY8eJAAvY3NDYCLa7RJL1QEOAgDjeC6+FJUHbMVkS71z7QxUMFrkJncA8u9BqOoAKnjmIAUmS+DmZ91RgJ9NVu+GeUF54Ny1WDb4uIMoAxX4soEUSH70RfCNSQQ+/Nh0HVqC6Ps1Jw0gAPLRnOG67jggRegxYd15FPDAoYf3xXLoWai6wBvRFPM+RLnsWgL4/jt/GLgDFhKXMTI85k8AAAAASUVORK5CYII=";

export const ACCOUNT_USER = {
  roles: "system_user system_user_access_token", auth_service: "", mfa_active: false, last_password_update: NOW - 40 * DAY, last_picture_update: NOW - 90 * DAY,
};

export const ACCOUNT_CONFIG = {
  EnableUserAccessTokens: "true", EnableOAuthServiceProvider: "true", EnableMultifactorAuthentication: "true", MaxFileSize: "52428800",
  MaximumPersonalAccessTokenLifetimeDays: "0", RequireEmailVerification: "false", PasswordMinimumLength: "8", PasswordRequireLowercase: "true",
  PasswordRequireUppercase: "false", PasswordRequireNumber: "true", PasswordRequireSymbol: "false", SiteName: "Acme Chat",
};

const TOKENS = [
  { id: "tok-panel", user_id: ME, description: "Herdr panel", is_active: true, expires_at: 0 },
  { id: "tok-release", user_id: ME, description: "Release script", is_active: true, expires_at: NOW + 3 * DAY },
  { id: "tok-laptop", user_id: ME, description: "Old laptop", is_active: false, expires_at: 0 },
  { id: "tok-ci", user_id: ME, description: "CI nightly", is_active: true, expires_at: NOW - 2 * DAY },
];
let nextToken = 1;

const session = (id, device_id, os, browser, platform, active, created, type = {}) => ({ id, user_id: ME, device_id, create_at: NOW - created, last_activity_at: NOW - active, props: { os, browser, platform, ...type } });
const SESSIONS = [
  session("s-panel", "", "", "", "", MIN, 8 * DAY, { type: "UserAccessToken", user_access_token_id: "tok-panel" }),
  session("s-mac", "", "Mac OS", "Chrome/131.0", "Macintosh", 20 * MIN, 3 * DAY),
  session("s-desktop", "", "Linux", "Mattermost Desktop App/5.10", "Linux", 2 * HOUR, 12 * DAY),
  session("s-phone", "apple_rn:abc", "iOS 18", "Mobile App", "iPhone", 26 * HOUR, 30 * DAY),
  session("s-old", "", "Windows 11", "Firefox/133.0", "Windows", 9 * DAY, 41 * DAY),
];

const APPS = [
  { id: "app-grafana", name: "Grafana", description: "Dashboards sign in with your Mattermost account.", homepage: "https://grafana.example", icon_url: "" },
  { id: "app-board", name: "Focalboard Sync", description: "Mirrors your boards to the team calendar.", homepage: "https://boards.example", icon_url: "" },
];

const AUDIT_KINDS = [
  ["/api/v4/users/login", "success"], ["/api/v4/users/login", "attempt"], ["/api/v4/users/me/patch", ""], ["/api/v4/users/newpassword", ""], ["/api/v4/users/newimage", ""],
  ["/api/v4/channels/create", "name=release-prep"], ["/api/v4/logout", ""], ["/api/v4/oauth/allow", "success"], ["/api/v4/users/revoke_session", "session_id=s-old"],
  ["/api/v4/users/tokens", "success - token_id=tok-release"],
];
const AUDITS = Array.from({ length: 120 }, (_, i) => {
  const [action, extra_info] = AUDIT_KINDS[i % AUDIT_KINDS.length];
  return { id: `audit-${i}`, create_at: NOW - i * 7 * HOUR - 4 * MIN, user_id: ME, action, extra_info, ip_address: i % 4 ? "10.1.20.14" : "203.0.113.42", session_id: i % 3 ? "s-mac" : "s-phone" };
});

const refuse = (status, id, text) => { throw Object.assign(new Error(text), { status, id, text }); };

// What the demo's server answers for the account, or undefined for what's not about the account.
export function accountApi(route, method, body, me) {
  if (route === `/users/${ME}/oauth/apps/authorized`) return APPS;
  if (route === `/users/${ME}/tokens`) {
    if (method === "GET") return TOKENS;
    const made = { id: `tok-new-${nextToken}`, user_id: ME, description: body.description, is_active: true, expires_at: body.expires_at ?? 0 };
    TOKENS.push(made);
    return { ...made, token: `demotoken${String(nextToken++).padStart(17, "0")}` };
  }
  const token = (id) => TOKENS.find((x) => x.id === id);
  if (route === "/users/tokens/revoke") { TOKENS.splice(TOKENS.indexOf(token(body.token_id)), 1); return {}; }
  if (route === "/users/tokens/disable") { token(body.token_id).is_active = false; return {}; }
  if (route === "/users/tokens/enable") { token(body.token_id).is_active = true; return {}; }
  if (route === "/users/tokens/rotate") {
    const old = token(body.token_id);
    old.expires_at = body.expires_at ?? 0;
    return { ...old, token: `demotoken${String(nextToken++).padStart(17, "0")}` };
  }
  if (route === `/users/${ME}/sessions`) return SESSIONS;
  if (route === `/users/${ME}/sessions/revoke`) { SESSIONS.splice(SESSIONS.findIndex((s) => s.id === body.session_id), 1); return {}; }
  if (route === `/users/${ME}/audits`) return AUDITS;
  if (route === `/users/${ME}/password`) {
    if (body.current_password !== PASSWORD) refuse(400, "api.user.check_user_password.invalid.app_error", `The demo's password is ${PASSWORD}.`);
    return {};
  }
  if (route === `/users/${ME}/mfa/generate`) return { secret: "DEMOSECRETDEMOSECRETDEMO", qr_code: QR };
  if (route === `/users/${ME}/mfa`) {
    if (body.activate && body.code !== MFA_CODE) refuse(400, "ent.mfa.activate.authenticate.app_error", "Invalid code.");
    me.mfa_active = body.activate;
    return {};
  }
  if (route === `/users/${ME}/image` && method === "DELETE") { me.last_picture_update = 0; return {}; }
  if (route === "/users/me/patch" && body.email && body.password !== PASSWORD) refuse(400, "api.user.check_user_password.invalid.app_error", `The demo's password is ${PASSWORD}.`);
  return undefined;
}
