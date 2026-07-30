# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| 0.2.x | Yes |
| Earlier versions | No |

Because Browser2IDE is an alpha, upgrade to the latest `0.2.x` release before
reporting or reproducing a security issue.

## Report A Vulnerability

Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/conus-vision/Browser2IDE/security/advisories/new).
Include the affected version, browser and VS Code versions, reproduction steps,
impact, and any suggested mitigation.

Do not open a public issue, discussion, or pull request for an unpatched
vulnerability. Public disclosure should wait until a fix or coordinated
mitigation is available.

## Security Model

Browser2IDE uses an explicitly authorized, loopback-only WebSocket connection
between a browser window and local VS Code. It does not auto-discover IDE
instances. The browser extensions require broad page access for inspected
pages, so reports involving injection conditions, link authentication, message
validation, source plugins, or sensitive inspection values are in scope. See
the detailed [security model](docs/security.md) and [privacy policy](PRIVACY.md).
