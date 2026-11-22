/**
 * Hide credentials in a URL before it goes into a report. Many hosted MCP servers take the API key in the
 * query string (https://host/mcp?api_key=...), and the report ends up in CI logs, job summaries and files.
 */

/** Query parameter names whose values are treated as secrets (matched as a substring, case-insensitive). */
const SECRET_PARAM = /key|token|secret|pass|pwd|auth|sig|credential|session/i;
const MASK = '***';

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * The URL with the user name, the password and the values of secret-looking query parameters (api_key, token,
 * access_token, secret, password, auth, signature, session...) replaced by ***. Other parts stay as written.
 * A string that is not a URL is returned unchanged.
 */
export function redactUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.username) u.username = MASK;
  if (u.password) u.password = MASK;
  if (u.search.length > 1) {
    const parts = u.search.slice(1).split('&').map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return part;
      const name = part.slice(0, eq);
      return SECRET_PARAM.test(decodeName(name)) && eq < part.length - 1 ? `${name}=${MASK}` : part;
    });
    u.search = '?' + parts.join('&');
  }
  return u.href;
}
