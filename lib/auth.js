// Role-aware auth shared by server.js (local) and api/*.js (prod, Node runtime).
//
// The site sits behind Basic Auth (middleware.js on Vercel). There are TWO accounts:
//   • manager (AUTH_USER / AUTH_PASS)  — normal access, GEO hidden
//   • admin   (ADMIN_USER / ADMIN_PASS) — sees the GEO tab + /api/geo
//
// On login the edge middleware sets a signed cookie `surf_auth` = HMAC(secret, "v1:<role>")
// (base64url, no padding). This module re-derives & verifies that SAME token with Node crypto,
// so middleware (Web Crypto) and the API (Node crypto) must agree byte-for-byte — they do:
// both are HMAC-SHA256 over the same string with the same secret, base64url without padding.
// secret = AUTH_SECRET || AUTH_PASS (must match middleware). Rotating it invalidates cookies.

const crypto = require('crypto');

const COOKIE_NAME = 'surf_auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function authConfig() {
  const managerUser = process.env.AUTH_USER || '';
  const managerPass = process.env.AUTH_PASS || '';
  const adminUser = process.env.ADMIN_USER || '';
  const adminPass = process.env.ADMIN_PASS || '';
  const secret = process.env.AUTH_SECRET || managerPass || adminPass || '';
  return {
    managerUser, managerPass, adminUser, adminPass, secret,
    managerConfigured: Boolean(managerUser && managerPass),
    adminConfigured: Boolean(adminUser && adminPass),
  };
}

function roleToken(role, secret) {
  return crypto.createHmac('sha256', secret).update(`v1:${role}`).digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function readCookie(cookieHeader, name) {
  const raw = cookieHeader || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

// 'admin' | 'manager' | null
function roleFromCookie(cookieHeader) {
  const { secret, adminConfigured } = authConfig();
  const c = readCookie(cookieHeader, COOKIE_NAME);
  if (!c) return null;
  if (adminConfigured && safeEqual(c, roleToken('admin', secret))) return 'admin';
  if (safeEqual(c, roleToken('manager', secret))) return 'manager';
  return null;
}

function isAdmin(cookieHeader) {
  return roleFromCookie(cookieHeader) === 'admin';
}

module.exports = {
  COOKIE_NAME,
  COOKIE_MAX_AGE,
  authConfig,
  roleToken,
  safeEqual,
  readCookie,
  roleFromCookie,
  isAdmin,
};
