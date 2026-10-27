
const crypto = require('node:crypto');

const TOKEN_TTL_SECONDS = 24 * 60 * 60;

function getSigningSecret() {
  const secret = process.env.GBL_QUOTE_SIGNING_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error('Clave de firma no configurada correctamente.');
  }

  return secret;
}

function sign(payload) {
  return crypto
    .createHmac('sha256', getSigningSecret())
    .update(payload)
    .digest('base64url');
}

function createQuoteToken({ recordId, number, requestId }) {
  if (
    typeof recordId !== 'string' ||
    !/^rec[A-Za-z0-9]+$/.test(recordId) ||
    !Number.isSafeInteger(number) ||
    number < 70 ||
    typeof requestId !== 'string'
  ) {
    throw new Error('Datos de cotización inválidos.');
  }

  const payload = Buffer.from(
    JSON.stringify({
      recordId,
      number,
      requestId,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
    })
  ).toString('base64url');

  return `${payload}.${sign(payload)}`;
}

function verifyQuoteToken(token) {
  if (typeof token !== 'string' || token.length > 4096) {
    return null;
  }

  const parts = token.split('.');

  if (parts.length !== 2) {
    return null;
  }

  const [payload, signature] = parts;

  if (!/^[A-Za-z0-9_-]+$/.test(payload) ||
      !/^[A-Za-z0-9_-]+$/.test(signature)) {
    return null;
  }

  const expected = Buffer.from(sign(payload), 'base64url');
  const received = Buffer.from(signature, 'base64url');

  if (
    expected.length !== received.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );

    const now = Math.floor(Date.now() / 1000);

    if (
      !Number.isSafeInteger(data.exp) ||
      data.exp <= now ||
      data.exp > now + TOKEN_TTL_SECONDS ||
      typeof data.recordId !== 'string' ||
      !/^rec[A-Za-z0-9]+$/.test(data.recordId) ||
      !Number.isSafeInteger(data.number) ||
      data.number < 70 ||
      typeof data.requestId !== 'string'
    ) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

module.exports = {
  createQuoteToken,
  verifyQuoteToken
};
