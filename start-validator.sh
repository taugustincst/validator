#!/bin/sh
# Starts the eCW Security Settings Validator web UI on this computer and opens it in the browser.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get the LTS version from https://nodejs.org"; exit 1; }
exec node bin/ecw-validate.js serve --open "$@"
