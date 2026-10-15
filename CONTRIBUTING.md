# Contributing to kcg-civic-mcp-worker

Thank you for contributing to the Kaohsiung Civic MCP project.

This repository provides open-source infrastructure for turning public-sector information into structured, source-verifiable MCP tools. Contributions should preserve source provenance, reproducibility, and safe handling of credentials.

## Development setup

```bash
git clone https://github.com/Hong1998tw/kcg-civic-mcp-worker.git
cd kcg-civic-mcp-worker
npm ci
cp .dev.vars.example .dev.vars
npm run typecheck
npm test
npm run dev
```

Never commit real credentials, access tokens, OAuth secrets, Cloudflare secrets, or private user data.

## Before opening a pull request

Please make sure the change:

- solves a clearly described problem;
- uses first-party or otherwise authoritative public-sector sources where possible;
- documents the canonical source URL and responsible agency for new data integrations;
- preserves source provenance and does not silently replace authoritative data with generated or inferred content;
- handles pagination, multi-tab interfaces, missing data, and source limitations explicitly;
- includes or updates tests when behavior changes;
- passes `npm test`;
- does not expose credentials or sensitive information.

## Adding or changing a data source

For a new source adapter or significant source change, document at least:

1. source agency or institution;
2. canonical URL or API endpoint;
3. data format and retrieval method;
4. update cadence if known;
5. pagination, tab, archive, or document-boundary behavior;
6. provenance and integrity checks;
7. known limitations and failure modes.

Prefer official government APIs, official websites, official document repositories, and primary records. Secondary sources may be useful for discovery but should not silently replace the canonical source.

## Data integrity and provenance

Where a workflow uses immutable manifests, hashes, validation gates, release snapshots, or other integrity controls, contributions must preserve those controls.

A tool should fail explicitly when a trusted source or validated snapshot is unavailable rather than fabricate, infer, or silently substitute data.

## Pull request guidance

A useful PR description should include:

- what changed;
- why the change is needed;
- which official source or interface is affected;
- how the change was tested;
- any known compatibility, deployment, or migration risk.

Keep unrelated changes out of the same PR when possible.

## Security-sensitive changes

Changes involving OAuth, PKCE, redirect URI validation, access or refresh tokens, authentication, authorization, Durable Objects, secrets, or credential storage deserve additional review and regression testing.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue with exploit details.

## License

By submitting a contribution, you agree that your contribution will be licensed under the repository's [Apache License 2.0](LICENSE), unless explicitly stated otherwise for material that is subject to a separate upstream license.

Public-sector data accessed by this project remains subject to the terms, licenses, attribution requirements, and usage conditions of its original sources.
