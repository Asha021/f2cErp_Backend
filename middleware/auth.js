const jwt = require('jsonwebtoken');

// Replaces PHP session-based AuthMiddleware (includes/auth_middleware.php)
// with stateless JWT, since Express APIs are consumed by a separate React app.

function verifyToken(req, res, next) {
  const header = req.headers['authorization'];
  let token = header && header.startsWith('Bearer ') ? header.split(' ')[1] : null;
  if (!token) token = req.query.token;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Please login to continue' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { user_id, username, role, company_id }
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Session expired, please login again' });
  }
}

// Equivalent of requireSuperAdmin()
function requireSuperAdmin(req, res, next) {
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }
  next();
}

// Equivalent of requireAdmin()
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }
  next();
}

module.exports = { verifyToken, requireSuperAdmin, requireAdmin };
