const KEY_ID  = '003ec0649a89f090000000001';
const APP_KEY = 'K003dwNhrjinpVEyi4VKsJxxZmL3LO4';
const BUCKET  = 'melo-music-2026';
const META    = 'melo-metadata.json';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

async function b2Auth() {
  const r = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${KEY_ID}:${APP_KEY}`).toString('base64') },
  });
  if (!r.ok) throw new Error('Auth B2 échouée: ' + r.status);
  return r.json();
}

async function getBucketId(auth) {
  if (auth.allowed?.bucketId) return auth.allowed.bucketId;
  const r = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_buckets`, {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: auth.accountId, bucketName: BUCKET }),
  });
  const d = await r.json();
  return d.buckets[0].bucketId;
}

async function getUploadUrl(auth, bucketId) {
  const r = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId }),
  });
  return r.json();
}

async function uploadToB2(upData, key, body, contentType) {
  const { createHash } = require('crypto');
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const sha1 = createHash('sha1').update(buf).digest('hex');
  const r = await fetch(upData.uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: upData.authorizationToken,
      'X-Bz-File-Name': encodeURIComponent(key),
      'Content-Type': contentType,
      'X-Bz-Content-Sha1': sha1,
    },
    body: buf,
  });
  if (!r.ok) throw new Error('Upload B2 échoué: ' + await r.text());
  return r.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const action = event.queryStringParameters?.action;

  try {
    const auth = await b2Auth();
    const bucketId = await getBucketId(auth);

    /* ── INIT : retourne metadata + token de téléchargement (1 seul appel au démarrage) ── */
    if (action === 'init') {
      let tracks = [];
      try {
        const r = await fetch(`${auth.downloadUrl}/file/${BUCKET}/${META}`, {
          headers: { Authorization: auth.authorizationToken },
        });
        if (r.ok) tracks = await r.json();
      } catch (_) {}

      const dlR = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_download_authorization`, {
        method: 'POST',
        headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucketId, fileNamePrefix: '', validDurationInSeconds: 14400 }),
      });
      const dlAuth = await dlR.json();

      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks, downloadUrl: auth.downloadUrl, downloadToken: dlAuth.authorizationToken }),
      };
    }

    /* ── UPLOAD CREDENTIALS : retourne l'URL d'upload direct B2 ── */
    if (action === 'upload-creds') {
      const upData = await getUploadUrl(auth, bucketId);
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadUrl: upData.uploadUrl, authorizationToken: upData.authorizationToken }),
      };
    }

    /* ── SAVE METADATA (petit fichier JSON, proxy complet) ── */
    if (action === 'save-meta' && event.httpMethod === 'POST') {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf-8')
        : (event.body || '[]');
      const upData = await getUploadUrl(auth, bucketId);
      await uploadToB2(upData, META, body, 'application/json');
      return { statusCode: 200, headers: CORS, body: '{"ok":true}' };
    }

    /* ── UPLOAD FICHIER AUDIO (proxy complet pour éviter CORS sur PUT) ── */
    if (action === 'upload-file' && event.httpMethod === 'POST') {
      const key  = event.queryStringParameters.key;
      const type = event.queryStringParameters.type || 'audio/mpeg';
      const buf  = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : Buffer.from(event.body || '', 'binary');
      const upData = await getUploadUrl(auth, bucketId);
      const result = await uploadToB2(upData, key, buf, type);
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: result.fileId }),
      };
    }

    /* ── DELETE ── */
    if (action === 'delete') {
      const key    = event.queryStringParameters.key;
      const fileId = event.queryStringParameters.fileId;
      if (key && fileId) {
        await fetch(`${auth.apiUrl}/b2api/v2/b2_delete_file_version`, {
          method: 'POST',
          headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: key, fileId }),
        });
      }
      return { statusCode: 200, headers: CORS, body: '{"ok":true}' };
    }

    return { statusCode: 404, headers: CORS, body: 'Action inconnue' };

  } catch (e) {
    console.error('api error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

