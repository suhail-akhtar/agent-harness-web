#!/bin/bash
# Hidden checks for the board deck: slide count and the numbers that must appear.
set -u
pages=$(pdfinfo deck.pdf 2>/dev/null | awk '/^Pages:/ {print $2}')
fail=0
[ -n "$pages" ] && [ "$pages" -ge 8 ] && [ "$pages" -le 12 ] || { echo "slide count ${pages:-none}, expected 8-12"; fail=1; }
text=$(pdftotext deck.pdf - 2>/dev/null | tr -s ' \n' ' ')
for n in '4.2' '16.8' '3.0M' '4.8' '38%' '112%' '77%' '2.1%'; do
  echo "$text" | grep -qF -- "$n" || { echo "missing $n"; fail=1; }
done
[ $fail -eq 0 ] && echo "$pages slides; all key numbers present"
exit $fail
