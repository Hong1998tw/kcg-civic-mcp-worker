# Kaohsiung Civic MCP

Open-source MCP infrastructure providing structured, source-verifiable access to Kaohsiung municipal laws, budgets, council records, news, and public datasets.

> 高雄市公民資料 MCP：將分散於政府網站、議會系統、公開資料與文件中的資訊，整理成可由 Claude、ChatGPT 與其他 MCP-compatible clients 使用的結構化工具，並優先保留來源、完整性與可驗證性。

- **Repository:** `Hong1998tw/kcg-civic-mcp-worker`
- **Current version:** `1.1.1`
- **Runtime:** Cloudflare Workers + R2 + SQLite Durable Object
- **Production service:** <https://kcg-civic-mcp-worker.lihong.workers.dev>
- **MCP endpoint:** <https://kcg-civic-mcp-worker.lihong.workers.dev/mcp>
- **License:** [Apache License 2.0](LICENSE)

## Why this project exists

Useful Kaohsiung public-sector information is spread across multiple government websites, council interfaces, open-data systems, APIs, HTML pages, PDFs, tabs, pagination models, and archives. A conventional search or scraper is often insufficient when an application needs to know **where a fact came from, whether the source is complete, and whether the retrieved content is the validated version**.

This project provides a reusable MCP layer over those fragmented sources.

```text
Official public-sector sources
            │
            ▼
    Fetch / source adapters
            │
            ▼
 Parser / normalization / identity checks
            │
            ▼
 Integrity validation / trusted releases
            │
            ▼
         MCP tools
            │
      ┌─────┴─────┐
      ▼           ▼
   Claude      ChatGPT
      │           │
      └──── other MCP clients
```

The goal is not to generate authoritative government facts. The goal is to make authoritative public sources easier for software and AI systems to retrieve, verify, and use without hiding source limitations.

## What it covers

The current MCP tools focus on:

- Kaohsiung municipal budgets;
- municipal laws and regulations;
- municipal news and public information;
- Kaohsiung City Council data and proposals;
- selected public/open-data workflows;
- source provenance and integrity validation around supported datasets.

Coverage is intentionally explicit. Features that do not yet have a trustworthy formal source should fail clearly rather than return fabricated or inferred records.

For example, council proposal retrieval must respect the official site's multi-tab and pagination behavior. Consumers should inspect fields such as `tab_counts`, `total_count`, `current_page`, `page_count`, and `is_complete` before treating a result set as complete.

## Data integrity and provenance

Reliability is a core design constraint.

Where supported, law and news workflows read only releases that have an immutable manifest, content hash, and passed validation. If a trusted snapshot is unavailable, the tool should fail explicitly rather than silently substitute an unverified source.

Council meeting-record text uses an existing verified R2 text layer. A cache miss may be parsed in memory for the current request, but does not silently mutate the trusted R2 corpus.

This project distinguishes between:

- **source data** from public-sector institutions;
- **normalized/parsed representations** produced by this software;
- **application logic** that exposes data through MCP.

Public-sector data remains subject to the terms, licenses, attribution requirements, and usage conditions of its original source. The Apache-2.0 license applies to this repository's source code and project documentation unless otherwise noted.

## MCP and authentication

The production MCP endpoint is:

```text
https://kcg-civic-mcp-worker.lihong.workers.dev/mcp
```

The service supports public OAuth discovery, CIMD, and Dynamic Client Registration. ChatGPT custom connectors can use the `/mcp` endpoint with **OAuth** authentication. With dynamic registration, a Client ID or Client Secret does not need to be pre-entered.

The authorization implementation uses:

- Authorization Code flow;
- PKCE S256;
- scoped MCP access (`mcp:read` and optional `offline_access`);
- client, redirect URI, and MCP resource binding;
- CSRF protection and single-use authorization state;
- atomic authorization-code consumption;
- access-token and rotating refresh-token lifecycles;
- rate limiting around relevant authorization flows.

OAuth state is stored in a SQLite Durable Object so authorization-code operations can be serialized instead of relying on eventually consistent KV behavior.

