import { fetchPlaylist } from "./_playlist.js";

function requireAdmin(req) {
  const want = process.env.ADMIN_TOKEN;
  if (!want) {
    const err = new Error("ADMIN_TOKEN is not configured on the server");
    err.status = 500;
    throw err;
  }
  if (req.headers["x-admin-token"] !== want) {
    const err = new Error("Admin token required");
    err.status = 401;
    throw err;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    // Bulk fetching can hit external rate limits and creates lots of writes —
    // gate it behind the admin token so only the owner can trigger imports.
    requireAdmin(req);

    const url = (req.body?.url || "").trim();
    if (!url) return res.status(400).json({ error: "url is required" });

    const result = await fetchPlaylist(url);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
