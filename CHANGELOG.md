# Changelog

## [Unreleased]

### Security
- `GET //` no longer crashes the server; malformed request URLs get 400.
- TLS certificates are verified for outbound requests; self-signed targets must opt in with `insecureTls: true` (warning logged).
- Optional `HOMEDECK_TOKEN` authentication and a `Host` allow-list (`ALLOWED_HOSTS`) against DNS rebinding.
- Docker image runs as non-root; compose uses a read-only docker-socket-proxy instead of the raw socket and no longer mounts the host root.
