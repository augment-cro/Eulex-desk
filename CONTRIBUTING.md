# Contributing to Eulex Desk

Thank you for your interest in contributing to Eulex Desk!

## License

Eulex Desk is licensed under the [GNU Affero General Public License v3.0](LICENSE)
(AGPL-3.0-only). By submitting a contribution you agree that your contribution
will be released under the same license.

## Developer Certificate of Origin

All contributions must be signed off with a **Developer Certificate of Origin**
(DCO). Add a `Signed-off-by` line to every commit message:

```
git commit -s -m "your commit message"
```

This certifies that you wrote the patch or otherwise have the right to pass it
on as an open-source contribution under the AGPL-3.0 license, per
<https://developercertificate.org/>.

## Getting started

1. Fork the repository.
2. Create a feature or fix branch from `main`.
3. Follow the [local development instructions](README.md#local-development) to
   set up your environment.
4. Write your changes, keeping commits focused and well-described.
5. Open a pull request against `main` with a clear description of what the PR
   does and why.

## Code style

- **Backend** (TypeScript/Node): formatted with Prettier (`npm run format` inside
  `backend/`).
- **Frontend** (Next.js/TypeScript): linted with ESLint
  (`npm run lint --prefix frontend`).
- Keep pull requests narrowly scoped — one feature or fix per PR makes review
  easier and faster.

## Reporting issues

Please file bug reports and feature requests as GitHub Issues. Include:

- A short, descriptive title.
- Steps to reproduce (for bugs).
- Expected vs. actual behaviour.
- Relevant log output or screenshots.

## Security

For security vulnerabilities, **do not open a public issue**. Instead, contact
the maintainers directly via the email listed in the repository profile.
