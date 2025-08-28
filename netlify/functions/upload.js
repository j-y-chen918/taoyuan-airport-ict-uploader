// netlify/functions/upload.js
// 簡潔：前端用 JSON 傳 { imageBase64, title, key }，這邊直接處理
// 會自動找出下一個 3 碼編號，存到 photos/NNN.jpg，並把 "NNN.jpg|標題" 追加到 photos/photos.txt

const TOKEN  = process.env.GITHUB_TOKEN;
const OWNER  = process.env.OWNER;
const REPO   = process.env.REPO;
const BRANCH = process.env.REPO_BRANCH || "main";
const UP_KEY = process.env.UPLOAD_KEY;

const GH = "https://api.github.com";

function b64(body) {
  return Buffer.from(body).toString("base64");
}
async function gh(path, opts = {}) {
  const r = await fetch(`${GH}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
  return r;
}
async function getFile(path) {
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${BRANCH}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${path} failed: ${r.status}`);
  const j = await r.json();
  // content is base64; return {sha, text}
  const text = Buffer.from(j.content, "base64").toString("utf8");
  return { sha: j.sha, text };
}
async function putFile(path, contentBase64, message, sha) {
  const body = {
    message,
    content: contentBase64,
    branch: BRANCH,
    ...(sha ? { sha } : {}),
  };
  const r = await gh(`/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`PUT ${path} failed: ${r.status} ${t}`);
  }
}

// 找目前最大編號（從 photos.txt 或掃描 photos 兩種方式擇一）
async function nextIndex() {
  // 先試 photos.txt（效率最好）
  const txt = await getFile("photos/photos.txt");
  if (txt && txt.text.trim()) {
    const max = txt.text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => l.split("|")[0].trim())
      .map(n => parseInt(n, 10))
      .filter(n => Number.isFinite(n))
      .reduce((a, b) => Math.max(a, b), 0);
    return max + 1;
  }
  // 沒有 txt 就從 1 開始
  return 1;
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const data = JSON.parse(event.body || "{}");
    const { imageBase64, title = "", key } = data;

    if (!key || key !== UP_KEY) {
      return { statusCode: 401, body: "Unauthorized" };
    }
    if (!imageBase64 || !/^data:image\/(png|jpe?g|webp);base64,/.test(imageBase64)) {
      return { statusCode: 400, body: "Bad imageBase64" };
    }

    // 取得下一個編號
    const idx = await nextIndex();
    const num = String(idx).padStart(3, "0");

    // 決定副檔名（若是 jpeg / png / webp）
    const ext = (imageBase64.match(/^data:image\/(png|jpe?g|webp)/i)?.[1] || "jpeg")
      .replace("jpeg", "jpg")
      .toLowerCase();

    const filename = `${num}.${ext}`;
    const imgPath  = `photos/${filename}`;

    // 圖檔內容（去掉 dataURL prefix）
    const base64Payload = imageBase64.replace(/^data:image\/\w+;base64,/, "");

    // 寫入圖片
    await putFile(
      imgPath,
      base64Payload,
      `upload: add ${filename}`
    );

    // 追加/建立 photos.txt
    const row = `${filename}|${title.replace(/\r?\n/g, " ").trim()}`;
    const prev = await getFile("photos/photos.txt");
    let newTxt = row + "\n";
    if (prev && prev.text) newTxt = (prev.text.replace(/\s+$/,"") + "\n" + row + "\n");

    await putFile(
      "photos/photos.txt",
      b64(newTxt),
      `upload: append ${filename} to photos.txt`,
      prev ? prev.sha : undefined
    );

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, filename, title, index: num }),
    };
  } catch (e) {
    return { statusCode: 500, body: `Error: ${e.message}` };
  }
}
