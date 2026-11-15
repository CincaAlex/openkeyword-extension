# Privacy and permissions

What the extension does with each permission, and what leaves the device. The privacy policy that
covers the extension is at https://openkeyword.org/privacy.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Keeps the random install key, settings, the contribution queue, the sent-batch log and personal stats (`chrome.storage.local`). Keeps the 30-minute repeat filter in memory only (`chrome.storage.session`). |
| `alarms` | One alarm every 5 minutes sends searches that have waited at least 30 minutes (batching plus a random delay). |

## Host permissions (granted at install)

| Host | Why |
|---|---|
| `https://app.openkeyword.org/*` (prod) / `http://localhost/*`, `http://127.0.0.1/*` (dev build only) | The extension's own API: receiving contributions and deleting install data. |

## Optional host permissions (requested only if the user opts in)

`https://www.google.com/*`, `https://www.bing.com/*`, `https://duckduckgo.com/*`,
`https://www.youtube.com/*`, `https://www.amazon.com/*`

- The extension requests these with `chrome.permissions.request` only when the user turns on
  "Share my searches" (popup or welcome page). Sharing is off by default and nothing is read before that.
- It removes them with `chrome.permissions.remove` when the user turns the toggle off. If the user
  revokes them in `chrome://extensions`, the toggle switches off.
- With these hosts granted, `chrome.tabs.onUpdated` reports the URL of tabs on these sites. The
  extension does not request the `tabs` permission, so it never sees URLs of any other site.
- It does not inject content scripts and does not read page content.
- It reads only the search-words parameter (`q`, `search_query` or `k`) of a first-page web
  search: `/search` on Google and Bing, `/` on DuckDuckGo, `/results` on YouTube and `/s` on Amazon.
  It skips:
  - pagination (`start`, `first`, `page`)
  - Google vertical tabs (`tbm`, `udm`) and DuckDuckGo image, video, news, map and shopping tabs
  - a query repeated within 30 minutes
  - incognito tabs (the manifest also sets `"incognito": "not_allowed"`)
- Every captured query runs through the on-device scrubber (`scrubQuery(q, "passive")` in
  `shared/scrub.ts`). It drops URLs, emails, phone numbers, long digit runs, search operators and
  sensitive topics (health, adult, legal, money trouble, people lookups) before anything is queued.

## What leaves the device

- **Contributions** (only after the user turns sharing on): each item contains exactly
  `{ kw, country, lang }`, sent in batches of at most 50, each search at least 30 minutes after it
  happened. No URL, timestamp, engine name or page content is sent. The local queue keeps the time
  and engine only to show them in the popup's waiting list and to decide when to send.
- **Delete my data** (`DELETE /v1/install`): the server queues deletion of this install's
  contribution counter.
  The extension then generates a new random install key and clears the local queue, log and stats.
- **Optional account login** (only if the user opens "Log in"): the email address and the 6-digit
  code go to the login service (Supabase Auth, EU) using its public publishable key. The session is
  kept in `chrome.storage.local`. When logged in, contribution requests also carry the account
  token, so the server adds the number of accepted items to that account. The keywords themselves
  are stored exactly as for anonymous users, with no link to the account. Logging out removes the
  session. No extra permission is needed because the login endpoints allow cross-origin requests.

The install key is 32 random bytes from `crypto.getRandomValues`. The server stores only a keyed
hash of it, never the key itself.

## Code

The extension has no remote code, no `eval` and no minification. The bundled output in `dist/`
maps one to one to `src/` and `shared/`. The CSP is `script-src 'self'; object-src 'self'`.
