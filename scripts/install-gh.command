#!/bin/zsh
set -euo pipefail

INSTALL_DIR="/Users/carlosp/Documents/Codex/bin"
TMP_DIR="/private/tmp/gh-install"
VERSION="2.92.0"
ARCHIVE="gh_${VERSION}_macOS_arm64.zip"
URL="https://github.com/cli/cli/releases/download/v${VERSION}/${ARCHIVE}"

mkdir -p "$INSTALL_DIR" "$TMP_DIR"
cd "$TMP_DIR"
rm -rf "gh_${VERSION}_macOS_arm64" "$ARCHIVE"

echo "Downloading GitHub CLI ${VERSION}..."
/usr/bin/curl -L --fail -o "$ARCHIVE" "$URL"

echo "Installing gh to $INSTALL_DIR..."
/usr/bin/unzip -q "$ARCHIVE"
/bin/cp "gh_${VERSION}_macOS_arm64/bin/gh" "$INSTALL_DIR/gh"
/bin/chmod +x "$INSTALL_DIR/gh"

echo
echo "Installed:"
"$INSTALL_DIR/gh" --version

echo
echo "For this Terminal session:"
echo "  export PATH=\"$INSTALL_DIR:\$PATH\""

echo
echo "Next, authenticate:"
echo "  $INSTALL_DIR/gh auth login"
echo
echo "You can leave this window open, or close it after auth is complete."
