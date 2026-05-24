// Admin CRUD for manual alias overrides. Override entries always win over
// MusicBrainz lookups in resolveAlias().
//
// Storage shape (Upstash HASH at key "alias:overrides"):
//   field: <normalized lowercase trimmed input name>
//   value: { original: "<as typed>", alias: "<counterpart>" }

import { kvClient, normalizeName, formatPair } from "./_aliasing.js";

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

function parseEntry(field, raw) {
  if (!raw) return null;
  const entry = typeof raw === "string" ? safeJson(raw) : raw;
  if (!entry || typeof entry !== "object") return null;
  return {
    key: field,
    original: entry.original || field,
    alias: entry.alias || "",
    formatted: formatPair(entry.original || field, entry.alias || ""),
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export default async function handler(req, res) {
  try {
    const redis = kvClient();
    if (!redis) {
      return res.status(500).json({ error: "Vercel KV is not configured" });
    }

    if (req.method === "GET") {
      // Listing overrides doesn't require admin — useful for the UI to render
      // existing pairs alongside auto-resolved ones. Mutations are gated.
      const all = await redis.hgetall("alias:overrides");
      const entries = Object.entries(all || {})
        .map(([k, v]) => parseEntry(k, v))
        .filter(Boolean)
        .sort((a, b) => a.original.localeCompare(b.original));
      return res.status(200).json({ overrides: entries });
    }

    if (req.method === "POST") {
      requireAdmin(req);
      const original = (req.body?.original || "").trim();
      const alias = (req.body?.alias || "").trim();
      if (!original || !alias) {
        return res.status(400).json({ error: "Both 'original' and 'alias' are required" });
      }
      const norm = normalizeName(original);
      await redis.hset("alias:overrides", { [norm]: JSON.stringify({ original, alias }) });
      // Invalidate any MB cache for the same name so the override takes effect
      // on the next resolve.
      await redis.del(`alias:cache:${norm}`);
      // Also seed the reverse mapping so resolving the alias name returns the
      // original — saves a round-trip when songs are added under the other name.
      const revNorm = normalizeName(alias);
      if (revNorm && revNorm !== norm) {
        await redis.hset("alias:overrides", {
          [revNorm]: JSON.stringify({ original: alias, alias: original }),
        });
        await redis.del(`alias:cache:${revNorm}`);
      }
      return res.status(200).json({ ok: true, entry: { original, alias, formatted: formatPair(original, alias) } });
    }

    if (req.method === "DELETE") {
      requireAdmin(req);
      const original =
        (req.body && req.body.original) ||
        new URL(req.url, "http://localhost").searchParams.get("original") ||
        "";
      if (!original) return res.status(400).json({ error: "original is required" });
      const norm = normalizeName(original);
      // Find the paired reverse key so we can drop both.
      const raw = await redis.hget("alias:overrides", norm);
      const entry = parseEntry(norm, raw);
      await redis.hdel("alias:overrides", norm);
      await redis.del(`alias:cache:${norm}`);
      if (entry?.alias) {
        const revNorm = normalizeName(entry.alias);
        if (revNorm && revNorm !== norm) {
          await redis.hdel("alias:overrides", revNorm);
          await redis.del(`alias:cache:${revNorm}`);
        }
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}
