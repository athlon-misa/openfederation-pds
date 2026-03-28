# Contributing to OpenFederation PDS

Thank you for your interest in contributing to OpenFederation PDS! This document explains how to get involved.

## Governance

OpenFederation PDS is currently **founder-led**. All contributions are welcome, but final decisions on direction, architecture, and merges rest with the project maintainer. This model may evolve as the community grows.

## Getting Started

1. Fork the repository
2. Clone your fork and create a branch from `main`
3. Install dependencies: `npm install`
4. Set up your environment: `cp .env.example .env` and configure database credentials
5. Initialize the database: `./scripts/init-db.sh`
6. Run in development mode: `npm run dev`

## Development Workflow

1. **Check for existing issues** before starting work. If none exists, open one to discuss your proposal.
2. **Create a feature branch** from `main` with a descriptive name (e.g., `feat/add-blob-storage`, `fix/refresh-token-race`).
3. **Write tests** for new functionality. Run the test suite before submitting:
   ```bash
   npm run test:unit    # Unit tests
   npm run test:api     # Integration tests (requires running database)
   ```
4. **Keep commits focused.** Each commit should represent a logical change.
5. **Open a pull request** against `main` with a clear description of what and why.

## Pull Request Guidelines

- Keep PRs focused on a single concern. Split unrelated changes into separate PRs.
- Include a description of what changed and why. Link to related issues.
- Ensure all tests pass and the build succeeds (`npm run build`).
- Do not include secrets, credentials, or `.env` files.
- Do not commit generated files (`dist/`, `node_modules/`).
- New XRPC endpoints need lexicon definitions in `src/lexicon/`.

## Code Style

- TypeScript with ESM modules
- Follow existing patterns in the codebase (see `CLAUDE.md` for architecture details)
- Use the existing auth guards (`requireAuth`, `requireRole`, `requireApprovedUser`) for new endpoints
- Database queries go through `query()` from `src/db/client.ts`
- All admin and security-relevant actions must be audit-logged

## What We're Looking For

Check the [issue tracker](https://github.com/athlon-misa/openfederation-pds/issues) for open issues. Issues labeled `good first issue` are a great starting point. We especially welcome:

- Bug fixes with reproduction steps
- Test coverage improvements
- Documentation improvements
- Performance optimizations with benchmarks

## Reporting Bugs

Open a [GitHub issue](https://github.com/athlon-misa/openfederation-pds/issues/new) with:

- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node.js version, OS, database version)

## Security Vulnerabilities

**Do not open a public issue for security vulnerabilities.** See [SECURITY.md](./SECURITY.md) for responsible disclosure instructions.

## License

By contributing, you agree that your contributions will be dual-licensed under the MIT License and Apache License 2.0, consistent with the project's [LICENSE](./LICENSE).
