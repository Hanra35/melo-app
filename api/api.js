const { createHash } = require('crypto');

/* ══════════════════════════════════════════════
   COMPTES BACKBLAZE
   Compte 1 : région eu-central-003
   Compte 2 : région us-east-005
   ══════════════════════════════════════════════ */
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

/* ── CORS réponse HTTP ── */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

/* ── Auth B2 native ── */
async function authB2(acct) {
  const cfg = ACCOUNTS[acct];
  if (!cfg) throw new Error('Compte inconnu: ' + acct);
  const r = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${cfg.keyId}:${cfg.appKey}`).toString('base64')
    }
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Auth B2 compte ${acct} failed (${r.status}): ${txt}`);
  }
  const d = await r.json();
  return { ...d, _cfg: cfg, _acct: acct };
}

/* ── Trouver l'ID du bucket ── */
async function getBucketId(a) {
  if (a.allowed?.bucketId) return a.allowed.bucketId;

  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_list_buckets`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: a.accountId, bucketName: a._cfg.bucket })
  });
  const d = await r.json();
  if (!d.buckets?.length) {
    throw new Error(`Bucket "${a._cfg.bucket}" introuvable. Vérifiez le nom exact dans Backblaze.`);
  }
  return d.buckets[0].bucketId;
}

/* ── Configurer le CORS sur le bucket ──
   CORRECTIF : on throw maintenant l'erreur au lieu de l'avaler silencieusement.
   Si la clé applicative n'a pas la permission "writeBuckets", B2 retourne une
   erreur 401/403 → l'appelant doit la traiter (voir upload-creds ci-dessous).   */
async function fixCors(a, bid) {
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_update_bucket`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: a.accountId,
      bucketId:  bid,
      corsRules: [{
        corsRuleName:      'melo-allow-all',
        allowedOrigins:    ['*'],
        allowedHeaders:    ['*'],
        allowedOperations: [
          'b2_download_file_by_name',
          'b2_download_file_by_id',
          'b2_upload_file',
          'b2_upload_part'
        ],
        exposeHeaders:  ['x-bz-upload-timestamp', 'X-Bz-File-Name', 'Content-Length'],
        maxAgeSeconds:  3600
      }]
    })
  });

  if (!r.ok) {
    const txt = await r.text();
    /* On throw maintenant — l'appelant décide de la gravité */
    throw new Error(`fixCors compte${a._acct} (${r.status}): ${txt}`);
  }
}

/* ── Obtenir l'URL d'upload ── */
async function getUploadUrl(a, bid) {
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: bid })
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`getUploadUrl failed (${r.status}): ${txt}`);
  }
  return r.json();
}

