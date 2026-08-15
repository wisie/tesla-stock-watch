# Security Policy

Tesla Stock Watch is a self-hosted tool. Most sensitive data lives in your private runtime environment, not in this repository.

## Do Not Share

Do not publish or attach:

- `.env`, `.env.docker`, or `.env.secrets`
- Pushover tokens or user keys
- Gmail app passwords or SMTP passwords
- Proxy credentials
- Chrome profiles, cookies, or browser state
- Logs or screenshots that reveal emails, IP addresses, private hostnames, cookies, or tokens
- `vehicle-state.json` if it contains data you consider private

## Reporting A Security Issue

Please open a GitHub issue only if the report does not require sharing secrets or private logs. If you need to discuss a sensitive issue, create a minimal description first and avoid including credentials or private infrastructure details.

## Recommended Defaults

- Keep `REAL_ALERTS_ENABLED=false` until setup is verified.
- Keep `ALERT_TESTS_ENABLED=false` except during deliberate alert tests.
- Keep noVNC bound to `127.0.0.1` and access it through an SSH tunnel.
- Rotate any credential that was ever committed, pasted into an issue, or shared in a screenshot.
