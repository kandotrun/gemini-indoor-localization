# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Use [GitHub's private vulnerability reporting](https://github.com/kandotrun/gemini-indoor-localization/security/advisories/new) with a description, reproduction steps, and the affected commit or version.

You should receive an acknowledgement within seven days. Please avoid including API keys, private building media, embedding caches, or other sensitive data in the report.

## Scope

This project sends the media you select to the Gemini endpoint configured by the caller. It does not provide authentication, access control, rate limiting, or long-term storage. Deployments that expose the CLI through another service must add those controls and must protect the manifest, media, cache, and provider credentials.
