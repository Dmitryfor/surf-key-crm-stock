import auth from '../lib/auth.js';

// GET /api/role → { role, admin }. Derived from the signed surf_auth cookie set by middleware.
// On Vercel the middleware guarantees a valid cookie before this runs.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const role = auth.roleFromCookie(req.headers.cookie) || 'manager';
  res.status(200).json({ role, admin: role === 'admin' });
}
