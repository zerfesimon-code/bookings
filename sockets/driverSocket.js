const driverService = require('../services/driverService');
const driverEvents = require('../events/driverEvents');
const bookingService = require('../services/bookingService');
const bookingEvents = require('../events/bookingEvents');
const lifecycle = require('../services/bookingLifecycleService');
const { sendMessageToSocketId } = require('./utils');
const logger = require('../utils/logger');

const geolib = require('geolib');
const { Driver } = require('../models/userModels');
const { Booking } = require('../models/bookingModels');
const { Wallet } = require('../models/common');
const financeService = require('../services/financeService');

module.exports = (io, socket) => {
  if (!socket.user || String(socket.user.type).toLowerCase() !== 'driver') return;

  const driverId = String(socket.user.id);
  const driverRoom = `driver:${driverId}`;
  socket.join(driverRoom);

  // Dedup nearby bookings for initial + updates
  let nearbyBookingCache = new Map();

  const emitNearby = async () => {
    try {
      const me = await Driver.findById(driverId).lean();
      if (!me?.lastKnownLocation?.latitude || !me?.lastKnownLocation?.longitude) return;

      const radiusKm = parseFloat(process.env.BROADCAST_RADIUS_KM || process.env.RADIUS_KM || '5');
      const openBookings = await Booking.find({
        status: 'requested',
        $or: [{ driverId: { $exists: false } }, { driverId: null }, { driverId: '' }]
      }).lean();

      const withDistance = openBookings
        .map(b => ({
          booking: b,
          distanceKm: geolib.getDistance(
            { latitude: me.lastKnownLocation.latitude, longitude: me.lastKnownLocation.longitude },
            { latitude: b.pickup?.latitude, longitude: b.pickup?.longitude }
          ) / 1000
        }))
        .filter(x => Number.isFinite(x.distanceKm) && x.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm);

      const wallet = await Wallet.findOne({ userId: driverId, role: 'driver' }).lean();
      const balance = wallet ? Number(wallet.balance || 0) : 0;

      const nearby = withDistance
        .filter(x => financeService.canAcceptBooking(balance, x.booking.fareFinal || x.booking.fareEstimated || 0))
        .slice(0, 50)
        .map(x => ({
          id: String(x.booking._id),
          status: x.booking.status,
          pickup: x.booking.pickup,
          dropoff: x.booking.dropoff,
          fareEstimated: x.booking.fareEstimated,
          fareFinal: x.booking.fareFinal,
          distanceKm: Math.round(x.distanceKm * 100) / 100,
          passenger: x.booking.passengerId ? {
            id: String(x.booking.passengerId),
            name: x.booking.passengerName,
            phone: x.booking.passengerPhone
          } : undefined,
          createdAt: x.booking.createdAt,
          updatedAt: x.booking.updatedAt
        }));

      nearbyBookingCache.clear();
      nearby.forEach(b => nearbyBookingCache.set(b.id, b));

      const currentBookings = await Booking.find({
        driverId,
        status: { $in: ['accepted', 'ongoing', 'requested'] }
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

      const payload = {
        init: true,
        driverId,
        bookings: Array.from(nearbyBookingCache.values()),
        currentBookings,
        user: { id: driverId, type: 'driver' }
      };

      socket.emit('booking:nearby', payload);
      try { logger.info('[socket->driver] booking:nearby emitted', { userId: driverId, nearbyCount: payload.bookings.length }); } catch (_) {}
    } catch (err) {
      try { logger.error('[emitNearby] failed', err); } catch (_) {}
    }
  };

  // Emit initial nearby bookings on connect
  emitNearby();

  // Update nearby bookings periodically (or after relevant events)
  const nearbyInterval = setInterval(emitNearby, 60 * 1000);
  socket.on('disconnect', () => clearInterval(nearbyInterval));

  // Listen to driver availability changes
  socket.on('driver:availability', async (payload) => {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (data.available == null) return socket.emit('booking_error', { message: 'available boolean required', source: 'driver:availability' });

      const updated = await driverService.setAvailability(driverId, !!data.available, socket.user);
      driverEvents.emitDriverAvailability(driverId, !!data.available);
      emitNearby();
    } catch (err) { socket.emit('booking_error', { message: 'Failed to update availability', source: 'driver:availability' }); }
  });

  // Listen to driver location updates
  socket.on('booking:driver_location_update', async (payload) => {
    try {
      const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const { latitude, longitude, bearing } = data;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
        return socket.emit('booking_error', { message: 'latitude and longitude must be numbers', source: 'booking:driver_location_update' });

      const d = await driverService.updateLocation(driverId, { latitude, longitude, bearing }, socket.user);
      driverEvents.emitDriverLocationUpdate({
        driverId,
        vehicleType: d.vehicleType,
        available: d.available,
        lastKnownLocation: d.lastKnownLocation,
        updatedAt: d.updatedAt
      });

      emitNearby();
    } catch (err) { socket.emit('booking_error', { message: 'Failed to process location update', source: 'booking:driver_location_update' }); }
  });
};
