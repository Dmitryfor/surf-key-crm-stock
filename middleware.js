export const config = {
  matcher: '/((?!_next/static|_vercel|favicon.ico).*)',
};

function encodeBasic(user, pass) {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
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

export default function middleware(req) {
  const user = process.env.AUTH_USER;
  const pass = process.env.AUTH_PASS;

  if (!user || !pass) {
    return new Response('Auth not configured', { status: 500 });
  }

  const header = req.headers.get('authorization') || '';
  const expected = encodeBasic(user, pass);

  if (!timingSafeEqual(header, expected)) {
    return new Response('Auth required', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="KeyCRM Stocks"',
        'Cache-Control': 'no-store',
      },
    });
  }
}
