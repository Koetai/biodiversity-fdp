#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== Biodiversity FDP Viewer — building JAR ==="

rm -rf out
mkdir -p out/web

echo "Compiling…"
javac --release 8 -d out src/FDPViewer.java

echo "Copying web resources…"
cp web/*.html web/*.css out/web/

echo "Packaging…"
jar cfe fdp-viewer.jar FDPViewer -C out .

echo ""
echo "✓ Done: fdp-viewer.jar"
echo ""
echo "Usage:"
echo "  1. cp config.properties.template config.properties"
echo "  2. Fill in your GitHub OAuth App Client ID (only needed to commit edits)"
echo "  3. java -jar fdp-viewer.jar"
