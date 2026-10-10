import { randomBytes, createHash } from "node:crypto";
import { copyFile, readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { neon } from "@neondatabase/serverless";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = resolve(process.env.DATA_DIR || root);
const accessPath = resolve(dataDirectory, "Acces.json");
const accessTemplatePath = resolve(root, "Acces.example.json");
const ledgerDirectory = process.env.DATA_DIR ? dataDirectory : resolve(root, "data");
const ledgerPath = resolve(ledgerDirectory, "visterie.json");
const ledgerTemplatePath = resolve(root, "data", "visterie.example.json");
const sessions = new Map();
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
let accessWriteQueue = Promise.resolve();
let ledgerWriteQueue = Promise.resolve();
let sqlClient;
let schemaReady;

function db() {
  if (!process.env.DATABASE_URL) {
    if (process.env.VERCEL) throw new Error("Configurează DATABASE_URL cu URL-ul bazei de date Neon în setările Vercel.");
    return undefined;
  }
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

async function ensureSchema(sql) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS visterie_state (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0)
      )`;
      await sql`CREATE TABLE IF NOT EXISTS visterie_transactions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal')),
        amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
        balance_cents BIGINT NOT NULL CHECK (balance_cents >= 0),
        note TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL,
        callsign TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS visterie_transactions_created_at_idx
        ON visterie_transactions (created_at DESC)`;
      await sql`CREATE TABLE IF NOT EXISTS visterie_users (
        discord_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        callsign TEXT NOT NULL
      )`;
      await sql`CREATE TABLE IF NOT EXISTS visterie_sessions (
        token_hash TEXT PRIMARY KEY,
        discord_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )`;
      await sql`CREATE INDEX IF NOT EXISTS visterie_sessions_expires_at_idx
        ON visterie_sessions (expires_at)`;
      await sql`INSERT INTO visterie_state (singleton, balance_cents)
        VALUES (TRUE, 0) ON CONFLICT (singleton) DO NOTHING`;
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  await schemaReady;
}

function sessionHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function ensureLocalFiles() {
  if (process.env.VERCEL) throw new Error("Vercel necesită DATABASE_URL; fișierele locale nu oferă stocare persistentă.");
  await mkdir(dataDirectory, { recursive: true });
  if (!existsSync(accessPath)) await copyFile(accessTemplatePath, accessPath);
  await mkdir(ledgerDirectory, { recursive: true });
  if (!existsSync(ledgerPath)) await copyFile(ledgerTemplatePath, ledgerPath);
}

async function readLocalAccessList() {
  await ensureLocalFiles();
  const contents = JSON.parse(await readFile(accessPath, "utf8"));
  if (!Array.isArray(contents.users)) throw new Error("Acces.json nu conține lista «users».");
  return contents.users;
}

async function writeLocalAccessList(contents) {
  const temporaryPath = `${accessPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, accessPath);
}

async function readLocalLedger() {
  await ensureLocalFiles();
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  if (!Number.isSafeInteger(ledger.balanceCents) || !Array.isArray(ledger.transactions)) {
    throw new Error("Fișierul de registru al vistieriei nu are un format valid.");
  }
  return ledger;
}

