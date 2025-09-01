# Contributing to MCP AI Memory

Thank you for your interest in contributing to MCP AI Memory! We welcome contributions from the community.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/mcp-ai-memory.git`
3. Create a new branch: `git checkout -b feature/your-feature-name`
4. Install dependencies: `bun install`
5. Set up your development environment (see README.md)

## Development Setup

### Prerequisites
- Node.js 20+ or Bun
- PostgreSQL with pgvector extension
- Redis (optional, for caching)

### Environment Setup
1. Copy `.env.example` to `.env`
2. Configure your database connection
3. Run migrations: `bun run migrate`

## Development Workflow

### Code Style
- We use Biome for linting and formatting
- Run `bun run lint` before committing
- Run `bun run format` to auto-format code
- TypeScript strict mode is enabled

### Testing
- Write tests for new features
- Ensure all tests pass before submitting PR
- Run `bun run typecheck` to check types

### Commit Messages
Follow conventional commits format:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style changes (formatting, etc.)
- `refactor:` Code refactoring
- `test:` Test additions or changes
- `chore:` Maintenance tasks

Example: `feat: add batch memory import functionality`

## Pull Request Process

1. Update the README.md with details of changes if applicable
2. Ensure your code passes all checks:
   - `bun run typecheck`
   - `bun run lint:check`
   - `bun run format:check`
3. Update documentation for any API changes
4. Add tests for new functionality
5. Ensure your branch is up to date with main
6. Submit a pull request with a clear description

### PR Title Format
Use the same conventional commits format as commit messages.

### PR Description Template
```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Tests pass locally
- [ ] Added new tests (if applicable)

## Checklist
- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] No new warnings
```

## Code Guidelines

### TypeScript
- Use strict TypeScript mode
- Define proper types (avoid `any`)
- Use interfaces for object shapes
- Prefer `const` over `let`

### Error Handling
- Always handle errors appropriately
- Use proper error types
- Include meaningful error messages
- Log errors with appropriate severity

### Database
- Use Kysely for type-safe queries
- Always use transactions for multi-step operations
- Include proper indexes for performance
- Follow migration best practices

### Performance
- Consider caching for expensive operations
- Use batch operations where possible
- Optimize database queries
- Profile before optimizing

## Project Structure

```
src/
├── server.ts           # MCP server implementation
├── types/              # TypeScript type definitions
├── schemas/            # Zod validation schemas
├── services/           # Business logic
├── database/           # Database client and migrations
├── workers/            # Background job processors
└── config/             # Configuration management
```

## Feature Requests

Have an idea? Open an issue with:
1. Clear description of the feature
2. Use case and benefits
3. Potential implementation approach
4. Any alternatives considered

## Bug Reports

Found a bug? Please include:
1. Description of the issue
2. Steps to reproduce
3. Expected behavior
4. Actual behavior
5. Environment details (OS, Node/Bun version, etc.)
6. Relevant logs or error messages

## Questions?

- Open an issue for general questions
- Check existing issues first
- Be clear and provide context

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

Thank you for contributing to MCP AI Memory!