require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const { db, DB_PATH } = require('./db');
const { initAdminPassword, verifyPassword, requireLogin, changePassword } = require('./auth');

initAdminPassword();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use('/static', express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'please-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 } // 12h
}));

// Make `current` available in all views
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

// --- AUTH ROUTES ---
app.get('/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (!password) {
    return res.status(400).render('login', { error: 'Password দিন!' });
  }
  if (verifyPassword(password)) {
    req.session.loggedIn = true;
    return res.redirect('/');
  }
  res.render('login', { error: 'ভুল password!' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.post('/change-password', requireLogin, (req, res) => {
  const current = req.body && typeof req.body.current === 'string' ? req.body.current : '';
  const newPass = req.body && typeof req.body.next === 'string' ? req.body.next : '';
  if (!verifyPassword(current)) {
    return res.redirect('/?msg=' + encodeURIComponent('Current password ভুল!'));
  }
  if (newPass.length < 6) {
    return res.redirect('/?msg=' + encodeURIComponent('New password কমপক্ষে 6 character দরকার!'));
  }
  changePassword(newPass);
  res.redirect('/?msg=' + encodeURIComponent('Password পরিবর্তন হয়েছে ✅'));
});

// --- PUBLIC ROUTES (no auth) — buyer Excel download via signed link ---
app.use('/o', require('./routes/public'));

// --- ZINIPAY (public — used by bot + ZiniPay webhook + user redirect) ---
app.use('/zinipay', require('./routes/zinipay'));

// --- FEATURE ROUTES (all protected) ---
app.use('/', requireLogin, require('./routes/dashboard'));
app.use('/notice', requireLogin, require('./routes/notice'));
app.use('/users', requireLogin, require('./routes/users'));
app.use('/deposits', requireLogin, require('./routes/deposits'));
app.use('/stock', requireLogin, require('./routes/stock'));
app.use('/replace', requireLogin, require('./routes/replace'));
app.use('/orders', requireLogin, require('./routes/orders'));
app.use('/credits', requireLogin, require('./routes/credits'));
app.use('/audit', requireLogin, require('./routes/audit'));
app.use('/status', requireLogin, require('./routes/status'));
app.use('/polls', requireLogin, require('./routes/polls'));
app.use('/nord', requireLogin, require('./routes/nord'));

// 404
app.use((req, res) => res.status(404).render('error', { message: 'Page not found', currentPath: req.originalUrl || '' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err && err.stack ? err.stack : err);
  res.status(500).render('error', { message: err.message || 'Server error', currentPath: req.originalUrl || '' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════════╗`);
  console.log(`║  Basictrick Admin Panel running          ║`);
  console.log(`║  http://localhost:${PORT}                     ║`);
  console.log(`║  DB: ${DB_PATH}`);
  console.log(`╚══════════════════════════════════════════╝`);
});
