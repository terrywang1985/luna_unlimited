import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isPublicIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

export function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version !== 6) return false;
  const lower = address.toLocaleLowerCase();
  if (lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(lower)) return false;
  if (lower.startsWith("::ffff:")) return isPublicIpv4(lower.slice(7));
  const first = Number.parseInt(lower.split(":", 1)[0], 16);
  return Number.isInteger(first) && first >= 0x2000 && first <= 0x3fff
    && !lower.startsWith("2001:db8:");
}

export async function resolvePublicAddresses(hostname, lookupFn = lookup) {
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookupFn(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) return [];
  return addresses;
}
