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

// Download Excel for a particular sale: pulls stock matching category & qty if available,
// otherwise just exports the sale info row. Note: bot deletes stock on sale, so for
// historical orders the IDs may not be retrievable. This works for fresh orders.
router.get('/:id/excel', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) return res.status(404).send('Sale not found');

  const wb = XLSX.utils.book_new();
  const headerRows = [
    ['Order ID', sale.id],
    ['User ID', sale.user_id],
    ['Username', sale.username],
    ['Category', sale.category],
    ['Quantity', sale.qty],
    ['Total', sale.total + '৳'],
    ['Date', `${sale.date} ${sale.time || ''}`],
    [],
    ['#', 'Data (delivered)'],
  ];
  // Fresh stock matching category — best-effort lookup
  const stockSample = db.prepare(
    'SELECT data FROM stock WHERE category = ? ORDER BY id DESC LIMIT ?'
  ).all(sale.category, sale.qty || 1);

  stockSample.forEach((s, i) => headerRows.push([i + 1, s.data]));
  if (!stockSample.length) headerRows.push(['—', '(historical — IDs not stored separately)']);

  const ws = XLSX.utils.aoa_to_sheet(headerRows);
  ws['!cols'] = [{ wch: 14 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(wb, ws, `Order-${sale.id}`);

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="order-${sale.id}-${sale.category}.xlsx"`);
  res.send(buf);
});

module.exports = router;
