#!/bin/bash
# Independent acceptance checks for a URL-shortener build. $1 = workspace, $2 = start command, $3 = port
export NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"
cd "${1:-.}"; T=$(mktemp -d); F=$T/links.json; B=$T/body; P=$3; CMD=$2
start() { (PORT=$P LINKS_FILE=$F DATA_FILE=$F STORE_PATH=$F DB_FILE=$F $CMD > /dev/null 2>&1 &); for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:$P/links && return; sleep 0.25; done; echo "server did not start"; }
stop() { kill $(lsof -t -i:$P 2>/dev/null) 2>/dev/null; fuser -k $P/tcp >/dev/null 2>&1; sleep 0.5; }
req() { curl -s -o $B -w "%{http_code}" "$@"; }
ok=0; bad=0; check() { if [ "$2" = "$3" ]; then ok=$((ok+1)); else bad=$((bad+1)); echo "FAIL $1: expected $3 got $2"; fi; }
start
check "create with slug" $(req -X POST -H 'content-type: application/json' -d '{"url":"https://example.com/a","slug":"abc"}' http://127.0.0.1:$P/links) 201
check "duplicate slug" $(req -X POST -H 'content-type: application/json' -d '{"url":"https://example.com/b","slug":"abc"}' http://127.0.0.1:$P/links) 409
check "generated slug" $(req -X POST -H 'content-type: application/json' -d '{"url":"http://example.org"}' http://127.0.0.1:$P/links) 201
gen=$(python3 -c "import json;d=json.load(open('$B'));print(d.get('slug') or d.get('link',{}).get('slug',''))"); check "generated slug is 6 chars [a-z0-9-]" $(python3 -c "import re;print(bool(re.fullmatch(r'[a-z0-9-]{6}','$gen')))") True
check "bad scheme" $(req -X POST -H 'content-type: application/json' -d '{"url":"ftp://x.com"}' http://127.0.0.1:$P/links) 400
check "relative url" $(req -X POST -H 'content-type: application/json' -d '{"url":"/local"}' http://127.0.0.1:$P/links) 400
check "slug too short" $(req -X POST -H 'content-type: application/json' -d '{"url":"https://x.com","slug":"ab"}' http://127.0.0.1:$P/links) 400
check "slug bad chars" $(req -X POST -H 'content-type: application/json' -d '{"url":"https://x.com","slug":"AB_c"}' http://127.0.0.1:$P/links) 400
check "url too long" $(req -X POST -H 'content-type: application/json' -d "{\"url\":\"https://x.com/$(head -c 2100 /dev/zero | tr '\0' a)\"}" http://127.0.0.1:$P/links) 400
check "malformed json" $(req -X POST -H 'content-type: application/json' -d '{"url":' http://127.0.0.1:$P/links) 400
check "body over 10KB" $(req -X POST -H 'content-type: application/json' --data-binary "{\"url\":\"https://x.com\",\"pad\":\"$(head -c 11000 /dev/zero | tr '\0' a)\"}" http://127.0.0.1:$P/links) 413
check "CRLF url" $(req -X POST -H 'content-type: application/json' -d '{"url":"https://x.com/\r\nSet-Cookie: a=b","slug":"crlf"}' http://127.0.0.1:$P/links) 400
check "redirect" $(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" http://127.0.0.1:$P/abc | cut -d' ' -f1) 302
check "redirect target" "$(curl -s -o /dev/null -w "%{redirect_url}" http://127.0.0.1:$P/abc)" "https://example.com/a"
curl -s -o /dev/null http://127.0.0.1:$P/abc
check "stats" $(req http://127.0.0.1:$P/links/abc) 200
check "clicks counted" $(python3 -c "import json;d=json.load(open('$B'));d=d.get('link',d);print(d.get('clicks'))") 3
check "stats fields" $(python3 -c "import json;d=json.load(open('$B'));d=d.get('link',d);print(all(k in d for k in ['slug','url','clicks','createdAt']))") True
check "list" $(req http://127.0.0.1:$P/links) 200
check "list newest first" $(python3 -c "
import json;d=json.load(open('$B'));l=d if isinstance(d,list) else d.get('links',d.get('items',[]))
print(l[0]['slug']=='$gen' and len(l)==2)") True
check "unknown slug 404" $(req http://127.0.0.1:$P/nope1) 404
check "404 is json" $(python3 -c "import json;json.load(open('$B'));print('ok')" 2>/dev/null) ok
stop; start
check "survives restart" $(req http://127.0.0.1:$P/links/abc) 200
check "clicks survive restart" $(python3 -c "import json;d=json.load(open('$B'));d=d.get('link',d);print(d.get('clicks'))") 3
check "delete" $(req -X DELETE http://127.0.0.1:$P/links/abc) 204
check "deleted is gone" $(req http://127.0.0.1:$P/abc) 404
stop
echo "acceptance: $ok passed, $bad failed"
[ $bad -eq 0 ]
