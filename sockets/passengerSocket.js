const logger = require('../utils/logger');

module.exports = (io, socket) => {
  try { logger.info('[socket] passenger namespace attached', { sid: socket.id, user: socket.user && { id: socket.user.id, type: socket.user.type } }); } catch (_) {}
  // booking:notes_fetch, booking:note can be handled under booking if desired.
  // Placeholder for passenger-specific socket events (notifications, etc.).
};

