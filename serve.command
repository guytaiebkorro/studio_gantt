#!/bin/bash
# Double-click this file (macOS) to serve the Gantt app over http://localhost,
# which lets Chrome/Edge save changes back into gantt.html in place.
# Close this Terminal window (or press Ctrl+C) to stop the server.

cd "$(dirname "$0")" || exit 1
PORT=8753
URL="http://localhost:$PORT/gantt.html"

echo "Serving $(pwd)"
echo "Opening $URL"
echo "Keep this window open while you work. Close it (or Ctrl+C) to stop."
echo

# Open in Chrome if available, otherwise the default browser. Slight delay so the server is up.
( sleep 1
  if open -a "Google Chrome" "$URL" 2>/dev/null; then :
  elif open -a "Microsoft Edge" "$URL" 2>/dev/null; then :
  else open "$URL"
  fi
) &

# Prefer python3's static server; fall back to python.
if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  exec python -m SimpleHTTPServer "$PORT"
else
  echo "Python not found. Install it, or run any static server in this folder, e.g.:"
  echo "  npx serve -l $PORT"
  read -r -p "Press Enter to close."
fi
