#!/bin/zsh
set -euo pipefail

PREFIX="/Users/carlosp/Documents/Codex"
BIN_DIR="$PREFIX/bin"
TMP_DIR="/private/tmp/vercel-install"
NODE_BIN="/Applications/Codex.app/Contents/Resources/node"

mkdir -p "$BIN_DIR" "$TMP_DIR"
cd "$TMP_DIR"

echo "Resolving latest npm package..."
NPM_TARBALL="$("$NODE_BIN" -e "fetch('https://registry.npmjs.org/npm/latest').then(r=>r.json()).then(j=>console.log(j.dist.tarball))")"

echo "Downloading npm..."
/usr/bin/curl -L --fail -o npm.tgz "$NPM_TARBALL"
rm -rf npm-package
mkdir npm-package
/usr/bin/tar -xzf npm.tgz -C npm-package --strip-components=1

echo "Installing Vercel CLI into $PREFIX..."
"$NODE_BIN" "$TMP_DIR/npm-package/bin/npm-cli.js" install --global --prefix "$PREFIX" vercel

echo
echo "Installed:"
"$BIN_DIR/vercel" --version

echo
echo "For this Terminal session:"
echo "  export PATH=\"$BIN_DIR:\$PATH\""
