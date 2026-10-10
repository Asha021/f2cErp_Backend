const nodemailer = require('nodemailer');
const pool = require('../config/db');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

// Helper to get system/default SMTP transporter
async function getSystemTransporter() {
  const envUser = process.env.SMTP_USER;
  const envPass = process.env.SMTP_PASS;
  const envHost = process.env.SMTP_HOST || 'smtp.gmail.com';
  const envPort = parseInt(process.env.SMTP_PORT, 10) || 587;
  const envFromName = process.env.SMTP_FROM_NAME || 'UA CONSULTANTS';
  const envFromEmail = process.env.SMTP_FROM_EMAIL || envUser;

  // If env has valid user & password
  if (envUser && envPass && envUser !== 'your_email@gmail.com') {
    const transporter = nodemailer.createTransport({
      host: envHost,
      port: envPort,
      secure: envPort === 465,
      auth: {
        user: envUser,
        pass: envPass,
      },
    });
    return {
      transporter,
      config: {
        smtp_host: envHost,
        smtp_port: envPort,
        smtp_email: envFromEmail,
        smtp_from_name: envFromName,
      },
    };
  }

  // Fallback: Check if any company in DB has working SMTP configured
  const [rows] = await pool.query(
    `SELECT smtp_host, smtp_email, smtp_password, smtp_port, smtp_from_name 
     FROM companies 
     WHERE smtp_email IS NOT NULL AND smtp_email != '' 
       AND smtp_password IS NOT NULL AND smtp_password != '' 
     ORDER BY company_id ASC LIMIT 1`
  );

  if (rows && rows.length > 0) {
    const config = rows[0];
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

  throw new Error('No SMTP configuration available (neither in company profile nor system default).');
}

async function getTransporter(companyId) {
  if (companyId) {
    try {
      const [rows] = await pool.query(
        'SELECT smtp_host, smtp_email, smtp_password, smtp_port, smtp_from_name FROM companies WHERE company_id = ?',
        [companyId]
      );

      const config = rows[0];

      // If company has its own complete SMTP configuration, use it
      if (config && config.smtp_host && config.smtp_email && config.smtp_password) {
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
    } catch (dbErr) {
      console.warn(`Error reading company ${companyId} SMTP config, falling back to system SMTP:`, dbErr.message);
    }
  }

  // Fallback to system default SMTP if company has no custom SMTP
  return await getSystemTransporter();
}

async function sendEmail({ companyId, to, cc, bcc, subject, html, attachments = [] }) {
  let transporter;
  let config;

  try {
    const result = await getTransporter(companyId);
    transporter = result.transporter;
    config = result.config;

    const fromName = config.smtp_from_name || process.env.SMTP_FROM_NAME || 'UA CONSULTANTS';
    const fromEmail = config.smtp_email || process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;

    const mailOptions = {
      from: `"${fromName.replace(/^"|"$/g, '')}" <${fromEmail}>`,
      to,
      subject,
      html,
      attachments,
    };
    if (cc) mailOptions.cc = cc;
    if (bcc) mailOptions.bcc = bcc;

    const info = await transporter.sendMail(mailOptions);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    // If sending with company custom SMTP failed, retry with system default SMTP
    if (companyId) {
      console.warn(`Failed sending email with company ${companyId} SMTP. Retrying with system default SMTP... Error: ${error.message}`);
      try {
        const sysResult = await getSystemTransporter();
        const sysTransporter = sysResult.transporter;
        const sysConfig = sysResult.config;

        const fromName = sysConfig.smtp_from_name || process.env.SMTP_FROM_NAME || 'UA CONSULTANTS';
        const fromEmail = sysConfig.smtp_email || process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;

        const mailOptions = {
          from: `"${fromName.replace(/^"|"$/g, '')}" <${fromEmail}>`,
          to,
          subject,
          html,
          attachments,
        };
        if (cc) mailOptions.cc = cc;
        if (bcc) mailOptions.bcc = bcc;

        const info = await sysTransporter.sendMail(mailOptions);
        console.log(`Email successfully sent using system fallback SMTP to: ${to}`);
        return { success: true, messageId: info.messageId, fallbackUsed: true };
      } catch (fallbackErr) {
        console.error('System fallback SMTP also failed:', fallbackErr);
        throw fallbackErr;
      }
    }

    console.error('Email sending failed:', error);
    throw error;
  }
}

module.exports = {
  sendEmail,
  getTransporter,
  getSystemTransporter,
};