/* ── Token de téléchargement (12h) ── */
async function getDlToken(a, bid) {
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_get_download_authorization`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: bid, fileNamePrefix: '', validDurationInSeconds: 43200 })
  });
  if (!r.ok) return '';
  return (await r.json()).authorizationToken;
}

/* ── Upload buffer sur B2 ── */
async function b2UploadBuf(upUrl, upToken, key, buf, mime) {
  const sha1 = createHash('sha1').update(buf).digest('hex');
  const r = await fetch(upUrl, {
    method: 'POST',
    headers: {
      Authorization:        upToken,
      'X-Bz-File-Name':     encodeURIComponent(key),
      'Content-Type':       mime,
      'X-Bz-Content-Sha1':  sha1,
    },
    body: buf,
  });
  if (!r.ok) throw new Error('B2 upload failed: ' + await r.text());
  return r.json();
}

/* ── Parser les métadonnées ── */
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

/* ── Calculer les stats de stockage ── */
function storageStats(tracks) {
  const AVG = 6 * 1024 * 1024;
  const used = tracks.reduce((s, t) => s + (t.fileSize || AVG), 0);
  const total = 10 * GB;
  return {
    used,
    total,
    free:  Math.max(0, total - used),
    count: tracks.length,
    pct:   Math.min(100, Math.round(used / total * 100)),
  };
}

/* ══════════════════════════════════════════════
   HANDLER VERCEL
   ══════════════════════════════════════════════ */
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

      /* Tente de configurer CORS — échec silencieux ici car init ne doit pas planter */
      try { await fixCors(a, bid); }
      catch (e) { console.warn('init fixCors:', e.message); }

      let meta = { tracks: [], playlists: [], albums: [], artists: [] };
      try {
        const r = await fetch(`${a.downloadUrl}/file/${a._cfg.bucket}/${META_FILE}`, {
          headers: { Authorization: a.authorizationToken }
        });
        if (r.ok) meta = parseMeta(await r.json());
      } catch (_) {}

      const dlToken = await getDlToken(a, bid);
      const statsActif = storageStats(meta.tracks);

      let statsAutre = { used: 0, total: 10 * GB, free: 10 * GB, count: 0, pct: 0 };
      const autreAcct = acct === 1 ? 2 : 1;
      try {
        const a2   = await authB2(autreAcct);
        const bid2 = await getBucketId(a2);
        let m2 = { tracks: [] };
        try {
          const r2 = await fetch(`${a2.downloadUrl}/file/${a2._cfg.bucket}/${META_FILE}`, {
            headers: { Authorization: a2.authorizationToken }
          });
          if (r2.ok) m2 = parseMeta(await r2.json());
        } catch (_) {}
        statsAutre = storageStats(m2.tracks);
      } catch (_) {}

      const stats1 = acct === 1 ? statsActif : statsAutre;
      const stats2 = acct === 2 ? statsActif : statsAutre;

      res.status(200).json({
        account:       acct,
        tracks:        meta.tracks,
        playlists:     meta.playlists,
        albums:        meta.albums,
        artists:       meta.artists,
        downloadUrl:   a.downloadUrl,
        downloadToken: dlToken,
        bucketName:    a._cfg.bucket,
        stats1,
        stats2,
      });
      return;
    }

    /* ── UPLOAD-CREDS ──
       CORRECTIF PRINCIPAL : si fixCors échoue (permission manquante sur la clé),
       on retourne une erreur claire au lieu de continuer et d'obtenir
       un "network error" cryptique dans le navigateur.                           */
    if (action === 'upload-creds') {
      const a   = await authB2(acct);
      const bid = await getBucketId(a);

      try {
        await fixCors(a, bid);
      } catch (corsErr) {
        /* La clé applicative n'a probablement pas la permission writeBuckets.
           On remonte l'erreur explicitement plutôt que de laisser l'upload échouer
           plus tard avec un "network error" sans explication.                    */
        console.error(`upload-creds fixCors compte${acct}:`, corsErr.message);
        res.status(500).json({
          error: `Impossible de configurer le CORS sur le bucket du compte ${acct}. `
               + `Vérifiez que la clé applicative possède la permission "writeBuckets" `
               + `dans la console Backblaze, ou configurez le CORS manuellement sur le bucket. `
               + `Détail : ${corsErr.message}`
        });
        return;
      }

      const up = await getUploadUrl(a, bid);

      res.status(200).json({
        uploadUrl:          up.uploadUrl,
        authorizationToken: up.authorizationToken,
        account:            acct,
        bucketName:         a._cfg.bucket,
      });
      return;
    }

    /* ── FIX-CORS (action dédiée pour forcer la mise à jour CORS) ── */
    if (action === 'fix-cors') {
      const results = {};
      for (const num of [1, 2]) {
        try {
          const a   = await authB2(num);
          const bid = await getBucketId(a);
          await fixCors(a, bid);
          results[`compte${num}`] = 'ok';
        } catch (e) {
          results[`compte${num}`] = `ERREUR: ${e.message}`;
        }
      }
      res.status(200).json(results);
      return;
    }

    /* ── SAVE-META ── */
    if (action === 'save-meta' && req.method === 'POST') {
      const body = req.body;
      const meta = parseMeta(body);
      const buf  = Buffer.from(JSON.stringify(meta), 'utf-8');
      const a    = await authB2(acct);
      const bid  = await getBucketId(a);
      const up   = await getUploadUrl(a, bid);
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
        const [bid1, bid2] = await Promise.all([getBucketId(a1), getBucketId(a2)]);
        const [r1, r2] = await Promise.all([
          fetch(`${a1.downloadUrl}/file/${a1._cfg.bucket}/${META_FILE}`, { headers: { Authorization: a1.authorizationToken }}),
          fetch(`${a2.downloadUrl}/file/${a2._cfg.bucket}/${META_FILE}`, { headers: { Authorization: a2.authorizationToken }})
        ]);
        if (r1.ok) m1 = parseMeta(await r1.json());
        if (r2.ok) m2 = parseMeta(await r2.json());
      } catch (_) {}
      res.status(200).json({
        stats1: storageStats(m1.tracks),
        stats2: storageStats(m2.tracks),
      });
      return;
    }

    res.status(404).json({ error: 'Action inconnue: ' + action });

  } catch (e) {
    console.error('api error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
