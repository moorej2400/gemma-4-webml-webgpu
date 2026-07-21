#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CA_CERT="$ROOT/certs/ios-webml-ca.pem"
LEAF_CERT="$ROOT/certs/ios-webml-server.pem"
PROFILE="$ROOT/certs/ios-webml-ca.mobileconfig"
HTTPS_PORT=9443
HTTP_PORT=9080
LAN_IP="${LAN_IP:-$(node -e 'const os=require("os"); for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries || []) if (entry.family === "IPv4" && !entry.internal) { console.log(entry.address); process.exit(0); }')}"

if [[ -z "$LAN_IP" ]]; then
  echo "no LAN IPv4 address found" >&2
  exit 1
fi

HTTPS_PORT="$HTTPS_PORT" PORT="$HTTP_PORT" node "$ROOT/server.js" >/tmp/webml-ios-tls-test.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT

for _ in {1..50}; do
  if curl -fsS "http://127.0.0.1:$HTTP_PORT/certs/ios-webml-ca.mobileconfig" >/tmp/ios-webml-ca.mobileconfig 2>/dev/null; then
    break
  fi
  sleep 0.1
done

test -f "$CA_CERT"
test -f "$LEAF_CERT"
test -f "$PROFILE"
test "$(stat -f '%Lp' "$ROOT/certs/ios-webml-ca-key.pem")" = "600"
test "$(stat -f '%Lp' "$ROOT/certs/ios-webml-server-key.pem")" = "600"

openssl verify -CAfile "$CA_CERT" "$LEAF_CERT"
openssl x509 -in "$LEAF_CERT" -noout -text | grep -q "CA:FALSE"
openssl x509 -in "$LEAF_CERT" -noout -text | grep -q "IP Address:$LAN_IP"

# Apple limits newly issued TLS leaf certificates to 398 days.
if openssl x509 -in "$LEAF_CERT" -checkend $((398 * 24 * 60 * 60)) -noout; then
  echo "leaf certificate is valid for longer than 398 days" >&2
  exit 1
fi

grep -q "com.apple.security.root" /tmp/ios-webml-ca.mobileconfig
curl -fsS --cacert "$CA_CERT" "https://127.0.0.1:$HTTPS_PORT/" >/dev/null
private_key_status="$(curl -sS --cacert "$CA_CERT" -o /dev/null -w '%{http_code}' "https://127.0.0.1:$HTTPS_PORT/certs/ios-webml-ca-key.pem")"
test "$private_key_status" = "404"

headers="$(curl -sSI -H "Host: $LAN_IP:$HTTP_PORT" "http://127.0.0.1:$HTTP_PORT/")"
grep -q "HTTP/1.1 301" <<<"$headers"
grep -q "Location: https://$LAN_IP:$HTTPS_PORT/" <<<"$headers"
