# Security Policy

Security reports are welcome and should be handled privately whenever possible.

## Scope

Security-sensitive areas include, but are not limited to:

- OAuth authorization and token flows;
- PKCE enforcement;
- redirect URI and client validation;
- authentication or authorization bypass;
- access-token or refresh-token leakage;
- secret handling;
- Durable Object authorization state;
- MCP endpoint access control;
- cross-request or cross-client data exposure;
- dependency vulnerabilities that are exploitable in this deployment.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting / Security Advisory workflow for this repository if it is available.

If private reporting is not available, open a minimal issue asking the maintainer for a private reporting channel. Do **not** include exploit details, credentials, tokens, private information, or a working proof of concept in a public issue.

A useful private report should include:

- affected component and version or commit;
- impact and attack prerequisites;
- reproduction steps using non-production credentials;
- suggested mitigation, if known;
- whether the issue has been disclosed elsewhere.

## Credentials and production data

Do not include real access keys, bearer tokens, OAuth credentials, Cloudflare secrets, refresh tokens, cookies, or private user information in reports, tests, screenshots, logs, or pull requests.

Please reproduce issues using local or disposable test credentials whenever possible.

## Coordinated disclosure

Please allow reasonable time for investigation, remediation, regression testing, and deployment before public disclosure. The maintainer may coordinate a security advisory or release note after a fix is available.

## Supported versions

The project is actively developed. Security fixes are generally applied to the current default branch and current production release rather than to older versions unless explicitly stated otherwise.
