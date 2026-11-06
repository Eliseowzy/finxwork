# Security

Please report a vulnerability privately through GitHub's security advisories on the release repository, rather than in a public issue.

finx runs what a model decides under your permission mode, and it has no operating-system sandbox. What it does and does not protect against is in [docs/cli/permissions.md](docs/cli/permissions.md). A model doing something within what you allowed is not a vulnerability. Getting past a rule, a permission mode, a protected path or project trust is.
