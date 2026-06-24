import { next } from '@vercel/edge';

export const config = {
  matcher: '/((?!_next/static|_vercel|favicon.ico).*)',
};

// How long a successful login is remembered (browser keeps the cookie).
const COOKIE_NAME = 'surf_auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const enc = (s) => new TextEncoder().encode(s);

function encodeBasic(user, pass) {
  const bytes = enc(`${user}:${pass}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'Basic ' + btoa(bin);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64url(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Deterministic token proving the holder logged in as <role>. Mirrors lib/auth.js roleToken()
// (HMAC-SHA256 over "v1:<role>", base64url, no padding) so the Node API can verify it.
// Cannot be forged without the secret; rotating the secret invalidates old cookies.
async function roleToken(role, secret) {
  const key = await crypto.subtle.importKey(
    'raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc(`v1:${role}`));
  return base64url(sig);
}

function readCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function setCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

export default async function middleware(req) {
  const managerUser = process.env.AUTH_USER;
  const managerPass = process.env.AUTH_PASS;

  if (!managerUser || !managerPass) {
    return new Response('Auth not configured', { status: 500 });
  }

  const adminUser = process.env.ADMIN_USER;
  const adminPass = process.env.ADMIN_PASS;
  const adminConfigured = Boolean(adminUser && adminPass);

  const secret = process.env.AUTH_SECRET || managerPass;
  const managerToken = await roleToken('manager', secret);
  const adminToken = adminConfigured ? await roleToken('admin', secret) : null;

  // 1) Already logged in once → cookie present (either role), no prompt.
  const cookie = readCookie(req, COOKIE_NAME);
  if (adminToken && timingSafeEqual(cookie, adminToken)) return; // continue (admin)
  if (timingSafeEqual(cookie, managerToken)) return; // continue (manager)

  // 2) First time → validate Basic Auth (admin first so it wins on overlap), remember via cookie.
  // Set the cookie on a pass-through (next) response, NOT a redirect: Safari silently drops
  // Set-Cookie on 3xx responses, which re-prompted Basic Auth on every visit. A 200 sticks.
  const header = req.headers.get('authorization') || '';
  if (adminConfigured && timingSafeEqual(header, encodeBasic(adminUser, adminPass))) {
    return next({ headers: { 'Set-Cookie': setCookie(adminToken) } });
  }
  if (timingSafeEqual(header, encodeBasic(managerUser, managerPass))) {
    return next({ headers: { 'Set-Cookie': setCookie(managerToken) } });
  }

  // 3) No cookie, no valid credentials → challenge.
  return new Response('Auth required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="KeyCRM Stocks"',
      'Cache-Control': 'no-store',
    },
  });
}
