const { createHash } = require('crypto');

const ACCOUNTS = {
  1: {
    keyId:  '003ec0649a89f090000000001',
    appKey: 'K003dwNhrjinpVEyi4VKsJxxZmL3LO4',
    bucket: 'melo-music-2026',
  },
  2: {
    keyId:  '005ac1e426dba9b0000000001',
    appKey: 'K005BBpJA11ponJY7pvKaPK94H4//qQ',
    bucket: 'melo-music-2-bucket',
  },
};

const META_FILE = 'melo-metadata.json';
const GB = 1073741824;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

/* ── BODY PARSER — Vercel ne parse pas toujours req.body automatiquement ──
   Sans ça, save-meta reçoit undefined → sauvegarde un fichier vide
   → les tracks du compte 2 disparaissent au rechargement              */
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk.toString());
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

async function authB2(acct) {
  const cfg = ACCOUNTS[acct];
  const r = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.keyId}:${cfg.appKey}`).toString('base64') }
  });
  if (!r.ok) throw new Error(`Auth compte ${acct} failed: ${r.status}`);
  const d = await r.json();
  return { ...d, _cfg: cfg };
}

async function getBucketId(a) {
  if (a.allowed?.bucketId) return a.allowed.bucketId;
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_list_buckets`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: a.accountId, bucketName: a._cfg.bucket })
  });
  const d = await r.json();
  if (!d.buckets?.length) throw new Error(`Bucket "${a._cfg.bucket}" introuvable`);
  return d.buckets[0].bucketId;
}

async function getUploadUrl(a, bid) {
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: bid })
  });
  if (!r.ok) throw new Error('getUploadUrl failed: ' + r.status);
  return r.json();
}

async function b2UploadBuf(upUrl, upToken, key, buf, mime) {
  const sha1 = createHash('sha1').update(buf).digest('hex');
  const r = await fetch(upUrl, {
    method: 'POST',
    headers: {
      Authorization: upToken,
      'X-Bz-File-Name': encodeURIComponent(key),
      'Content-Type': mime,
      'X-Bz-Content-Sha1': sha1,
    },
    body: buf,
  });
  if (!r.ok) throw new Error('Upload failed: ' + await r.text());
  return r.json();
}

function parseMeta(raw) {
  if (!raw) return { tracks: [], playlists: [], albums: [], artists: [] };
  if (Array.isArray(raw)) return { tracks: raw, playlists: [], albums: [], artists: [] };
  return {
    tracks:    Array.isArray(raw.tracks)    ? raw.tracks    : [],
    playlists: Array.isArray(raw.playlists) ? raw.playlists : [],
    albums:    Array.isArray(raw.albums)    ? raw.albums    : [],
    artists:   Array.isArray(raw.artists)   ? raw.artists   : [],
  };
}

