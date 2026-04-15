const KEY_ID  = '003ec0649a89f090000000001';
const APP_KEY = 'K003dwNhrjinpVEyi4VKsJxxZmL3LO4';
const BUCKET  = 'melo-music-2026';
const META    = 'melo-metadata.json';

const CH = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function ok(body) { return { statusCode:200, headers:{...CH,'Content-Type':'application/json'}, body: typeof body==='string'?body:JSON.stringify(body) }; }
function err(msg) { return { statusCode:500, headers:CH, body: JSON.stringify({error:msg}) }; }

async function b2Auth() {
  const r = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${KEY_ID}:${APP_KEY}`).toString('base64') }
  });
  if (!r.ok) throw new Error('Auth B2 failed: ' + r.status);
  return r.json();
}

async function getBucketId(a) {
  if (a.allowed?.bucketId) return a.allowed.bucketId;
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_list_buckets`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: a.accountId, bucketName: BUCKET })
  });
  const d = await r.json();
  if (!d.buckets?.length) throw new Error('Bucket "' + BUCKET + '" introuvable');
  return d.buckets[0].bucketId;
}

/* ── CORS FIX — noms d'opérations corrects selon la doc B2 ── */
async function fixCors(a, bid) {
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_update_bucket`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: a.accountId,
      bucketId: bid,
      corsRules: [{
        corsRuleName: 'allowAll',
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        allowedOperations: [
          'b2_download_file_by_name',
          'b2_download_file_by_id',
          'b2_upload_file',
          'b2_upload_part'
        ],
        exposeHeaders: ['x-bz-upload-timestamp', 'X-Bz-File-Name', 'Content-Length'],
        maxAgeSeconds: 3600
      }]
    })
  });
  const result = await r.json();
  if (!r.ok) throw new Error('fixCors failed: ' + JSON.stringify(result));
  console.log('CORS OK:', JSON.stringify(result.corsRules));
}

async function getUploadUrl(a, bid) {
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: bid })
  });
  return r.json();
}

async function b2UploadBuf(upUrl, upToken, key, buf, contentType) {
  const { createHash } = require('crypto');
  const sha1 = createHash('sha1').update(buf).digest('hex');
  const r = await fetch(upUrl, {
    method: 'POST',
    headers: {
      Authorization: upToken,
      'X-Bz-File-Name': encodeURIComponent(key),
      'Content-Type': contentType,
      'X-Bz-Content-Sha1': sha1,
    },
    body: buf,
  });
  if (!r.ok) throw new Error('B2 upload failed: ' + await r.text());
  return r.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CH, body: '' };
  const q = event.queryStringParameters || {};

  try {
    const a   = await b2Auth();
    const bid = await getBucketId(a);

    /* ── INIT ── */
    if (q.action === 'init') {
      await fixCors(a, bid);

      let tracks = [];
      try {
        const r = await fetch(`${a.downloadUrl}/file/${BUCKET}/${META}`, {
          headers: { Authorization: a.authorizationToken }
        });
        if (r.ok) tracks = await r.json();
      } catch (_) {}

      const dlR = await fetch(`${a.apiUrl}/b2api/v2/b2_get_download_authorization`, {
        method: 'POST',
        headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucketId: bid, fileNamePrefix: '', validDurationInSeconds: 43200 })
      });
      const dlAuth = await dlR.json();

      return ok({ tracks, downloadUrl: a.downloadUrl, downloadToken: dlAuth.authorizationToken });
    }

    /* ── UPLOAD-CREDS — URL d'upload fraîche pour chaque fichier ── */
    if (q.action === 'upload-creds') {
      const up = await getUploadUrl(a, bid);
      return ok({ uploadUrl: up.uploadUrl, authorizationToken: up.authorizationToken });
    }

    /* ── SAVE-META ── */
    if (q.action === 'save-meta' && event.httpMethod === 'POST') {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf-8')
        : (event.body || '[]');
      const up = await getUploadUrl(a, bid);
      await b2UploadBuf(up.uploadUrl, up.authorizationToken, META, Buffer.from(body), 'application/json');
      return ok({ ok: true });
    }

    /* ── DELETE ── */
    if (q.action === 'delete') {
      if (q.key && q.fileId) {
        await fetch(`${a.apiUrl}/b2api/v2/b2_delete_file_version`, {
          method: 'POST',
          headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: q.key, fileId: q.fileId })
        });
      }
      return ok({ ok: true });
    }

    return { statusCode: 404, headers: CH, body: 'Action inconnue' };

  } catch (e) {
    console.error('api error:', e.message);
    return err(e.message);
  }
};
