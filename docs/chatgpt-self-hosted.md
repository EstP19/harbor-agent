# ChatGPT authorization for a self-hosted Harbor Agent

This workflow is for this open-source application on your own VM. It uses the same ChatGPT account and workspace locally and on the VM, as described in [OpenAI's VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). It does not provide a hosted commercial OAuth client.

## 1. Configure Dokploy

Run Harbor Agent on the private Docker network, using Node.js 24. Supply these environment variables to Agent:

```dotenv
HARBOR_CHATGPT_MODE=self-hosted
HARBOR_CHATGPT_PUBLIC_ORIGIN=https://developer.myharborliving.com
HARBOR_CHATGPT_AGENT_HOST=harbor-agent:2000
HARBOR_CHATGPT_STATE_KEY=<32-random-bytes-as-64-hex-characters>
HARBOR_CHATGPT_OWNER_ID=<your-existing-Developer-IAM-user-UUID>
HARBOR_DEVELOPER_SERVICE_TOKEN=<a-unique-shared-service-token>
DATABASE_URL=<your-Agent-runtime-PostgreSQL-connection>
```

Use your real private network alias in place of `harbor-agent`. Keep the encryption key stable and secret. Generate it in the server's protected environment; do not paste it into chat or commit it. Do not configure partner client credentials for this mode.

On Developer, configure the same `HARBOR_CHATGPT_PUBLIC_ORIGIN` and `HARBOR_DEVELOPER_SERVICE_TOKEN`, plus `HARBOR_CHATGPT_AGENT_URL=http://harbor-agent:2000`. Its HTTPS proxy must preserve the expected host and send `X-Forwarded-Proto: https`.

Existing Harbor installations need migration `180_chatgpt_plan_session.sql`. Apply it using your existing migration service with its owner connection. It grants only Agent read/update access to the encrypted singleton session; Developer accesses it through the authenticated internal service.

The existing Developer user's IAM UUID appears in the connection panel once self-hosted mode is running. Use that UUID throughout; inventing a different one prevents that Developer from using the session.

## 2. Prepare the destination inside the Agent container

Use the container terminal in Dokploy:

```sh
npm run chatgpt:session -- prepare-import --output /tmp/harbor-vm.recipient.json
```

The manifest contains a public encryption key, one-use transfer ID, the Developer UUID, and the VM's persistent host ID. Its corresponding private key stays encrypted in PostgreSQL. It expires after one hour. Creating a new manifest replaces the pending import, while keeping the same VM host ID.

Copy only this recipient manifest to your computer over SSH/SCP, using the server and container access you normally use. Do not copy server environment files or encryption keys. You can first copy the manifest from the container to a protected directory on the VM using `docker cp`, then use `scp`.

## 3. Authorize on your computer

Clone this public repository, run `npm ci`, and run:

```sh
npm run chatgpt:session -- login --recipient /path/to/harbor-vm.recipient.json --output /path/to/harbor-session.jwe
```

Use absolute file paths appropriate to your OS. Open the printed OpenAI authorization URL in a browser on that computer. The CLI starts a listener at `http://127.0.0.1:1455/api/chatgpt-plan/callback` before starting OAuth, and uses state, nonce, and PKCE. You can select another free port with `--port`.

Sign in with your eligible ChatGPT account, select the intended workspace, and authorize Harbor Agent to use your plan. The initial dynamic registration issues a client ID; no partner client secret or API key is required by this flow.

The CLI validates OpenAI's signed ID token and granted plan scopes, then encrypts the credential record to the VM's public key. It writes the output with exclusive creation and restrictive permissions. Existing output files are never overwritten. The local helper authorizes the target VM's host ID and keeps a separate credential cache for each VM in the OS user data directory by default; use `--directory` to choose a protected alternative. Later authorizations reuse that VM's host ID and the registration's issued client ID.

After export, the local copy drops its tokens without revoking them: the VM must become the only refresher of the renewable session. The retained local account/client mapping supports subsequent reauthorization. Keep the same account and workspace.

## 4. Transfer and import

Transfer `harbor-session.jwe` to the VM over SSH/SCP and then into the Agent container. In the same container that prepared the recipient, run:

```sh
npm run chatgpt:session -- import --file /tmp/harbor-session.jwe
npm run chatgpt:session -- status
```

Import validates the recipient, owner, identity, client, permissions, and expiry. Each transfer is consumed atomically, so replays are rejected across Agent instances. An invalid import consumes that attempt; prepare a new recipient and authorize again. It preserves the VM host ID rather than copying the laptop's.

Delete the temporary transfer files after successful import. Session state remains encrypted in PostgreSQL, and subsequent refresh-token rotations are serialized across Agent instances.

## 5. Send a task from Developer

Open **Harbor Agent · ChatGPT** in Developer. Refresh the connection status, select an available model, and send an internal task. Developer forwards it to Agent; Agent calls `https://api.openai.com/v1/responses` with `store:false` and `stream:true`, and returns the answer only after the completion event.

Use **Manage usage** to inspect plan limits. **Disconnect ChatGPT** attempts to revoke the renewable session and removes the saved tokens. If authorization expires or is revoked, repeat the local authorization/import flow with a newly prepared recipient. Do not attempt to use the dynamic registration with the public HTTPS callback.

## Checks and limits

Run `npm test` and `npm run typecheck`. The database integration test additionally needs an isolated, loopback PostgreSQL database named `harbor_chatgpt_test_...`, supplied through `HARBOR_CHATGPT_TEST_DATABASE_URL`.

OpenAI controls access and plan limits. Follow its [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). The VM guide currently states that host-specific usage attribution and revocation for transferred sessions are unavailable.
