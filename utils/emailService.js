const dns = require('dns').promises;
const net = require('net');
const nodemailer = require('nodemailer');

/**
 * Nodemailer picks a random A/AAAA address per connection; on networks without
 * working IPv6 that often yields ENETUNREACH to Google/other SMTP. Prefer A
 * record and keep TLS SNI on the real hostname when connecting by IPv4.
 */
let cachedTransporter = null;
let cachedTransportConfigKey = '';

const buildTransport = async () => {
  const originalHost = process.env.EMAIL_HOST;
  const port = Number(process.env.EMAIL_PORT) || 587;
  const auth = {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  };

  let host = originalHost;
  if (
    originalHost &&
    !net.isIP(originalHost) &&
    process.env.EMAIL_SMTP_USE_IPV6 !== 'true'
  ) {
    try {
      const v4 = await dns.resolve4(originalHost);
      if (v4.length) {
        host = v4[0];
      }
    } catch {
      // No A record or DNS error — let nodemailer resolve the hostname.
    }
  }

  const connectByIp = host && net.isIP(host) && originalHost && !net.isIP(originalHost);

  // Determine if we should use SSL (port 465) or TLS (port 587)
  const isSSL = port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure: isSSL, // true for SSL (465), false for TLS (587)
    auth,
    // Connection timeouts (in milliseconds)
    connectionTimeout: 60000, // 60 seconds - connection to SMTP server
    greetingTimeout: 30000,   // 30 seconds - wait for SMTP greeting
    socketTimeout: 60000,     // 60 seconds - wait for data transfer
    tls: {
      // For Gmail, we need to allow less secure certificates in development
      // but in production this should be omitted or set to true
      rejectUnauthorized: process.env.NODE_ENV !== 'development',
      ...(connectByIp ? { servername: originalHost } : {})
    },
    // Connection pool settings for better performance
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    rateDelta: 1000,    // Rate limit: delay between messages
    rateLimit: 5        // Max messages per rateDelta
  });
};

const getTransporter = async () => {
  const key = [
    process.env.EMAIL_HOST,
    process.env.EMAIL_PORT,
    process.env.EMAIL_USER,
    process.env.EMAIL_SMTP_USE_IPV6
  ].join('|');

  if (!cachedTransporter || cachedTransportConfigKey !== key) {
    cachedTransporter = await buildTransport();
    cachedTransportConfigKey = key;
  }

  return cachedTransporter;
};

const sendEmail = async (to, subject, html) => {
  try {
    const transporter = await getTransporter();
    const info = await transporter.sendMail({
      from: `"TUKTUK-RIDE" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html
    });
    
    console.log(`Email sent: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error('Email sending failed:', error);
    throw error;
  }
};

// Send verification email
const sendVerificationEmail = async (email, token) => {
  const verificationUrl = `${process.env.FRONTEND_URL}/verify-email/${token}`;
  
  const html = `
    <h1>Welcome to TUKTUK-RIDE!</h1>
    <p>Please verify your email address by clicking the link below:</p>
    <a href="${verificationUrl}">Verify Email</a>
    <p>This link will expire in 24 hours.</p>
  `;
  
  return sendEmail(email, 'Verify Your Email', html);
};

// Send password reset email
const sendPasswordResetEmail = async (email, token) => {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${token}`;
  
  const html = `
    <h1>TookRide Password Reset</h1>
    <p>We received a request to reset your password.</p>
    <p><a href="${resetUrl}">Reset Password</a></p>
    <p>This link will expire in 1 hour.</p>
    <p>If the button does not open, use this link:</p>
    <p>${resetUrl}</p>
    <p>If you didn't request this, please ignore this email.</p>
  `;
  
  return sendEmail(email, 'Reset Your Password', html);
};

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail
};
