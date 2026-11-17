# @ateam/relay

Self-hosted tunnel so a phone / another machine on the internet can reach a
desktop Ateam behind NAT. The desktop dials OUT; the relay never parses traffic
— every public TLS connection is piped into the desktop's LAN server (login,
password, UI, RPC all live there).

```
browser ─TLS─▶ relay :27443 ─(desktop's outbound WS)─▶ desktop 127.0.0.1:<lan port>
                          ▲
desktop ──wss──▶ relay :27444/agent  (device id + token)
```

## Deploy (any Linux box with Node ≥ 20)

```sh
pnpm --filter @ateam/relay build            # dist/index.cjs — one self-contained file
scp dist/index.cjs box:/opt/ateam-relay/index.cjs
ssh box
cd /opt/ateam-relay
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 \
  -subj "/CN=ateam-relay" -addext "subjectAltName=IP:<public ip>"   # or a real cert
cat > relay.config.json <<'JSON'
{ "clientPort": 27443, "agentPort": 27444,
  "tls": { "cert": "/opt/ateam-relay/cert.pem", "key": "/opt/ateam-relay/key.pem" },
  "devices": {} }
JSON
RELAY_CONFIG=$PWD/relay.config.json node index.cjs add-device "my mac"   # prints id + token (hash stored)
RELAY_CONFIG=$PWD/relay.config.json node index.cjs fingerprint            # paste into Ateam if self-signed
RELAY_CONFIG=$PWD/relay.config.json node index.cjs                        # or run it under systemd
```

Open TCP 27443 + 27444 in the provider's firewall. Then on the desktop:
Settings → Remote → **LAN access** on (with a password) → **Remote access**:
URL `wss://<ip>:27444`, device id, token, fingerprint → Save → toggle on.
Phones open `https://<ip>:27443` (accept the self-signed warning once).

Commands: `add-device <name>`, `list`, `fingerprint`.
