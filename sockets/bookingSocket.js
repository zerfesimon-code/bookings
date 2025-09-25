const bookingService = require('../services/bookingService');
const bookingEvents = require('../events/bookingEvents');
const { sendMessageToSocketId } = require('./utils');
const lifecycle = require('../services/bookingLifecycleService');
const logger = require('../utils/logger');
const { Booking } = require('../models/bookingModels');

// Prevent duplicate booking:new dispatches to the same driver for the same booking
// Key format: `${bookingId}:${driverId}`; values are timestamps for basic TTL cleanup
const dispatchedBookingToDriver = new Map();
const DISPATCH_TTL_MS = 5 * 60 * 1000; // 5 minutes
function markDispatched(bookingId, driverId) {
  dispatchedBookingToDriver.set(`${bookingId}:${driverId}`, Date.now());
}
function wasDispatched(bookingId, driverId) {
  const ts = dispatchedBookingToDriver.get(`${bookingId}:${driverId}`);
  if (!ts) return false;
  if (Date.now() - ts > DISPATCH_TTL_MS) {
    dispatchedBookingToDriver.delete(`${bookingId}:${driverId}`);
    return false;
  }
  return true;
}
function cleanupDispatches() {
  const now = Date.now();
  for (const [key, ts] of dispatchedBookingToDriver.entries()) {
    if (now - ts > DISPATCH_TTL_MS) dispatchedBookingToDriver.delete(key);
  }
}
setInterval(cleanupDispatches, DISPATCH_TTL_MS).unref();

