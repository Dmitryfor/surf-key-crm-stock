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

// Deterministic token proving the holder once knew the password.
// Cannot be forged without the secret; rotating AUTH_PASS invalidates old cookies.
async function makeToken(user, secret) {
  const key = await crypto.subtle.importKey(
    'raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc(`v1:${user}`));
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

export default async function middleware(req) {
  const user = process.env.AUTH_USER;
  const pass = process.env.AUTH_PASS;

  if (!user || !pass) {
    return new Response('Auth not configured', { status: 500 });
  }

  const secret = process.env.AUTH_SECRET || pass;
  const token = await makeToken(user, secret);

  // 1) Already logged in once → cookie present, no prompt.
  if (timingSafeEqual(readCookie(req, COOKIE_NAME), token)) {
    return; // continue
  }

  // 2) First time → validate Basic Auth, then remember via cookie (redirect to self).
  const header = req.headers.get('authorization') || '';
  if (timingSafeEqual(header, encodeBasic(user, pass))) {
    const cookie = `${COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; `
      + 'HttpOnly; Secure; SameSite=Lax';
    return new Response(null, {
      status: 302,
      headers: { Location: req.url, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' },
    });
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
