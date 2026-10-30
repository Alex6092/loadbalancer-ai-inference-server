import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHmac,
} from 'node:crypto';
import { promisify } from 'node:util';
import ipaddr from 'ipaddr.js';

const scrypt = promisify(scryptCallback);
export const opaque = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const json = (value) => JSON.stringify(value);
export const parse = (value, fallback = null) => (value == null ? fallback : JSON.parse(value));

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.statusCode = status;
    this.code = code;
    this.details = details;
  }
}

export function encrypt(value, key) {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decrypt(value, key) {
  if (!value) return '';
  const data = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
}

export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new ApiError(400, 'invalid_password', 'Le mot de passe doit contenir entre 12 et 256 caractères.');
  }
  const salt = opaque(16);
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}

export async function passwordMatches(password, stored) {
  const [salt, expected] = stored.split(':');
  const actual = await scrypt(String(password).slice(0, 256), salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

export function ipAllowed(ip, networks) {
  if (!networks.length) return true;
  try {
    const address = ipaddr.process(ip);
    return networks.some((network) => {
      const [net, prefix] = network.includes('/')
        ? ipaddr.parseCIDR(network)
        : [ipaddr.process(network), ipaddr.process(network).kind() === 'ipv4' ? 32 : 128];
      return address.kind() === net.kind() && address.match(net, prefix);
    });
  } catch {
    return false;
  }
}

export function validNetworks(networks) {
  return (
    Array.isArray(networks) &&
    networks.every((n) => {
      if (typeof n !== 'string') return false;
      try {
        n.includes('/') ? ipaddr.parseCIDR(n) : ipaddr.parse(n);
        return true;
      } catch {
        return false;
      }
    })
  );
}

export function httpUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error();
    return url;
  } catch {
    throw new ApiError(400, 'invalid_url', 'URL HTTP(S) sans identifiants ni fragment requise.');
  }
}

export function callbackAllowed(value, bases) {
  const url = httpUrl(value);
  return bases.some((base) => {
    const allowed = httpUrl(base);
    const prefix = allowed.pathname.replace(/\/$/, '');
    return (
      url.origin === allowed.origin && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
    );
  });
}

export function signature(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
