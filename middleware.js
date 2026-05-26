export const config = {
  matcher: '/((?!_next/static|_vercel|favicon.ico).*)',
};

export default function middleware(req) {
  const user = process.env.AUTH_USER;
  const pass = process.env.AUTH_PASS;

  if (!user || !pass) {
    return new Response('Auth not configured', { status: 500 });
  }

  const header = req.headers.get('authorization') || '';
  const expected = 'Basic ' + btoa(`${user}:${pass}`);

  if (header !== expected) {
    return new Response('Auth required', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="KeyCRM Stocks"',
        'Cache-Control': 'no-store',
      },
    });
  }
}
