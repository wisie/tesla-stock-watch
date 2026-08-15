# Contributing

Thanks for improving Tesla Stock Watch.

## Before Opening An Issue

Please check:

- You are using Node.js 18 or newer.
- You copied `.env.example` or `.env.docker.example` to a private env file.
- `/api/health` is reachable.
- You have not committed `.env`, logs, private screenshots, browser profiles, or `vehicle-state.json`.

## Good Bug Reports Include

- What you expected to happen.
- What actually happened.
- Your runtime: local Node, Docker, or another host.
- Relevant `/api/health` fields with secrets removed.
- Logs with emails, tokens, hostnames, cookies, and IP addresses removed.

## Pull Requests

- Keep changes focused.
- Update `README.md` or env examples when behavior changes.
- Run syntax checks or the relevant local command before submitting.
- Do not include generated files such as `node_modules`, `dist`, logs, private screenshots, or local state.

## Security And Privacy

Never paste real credentials into issues, pull requests, or screenshots. Rotate any Pushover token, Gmail app password, proxy credential, or SMTP password that may have been exposed.
