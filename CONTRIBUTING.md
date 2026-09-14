# Contributing

Thank you for improving Gemini Indoor Localization.

## Before opening a pull request

- Keep the package focused on reference-based indoor visual localization.
- Do not add real building media, embeddings, API keys, or private evaluation captures.
- Add or update focused tests for behavior changes.
- Run `npm test` and `npm run check` locally.
- Describe provider assumptions and accuracy implications in the pull request.

## Code style

The project uses native ECMAScript modules and Node.js built-ins. Prefer small, explicit functions and keep provider-specific behavior behind the embedding provider boundary. Error states should remain distinguishable from low-confidence matches.

## Commit and pull request messages

Use a concise imperative subject, for example:

```text
Add JSONL support for holdout manifests
```

Explain what changed, how it was tested, and any limitations that affect localization accuracy or privacy.
