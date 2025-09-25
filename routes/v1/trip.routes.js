const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/trip.controller');
const { authenticate, authorize } = require('../../middleware/auth');

router.post('/', authenticate, authorize('admin','staff'), ctrl.create);
router.get('/', authenticate, authorize('admin','staff'), ctrl.list);
router.get('/:id', authenticate, authorize('admin','staff'), ctrl.get);
router.put('/:id', authenticate, authorize('admin','staff'), ctrl.update);
router.delete('/:id', authenticate, authorize('admin','staff'), ctrl.remove);

module.exports = router;