The MCP transport uses the official MCP SDK Streamable HTTP implementation with JSON responses. Protocol negotiation is handled by the SDK. Legacy SSE is not exposed; authenticated `GET /mcp` returns `405`.

### CLI / custom client example

CLI and custom MCP clients may use a Cloudflare Secret such as `MCP_ACCESS_KEY` or `AUTH_TOKEN` as a bearer credential where supported by the deployment configuration.

```json
{
  "mcpServers": {
    "Kaohsiung Civic Data": {
      "url": "https://kcg-civic-mcp-worker.lihong.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_TOKEN>"
      }
    }
  }
}
```

Credentials are accepted through the `Authorization` header. Do not place access tokens in repository files, documentation examples with real values, URLs, query strings, issue reports, screenshots, test output, or chat logs.

## Local development

### Requirements

- Node.js compatible with the repository toolchain
- npm
- Cloudflare Wrangler

### Setup

```bash
git clone https://github.com/Hong1998tw/kcg-civic-mcp-worker.git
cd kcg-civic-mcp-worker
npm ci
cp .dev.vars.example .dev.vars
npm run typecheck
npm test
npm run dev
```

Local development also uses bearer/OAuth authentication. `MCP_ALLOW_ANONYMOUS` does not bypass the current OAuth boundary. When using Wrangler locally, set `PUBLIC_ORIGIN` to the actual local origin.

Artificial demo/seed records are not read by formal production query paths.

## Testing

The main verification command is:

```bash
npm test
```

It currently runs TypeScript checking plus targeted parser, integrity, and OAuth regression tests.

Useful commands include:

```bash
npm run typecheck
npm run test:budget-parser
npm run test:integrity
npm run test:oauth
npm run verify:production-safety
npm run verify:toolchain
```

`npm run test:oauth` exercises the security-sensitive OAuth behavior against a real local workerd/SQLite environment. Production verification can use the project's dedicated test script and locally stored credentials, but automated tests must never print access keys or tokens.

Automated tests also do not follow a real ChatGPT callback, so they do not replace an end-to-end authorization and MCP tool-call acceptance test in an actual client.

## Deployment

```bash
npx wrangler secret put MCP_ACCESS_KEY
npm test
npm run deploy
```

`predeploy` runs the test suite plus production-safety and toolchain checks before deployment.

The `oauth-v1` Durable Object migration introduces SQLite-backed OAuth state. Deployment should preserve existing R2 data and secrets. Do not delete OAuth state or rotate production secrets merely as a rollback substitute; verify migration compatibility before rolling code back.

Durable Object requests, SQLite storage, cleanup alarms, R2, and Workers usage may incur Cloudflare charges according to the active Cloudflare plan.

## Known coverage boundaries

Some council capabilities are deliberately unavailable until an authoritative implementation exists. Examples may include schedules, live councillor/committee rosters, temporary motions, speaker attribution, or proposal-to-speech relationships. Unsupported paths should return an explicit unavailable state instead of synthesizing an answer.

Consumers should also treat upstream government interface changes as a possible source of parser or completeness failures.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

In particular, new data integrations should document their official source, retrieval behavior, update pattern, provenance checks, known limitations, and tests.

## Security

Please do not disclose authentication bypasses, token leakage, OAuth weaknesses, or other exploitable vulnerabilities in a public issue. See [SECURITY.md](SECURITY.md) for the reporting process.

## License

The source code and project documentation in this repository are licensed under the [Apache License 2.0](LICENSE), unless a file or third-party component states otherwise.

**Data licensing boundary:** public-sector data accessed, transformed, indexed, or returned by this project remains subject to the original source's applicable terms, licenses, attribution requirements, and legal conditions. This repository does not relicense third-party or government data merely by providing software that accesses it.

## Disclaimer

This is an independent civic-technology/open-source project. It is **not an official service of Kaohsiung City Government, Kaohsiung City Council, or any other government agency**. For legally authoritative or time-sensitive decisions, verify the underlying record with the responsible public institution and the canonical source linked by the tool.
