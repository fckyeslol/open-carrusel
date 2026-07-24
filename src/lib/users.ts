/**
 * Usuarias del modo hosteado (data/users.json, vía data.ts: mutex + escritura
 * atómica). Cada usuaria tiene su contraseña (hasheada con scrypt) y,
 * opcionalmente, su token de Claude (`claude setup-token`) cifrado en reposo.
 *
 * Altas: por CLI en el server (`node scripts/users.mjs add <usuario>`) — no hay
 * registro público.
 */
import { randomUUID } from "crypto";
import { readDataSafe, updateData } from "./data";
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from "./token-crypto";

const USERS_FILE = "users.json";

export interface User {
  id: string;
  /** Identificador de login, minúsculas, sin espacios. */
  username: string;
  displayName: string;
  passwordHash: string;
  /** CLAUDE_CODE_OAUTH_TOKEN cifrado (AES-256-GCM). Ausente hasta que lo pegue. */
  claudeTokenEnc?: string;
  /** true tras un alta o reseteo por CLI: la UI fuerza cambio de contraseña. */
  mustChangePassword?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface UsersFile {
  users: User[];
}

const EMPTY: UsersFile = { users: [] };

/** Vista segura para la UI: sin hash ni token cifrado. */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  hasClaudeToken: boolean;
  mustChangePassword: boolean;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    hasClaudeToken: Boolean(user.claudeTokenEnc),
    mustChangePassword: Boolean(user.mustChangePassword),
  };
}

export async function listUsers(): Promise<User[]> {
  return (await readDataSafe<UsersFile>(USERS_FILE, EMPTY)).users;
}

export async function getUserById(id: string): Promise<User | null> {
  return (await listUsers()).find((u) => u.id === id) ?? null;
}

export async function getUserByUsername(username: string): Promise<User | null> {
  const normalized = username.trim().toLowerCase();
  return (await listUsers()).find((u) => u.username === normalized) ?? null;
}

/** Valida credenciales; null si usuario inexistente o contraseña incorrecta. */
export async function authenticate(username: string, password: string): Promise<User | null> {
  const user = await getUserByUsername(username);
  if (!user) return null;
  return verifyPassword(password, user.passwordHash) ? user : null;
}

export async function createUser(input: {
  username: string;
  displayName: string;
  password: string;
}): Promise<User> {
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
    throw new Error("Usuario inválido: solo minúsculas, números, punto, guion (2-32 chars)");
  }
  const now = new Date().toISOString();
  const user: User = {
    id: randomUUID(),
    username,
    displayName: input.displayName.trim() || username,
    passwordHash: hashPassword(input.password),
    mustChangePassword: true,
    createdAt: now,
    updatedAt: now,
  };
  await updateData<UsersFile>(USERS_FILE, EMPTY, (current) => {
    if (current.users.some((u) => u.username === username)) {
      throw new Error(`Ya existe la usuaria "${username}"`);
    }
    return { users: [...current.users, user] };
  });
  return user;
}

async function patchUser(id: string, patch: (user: User) => User): Promise<User> {
  let updated: User | null = null;
  await updateData<UsersFile>(USERS_FILE, EMPTY, (current) => {
    const users = current.users.map((u) => {
      if (u.id !== id) return u;
      updated = patch({ ...u, updatedAt: new Date().toISOString() });
      return updated;
    });
    return { users };
  });
  if (!updated) throw new Error("Usuaria no encontrada");
  return updated;
}

export async function setClaudeToken(id: string, token: string): Promise<User> {
  const trimmed = token.trim();
  // Los tokens de `claude setup-token` son OAuth largos; un pegado truncado es
  // el error más común — mejor rechazarlo acá que fallar en el spawn.
  if (trimmed.length < 40) {
    throw new Error("Ese token parece incompleto — pegá el token completo de `claude setup-token`");
  }
  if (/\s/.test(trimmed)) {
    throw new Error("El token no puede contener espacios ni saltos de línea");
  }
  return patchUser(id, (u) => ({ ...u, claudeTokenEnc: encryptSecret(trimmed) }));
}

export async function clearClaudeToken(id: string): Promise<User> {
  return patchUser(id, (u) => {
    const next = { ...u };
    delete next.claudeTokenEnc;
    return next;
  });
}

/** Descifra el token de Claude de la usuaria. null si aún no lo configuró. */
export async function getClaudeToken(id: string): Promise<string | null> {
  const user = await getUserById(id);
  if (!user?.claudeTokenEnc) return null;
  return decryptSecret(user.claudeTokenEnc);
}

export async function changePassword(id: string, current: string, next: string): Promise<User> {
  const user = await getUserById(id);
  if (!user) throw new Error("Usuaria no encontrada");
  if (!verifyPassword(current, user.passwordHash)) {
    throw new Error("La contraseña actual no es correcta");
  }
  if (next.length < 8) {
    throw new Error("La contraseña nueva debe tener al menos 8 caracteres");
  }
  return patchUser(id, (u) => ({
    ...u,
    passwordHash: hashPassword(next),
    mustChangePassword: false,
  }));
}
