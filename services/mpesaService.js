const axios = require('axios');
const { normalizeKenyanPhone } = require('../utils/phone');
const { DEFAULT_TIMEZONE, formatTimestampForMpesa } = require('../utils/businessTime');

let accessTokenCache = null;
let accessTokenExpiry = 0;

const getMpesaBaseUrl = () => (
  process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke'
);

const getShortCode = () => process.env.DARAJA_SHORTCODE || process.env.MPESA_SHORTCODE;
const getPasskey = () => process.env.DARAJA_PASSKEY || process.env.MPESA_PASSKEY;

const buildCallbackUrl = (transactionId) => {
  const baseCallbackUrl = process.env.MPESA_CALLBACK_URL || process.env.PUBLIC_API_BASE_URL;

  if (!baseCallbackUrl) {
    throw new Error('MPESA_CALLBACK_URL or PUBLIC_API_BASE_URL must be configured');
  }

  const callbackUrl = baseCallbackUrl.includes('/api/payments/callback')
    ? new URL(baseCallbackUrl)
    : new URL('/api/payments/callback', baseCallbackUrl);

  if (process.env.MPESA_CALLBACK_TOKEN) {
    callbackUrl.searchParams.set('token', process.env.MPESA_CALLBACK_TOKEN);
  }

  if (transactionId) {
    callbackUrl.searchParams.set('transactionId', transactionId);
  }

  return callbackUrl.toString();
};

const generatePassword = (timestamp) => {
  const shortCode = getShortCode();
  const passkey = getPasskey();

  if (!shortCode || !passkey) {
    throw new Error('Daraja shortcode/passkey are not configured');
  }

  return Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
};

const getAccessToken = async (forceRefresh = false) => {
  if (!forceRefresh && accessTokenCache && Date.now() < accessTokenExpiry) {
    return accessTokenCache;
  }

  const consumerKey = process.env.DARAJA_CONSUMER_KEY;
  const consumerSecret = process.env.DARAJA_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    throw new Error('Daraja consumer key/secret are not configured');
  }

  const response = await axios.get(
    `${getMpesaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
    {
      auth: {
        username: consumerKey,
        password: consumerSecret
      },
      timeout: Number(process.env.MPESA_REQUEST_TIMEOUT_MS || 15000)
    }
  );

  accessTokenCache = response.data.access_token;
  accessTokenExpiry = Date.now() + (Number(response.data.expires_in || 3599) - 60) * 1000;

  return accessTokenCache;
};

const initiateStkPush = async ({
  phoneNumber,
  amount,
  accountReference,
  description,
  transactionId
}) => {
  const normalizedPhone = normalizeKenyanPhone(phoneNumber);

  if (!normalizedPhone) {
    throw new Error('A valid Kenyan phone number is required for STK Push');
  }

  const token = await getAccessToken();
  const timestamp = formatTimestampForMpesa(new Date(), DEFAULT_TIMEZONE);

  const payload = {
    BusinessShortCode: getShortCode(),
    Password: generatePassword(timestamp),
    Timestamp: timestamp,
    TransactionType: process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
    Amount: Math.max(1, Math.round(amount)),
    PartyA: normalizedPhone,
    PartyB: getShortCode(),
    PhoneNumber: normalizedPhone,
    CallBackURL: buildCallbackUrl(transactionId),
    AccountReference: String(accountReference || 'TookRide').slice(0, 20),
    TransactionDesc: String(description || 'Driver commission').slice(0, 50)
  };

  const response = await axios.post(
    `${getMpesaBaseUrl()}/mpesa/stkpush/v1/processrequest`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: Number(process.env.MPESA_REQUEST_TIMEOUT_MS || 15000)
    }
  );

  return {
    normalizedPhone,
    requestPayload: payload,
    responsePayload: response.data
  };
};

const isCallbackAuthorized = (req) => {
  const expectedToken = process.env.MPESA_CALLBACK_TOKEN;

  if (!expectedToken) {
    return true;
  }

  return req.query.token === expectedToken || req.headers['x-callback-token'] === expectedToken;
};

const parseCallbackMetadata = (items = []) => {
  const metadata = {};

  for (const item of items) {
    metadata[item.Name] = item.Value;
  }

  return metadata;
};

const parseStkPushCallback = (body = {}) => {
  const stkCallback = body?.Body?.stkCallback;

  if (!stkCallback) {
    throw new Error('Invalid STK callback payload');
  }

  return {
    merchantRequestId: stkCallback.MerchantRequestID,
    checkoutRequestId: stkCallback.CheckoutRequestID,
    resultCode: Number(stkCallback.ResultCode),
    resultDesc: stkCallback.ResultDesc,
    metadata: parseCallbackMetadata(stkCallback.CallbackMetadata?.Item || []),
    raw: stkCallback
  };
};

module.exports = {
  getMpesaBaseUrl,
  initiateStkPush,
  isCallbackAuthorized,
  parseStkPushCallback
};
