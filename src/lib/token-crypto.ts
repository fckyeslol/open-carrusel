/**
 * Criptografía del modo hosteado, todo derivado de UN secreto raíz (AUTH_SECRET):
 *
 *   - HKDF "session-sign"  → clave HMAC-SHA256 para firmar cookies de sesión
 *   - HKDF "claude-token"  → clave AES-256-GCM para cifrar el CLAUDE_CODE_OAUTH_TOKEN
 *                            de cada usuaria en reposo (data/users.json)
 *   - scrypt               → hash de contraseñas (nunca se guarda la contraseña)
 *
 * El token de Claude de una usuaria da acceso a su cuenta: NUNCA se guarda ni se
 * loggea en texto plano. Solo se descifra en memoria al momento del spawn.
 */
import {
  hkdfSync,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "crypto";
import { getAuthSecret } from "./hosted";

const HKDF_SALT = "open-carrusel-hosted-v1";
const AES_ALGO = "aes-256-gcm";
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function deriveKey(info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", getAuthSecret(), HKDF_SALT, info, 32));
}

// ---------------------------------------------------------------------------
// Firma de sesión (HMAC-SHA256)
// ---------------------------------------------------------------------------

export function signSession(payload: string): string {
  return createHmac("sha256", deriveKey("session-sign")).update(payload).digest("base64url");
}

export function verifySessionSignature(payload: string, signature: string): boolean {
  const expected = signSession(payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Cifrado de tokens de Claude en reposo (AES-256-GCM)
// ---------------------------------------------------------------------------

/** Formato serializado: v1.<iv b64url>.<authTag b64url>.<ciphertext b64url> */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGO, deriveKey("claude-token"), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptSecret(serialized: string): string {
  const parts = serialized.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Token cifrado con formato desconocido");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(AES_ALGO, deriveKey("claude-token"), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Contraseñas (scrypt)
// ---------------------------------------------------------------------------

/** Formato serializado: scrypt.<salt b64url>.<hash b64url> */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt.${salt.toString("base64url")}.${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, serialized: string): boolean {
  const parts = serialized.split(".");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "base64url");
  const expected = Buffer.from(parts[2], "base64url");
  const actual = scryptSync(password, salt, expected.length, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return timingSafeEqual(actual, expected);
}
