# Harbor Agent

Open-source Node.js service for Harbor AI capabilities, document extraction, and internal tasks. The source is licensed under MIT. Third-party dependencies retain their own licenses.

Public source: https://github.com/EstP19/harbor-agent

## Development

Requires Node.js 24 and npm. Install dependencies with `npm ci`, copy `.env.example` to `.env`, and supply your own credentials. Run `npm run dev`, `npm run typecheck`, and `npm test`.

The service integrates with the Harbor PostgreSQL schemas and authenticated Harbor backend services. Those schemas, production credentials, clinical knowledge-base content, and patient records are not distributed here. Existing AI provider routes use the provider configuration in `.env`.

## ChatGPT plan for personal internal tasks

The optional ChatGPT connection is managed in Harbor Developer; Harbor Agent generates the answers through the public Responses API. This connection applies to the internal task panel. Other capability routes retain their existing provider selection.

For an open-source installation on your own VM, authorize ChatGPT on your computer and import the encrypted session into your Dokploy container. See [the complete self-hosted setup](docs/chatgpt-self-hosted.md).

This follows OpenAI's [self-hosted VM flow](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). Availability, account eligibility, models, and usage limits are controlled by OpenAI. Publishing this repository does not guarantee an OAuth grant. Commercial/partner HTTPS callbacks remain a separate mode.

## Security

Keep the Agent's internal endpoints on a private network. Set unique service tokens. Never commit an `.env`, key, recipient/session file, database dump, or real patient document. Production source releases contain a reviewed snapshot, not the private development repository's historical commits or operational records.

For the ChatGPT connection, credentials remain encrypted in server storage. The application does not send OAuth tokens to browser JavaScript. For responsible disclosure, use GitHub's private vulnerability reporting if enabled; never post credentials or patient information in a public issue.

## License

[MIT](LICENSE). External packages, model data installed from npm, OpenAI branding, and service terms retain their respective ownership and conditions.
