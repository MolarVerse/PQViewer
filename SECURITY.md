# Security policy

## Supported versions

Security fixes are applied to the latest release and the current `main` branch.
Pre-release versions may require upgrading to the newest build.

## Report a vulnerability

Do not open a public issue. Use **Security → Report a vulnerability** in the
GitHub repository to create a private report. A working private-report form is
a release requirement and must be enabled before the public beta is announced.

If the form is unavailable, do not send vulnerability details through a public
issue. The repository is not ready for public security reports until that
channel is working.

Include:

- the affected version or commit
- operating system and browser
- reproduction steps or a minimal proof of concept
- expected impact
- any suggested mitigation

Do not include unrelated private simulation data. We aim to acknowledge a
report within seven days and will coordinate disclosure after a fix is
available.

## Local-server boundary

PQViewer is designed as a local scientific tool. It binds to `127.0.0.1` by
default and has no authentication, authorization, or TLS.

- Do not expose it directly to the public internet.
- Treat opened files and figure recipes as trusted local inputs.
- A recipe can reference local source and companion paths.
- Review proxy, firewall, and access controls before changing `--host`.
- Do not use the browser upload path for confidential data on a server managed
  by someone else.

General bugs and data-format errors belong in the public issue tracker only when
the reproducer is safe to share.
