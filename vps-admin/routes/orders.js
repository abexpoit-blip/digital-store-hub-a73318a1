const express = require('express');
const XLSX = require('xlsx');
const { db } = require('../db');
const router = express.Router();

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 25;
  const offset = (page - 1) * limit;

  let sales;
  let totalCount = 0;

  if (q) {
    const countRow = db.prepare(
      `SELECT COUNT(*) as count FROM sales WHERE LOWER(COALESCE(username,'')) LIKE ?
        OR CAST(user_id AS TEXT) LIKE ? OR LOWER(category) LIKE ?`
    ).get(`%${q.toLowerCase()}%`, `%${q}%`, `%${q.toLowerCase()}%`);
    totalCount = countRow ? countRow.count : 0;

    sales = db.prepare(
      `SELECT * FROM sales WHERE LOWER(COALESCE(username,'')) LIKE ?
        OR CAST(user_id AS TEXT) LIKE ? OR LOWER(category) LIKE ?
        ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(`%${q.toLowerCase()}%`, `%${q}%`, `%${q.toLowerCase()}%`, limit, offset);
  } else {
    const countRow = db.prepare('SELECT COUNT(*) as count FROM sales').get();
    totalCount = countRow ? countRow.count : 0;

    sales = db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / limit));

  res.render('orders', {
    sales,
    q,
    page,
    limit,
    totalPages,
    totalCount
  });
});

// Download Excel for a particular sale: pulls real delivered accounts from delivery_archive
router.get('/:id/excel', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) return res.status(404).send('Sale not found');

  // Pull actual delivered items from delivery_archive (real IDs that user received)
  let items = [];
  try {
    items = db.prepare(
      'SELECT stock_id, data, delivered_at, seller_name FROM delivery_archive WHERE sale_id = ? ORDER BY id ASC'
    ).all(sale.id);
  } catch (_) {}

  // Fallback for older orders where sale_id might have been unlinked
  if (!items.length) {
    try {
      items = db.prepare(
        'SELECT stock_id, data, delivered_at, seller_name FROM delivery_archive WHERE user_id = ? AND category = ? ORDER BY id DESC LIMIT ?'
      ).all(sale.user_id, sale.category, sale.qty || 1);
    } catch (_) {}
  }

  const wb = XLSX.utils.book_new();
  const rows = [
    ['Order ID', sale.id],
    ['User ID', sale.user_id],
    ['Username', sale.username || '-'],
    ['Category', sale.category],
    ['Quantity', sale.qty],
    ['Total', (sale.total || 0) + '৳'],
    ['Date', `${sale.date || ''} ${sale.time || ''}`.trim()],
    [],
    ['#', 'UID', 'PASSWORD', 'COOKIES'],
  ];

  if (items.length) {
    items.forEach((it, i) => {
      const line = (it.data || '').trim();
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const uid = parts[0] || '';
        const pass = parts[1] || '';
        const cookies = line.split(null, 2)[2] || parts.slice(2).join(' ');
        rows.push([i + 1, uid, pass, cookies]);
      } else {
        // e.g. VPN or single data string
        rows.push([i + 1, line, '', '']);
      }
    });
  } else {
    rows.push(['—', '(No delivered items found in archive for this order)', '', '']);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 6 }, { wch: 22 }, { wch: 18 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, ws, `Order-${sale.id}`);

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="order-${sale.id}-${sale.category}.xlsx"`);
  res.send(buf);
});

module.exports = router;
