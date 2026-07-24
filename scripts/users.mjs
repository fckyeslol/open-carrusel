#!/usr/bin/env node
/**
 * Gestión de usuarias del modo hosteado — se corre EN el server:
 *
 *   node scripts/users.mjs add <usuario> [--nombre "Nombre Visible"]
 *   node scripts/users.mjs list
 *   node scripts/users.mjs reset <usuario>     (nueva contraseña temporal)
 *   node scripts/users.mjs remove <usuario>
 *
 * El alta imprime una contraseña temporal de un solo uso: la usuaria entra con
 * ella y la app la obliga a cambiarla. El hash usa el MISMO formato scrypt que
 * src/lib/token-crypto.ts (scrypt.<salt>.<hash> en base64url).
 */
import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { randomBytes, randomUUID, scryptSync } from "crypto";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const USERS_PATH = path.join(DATA_DIR, "users.json");

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt.${salt.toString("base64url")}.${hash.toString("base64url")}`;
}

/** Contraseña temporal legible: 3 bloques de 4 (sin caracteres ambiguos). */
function tempPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const pick = () =>
    Array.from(randomBytes(4), (b) => alphabet[b % alphabet.length]).join("");
  return `${pick()}-${pick()}-${pick()}`;
}

async function loadUsers() {
  try {
    const raw = await readFile(USERS_PATH, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data?.users) ? data.users : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw new Error(`No se pudo leer ${USERS_PATH}: ${err.message}`);
  }
}

async function saveUsers(users) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${USERS_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ users }, null, 2), "utf-8");
  await rename(tmp, USERS_PATH);
}

function usage(mensaje) {
  if (mensaje) console.error(`\n${mensaje}`);
  console.error(`
Uso:
  node scripts/users.mjs add <usuario> [--nombre "Nombre Visible"]
  node scripts/users.mjs list
  node scripts/users.mjs reset <usuario>
  node scripts/users.mjs remove <usuario>
`);
  process.exit(1);
}

const [, , comando, usuarioArg] = process.argv;
const nombreIdx = process.argv.indexOf("--nombre");
const nombre = nombreIdx > -1 ? process.argv[nombreIdx + 1] : null;

const username = usuarioArg?.trim().toLowerCase();

switch (comando) {
  case "add": {
    if (!username) usage("Falta el usuario.");
    if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
      usage("Usuario inválido: solo minúsculas, números, punto, guion (2-32 chars).");
    }
    const users = await loadUsers();
    if (users.some((u) => u.username === username)) {
      usage(`Ya existe la usuaria "${username}". Usá reset para darle contraseña nueva.`);
    }
    const password = tempPassword();
    const now = new Date().toISOString();
    users.push({
      id: randomUUID(),
      username,
      displayName: nombre || username,
      passwordHash: hashPassword(password),
      mustChangePassword: true,
      createdAt: now,
      updatedAt: now,
    });
    await saveUsers(users);
    console.log(`\n✓ Usuaria creada: ${username}`);
    console.log(`\n  Contraseña temporal: ${password}`);
    console.log(`\n  Pasásela por un canal seguro — la app la obliga a cambiarla al entrar.`);
    console.log(`  Después, en "Mi cuenta", pega su token de \`claude setup-token\`.\n`);
    break;
  }
  case "list": {
    const users = await loadUsers();
    if (!users.length) {
      console.log("Sin usuarias. Creá la primera con: node scripts/users.mjs add <usuario>");
      break;
    }
    for (const u of users) {
      const token = u.claudeTokenEnc ? "claude ✓" : "claude ✗";
      const pass = u.mustChangePassword ? "pass temporal" : "pass propia";
      console.log(`  ${u.username.padEnd(20)} ${u.displayName.padEnd(24)} ${token}  ${pass}`);
    }
    break;
  }
  case "reset": {
    if (!username) usage("Falta el usuario.");
    const users = await loadUsers();
    const user = users.find((u) => u.username === username);
    if (!user) usage(`No existe la usuaria "${username}".`);
    const password = tempPassword();
    user.passwordHash = hashPassword(password);
    user.mustChangePassword = true;
    user.updatedAt = new Date().toISOString();
    await saveUsers(users);
    console.log(`\n✓ Contraseña reseteada para ${username}`);
    console.log(`\n  Contraseña temporal: ${password}\n`);
    break;
  }
  case "remove": {
    if (!username) usage("Falta el usuario.");
    const users = await loadUsers();
    if (!users.some((u) => u.username === username)) {
      usage(`No existe la usuaria "${username}".`);
    }
    await saveUsers(users.filter((u) => u.username !== username));
    console.log(`✓ Usuaria eliminada: ${username}`);
    break;
  }
  default:
    usage(comando ? `Comando desconocido: ${comando}` : undefined);
}
