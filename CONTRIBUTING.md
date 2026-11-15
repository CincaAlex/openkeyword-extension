# Contributing

Bug reports and pull requests are welcome.

## Before you open a pull request

```sh
npm ci
npm run typecheck
npm test
npm run build:prod
```

All four must pass; CI runs the same steps.

## Guidelines

- Keep changes small and focused. One topic per pull request.
- Add or update tests in `test/` for logic changes (queue rules, URL extraction, scrubbing, API client).
- Do not add permissions, remote code, `eval`, analytics or new network requests. Changes that
  widen what the extension reads or sends need a clear reason and will get a careful review.
- User-facing text lives in `src/i18n/`. Add new keys to `en.ts` and every other language;
  TypeScript reports missing keys.
- No minification and no new runtime dependencies: the store build must stay readable and
  comparable with this source.

For security issues, do not open a public issue. See [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the Apache License 2.0.