async function writeLocalLedger(ledger) {
  const temporaryPath = `${ledgerPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, ledgerPath);
}

export async function loadAccessList() {
  const sql = db();
  if (!sql) return readLocalAccessList();
  await ensureSchema(sql);
  const users = await sql`SELECT discord_id AS "discordId", display_name AS "displayName", callsign
    FROM visterie_users ORDER BY display_name`;
  return users;
}

export async function addAccessEntry(member) {
  const sql = db();
  if (sql) {
    await ensureSchema(sql);
    const inserted = await sql`INSERT INTO visterie_users (discord_id, display_name, callsign)
      VALUES (${member.discordId}, ${member.displayName}, ${member.callsign})
      ON CONFLICT (discord_id) DO NOTHING RETURNING discord_id`;
    return inserted.length > 0;
  }

  const result = accessWriteQueue.then(async () => {
    const contents = { users: await readLocalAccessList() };
    if (contents.users.some((user) => user.discordId === member.discordId)) return false;
    contents.users.push(member);
    await writeLocalAccessList(contents);
    return true;
  });
  accessWriteQueue = result.catch(() => {});
  return result;
}

export async function removeAccessEntry(discordId) {
  const sql = db();
  if (sql) {
    await ensureSchema(sql);
    const removed = await sql`DELETE FROM visterie_users WHERE discord_id = ${discordId}
      RETURNING discord_id`;
    return removed.length > 0;
  }

  const result = accessWriteQueue.then(async () => {
    const contents = { users: await readLocalAccessList() };
    const index = contents.users.findIndex((user) => user.discordId === discordId);
    if (index === -1) return false;
    contents.users.splice(index, 1);
    await writeLocalAccessList(contents);
    return true;
  });
  accessWriteQueue = result.catch(() => {});
  return result;
}

export async function loadLedger() {
  const sql = db();
  if (!sql) return readLocalLedger();
  await ensureSchema(sql);
  const [state] = await sql`SELECT balance_cents AS "balanceCents"
    FROM visterie_state WHERE singleton = TRUE`;
  const transactions = await sql`SELECT id, type, amount_cents AS "amountCents",
      balance_cents AS "balanceCents", note, actor, callsign, discord_id AS "discordId",
      created_at AS "createdAt"
    FROM visterie_transactions ORDER BY created_at DESC, id DESC LIMIT 500`;
  return {
    balanceCents: Number(state.balanceCents),
    transactions: transactions.map((transaction) => ({
      ...transaction,
      amountCents: Number(transaction.amountCents),
      balanceCents: Number(transaction.balanceCents),
      createdAt: new Date(transaction.createdAt).toISOString()
    }))
  };
}

export async function recordTransaction({ type, amountCents, note, user }) {
  const sql = db();
  if (sql) {
    await ensureSchema(sql);
    const delta = type === "deposit" ? amountCents : -amountCents;
    const id = randomBytes(12).toString("hex");
    const updated = await sql`
      WITH balance AS (
        UPDATE visterie_state
        SET balance_cents = balance_cents + ${delta}
        WHERE singleton = TRUE AND balance_cents + ${delta} >= 0
        RETURNING balance_cents
      ), inserted AS (
        INSERT INTO visterie_transactions
          (id, type, amount_cents, balance_cents, note, actor, callsign, discord_id)
        SELECT ${id}, ${type}, ${amountCents}, balance.balance_cents, ${note},
          ${user.displayName}, ${user.callsign}, ${user.discordId}
        FROM balance
        RETURNING id
      )
      SELECT balance_cents AS "balanceCents" FROM balance`;
    if (updated.length === 0) return { insufficientBalance: true };
    return { ledger: await loadLedger() };
  }

  const result = ledgerWriteQueue.then(async () => {
    const ledger = await readLocalLedger();
    if (type === "withdrawal" && amountCents > ledger.balanceCents) return { insufficientBalance: true };

    ledger.balanceCents += type === "deposit" ? amountCents : -amountCents;
    ledger.transactions.unshift({
      id: randomBytes(12).toString("hex"),
      type,
      amountCents,
      balanceCents: ledger.balanceCents,
      note,
      actor: user.displayName,
      callsign: user.callsign,
      discordId: user.discordId,
      createdAt: new Date().toISOString()
    });
    ledger.transactions = ledger.transactions.slice(0, 500);
    await writeLocalLedger(ledger);
    return { ledger };
  });
  ledgerWriteQueue = result.catch(() => {});
  return result;
}

export async function createSession(token, discordId, displayName) {
  const expiresAt = new Date(Date.now() + sessionLifetimeMs);
  const sql = db();
  if (sql) {
    await ensureSchema(sql);
    await sql`INSERT INTO visterie_sessions (token_hash, discord_id, display_name, expires_at)
      VALUES (${sessionHash(token)}, ${discordId}, ${displayName}, ${expiresAt.toISOString()})`;
    return;
  }
  await ensureLocalFiles();
  sessions.set(token, { discordId, discordDisplayName: displayName, stage: "authorized", expiresAt: expiresAt.getTime() });
}

export async function getSession(token) {
  if (!token) return undefined;
  const sql = db();
  if (sql) {
    await ensureSchema(sql);
    const [session] = await sql`UPDATE visterie_sessions
      SET expires_at = NOW() + INTERVAL '7 days'
      WHERE token_hash = ${sessionHash(token)} AND expires_at > NOW()
      RETURNING discord_id AS "discordId", display_name AS "discordDisplayName"`;
    return session ? { ...session, stage: "authorized" } : undefined;
  }
  await ensureLocalFiles();
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(token);
    return undefined;
  }
  session.expiresAt = Date.now() + sessionLifetimeMs;
  return session;
}

export async function deleteSession(token) {
  if (!token) return;
  const sql = db();
  if (sql) {
    await ensureSchema(sql);
    await sql`DELETE FROM visterie_sessions WHERE token_hash = ${sessionHash(token)}`;
    return;
  }
  sessions.delete(token);
}
