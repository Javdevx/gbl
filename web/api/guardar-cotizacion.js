const { verifyQuoteToken } = require('./_lib/quote-auth');
const MAX_PDF_BYTES = 3 * 1024 * 1024;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;

  if (origin) {
    try {
      if (new URL(origin).host !== host) {
        return res.status(403).json({ error: 'Origen no permitido.' });
      }
    } catch {
      return res.status(403).json({ error: 'Origen no permitido.' });
    }
  }

  const { GBL_APPS_SCRIPT_URL, GBL_UPLOAD_SECRET } = process.env;

  if (!GBL_APPS_SCRIPT_URL || !GBL_UPLOAD_SECRET) {
    return res.status(503).json({
      error: 'Falta configurar Google Drive en Vercel.'
    });
  }

  const { number, recordId, pdfBase64, uploadToken } = req.body || {};
const authorization = verifyQuoteToken(uploadToken);

if (
  !authorization ||
  authorization.number !== number ||
  authorization.recordId !== recordId
) {
  return res.status(403).json({
    error: 'Autorización de cotización inválida o vencida.'
  });
}
if (
  typeof recordId !== 'string' ||
  !/^rec[A-Za-z0-9]+$/.test(recordId)
) {
  return res.status(400).json({
    error: 'Identificador de Airtable inválido.'
  });
}

  if (!Number.isSafeInteger(number) || number < 70) {
    return res.status(400).json({ error: 'Número inválido.' });
  }

  if (
    typeof pdfBase64 !== 'string' ||
    !pdfBase64.length ||
    pdfBase64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4
  ) {
    return res.status(413).json({ error: 'PDF demasiado grande o inválido.' });
  }

  try {
    const bytes = Buffer.from(pdfBase64, 'base64');

    if (
      bytes.length > MAX_PDF_BYTES ||
      bytes.length < 8 ||
      bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
    ) {
      return res.status(400).json({ error: 'PDF inválido.' });
    }


    // Confirmar que la cotización existe en Airtable.
    const {
      AIRTABLE_TOKEN,
      AIRTABLE_BASE_ID,
      AIRTABLE_TABLE_ID
    } = process.env;

    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_ID) {
      return res.status(503).json({
        error: 'Falta configurar Airtable.'
      });
    }

    const airtableUrl =
      `https://api.airtable.com/v0/` +
      `${encodeURIComponent(AIRTABLE_BASE_ID)}/` +
      `${encodeURIComponent(AIRTABLE_TABLE_ID)}/` +
      `${encodeURIComponent(recordId)}`;

    const airtableResponse = await fetch(airtableUrl, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`
      },
      signal: AbortSignal.timeout(15000)
    });

    if (airtableResponse.status === 404) {
      return res.status(403).json({
        error: 'La cotización no existe en Airtable.'
      });
    }

    if (!airtableResponse.ok) {
      throw new Error('Error al consultar Airtable.');
    }

    const airtableRecord = await airtableResponse.json();

    const internalNumber =
      airtableRecord.fields?.['N˚ Cotización'];

    if (
      !Number.isSafeInteger(internalNumber) ||
      internalNumber + 69 !== number
    ) {
      return res.status(403).json({
        error: 'El número no corresponde al registro de Airtable.'
      });
    }


    const response = await fetch(GBL_APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        secret: GBL_UPLOAD_SECRET,
        number,
        pdfBase64
      }),
      redirect: 'follow',
      signal: AbortSignal.timeout(25000)
    });

    if (!response.ok) {
      throw new Error('Apps Script HTTP ' + response.status);
    }

    const result = await response.json();

    if (!result.ok) {
      return res.status(502).json({
        error: 'Google Drive rechazó el archivo.'
      });
    }

    return res.status(200).json({
      ok: true,
      alreadyExists: result.alreadyExists,
      fileId: result.fileId
    });

  } catch (error) {
    console.error('Error al archivar PDF:', error.message);

    return res.status(502).json({
      error: 'No se pudo guardar el PDF en Google Drive.'
    });
  }
};
