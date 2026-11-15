// Minimal Supabase Auth client for the 6-digit email code login, shared by the website and the
// extension. Talks to Supabase's documented Auth REST endpoints with the publishable key only.
// Storage and fetch are injected, so it works in a page (localStorage) and in an extension
// (chrome.storage), and in tests.

export const SUPABASE_URL = "https://lseqeedqntgwiwgnreqq.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_YgyJueWTVyZOV2e5TsspXA_xfNjeWr4";

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
  userId: string;
  email: string;
}

export interface SessionStore {
  get(): Promise<AuthSession | null>;
  set(s: AuthSession | null): Promise<void>;
}

export class AuthError extends Error {
  constructor(
    readonly code: "invalid_code" | "rate_limited" | "invalid_email" | "network" | "signed_out" | "server",
    message?: string,
  ) {
    super(message ?? code);
  }
}

interface Opts {
  store: SessionStore;
  fetch?: typeof fetch;
  url?: string;
  key?: string;
  now?: () => number;
  /**
   * Runs `fn` while holding a lock shared by every page and worker of the same origin, so two tabs (or the
   * extension popup and its background worker) never spend the same single-use refresh token at once.
   * Defaults to the Web Locks API when present.
   */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const LOCK_NAME = "openkeyword-auth-refresh";

function defaultLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: { request: (n: string, f: () => Promise<T>) => Promise<T> } } }).navigator?.locks;
  return locks ? locks.request(LOCK_NAME, fn) : fn();
}

/** Refresh answers that mean the session is really over. Anything else keeps it and tries again later. */
const SESSION_GONE = /refresh_token_not_found|refresh_token_already_used|session_not_found|session_expired|user_not_found|user_banned/;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE_RE = /^\d{6,10}$/;

export function createAuthClient(opts: Opts) {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = (opts.url ?? SUPABASE_URL).replace(/\/+$/, "") + "/auth/v1";
  const key = opts.key ?? SUPABASE_PUBLISHABLE_KEY;
  const nowSec = () => Math.floor((opts.now ?? Date.now)() / 1000);
  const lock = opts.lock ?? defaultLock;
  let refreshing: Promise<AuthSession | null> | null = null;

  async function post(path: string, body: unknown, bearer?: string): Promise<Response> {
    try {
      return await doFetch(`${base}${path}`, {
        method: "POST",
        headers: { apikey: key, "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      throw new AuthError("network");
    }
  }

  function toSession(d: Record<string, unknown>): AuthSession {
    const user = (d.user ?? {}) as { id?: string; email?: string };
    const expiresAt = typeof d.expires_at === "number" ? d.expires_at : nowSec() + Number(d.expires_in ?? 3600);
    if (typeof d.access_token !== "string" || typeof d.refresh_token !== "string" || !user.id) throw new AuthError("server");
    return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt, userId: user.id, email: user.email ?? "" };
  }

  async function fail(res: Response): Promise<never> {
    if (res.status === 429) throw new AuthError("rate_limited");
    let msg = "";
    try {
      const b = (await res.json()) as { msg?: string; error_description?: string; error_code?: string };
      msg = `${b.error_code ?? ""} ${b.msg ?? b.error_description ?? ""}`.trim();
    } catch {
      /* not JSON */
    }
    if (res.status === 403 || /otp_expired|invalid|expired/i.test(msg)) throw new AuthError("invalid_code", msg);
    throw new AuthError("server", msg || `status ${res.status}`);
  }

  return {
    /** Sends a 6-digit login code by email. Creates the account on first use. */
    async sendCode(email: string): Promise<void> {
      const e = email.trim().toLowerCase();
      if (!EMAIL_RE.test(e) || e.length > 254) throw new AuthError("invalid_email");
      const res = await post("/otp", { email: e, create_user: true });
      if (!res.ok) await fail(res);
    },

    /** Checks the code from the email and stores the session. */
    async verifyCode(email: string, code: string): Promise<AuthSession> {
      const c = code.replace(/\s+/g, "");
      if (!CODE_RE.test(c)) throw new AuthError("invalid_code");
      const res = await post("/verify", { type: "email", email: email.trim().toLowerCase(), token: c });
      if (!res.ok) await fail(res);
      const s = toSession((await res.json()) as Record<string, unknown>);
      await opts.store.set(s);
      return s;
    },

    /** Current session, refreshed when it expires within a minute. Null when signed out. */
    async getSession(): Promise<AuthSession | null> {
      const s = await opts.store.get();
      if (!s) return null;
      if (s.expiresAt - nowSec() > 60) return s;
      if (!refreshing) {
        refreshing = lock(async () => {
          // Another tab or context may have refreshed while we waited for the lock.
          const cur = await opts.store.get();
          if (!cur) return null;
          if (cur.refreshToken !== s.refreshToken || cur.expiresAt - nowSec() > 60) return cur;
          try {
            const res = await post("/token?grant_type=refresh_token", { refresh_token: cur.refreshToken });
            if (res.ok) {
              const next = toSession((await res.json()) as Record<string, unknown>);
              await opts.store.set(next);
              return next;
            }
            let code = "";
            try {
              const b = (await res.json()) as { error_code?: string; msg?: string; error_description?: string };
              code = `${b.error_code ?? ""} ${b.msg ?? b.error_description ?? ""}`.toLowerCase();
            } catch {
              /* not JSON */
            }
            const gone = (res.status === 400 || res.status === 401 || res.status === 403) && (SESSION_GONE.test(code) || /invalid refresh token/.test(code));
            if (!gone) return cur; // rate limit, outage or unknown answer: keep the session, try again next time
            const latest = await opts.store.get();
            if (latest && latest.refreshToken !== cur.refreshToken) return latest; // someone else already rotated it
            await opts.store.set(null);
            return null;
          } catch {
            return cur; // offline: keep it
          }
        }).finally(() => {
          refreshing = null;
        });
      }
      return refreshing;
    },
    /** Access token for the API, or null when signed out. */
    async accessToken(): Promise<string | null> {
      return (await this.getSession())?.accessToken ?? null;
    },

    /** Forces a refresh (after the API answered 401). */
    async refreshNow(): Promise<string | null> {
      const s = await opts.store.get();
      if (!s) return null;
      await opts.store.set({ ...s, expiresAt: 0 });
      return this.accessToken();
    },

    async signOut(): Promise<void> {
      const s = await opts.store.get();
      await opts.store.set(null);
      if (s) await post("/logout?scope=local", {}, s.accessToken).catch(() => undefined);
    },
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
