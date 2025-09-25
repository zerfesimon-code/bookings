const { Pricing } = require('../models/pricing');
const { crudController } = require('./basic.crud');
const { broadcast } = require('../sockets/utils');

const base = crudController(Pricing);

async function updateAndBroadcast(req, res) {
  try {
    const item = await Pricing.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!item) return res.status(404).json({ message: 'Not found' });
    // Include bookingId if present in request body (for clients tracking pricing per booking)
    const payload = { ...item.toObject?.() ? item.toObject() : item, ...(req.body && req.body.bookingId ? { bookingId: String(req.body.bookingId) } : {}) };
    broadcast('pricing:update', payload);
    return res.json(item);
  } catch (e) { return res.status(500).json({ message: e.message }); }
}

module.exports = { ...base, updateAndBroadcast };

