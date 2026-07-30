const nodemailer = require('nodemailer');
const pool = require('../config/db');

async function getTransporter(companyId) {
  const [rows] = await pool.query(
    'SELECT smtp_host, smtp_email, smtp_password, smtp_port, smtp_from_name FROM companies WHERE company_id = ?',
    [companyId]
  );
  const config = rows[0];

  if (!config || !config.smtp_host || !config.smtp_email || !config.smtp_password) {
    throw new Error('SMTP configuration is incomplete for this company.');
  }

  const transporter = nodemailer.createTransport({
    host: config.smtp_host,
    port: config.smtp_port || 587,
    secure: config.smtp_port === 465, 
    auth: {
      user: config.smtp_email,
      pass: config.smtp_password,
    },
  });

  return { transporter, config };
}

async function sendEmail({ companyId, to, subject, html, attachments = [] }) {
  try {
    const { transporter, config } = await getTransporter(companyId);
    
    const mailOptions = {
      from: `"${config.smtp_from_name || 'F2C ERP'}" <${config.smtp_email}>`,
      to,
      subject,
      html,
      attachments,
    };

    const info = await transporter.sendMail(mailOptions);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Email sending failed:', error);
    throw error;
  }
}

module.exports = {
  sendEmail,
};
