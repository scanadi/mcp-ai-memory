# Security Policy

## Supported Versions

Currently supported versions for security updates:

| Version | Supported          |
| ------- | ------------------ |
| 2.0.x   | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

We take the security of MCP AI Memory seriously. If you discover a security vulnerability, please follow these steps:

### How to Report

1. **DO NOT** open a public GitHub issue for security vulnerabilities
2. Email your findings to [INSERT SECURITY EMAIL]
3. Include detailed information about the vulnerability:
   - Description of the issue
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### What to Expect

- **Acknowledgment**: We will acknowledge receipt within 48 hours
- **Initial Assessment**: Within 5 business days, we'll provide an initial assessment
- **Updates**: We'll keep you informed about our progress
- **Resolution**: We aim to resolve critical issues within 30 days
- **Credit**: We'll credit you for the discovery (unless you prefer to remain anonymous)

## Security Best Practices

When using MCP AI Memory:

### Database Security
- Always use strong PostgreSQL credentials
- Enable SSL/TLS for database connections in production
- Regularly update PostgreSQL and pgvector extensions
- Use database-level access controls

### Environment Variables
- Never commit `.env` files to version control
- Use strong, unique passwords
- Rotate credentials regularly
- Use secrets management in production

### Redis Security
- Enable Redis authentication
- Use SSL/TLS for Redis connections
- Configure appropriate memory limits
- Regular security updates

### API Security
- Implement rate limiting
- Validate all inputs
- Sanitize user-provided content
- Use proper authentication for MCP connections

## Security Features

MCP AI Memory includes several security features:

- **Input Validation**: All inputs are validated using Zod schemas
- **SQL Injection Protection**: Kysely ORM provides parameterized queries
- **Soft Deletes**: Data recovery capabilities with audit trails
- **User Isolation**: Multi-agent support with context separation
- **Content Size Limits**: Configurable limits to prevent abuse

## Dependencies

We regularly update dependencies to patch known vulnerabilities:
- Run `bun update` to get the latest patches
- Monitor security advisories for critical updates
- Use `bun audit` to check for known vulnerabilities

## Contact

For security concerns, contact: [INSERT SECURITY EMAIL]

For general questions, use GitHub issues.

Thank you for helping keep MCP AI Memory secure!