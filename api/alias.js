import { resolveAlias, kvClient } from "./_aliasing.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const name = (req.query?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    const result = await resolveAlias(name, kvClient());
    return res.status(200).json(result);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
