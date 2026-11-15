// Thin client for the public API. fetch is injectable for tests.
import type { ContributeItem } from "../../shared/index.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly resetAt?: string,
  ) {
    super(`API ${status} ${code}`);
  }
}

export interface ApiClient {
  contribute(items: ContributeItem[]): Promise<void>;
  deleteInstall(): Promise<void>;
}

async function toError(res: Response): Promise<ApiError> {
  let code = "server";
  let resetAt: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; resetAt?: string };
    if (typeof body.error === "string") code = body.error;
    if (typeof body.resetAt === "string") resetAt = body.resetAt;
  } catch {
    /* empty or non-JSON body */
  }
  return new ApiError(res.status, code, resetAt);
}

export function createApi(
  base: string,
  getInstallKey: () => Promise<string>,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  /** Logged-in account token, or null. Its only effect: the number of shared items is added to the account. */
  getAccessToken: () => Promise<string | null> = async () => null,
): ApiClient {
  const url = (p: string) => base.replace(/\/+$/, "") + p;
  const headers = async (json: boolean): Promise<Record<string, string>> => ({
    "X-Install-Key": await getInstallKey(),
    ...(json ? { "Content-Type": "application/json" } : {}),
  });

  return {
    async contribute(items) {
      const h = await headers(true);
      let token: string | null = null;
      try {
        token = await getAccessToken();
      } catch {
        token = null;
      }
      const send = (withAccount: boolean) =>
        fetchImpl(url("/v1/contribute"), {
          method: "POST",
          headers: withAccount && token ? { ...h, Authorization: `Bearer ${token}` } : h,
          body: JSON.stringify({ items }),
        });
      let res = await send(true);
      // An expired login must never block the contribution itself: resend anonymously.
      if (res.status === 401 && token) res = await send(false);
      // The API answers 202 on success. Anything else is a failure and items stay queued.
      if (res.status !== 202) throw await toError(res);
    },
    async deleteInstall() {
      const res = await fetchImpl(url("/v1/install"), { method: "DELETE", headers: await headers(false) });
      if (!res.ok) throw await toError(res);
    },
  };
}

