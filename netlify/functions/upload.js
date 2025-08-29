// netlify/functions/upload.js
// === 環境變數：在 Netlify → Site configuration → Environment variables 設定 ===
// OWNER, REPO, REPO_BRANCH(可省), GITHUB_TOKEN, UPLOAD_KEY
const GH_API       = 'https://api.github.com';
const OWNER        = process.env.OWNER;
const REPO         = process.env.REPO;
const BRANCH       = process.env.REPO_BRANCH || 'main';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// --- 小工具 ---
function json(status, obj) {
  return { statusCode: status, headers: CORS, body: JSON.stringify(obj) };
}
async function gh(path, init = {}) {
  const url = `${GH_API}/repos/${OWNER}/${REPO}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data.message || `GitHub error ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// 建立一次性鎖（idempotency）。同一 nonce 只會成功一次。
async function createIdempotencyLock(nonce) {
  const lockPath = `.locks/${nonce}.json`;
  const body = {
    message: `lock ${nonce}`,
    branch : BRANCH,
    content: Buffer.from(JSON.stringify({ nonce, ts: Date.now() })).toString('base64'),
  };
  try {
    await gh(`/contents/${encodeURIComponent(lockPath)}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    return true; // 第一次：建立成功
  } catch (e) {
    // 第二次以上：GitHub 會回 422 already exists
    if (e.status === 422 || /already exists/i.test(e.message || '')) return false;
    throw e;
  }
}

// 取目前最大編號（存在 photos/ 目錄）
async function getMaxNumberInPhotos() {
  try {
    const arr = await gh(`/contents/photos?ref=${encodeURIComponent(BRANCH)}`);
    let max = 0;
    for (const f of arr) {
      const m = /^(\d{3})\.(jpe?g|png|webp)$/i.exec(f.name);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max;
  } catch (e) {
    // 若資料夾不存在，GitHub 會回 404；視為 0
    if (e.status === 404) return 0;
    throw e;
  }
}

// 嘗試用指定檔名上傳；若檔名已存在（422），回 false，否則 true
async function tryPutImage(filename, base64Content) {
  try {
    await gh(`/contents/photos/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `upload ${filename}`,
        content: base64Content,
        branch : BRANCH
      })
    });
    return true;
  } catch (e) {
    if (e.status === 422 || /already exists/i.test(e.message || '')) return false;
    throw e;
  }
}

// 讀 / 寫 photos.txt（在檔尾追加一行）
async function appendToPhotosTxt(line) {
  let sha = null;
  let txt = '';
  try {
    const file = await gh(`/contents/photos/photos.txt?ref=${encodeURIComponent(BRANCH)}`);
    sha = file.sha;
    txt = Buffer.from(file.content, 'base64').toString('utf8');
    if (txt.length && !txt.endsWith('\n')) txt += '\n';
  } catch (e) {
    if (e.status !== 404) throw e; // 404 = 尚未建立，視為空字串
  }
  txt += line + '\n';

  await gh(`/contents/photos/photos.txt`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `append ${line.split('|')[0]} to photos.txt`,
      content: Buffer.from(txt, 'utf8').toString('base64'),
      branch : BRANCH,
      ...(sha ? { sha } : {})
    })
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  try {
    const payload = JSON.parse(event.body || '{}');
    const key     = payload.key;
    const title   = (payload.title || '').trim();
    let   contentBase64 = payload.contentBase64 || '';
    let   ext     = (payload.ext || '').toLowerCase();
    const nonce   = payload.nonce; // 可選；若有才做鎖

    if (!key || key !== process.env.UPLOAD_KEY)
      return json(401, { error: 'unauthorized' });

    if (!contentBase64 || !ext)
      return json(400, { error: 'missing file or ext' });

    // 去掉 dataURL 前綴
    contentBase64 = contentBase64.replace(/^data:[^;]+;base64,/, '');
    // 清理副檔名
    ext = ext.replace(/[^a-z0-9]/g, '');
    if (!/^(jpe?g|png|webp)$/.test(ext)) return json(400, { error: 'bad ext' });

    // === 一次性鎖：若有帶 nonce 才開啟 ===
    if (nonce) {
      const ok = await createIdempotencyLock(nonce);
      if (!ok) return json(409, { error: 'duplicate submit' }); // 同一表單已處理過
    }

    // 先抓目前最大號
    let next = (await getMaxNumberInPhotos()) + 1;

    // 穩健上傳：若檔名已存在就 +1 重試（避免並發碰撞）
    let filename, putOk = false, attempts = 0;
    while (!putOk && attempts < 20) { // 給個安全上限
      filename = `${String(next).padStart(3, '0')}.${ext}`;
      putOk = await tryPutImage(filename, contentBase64);
      if (!putOk) { next += 1; attempts += 1; }
    }
    if (!putOk) return json(500, { error: 'failed to allocate filename' });

    // 追加到 photos.txt
    await appendToPhotosTxt(`${filename}|${title}`);

    return json(200, {
      ok: true,
      filename,
      raw: `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/photos/${filename}`
    });
  } catch (e) {
    return json(500, { error: e.message || String(e) });
  }
};
