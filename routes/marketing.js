// ============================================================
// routes/marketing.js — admin-only Marketing dashboard data.
// Read-only v1: serves the marketing plan, content, and analytics
// from config/marketing.json for the portal's Marketing section.
// Editing + persistence will come in a later change (needs DB storage).
// ============================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const { authenticate, requireAdmin } = require('../lib/sessions');

const DATA_PATH = path.join(__dirname, '..', 'config', 'marketing.json');

module.exports = function createMarketingRouter() {
  const router = express.Router();

  // GET /api/marketing — the marketing dashboard data (admin-only, read-only).
  router.get('/api/marketing', authenticate, requireAdmin, (req, res) => {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      res.json(data);
    } catch (e) {
      console.error('[MARKETING] load failed:', e.message);
      res.status(500).json({ error: 'Could not load marketing data.' });
    }
  });

  return router;
};
