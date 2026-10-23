# Kithwall onion service

Copy-paste configuration, **not deployed**. Why and how: [docs/v2/08-censorship.md](../../docs/v2/08-censorship.md) §4.

On a small Debian/Ubuntu VPS (1 vCPU / 1 GB is plenty, about €4–6 a month):

```sh
apt install tor caddy                    # tor from deb.torproject.org for a current version
cp torrc /etc/tor/torrc && systemctl restart tor
ONION=$(cat /var/lib/tor/kithwall/hostname)
sed "s/ONION_HOSTNAME/$ONION/" Caddyfile > /etc/caddy/Caddyfile && systemctl reload caddy
curl -s http://127.0.0.1:8080/api/net/health   # {"ok":true,"app":"kithwall","v":1}
```

Then in Vercel set `NEXT_PUBLIC_ONION_ORIGIN=http://$ONION` and redeploy: pages send `Onion-Location`
(Tor Browser offers the onion), Help and Settings → Connection show the address, and on the onion the app
sends Supabase traffic through the onion's own `/sb` (never leaving Tor). Back up
`/var/lib/tor/kithwall/hs_ed25519_secret_key` offline.

Passkeys are bound to the domain they were created on, so on the onion people sign in with their
passphrase or recovery key. The same VPS can also host the clearnet mirror from `infra/proxy/`.
