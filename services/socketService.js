const { setIo } = require('../sockets/utils');
const logger = require('../utils/logger');
const { socketAuth } = require('../utils/jwt');
const registerDriverSocketHandlers = require('../modules/driver/driverSocketHandlers');
const attachSocketHandlers = require('../sockets');

function initializeSocket(io) {
  setIo(io);
  io.use(socketAuth);
  io.on('connection', (socket) => {
    logger.info('[socket] connection', { socketId: socket.id, user: socket.user });
    // Keep original sockets/ handlers (includes booking_request and others)
    try { attachSocketHandlers.attachSocketHandlers && attachSocketHandlers.attachSocketHandlers(io); } catch (_) {}
    // Additional modular driver handlers can coexist
    registerDriverSocketHandlers(io, socket);
    socket.on('disconnect', () => {
      logger.info('[socket] disconnect', { socketId: socket.id, user: socket.user });
    });
  });
}

module.exports = { initializeSocket };

