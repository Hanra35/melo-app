const { createHash } = require('crypto');

const KEY_ID  = '003ec0649a89f090000000001';
const APP_KEY = 'K003dwNhrjinpVEyi4VKsJxxZmL3LO4';
const BUCKET  = 'melo-music-2026';
const META    = 'melo-metadata.json';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

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

async function fixCors(a, bid) {
  await fetch(`${a.apiUrl}/b2api/v2/b2_update_bucket`, {
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

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const action = req.query?.action;

  try {
    const a   = await b2Auth();
    const bid = await getBucketId(a);

    /* ── INIT ── */
    if (action === 'init') {
      await fixCors(a, bid);

      let tracks = [], playlists = [];
      try {
        const r = await fetch(`${a.downloadUrl}/file/${BUCKET}/${META}`, {
          headers: { Authorization: a.authorizationToken }
        });
        if (r.ok) {
          const parsed = await r.json();
          /* Compatibilité : ancien format = tableau brut, nouveau = {tracks, playlists} */
          if (Array.isArray(parsed)) {
            tracks = parsed;
          } else {
            tracks    = Array.isArray(parsed.tracks)    ? parsed.tracks    : [];
            playlists = Array.isArray(parsed.playlists) ? parsed.playlists : [];
          }
        }
      } catch (_) {}

      const dlR = await fetch(`${a.apiUrl}/b2api/v2/b2_get_download_authorization`, {
        method: 'POST',
        headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucketId: bid, fileNamePrefix: '', validDurationInSeconds: 43200 })
      });
      const dlAuth = await dlR.json();

      res.status(200).json({ tracks, playlists, downloadUrl: a.downloadUrl, downloadToken: dlAuth.authorizationToken });
      return;
    }

    /* ── UPLOAD-CREDS ── */
    if (action === 'upload-creds') {
      const up = await getUploadUrl(a, bid);
      res.status(200).json({ uploadUrl: up.uploadUrl, authorizationToken: up.authorizationToken });
      return;
    }

    /* ── SAVE-META ── */
    /* Vercel parse automatiquement le JSON — on utilise req.body directement */
    if (action === 'save-meta' && req.method === 'POST') {
      const body = req.body;
      const tracks    = Array.isArray(body?.tracks)    ? body.tracks    : (Array.isArray(body) ? body : []);
      const playlists = Array.isArray(body?.playlists) ? body.playlists : [];
      const buf = Buffer.from(JSON.stringify({ tracks, playlists }), 'utf-8');
      const up  = await getUploadUrl(a, bid);
      await b2UploadBuf(up.uploadUrl, up.authorizationToken, META, buf, 'application/json');
      res.status(200).json({ ok: true });
      return;
    }

    /* ── DELETE ── */
    if (action === 'delete') {
      const { key, fileId } = req.query;
      if (key && fileId) {
        await fetch(`${a.apiUrl}/b2api/v2/b2_delete_file_version`, {
          method: 'POST',
          headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: key, fileId })
        });
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(404).json({ error: 'Action inconnue' });

  } catch (e) {
    console.error('api error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