module.exports = (io, socket) => {
  // booking_request (create booking)
  socket.on('booking_request', async (payload) => {
    try { logger.info('[socket<-passenger] booking_request', { sid: socket.id, userId: socket.user && socket.user.id }); } catch (_) {}
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'passenger') {
        return socket.emit('booking_error', { message: 'Unauthorized: passenger token required' });
      }
      const passengerId = String(socket.user.id);
      const booking = await bookingService.createBooking({
        passengerId,
        jwtUser: socket.user,
        vehicleType: data.vehicleType || 'mini',
        pickup: data.pickup,
        dropoff: data.dropoff,
        authHeader: socket.authToken ? { Authorization: socket.authToken } : undefined
      });
      const bookingRoom = `booking:${String(booking._id)}`;
      socket.join(bookingRoom);
      const createdPayload = { bookingId: String(booking._id) };
      try { logger.info('[socket->passenger] booking:created', { sid: socket.id, userId: socket.user && socket.user.id, bookingId: createdPayload.bookingId }); } catch (_) {}
      socket.emit('booking:created', createdPayload);

      // Select the nearest driver who can accept (has sufficient package balance)
      try {
        const { Driver } = require('../models/userModels');
        const geolib = require('geolib');
        const { Wallet } = require('../models/common');
        const financeService = require('../services/financeService');

        const radiusKm = parseFloat(process.env.BROADCAST_RADIUS_KM || process.env.RADIUS_KM || '5');
        const drivers = await Driver.find({ available: true, ...(booking.vehicleType ? { vehicleType: booking.vehicleType } : {}) }).lean();

        const withDistance = drivers.map(d => ({
          driver: d,
          distanceKm: d.lastKnownLocation && d.lastKnownLocation.latitude != null && d.lastKnownLocation.longitude != null
            ? (geolib.getDistance(
                { latitude: d.lastKnownLocation.latitude, longitude: d.lastKnownLocation.longitude },
                { latitude: booking.pickup.latitude, longitude: booking.pickup.longitude }
              ) / 1000)
            : Number.POSITIVE_INFINITY
        }))
        .filter(x => Number.isFinite(x.distanceKm) && x.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm);

        const targetFare = booking.fareFinal || booking.fareEstimated || 0;
        let chosenDriver = null;
        for (const item of withDistance) {
          try {
            const w = await Wallet.findOne({ userId: String(item.driver._id), role: 'driver' }).lean();
            const balance = w ? Number(w.balance || 0) : 0;
            if (financeService.canAcceptBooking(balance, targetFare)) {
              chosenDriver = item.driver;
              break;
            }
          } catch (_) {}
        }

        if (chosenDriver) {
          const bookingDetails = {
            id: String(booking._id),
            status: 'requested',
            passengerId,
            passenger: { id: passengerId, name: socket.user.name, phone: socket.user.phone },
            vehicleType: booking.vehicleType,
            pickup: booking.pickup,
            dropoff: booking.dropoff,
            fareEstimated: booking.fareEstimated,
            fareFinal: booking.fareFinal,
            distanceKm: booking.distanceKm,
            createdAt: booking.createdAt,
            updatedAt: booking.updatedAt
          };
          const patch = {
            status: 'requested',
            passengerId,
            vehicleType: booking.vehicleType,
            pickup: booking.pickup,
            dropoff: booking.dropoff,
            passenger: { id: passengerId, name: socket.user.name, phone: socket.user.phone }
          };
          const payloadForDriver = { bookingId: String(booking._id), booking: bookingDetails, patch, user: { id: passengerId, type: 'passenger' } };
          const channel = `driver:${String(chosenDriver._id)}`;
          // Deduplicate dispatch per booking-driver
          if (!wasDispatched(String(booking._id), String(chosenDriver._id))) {
            sendMessageToSocketId(channel, { event: 'booking:new', data: payloadForDriver });
            markDispatched(String(booking._id), String(chosenDriver._id));
            try { logger.info('message sent to:  driver:' + String(chosenDriver._id), { bookingId: String(booking._id) }); } catch (_) {}
          } else {
            try { logger.info('skipped duplicate booking:new', { bookingId: String(booking._id), driverId: String(chosenDriver._id) }); } catch (_) {}
          }
        } else {
          try { logger.info('[socket->drivers] no eligible driver (package/distance)', { bookingId: String(booking._id) }); } catch (_) {}
        }
      } catch (err) { try { logger.error('[booking_request] broadcast error', err); } catch (_) {} }
    } catch (err) {
      socket.emit('booking_error', { message: 'Failed to create booking' });
    }
  });

  // booking_accept
  socket.on('booking_accept', async (payload) => {
    try { logger.info('[socket<-driver] booking_accept', { sid: socket.id, userId: socket.user && socket.user.id, payload }); } catch (_) {}
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver' || !socket.user.id) {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', bookingId });
      }
      if (!bookingId) return socket.emit('booking_error', { message: 'bookingId is required' });

      // Only allow accept transition via lifecycle update in service
      const updated = await bookingService.updateBookingLifecycle({ requester: socket.user, id: bookingId, status: 'accepted' });
      const room = `booking:${String(updated._id)}`;
      socket.join(room);
      bookingEvents.emitBookingUpdate(String(updated._id), { status: 'accepted', driverId: String(socket.user.id), acceptedAt: updated.acceptedAt });
      try { logger.info('[socket->room] booking:update accepted', { bookingId: String(updated._id), driverId: String(socket.user.id) }); } catch (_) {}

      // Emit explicit booking_accept with enriched driver details to booking room
      try {
        const { Driver } = require('../models/userModels');
        const d = await Driver.findById(String(socket.user.id)).lean();
        const driverPayload = {
          id: String(socket.user.id),
          name: (d && d.name) || socket.user.name,
          phone: (d && d.phone) || socket.user.phone,
          carName: (d && (d.carModel || d.carName)) || socket.user.carName || socket.user.carModel,
          vehicleType: (d && d.vehicleType) || socket.user.vehicleType,
          rating: (d && (d.rating || d.rating === 0 ? d.rating : undefined)) ?? 5.0,
          carPlate: d && d.carPlate || socket.user.carPlate
        };
        const acceptPayload = {
          bookingId: String(updated._id),
          status: 'accepted',
          driver: driverPayload,
          user: { id: String(socket.user.id), type: 'driver' }
        };
        try { logger.info('[socket->room] booking_accept', { room, bookingId: acceptPayload.bookingId, driverId: driverPayload.id }); } catch (_) {}
        io.to(room).emit('booking_accept', acceptPayload);
      } catch (_) {}

      // Inform nearby drivers to remove
      try {
        const { Driver } = require('../models/userModels');
        const geolib = require('geolib');
        const drivers = await Driver.find({ available: true }).lean();
        const radiusKm = parseFloat(process.env.RADIUS_KM || process.env.BROADCAST_RADIUS_KM || '5');
        const vehicleType = updated.vehicleType;
        const nearby = drivers.filter(d => (
          d && d._id && String(d._id) !== String(socket.user.id) &&
          d.lastKnownLocation &&
          (!vehicleType || String(d.vehicleType || '').toLowerCase() === String(vehicleType || '').toLowerCase()) &&
          (geolib.getDistance(
            { latitude: d.lastKnownLocation.latitude, longitude: d.lastKnownLocation.longitude },
            { latitude: updated.pickup?.latitude, longitude: updated.pickup?.longitude }
          ) / 1000) <= radiusKm
        ));
        nearby.forEach(d => sendMessageToSocketId(`driver:${String(d._id)}`, { event: 'booking:removed', data: { bookingId: String(updated._id) } }));
        try { logger.info('[socket->drivers] booking:removed broadcast', { bookingId: String(updated._id), count: nearby.length }); } catch (_) {}
      } catch (_) {}
    } catch (err) {}
  });

  // booking_cancel
  socket.on('booking_cancel', async (payload) => {
    try { logger.info('[socket<-user] booking_cancel', { sid: socket.id, userId: socket.user && socket.user.id, payload }); } catch (_) {}
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      const reason = data.reason;
      if (!socket.user || !socket.user.type) return socket.emit('booking_error', { message: 'Unauthorized: user token required', bookingId });
      if (!bookingId) return socket.emit('booking_error', { message: 'bookingId is required', bookingId });
      const updated = await bookingService.updateBookingLifecycle({ requester: socket.user, id: bookingId, status: 'canceled' });
      bookingEvents.emitBookingUpdate(String(updated._id), { status: 'canceled', canceledBy: String(socket.user.type).toLowerCase(), canceledReason: reason });
      try { logger.info('[socket->room] booking:update canceled', { bookingId: String(updated._id), by: String(socket.user.type).toLowerCase() }); } catch (_) {}
    } catch (err) {}
  });

  // trip_started
  socket.on('trip_started', async (payload) => {
    try { logger.info('[socket<-driver] trip_started', { sid: socket.id, userId: socket.user && socket.user.id, payload }); } catch (_) {}
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      const startLocation = data.startLocation || data.location;
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'trip_started' });
      }
      if (!bookingId) return socket.emit('booking_error', { message: 'bookingId is required', source: 'trip_started' });
      const booking = await Booking.findOne({ _id: bookingId, driverId: String(socket.user.id) });
      if (!booking) return socket.emit('booking_error', { message: 'Booking not found or not assigned to you', source: 'trip_started' });
      const updated = await lifecycle.startTrip(bookingId, startLocation);
      bookingEvents.emitTripStarted(io, updated);
      try { logger.info('[socket->room] trip_started', { bookingId: String(updated._id) }); } catch (_) {}
    } catch (err) {
      logger.error('[trip_started] error', err);
      socket.emit('booking_error', { message: 'Failed to start trip', source: 'trip_started' });
    }
  });

  // trip_ongoing
  socket.on('trip_ongoing', async (payload) => {
    try { logger.info('[socket<-driver] trip_ongoing', { sid: socket.id, userId: socket.user && socket.user.id, payload }); } catch (_) {}
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      const location = data.location || { latitude: data.latitude, longitude: data.longitude };
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'trip_ongoing' });
      }
      if (!bookingId || !location || location.latitude == null || location.longitude == null) {
        return socket.emit('booking_error', { message: 'bookingId and location are required', source: 'trip_ongoing' });
      }
      const booking = await Booking.findOne({ _id: bookingId, driverId: String(socket.user.id) }).lean();
      if (!booking) return socket.emit('booking_error', { message: 'Booking not found or not assigned to you', source: 'trip_ongoing' });
      const point = await lifecycle.updateTripLocation(bookingId, String(socket.user.id), location);
      bookingEvents.emitTripOngoing(io, bookingId, point);
      try { logger.info('[socket->room] trip_ongoing', { bookingId, lat: point.lat, lon: point.lng }); } catch (_) {}
    } catch (err) {
      logger.error('[trip_ongoing] error', err);
      socket.emit('booking_error', { message: 'Failed to update trip location', source: 'trip_ongoing' });
    }
  });

  // trip_completed
  socket.on('trip_completed', async (payload) => {
    try { logger.info('[socket<-driver] trip_completed', { sid: socket.id, userId: socket.user && socket.user.id, payload }); } catch (_) {}
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
      const bookingId = String(data.bookingId || '');
      const endLocation = data.endLocation || data.location;
      const surgeMultiplier = data.surgeMultiplier || 1;
      const discount = data.discount || 0;
      const debitPassengerWallet = !!data.debitPassengerWallet;
      if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') {
        return socket.emit('booking_error', { message: 'Unauthorized: driver token required', source: 'trip_completed' });
      }
      if (!bookingId) return socket.emit('booking_error', { message: 'bookingId is required', source: 'trip_completed' });
      const booking = await Booking.findOne({ _id: bookingId, driverId: String(socket.user.id) });
      if (!booking) return socket.emit('booking_error', { message: 'Booking not found or not assigned to you', source: 'trip_completed' });
      const updated = await lifecycle.completeTrip(bookingId, endLocation, { surgeMultiplier, discount, debitPassengerWallet });
      bookingEvents.emitTripCompleted(io, updated);
      try { logger.info('[socket->room] trip_completed', { bookingId: String(updated._id) }); } catch (_) {}
    } catch (err) {
      logger.error('[trip_completed] error', err);
      socket.emit('booking_error', { message: 'Failed to complete trip', source: 'trip_completed' });
    }
  });
};
