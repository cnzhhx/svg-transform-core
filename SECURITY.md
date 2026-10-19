# Security Policy

## Supported Versions

Security fixes are applied to the latest release line. Upgrade to the newest
published Docker image and client SDK before reporting an issue that may
already have been fixed.

## Reporting a Vulnerability

Use the repository's private GitHub security advisory form to report a
vulnerability. Include the affected version, deployment shape, reproduction
steps, and expected impact. Do not open a public issue for an unpatched
vulnerability or include credentials, model responses, uploaded SVGs, or job
artifacts in a report.

## Deployment Boundary

The core service does not provide authentication, authorization, tenant
isolation, quotas, or TLS termination. Bind it to loopback for local use. Any
network deployment must place it behind an authenticated, rate-limited reverse
proxy and restrict access to the workspace and model provider configuration.
