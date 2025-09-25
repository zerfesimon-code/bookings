const jwt = require('jsonwebtoken');
require('dotenv').config();

function generateUserInfoToken(user, type, roles = [], permissions = []) {
  const payload = {
    id: user.id || user._id || user._doc?._id,
    type,
    roles,
    permissions
  };
  const secret = process.env.JWT_SECRET || 'secret';
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  return jwt.sign(payload, secret, { expiresIn });
}

function socketAuth(socket, next) {
  try {
    const raw = socket.handshake.auth?.token
      || socket.handshake.query?.token
      || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
    if (!raw) return next();
    const decoded = jwt.verify(raw, process.env.JWT_SECRET || 'secret');
    socket.user = {
      id: decoded.id ? String(decoded.id) : undefined,
      type: decoded.type,
      name: decoded.name || decoded.fullName || decoded.displayName,
      phone: decoded.phone || decoded.phoneNumber || decoded.mobile,
      email: decoded.email,
      vehicleType: decoded.vehicleType
    };
    socket.authToken = raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`;
    return next();
  } catch (e) {
    return next();
  }
}

module.exports = { generateUserInfoToken, socketAuth };

