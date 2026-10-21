#!/bin/sh
# ops-fetch.sh URL SHA256: downloads URL to /tmp/dl and fails unless its SHA-256 matches.
set -eu
curl -fsSL --retry 3 -o /tmp/dl "$1"
echo "$2  /tmp/dl" | sha256sum -c -
