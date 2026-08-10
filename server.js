require('dotenv').config();
const express = require('express');
const cors = require('cors');

const fs = require('fs');
const uploadDirs = ['uploads', 'uploads/items', 'uploads/templates', 'uploads/invoices', 'uploads/pos', 'uploads/reports'];
uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const authRoutes = require('./routes/auth.routes');
const companiesRoutes = require('./routes/companies.routes');
const usersRoutes = require('./routes/users.routes');
const inventoryRoutes = require('./routes/inventory.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const purchaseOrdersRoutes = require('./routes/purchaseOrders.routes');
const salesRoutes = require('./routes/sales.routes');
const workflowRoutes = require('./routes/workflow.routes');

const app = express();

// app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || "https://f2c-erp-frontend.vercel.app",
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static('uploads'));
app.get('/api/health', (req, res) => res.json({ success: true, message: 'ERP API running' }));

app.use('/api/auth', authRoutes);
app.use('/api/companies', companiesRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/purchase-orders', purchaseOrdersRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/reports', require('./routes/reports.routes'));
app.use('/api/workflow', workflowRoutes);

// 404
app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// Global error handler
app.use((err, req, res, next) => {
  require('fs').appendFileSync('global_error.log', (err.stack || err.message || JSON.stringify(err)) + '\n');
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

const { initCronJobs } = require('./cron/followUpJobs');
initCronJobs();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`ERP API listening on port ${PORT}`));
