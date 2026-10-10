import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, resolve, sep } from "node:path";
import { createAccessEntry, parseAmountToCents } from "./lib/access.mjs";
import {
  addAccessEntry,
  createSession,
  deleteSession,
  getSession,
  loadAccessList,
  loadLedger,
  recordTransaction,
  removeAccessEntry
} from "./lib/store.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(root, "public");
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const configuredPort = Number(process.env.PORT || 3000);
const secureCookie = process.env.NODE_ENV === "production" ? "; Secure" : "";

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function cookieValue(request, name) {
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : "";
}

function setCookie(response, name, value, maxAge) {
  response.setHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie}`);
}

function clearCookie(response, name) {
  setCookie(response, name, "", 0);
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const requestHost = request.headers["x-forwarded-host"] || request.headers.host;
    return new URL(origin).host === requestHost;
  } catch {
    return false;
  }
}

async function readJson(request, maxBytes = 4096) {
  if (request.body !== undefined) {
    const body = typeof request.body === "string" || Buffer.isBuffer(request.body)
      ? request.body.toString()
      : JSON.stringify(request.body);
    if (Buffer.byteLength(body) > maxBytes) throw new Error("Cererea este prea mare.");
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("Datele trimise nu sunt valide.");
    }
  }

  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new Error("Cererea este prea mare.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Datele trimise nu sunt valide.");
  }
}

function isAdminDiscordId(discordId) {
  return (process.env.DISCORD_ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(discordId);
}

async function resolveSessionUser(session) {
  if (!session || session.stage !== "authorized") return undefined;
  const users = await loadAccessList();
  const member = users.find((user) => user.discordId === session.discordId);
  const isAdmin = isAdminDiscordId(session.discordId);
  if (!member && !isAdmin) return undefined;

  const user = member || {
    discordId: session.discordId,
    displayName: session.discordDisplayName,
    callsign: "ADMIN"
  };
  session.user = {
    discordId: user.discordId,
    displayName: user.displayName,
    callsign: user.callsign || "—",
    isAdmin
  };
  return session.user;
}

async function handleApi(request, response, url) {
  const session = await getSession(cookieValue(request, "visterie_session"));
  if (url.pathname === "/api/session" && request.method === "GET") {
    const user = await resolveSessionUser(session);
    if (session && !user) {
      await deleteSession(cookieValue(request, "visterie_session"));
      clearCookie(response, "visterie_session");
    }
    return sendJson(response, 200, user ? { stage: "authorized", user } : { stage: "anonymous" });
  }

  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/logout") {
    const user = await resolveSessionUser(session);
    if (!user) return sendJson(response, 401, { error: "Conectează-te cu un cont Discord autorizat." });

    if (url.pathname.startsWith("/api/admin/")) {
      if (!user.isAdmin) return sendJson(response, 403, { error: "Doar administratorii pot gestiona accesul." });
      if (!isSameOrigin(request) && request.method !== "GET") {
        return sendJson(response, 403, { error: "Cererea nu este permisă." });
      }
      if (url.pathname === "/api/admin/access" && request.method === "GET") {
        const users = await loadAccessList();
        return sendJson(response, 200, { users: users.map(({ discordId, displayName, callsign }) => ({ discordId, displayName, callsign: callsign || "—" })) });
      }
      if (url.pathname === "/api/admin/access" && request.method === "POST") {
        const body = await readJson(request);
        let member;
        try {
          member = createAccessEntry(body);
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }

        const added = await addAccessEntry(member);
        if (!added) return sendJson(response, 409, { error: "Acest ID Discord are deja acces." });
        return sendJson(response, 201, member);
      }
      if (url.pathname === "/api/admin/access" && request.method === "DELETE") {
        const body = await readJson(request);
        const discordId = typeof body?.discordId === "string" ? body.discordId.trim() : "";
        const removed = await removeAccessEntry(discordId);
        if (!removed) return sendJson(response, 404, { error: "ID-ul Discord nu există în lista de acces." });
        return sendJson(response, 200, { ok: true });
      }
      return sendJson(response, 404, { error: "Ruta API nu există." });
    }

    if (url.pathname === "/api/ledger" && request.method === "GET") {
      const ledger = await loadLedger();
      return sendJson(response, 200, ledger);
    }

    if (url.pathname === "/api/transactions" && request.method === "POST") {
      if (!isSameOrigin(request)) return sendJson(response, 403, { error: "Cererea nu este permisă." });
      const body = await readJson(request);
      if (body.type !== "deposit" && body.type !== "withdrawal") {
        return sendJson(response, 400, { error: "Alege adăugare sau retragere." });
      }

      let amountCents;
      try {
        amountCents = parseAmountToCents(body.amount);
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }

      const result = await recordTransaction({
        type: body.type,
        amountCents,
        note: typeof body.note === "string" ? body.note.trim().slice(0, 120) : "",
        user
      });
      if (result.insufficientBalance) {
        return sendJson(response, 400, { error: "Soldul vistieriei nu este suficient pentru această retragere." });
      }
      return sendJson(response, 201, result.ledger);
    }

    return sendJson(response, 404, { error: "Ruta API nu există." });
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: "Cererea nu este permisă." });
    await deleteSession(cookieValue(request, "visterie_session"));
    clearCookie(response, "visterie_session");
    return sendJson(response, 200, { ok: true });
  }

  return sendJson(response, 404, { error: "Ruta API nu există." });
}

async function handleOAuth(request, response, url) {
  const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI } = process.env;
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI) {
    return sendJson(response, 503, { error: "Autentificarea Discord nu este configurată. Completează variabilele DISCORD_* din fișierul .env." });
  }

  if (url.pathname === "/auth/discord" && request.method === "GET") {
    const state = randomBytes(32).toString("hex");
    setCookie(response, "visterie_oauth_state", state, 600);
    const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
    authorizeUrl.search = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: DISCORD_REDIRECT_URI,
      response_type: "code",
      scope: "identify",
      state
    }).toString();
    response.writeHead(302, { Location: authorizeUrl.toString(), "Cache-Control": "no-store" });
    return response.end();
  }

  if (url.pathname === "/auth/discord/callback" && request.method === "GET") {
    const state = url.searchParams.get("state") || "";
    const stateCookie = cookieValue(request, "visterie_oauth_state");
    const expected = Buffer.from(stateCookie);
    const actual = Buffer.from(state);
    const matchingState = expected.length === actual.length && timingSafeEqual(expected, actual);
    clearCookie(response, "visterie_oauth_state");

    if (!matchingState) {
      response.writeHead(302, { Location: "/?error=oauth", "Cache-Control": "no-store" });
      return response.end();
    }
    if (url.searchParams.has("error") || !url.searchParams.has("code")) {
      response.writeHead(302, { Location: "/?error=oauth", "Cache-Control": "no-store" });
      return response.end();
    }

    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: url.searchParams.get("code"),
        redirect_uri: DISCORD_REDIRECT_URI
      })
    });
    if (!tokenResponse.ok) throw new Error("Discord nu a putut valida autentificarea.");
    const token = await tokenResponse.json();
    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (!userResponse.ok) throw new Error("Nu s-au putut prelua datele contului Discord.");
    const discordUser = await userResponse.json();
    if (!/^\d{17,20}$/.test(discordUser.id)) throw new Error("Discord a returnat un ID de utilizator invalid.");

    const allowedUsers = await loadAccessList();
    if (!allowedUsers.some((entry) => entry.discordId === discordUser.id) && !isAdminDiscordId(discordUser.id)) {
      response.writeHead(302, { Location: "/?error=not-allowed", "Cache-Control": "no-store" });
      return response.end();
    }

    const sessionId = randomBytes(32).toString("hex");
    await createSession(sessionId, discordUser.id, discordUser.global_name || discordUser.username);
    setCookie(response, "visterie_session", sessionId, sessionLifetimeMs / 1000);
    response.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
    return response.end();
  }

  return sendJson(response, 404, { error: "Ruta de autentificare nu există." });
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = resolve(publicRoot, requested);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
    response.writeHead(403);
    return response.end("Acces interzis.");
  }
  if (!existsSync(filePath)) {
    response.writeHead(404);
    return response.end("Pagina nu a fost găsită.");
  }

  const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  response.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(await readFile(filePath));
}

export async function handler(request, response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://cdn.discordapp.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/auth/")) {
      url.pathname = url.pathname.slice("/api".length);
    }
    if (process.env.VERCEL && !process.env.DATABASE_URL
      && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/"))) {
      return sendJson(response, 503, {
        error: "Baza de date Neon nu este configurată. Adaugă DATABASE_URL în Environment Variables pe Vercel și redeployează."
      });
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    if (url.pathname.startsWith("/auth/")) return await handleOAuth(request, response, url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      return response.end("Metodă neacceptată.");
    }
    return await serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "A apărut o eroare internă. Verifică jurnalul serverului." });
    } else {
      response.destroy(error);
    }
  }
}

export default handler;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET || !process.env.DISCORD_REDIRECT_URI) {
    console.warn("Configurează variabilele DISCORD_* pentru a activa autentificarea Discord.");
  }
  createServer(handler).listen(configuredPort, () => {
    console.log(`Vistieria rulează la http://localhost:${configuredPort}`);
  });
}
