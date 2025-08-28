// netlify/functions/upload.js
exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'POST,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };

  try{
    const { key, title, contentBase64, ext } = JSON.parse(event.body || '{}');

    if (!key || key !== process.env.UPLOAD_KEY)
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error:'unauthorized' }) };

    if (!contentBase64 || !ext)
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error:'missing file or ext' }) };

    const owner  = process.env.OWNER;
    const repo   = process.env.REPO;
    const branch = process.env.REPO_BRANCH || 'main';
    const token  = process.env.GITHUB_TOKEN;
    const gh = 'https://api.github.com';
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    // 1) 找下一個連號
    let next = 1;
    const listRes = await fetch(`${gh}/repos/${owner}/${repo}/contents/photos?ref=${branch}`, { headers });
    if (listRes.ok) {
      const arr = await listRes.json();
      let max = 0;
      for (const f of arr) {
        const m = /^(\d{3})\.(jpe?g|png|webp)$/i.exec(f.name);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
      next = max + 1;
    }
    const num = String(next).padStart(3, '0');
    const extSafe = ext.toLowerCase().replace(/[^a-z0-9]/g,'');
    const filename = `${num}.${extSafe}`;

    // 2) 新增影像檔
    const putImg = await fetch(`${gh}/repos/${owner}/${repo}/contents/photos/${encodeURIComponent(filename)}`, {
      method: 'PUT', headers,
      body: JSON.stringify({
        message: `upload ${filename}`,
        content: contentBase64,
        branch
      })
    });
    if (!putImg.ok) {
      const t = await putImg.text();
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error:'create image failed', details:t }) };
    }

    // 3) 更新 photos.txt
    let txt = '';
    let sha = null;
    const getTxt = await fetch(`${gh}/repos/${owner}/${repo}/contents/photos/photos.txt?ref=${branch}`, { headers });
    if (getTxt.ok) {
      const j = await getTxt.json();
      sha = j.sha;
      txt = Buffer.from(j.content, 'base64').toString('utf8');
      if (txt.length && !txt.endsWith('\n')) txt += '\n';
    }
    txt += `${filename}|${title||''}\n`;

    const putTxt = await fetch(`${gh}/repos/${owner}/${repo}/contents/photos/photos.txt`, {
      method: 'PUT', headers,
      body: JSON.stringify({
        message: `append ${filename} to photos.txt`,
        content: Buffer.from(txt,'utf8').toString('base64'),
        branch, sha
      })
    });
    if (!putTxt.ok) {
      const t = await putTxt.text();
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error:'update photos.txt failed', details:t }) };
    }

    // 4) 回傳成功
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ok:true,
        filename,
        raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/photos/${filename}`
      })
    };
  }catch(e){
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message || String(e) }) };
  }
};
