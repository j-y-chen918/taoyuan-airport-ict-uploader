import { Octokit } from "octokit";
import Busboy from "busboy";

export async function handler(event) {
  if (event.httpMethod !== "POST")
    return resp(405, { error: "Method not allowed" });

  const UPLOAD_KEY = process.env.UPLOAD_KEY || "";
  const OWNER = process.env.OWNER;
  const REPO  = process.env.REPO;
  const BRANCH = process.env.REPO_BRANCH || 'main';
  const octo  = new Octokit({ auth: process.env.GITHUB_TOKEN });

  // 解析 multipart/form-data
  const files = [];
  const fields = {};
  try {
    await new Promise((resolve, reject) => {
      const bb = Busboy({ headers: event.headers });
      bb.on("file", (name, file, info) => {
        const chunks = [];
        file.on("data", d => chunks.push(d));
        file.on("end", () => files.push({ filename: info.filename, buffer: Buffer.concat(chunks) }));
      });
      bb.on("field", (name, val) => (fields[name] = val));
      bb.on("close", resolve);
      bb.on("error", reject);
      bb.end(Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8"));
    });
  } catch {
    return resp(400, { error: "Malformed form data" });
  }

  if (UPLOAD_KEY && fields.key !== UPLOAD_KEY) return resp(401, { error: "Invalid key" });
  if (!files.length) return resp(400, { error: "No files" });

  // 找目前最大編號
  let max = 0;
  const tree = await octo.request("GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1", {
    owner: OWNER, repo: REPO, ref: BRANCH
  });
  for (const t of tree.data.tree) {
    if (t.path?.startsWith("photos/") && /^\d{3}\.(jpg|jpeg|png|webp)$/i.test(t.path)) {
      const n = parseInt(t.path.slice(7,10), 10); if (n > max) max = n;
    }
  }

  // 讀/建 photos.txt
  const TXT = "photos/photos.txt";
  let txtSHA = null, txtContent = "";
  try {
    const r = await octo.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: OWNER, repo: REPO, path: TXT, ref: BRANCH
    });
    txtSHA = r.data.sha;
    txtContent = Buffer.from(r.data.content, "base64").toString("utf8");
  } catch {}

  const saved = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const next = String(++max).padStart(3, "0");
    const ext  = (f.filename.split(".").pop() || "jpg").toLowerCase();
    const saveAs = `photos/${next}.${ext}`;
    const title = (fields[`title_${i}`] || next).trim();

    // 上傳檔案
    await octo.request("PUT /repos/{owner}/{repo}/contents/{path}", {
      owner: OWNER, repo: REPO, path: saveAs, branch: BRANCH,
      message: `upload: ${saveAs}`,
      content: f.buffer.toString("base64")
    });

    // 追加一行
    const newline = `${next}.${ext}|${title}\n`;
    txtContent = (txtContent ? txtContent.replace(/\s*$/,'') + "\n" : "") + newline;
    saved.push(saveAs);
  }

  // 寫回 photos.txt
  await octo.request("PUT /repos/{owner}/{repo}/contents/{path}", {
    owner: OWNER, repo: REPO, path: TXT, branch: BRANCH, sha: txtSHA,
    message: "append: update photos.txt",
    content: Buffer.from(txtContent, "utf8").toString("base64")
  });

  return resp(200, { ok: true, files: saved });
}

function resp(code, obj) {
  return {
    statusCode: code,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
    body: JSON.stringify(obj)
  };
}
