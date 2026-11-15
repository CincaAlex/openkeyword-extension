import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/lib/api.ts";

const KEY = "a".repeat(64);
const items = [{ kw: "best espresso grinder", country: "us", lang: "en" }];

function recorder(statuses: number[]) {
  const calls: Headers[] = [];
  const f = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers));
    return new Response(null, { status: statuses[calls.length - 1] ?? 202 });
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe("contribute with an optional account", () => {
  it("anonymous: install key only", async () => {
    const { f, calls } = recorder([202]);
    await createApi("http://api.test", async () => KEY, f).contribute(items);
    expect(calls[0]!.get("X-Install-Key")).toBe(KEY);
    expect(calls[0]!.get("Authorization")).toBeNull();
  });

  it("logged in: install key plus the account token", async () => {
    const { f, calls } = recorder([202]);
    await createApi("http://api.test", async () => KEY, f, async () => "tok").contribute(items);
    expect(calls[0]!.get("Authorization")).toBe("Bearer tok");
    expect(calls[0]!.get("X-Install-Key")).toBe(KEY);
  });

  it("an expired login never blocks the contribution: resent anonymously", async () => {
    const { f, calls } = recorder([401, 202]);
    await createApi("http://api.test", async () => KEY, f, async () => "old").contribute(items);
    expect(calls.map((h) => h.get("Authorization"))).toEqual(["Bearer old", null]);
  });

  it("a broken token getter falls back to anonymous", async () => {
    const { f, calls } = recorder([202]);
    await createApi("http://api.test", async () => KEY, f, async () => {
      throw new Error("storage");
    }).contribute(items);
    expect(calls[0]!.get("Authorization")).toBeNull();
  });
});

describe("contribute failures carry the HTTP status", () => {
  it("a 400 rejects with status 400 (the queue then drops the batch)", async () => {
    const { f } = recorder([400]);
    await expect(createApi("http://api.test", async () => KEY, f).contribute(items)).rejects.toMatchObject({ status: 400 });
  });
  it("a 503 rejects with status 503 (the queue keeps the batch and retries)", async () => {
    const { f } = recorder([503]);
    await expect(createApi("http://api.test", async () => KEY, f).contribute(items)).rejects.toMatchObject({ status: 503 });
  });
});
