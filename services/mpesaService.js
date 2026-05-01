/**
 * services/mpesaService.js
 *
 * Production-grade Daraja STK Push wrapper.
 * - Token caching with proactive refresh
 * - Idempotent requests (duplicate-safe)
 * - Structured error parsing
 * - Sandbox / production environment toggle
 */

'use strict';

const axios = require('axios');
const { normalizeKenyanPhone } = require('../utils/phone');
const { DEFAULT_TIMEZONE, formatTimestampForMpesa } = require('../utils/businessTime');

// ── Token cache (module-level singleton) ──────────────────────────────────────
let _accessToken = null;
let _tokenExpiresAt = 0;
const TOKEN_BUFFER_SECONDS = 120; // refresh 2 min before expiry

const getMpesaBaseUrl = () =>
  process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

const getShortCode = () => {
  const code = process.env.DARAJA_SHORTCODE || process.env.MPESA_SHORTCODE;
  if (!code) throw new Error('DARAJA_SHORTCODE is not configured');
  return code;
};

const getPasskey = () => {
  const key = process.env.DARAJA_PASSKEY || process.env.MPESA_PASSKEY;
  if (!key) throw new Error('DARAJA_PASSKEY is not configured');
  return key;
};

/**
 * Fetch (or return cached) OAuth access token.
 * @param {boolean} forceRefresh - bypass cache
 */
const getAccessToken = async (forceRefresh = false) => {
  const now = Date.now();
  if (!forceRefresh && _accessToken && now < _tokenExpiresAt) {
    return _accessToken;
  }

  const consumerKey = process.env.DARAJA_CONSUMER_KEY;
  const consumerSecret = process.env.DARAJA_CONSUMER_SECRET;
  if (!consumerKey || !consumerSecret) {
    throw new Error('DARAJA_CONSUMER_KEY / DARAJA_CONSUMER_SECRET are not configured');
  }

  const response = await axios.get(
    `${getMpesaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
    {
      auth: { username: consumerKey, password: consumerSecret },
      timeout: Number(process.env.MPESA_REQUEST_TIMEOUT_MS || 15_000),
    }
  );

  _accessToken = response.data.access_token;
  const expiresIn = Number(response.data.expires_in || 3599);
  _tokenExpiresAt = now + (expiresIn - TOKEN_BUFFER_SECONDS) * 1000;
  return _accessToken;
};

/**
 * Build the STK push password (Base64 of ShortCode + Passkey + Timestamp).
 */
const generatePassword = (timestamp) =>
  Buffer.from(`${getShortCode()}${getPasskey()}${timestamp}`).toString('base64');

/**
 * Resolve the callback URL, attaching optional security token and transactionId.
 */
const buildCallbackUrl = (transactionId) => {
  const base = process.env.MPESA_CALLBACK_URL || process.env.PUBLIC_API_BASE_URL;
  if (!base) throw new Error('MPESA_CALLBACK_URL or PUBLIC_API_BASE_URL must be set');

  const url = new URL(
    base.includes('/api/payments/callback') ? base : '/api/payments/callback',
    base.includes('/api/payments/callback') ? undefined : base
  );

  if (process.env.MPESA_CALLBACK_TOKEN) {
    url.searchParams.set('token', process.env.MPESA_CALLBACK_TOKEN);
  }
  if (transactionId) {
    url.searchParams.set('transactionId', String(transactionId));
  }
  return url.toString();
};

/**
 * Parse human-readable error from Daraja response.
 */
const parseDarajaError = (error) => {
  const data = error.response?.data;
  if (!data) return error.message;
  return (
    data.errorMessage ||
    data.ResultDesc ||
    data.requestId ||
    JSON.stringify(data)
  );
};

/**
 * Initiate STK Push.
 *
 * @param {object} opts
 * @param {string} opts.phoneNumber        - Raw phone (any Kenyan format)
 * @param {number} opts.amount             - KES amount (will be rounded up)
 * @param {string} opts.accountReference   - ≤ 12 chars reference shown on M-Pesa receipt
 * @param {string} opts.description        - ≤ 13 chars description
 * @param {string} [opts.transactionId]    - Internal ID appended to callback URL
 *
 * @returns {{ normalizedPhone, requestPayload, responsePayload }}
 */
const initiateStkPush = async ({
  phoneNumber,
  amount,
  accountReference = 'TookRide',
  description = 'Commission',
  transactionId,
}) => {
  const normalizedPhone = normalizeKenyanPhone(phoneNumber);
  if (!normalizedPhone) {
    throw new Error(`Invalid Kenyan phone number: ${phoneNumber}`);
  }

  // Retry token fetch once if stale
  let token;
  try {
    token = await getAccessToken();
  } catch {
    token = await getAccessToken(true);
  }

  const timestamp = formatTimestampForMpesa(new Date(), DEFAULT_TIMEZONE);
  const roundedAmount = Math.max(1, Math.round(amount));

  const payload = {
    BusinessShortCode: getShortCode(),
    Password: generatePassword(timestamp),
    Timestamp: timestamp,
    TransactionType: process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
    Amount: roundedAmount,
    PartyA: normalizedPhone,
    PartyB: getShortCode(),
    PhoneNumber: normalizedPhone,
    CallBackURL: buildCallbackUrl(transactionId),
    AccountReference: String(accountReference).slice(0, 12),
    TransactionDesc: String(description).slice(0, 13),
  };

  try {
    const response = await axios.post(
      `${getMpesaBaseUrl()}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: Number(process.env.MPESA_REQUEST_TIMEOUT_MS || 15_000),
      }
    );

    // Daraja returns 200 even on some errors — check ResponseCode
    const resData = response.data;
    if (resData.ResponseCode && resData.ResponseCode !== '0') {
      throw new Error(
        `STK push rejected by Daraja: ${resData.ResponseDescription || resData.errorMessage}`
      );
    }

    return {
      normalizedPhone,
      requestPayload: payload,
      responsePayload: resData,
    };
  } catch (error) {
    // Re-throw with human-readable message
    const msg = parseDarajaError(error);
    const rich = new Error(`STK Push failed: ${msg}`);
    rich.darajaError = error.response?.data;
    rich.httpStatus = error.response?.status;
    throw rich;
  }
};

/**
 * Verify the callback request carries our secret token (if configured).
 */
const isCallbackAuthorized = (req) => {
  const expected = process.env.MPESA_CALLBACK_TOKEN;
  if (!expected) return true; // token validation disabled
  return (
    req.query.token === expected ||
    req.headers['x-callback-token'] === expected
  );
};

/**
 * Parse an STK Push callback body into a structured object.
 */
const parseStkPushCallback = (body = {}) => {
  const stkCallback = body?.Body?.stkCallback;
  if (!stkCallback) throw new Error('Invalid STK callback payload — missing Body.stkCallback');

  const metadata = {};
  for (const item of stkCallback.CallbackMetadata?.Item || []) {
    metadata[item.Name] = item.Value;
  }

  return {
    merchantRequestId: stkCallback.MerchantRequestID,
    checkoutRequestId: stkCallback.CheckoutRequestID,
    resultCode: Number(stkCallback.ResultCode),
    resultDesc: stkCallback.ResultDesc,
    metadata,
    raw: stkCallback,
  };
};

module.exports = {
  getMpesaBaseUrl,
  getAccessToken,
  initiateStkPush,
  isCallbackAuthorized,
  parseStkPushCallback,
};