function storageStats(tracks) {
  const AVG = 6 * 1024 * 1024;
  const used = tracks.reduce((s, t) => s + (t.fileSize || AVG), 0);
  const total = 10 * GB;
  return { used, total, free: Math.max(0, total - used), count: tracks.length,
           pct: Math.min(100, Math.round(used / total * 100)) };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action, account: acctParam } = req.query;
  const acct = parseInt(acctParam) === 2 ? 2 : 1;

  try {

    /* ── INIT ── */
    if (action === 'init') {
      const a   = await authB2(acct);
      const bid = await getBucketId(a);

      let meta = { tracks: [], playlists: [], albums: [], artists: [] };
      try {
        const r = await fetch(`${a.downloadUrl}/file/${a._cfg.bucket}/${META_FILE}`, {
          headers: { Authorization: a.authorizationToken }
        });
        if (r.ok) meta = parseMeta(await r.json());
      } catch (_) {}

      /* Stats de l'autre compte en parallèle */
      let statsAutre = { used: 0, total: 10 * GB, free: 10 * GB, count: 0, pct: 0 };
      const autreAcct = acct === 1 ? 2 : 1;
      try {
        const a2 = await authB2(autreAcct);
        let m2 = { tracks: [] };
        try {
          const r2 = await fetch(`${a2.downloadUrl}/file/${a2._cfg.bucket}/${META_FILE}`, {
            headers: { Authorization: a2.authorizationToken }
          });
          if (r2.ok) m2 = parseMeta(await r2.json());
        } catch (_) {}
        statsAutre = storageStats(m2.tracks);
      } catch (_) {}

      const statsActif = storageStats(meta.tracks);
      const stats1 = acct === 1 ? statsActif : statsAutre;
      const stats2 = acct === 2 ? statsActif : statsAutre;

      res.status(200).json({
        account: acct,
        tracks: meta.tracks, playlists: meta.playlists,
        albums: meta.albums, artists: meta.artists,
        stats1, stats2,
      });
      return;
    }

    /* ── STREAM — proxy audio B2 → navigateur (résout le CORS définitivement) ──
       Le navigateur envoie un header Range pour le seek → on le transmet à B2   */
    if (action === 'stream') {
      const { key } = req.query;
      if (!key) { res.status(400).json({ error: 'key manquant' }); return; }

      const a = await authB2(acct);
      const url = `${a.downloadUrl}/file/${a._cfg.bucket}/${key}`;

      const b2Headers = { Authorization: a.authorizationToken };
      if (req.headers.range) b2Headers['Range'] = req.headers.range;

      const b2r = await fetch(url, { headers: b2Headers });

      if (!b2r.ok && b2r.status !== 206) {
        res.status(b2r.status).json({ error: 'Fichier introuvable sur B2' });
        return;
      }

      const ct = b2r.headers.get('Content-Type') || 'audio/mpeg';
      const cl = b2r.headers.get('Content-Length');
      const cr = b2r.headers.get('Content-Range');

      res.setHeader('Content-Type', ct);
      res.setHeader('Accept-Ranges', 'bytes');
      if (cl) res.setHeader('Content-Length', cl);
      if (cr) res.setHeader('Content-Range', cr);
      res.status(b2r.status === 206 ? 206 : 200);

      const reader = b2r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        const ok = res.write(Buffer.from(value));
        if (!ok) await new Promise(r => res.once('drain', r));
      }
      return;
    }

    /* ── UPLOAD-CREDS ── */
    if (action === 'upload-creds') {
      const a   = await authB2(acct);
      const bid = await getBucketId(a);
      const up  = await getUploadUrl(a, bid);
      res.status(200).json({
        uploadUrl: up.uploadUrl,
        authorizationToken: up.authorizationToken,
        account: acct,
        bucketName: a._cfg.bucket,
      });
      return;
    }

    /* ── SAVE-META ── */
    if (action === 'save-meta' && req.method === 'POST') {
      const rawBody = await readBody(req);
      const meta = parseMeta(rawBody);

      /* Garde-fou : ne jamais sauvegarder un fichier vide si le body est suspect */
      const bodyStr = JSON.stringify(rawBody);
      if (!meta.tracks.length && (bodyStr === '{}' || bodyStr === '' || bodyStr === 'null')) {
        console.warn('save-meta: body vide reçu — sauvegarde annulée');
        res.status(400).json({ error: 'Body vide' });
        return;
      }

      const buf = Buffer.from(JSON.stringify(meta), 'utf-8');
      const a   = await authB2(acct);
      const bid = await getBucketId(a);
      const up  = await getUploadUrl(a, bid);
      await b2UploadBuf(up.uploadUrl, up.authorizationToken, META_FILE, buf, 'application/json');
      res.status(200).json({ ok: true });
      return;
    }

    /* ── DELETE ── */
    if (action === 'delete') {
      const { key, fileId } = req.query;
      if (key && fileId) {
        const a = await authB2(acct);
        await fetch(`${a.apiUrl}/b2api/v2/b2_delete_file_version`, {
          method: 'POST',
          headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: key, fileId })
        });
      }
      res.status(200).json({ ok: true });
      return;
    }

    /* ── STORAGE-STATS ── */
    if (action === 'storage-stats') {
      const [a1, a2] = await Promise.all([authB2(1), authB2(2)]);
      let m1 = { tracks: [] }, m2 = { tracks: [] };
      try {
        const [r1, r2] = await Promise.all([
          fetch(`${a1.downloadUrl}/file/${a1._cfg.bucket}/${META_FILE}`, { headers: { Authorization: a1.authorizationToken } }),
          fetch(`${a2.downloadUrl}/file/${a2._cfg.bucket}/${META_FILE}`, { headers: { Authorization: a2.authorizationToken } }),
        ]);
        if (r1.ok) m1 = parseMeta(await r1.json());
        if (r2.ok) m2 = parseMeta(await r2.json());
      } catch (_) {}
      res.status(200).json({ stats1: storageStats(m1.tracks), stats2: storageStats(m2.tracks) });
      return;
    }

    res.status(404).json({ error: 'Action inconnue' });

  } catch (e) {
    console.error('api error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
