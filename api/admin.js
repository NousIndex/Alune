// Lightweight verify endpoint for the admin sign-in modal.
// All actual mutations live in api/library.js (PATCH/DELETE).
export default function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const want = process.env.ADMIN_TOKEN;
  if (!want) {
    return res.status(500).json({ error: "ADMIN_TOKEN is not configured on the server" });
  }
  const got = req.headers["x-admin-token"];
  if (got !== want) return res.status(401).json({ error: "Invalid admin token" });
  return res.status(200).json({ ok: true });
}
