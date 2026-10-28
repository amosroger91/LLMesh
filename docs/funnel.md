# LLMesh Funnel v1

A funnel publishes a node's existing API on the internet. It does not create a second API, and it does not replace the encrypted peer mesh.

The local listener stays on loopback unless an operator deliberately binds a public address. The funnel puts a public HTTPS URL in front of that listener. Callers still present the node's API key or a NIP-98 signature. Browser pages remain blocked.

## Providers

| Provider | What it does |
| --- | --- |
| `off` | Default. Nothing is published. |
| `relay` | The node dials out to an LLMesh funnel relay. This is the standard the other providers also satisfy: a verified public base URL. |
| `tailscale` | Runs `tailscale funnel` for the loopback port and reads `tailscale funnel status --json`. |
| `cloudflare` | Runs `cloudflared tunnel --url http://127.0.0.1:<port>` and accepts only an `https://*.trycloudflare.com` URL, unless the operator sets an explicit public URL for a named tunnel. |
| `public` | Records an API that is already on a public HTTPS URL. |

`LLMESH_FUNNEL` selects the provider. A node advertises the URL to trusted peers only after `GET <public>/.well-known/llmesh.json` returns this node's key.

## Relay

Run a relay where the group can reach it:

```powershell
$env:LLMESH_FUNNEL_PUBLIC_BASE = 'https://funnel.example'
$env:LLMESH_FUNNEL_TOKEN = '<16 or more random characters>'
node src/cli/index.js funnel relay --listen 127.0.0.1:7443 --tls-cert cert.pem --tls-key key.pem
```

`LLMESH_FUNNEL_PUBLIC_BASE` is the origin printed to nodes. Set it to the name clients use, not the relay's private bind address. Terminate TLS on the relay or at a proxy in front of it. Set a token, a node allowlist (`LLMESH_FUNNEL_ALLOW`, comma-separated node keys), or both. Without either, any node that can sign an announcement can publish through the relay.

A container and a systemd unit live in `deploy/funnel/`.

Publish a node through that relay:

```powershell
$env:LLMESH_FUNNEL = 'relay'
$env:LLMESH_FUNNEL_RELAY = 'https://funnel.example'
$env:LLMESH_FUNNEL_TOKEN = '<the relay token>'
node src/cli/index.js serve
```

The desktop **Publish this node** panel stores the choice next to the node. The token is encrypted with the operating system. Leave the token field blank to keep the saved token.

`node src/cli/index.js funnel status` and `node src/cli/index.js funnel probe` talk to a running daemon. `npm run headless` honors the same `LLMESH_FUNNEL*` variables.

## Wire protocol

Announcements are Nostr events, kind `30078`, with tag `d` = `llmesh-funnel-v1` and this content:

```json
{"v":1,"role":"node","protocol":"llmesh-funnel/1","nonce":"<32 hex characters>"}
```

The event must be signed by the node key and be less than 60 seconds old. Relays remember the event id so it cannot be replayed.

1. `POST /v1/funnel/sessions` with `{"v":1,"event":<signed event>}` and, when the relay requires it, `Authorization: Bearer <token>`.
2. The relay answers `201` with `session` and `publicUrl` (`<origin>/f/<session>`).
3. The node upgrades `GET /v1/funnel/tunnel` with `Upgrade: llmesh-funnel` and `Authorization: Funnel <session>`.
4. Frames are UTF-8 JSON lines, at most 900,000 bytes.

Request, relay to node:

```json
{"type":"request","id":"<uuid>","method":"GET","path":"/health","headers":{},"body":""}
```

Response, node to relay: one `response` frame (`status`, filtered headers), zero or more `chunk` frames (`body` is base64), then `end`. An `error` frame carries `status` and a short `message`.

The node forwards only `authorization`, `content-type`, and `accept`. It adds `x-llmesh-funnel-url` itself and proxies only to its loopback API. Paths containing `..` or an encoded parent segment are rejected. Bodies stop at 512 KiB. Each session handles at most 8 requests at once.

Public traffic uses `<publicUrl>` plus the API path. `https://funnel.example/f/<session>/v1` is the OpenAI base URL.

## Identity document

`GET /.well-known/llmesh.json` is unauthenticated and contains no key, wallet, topic, or prompt:

```json
{"v":1,"product":"llmesh","protocol":"llmesh-funnel/1","pubkey":"<node key>","auth":["bearer","nip98"],"endpoints":{"openai":"/v1"},"funnel":{"provider":"relay","state":"verified","verified":true}}
```

NIP-98 signatures through a funnel bind the public URL, not the loopback URL. The loopback header that carries that URL is accepted only from a loopback connection and only when it matches the verified funnel. A caller cannot supply it.

## What a funnel does not do

- It does not publish the API key or accept browser origins.
- It does not move mesh jobs off the Noise-encrypted peer connection. Peers learn the verified URL so operators and API clients can reach the node when hole punching fails.
- It does not turn a Tailscale or Cloudflare process on unless that provider is selected. Stopping a Tailscale funnel turns off the mapping LLMesh created for this port. It does not reset every serve configuration on the machine.
- It does not make an open relay safe. Use a token and an allowlist.
