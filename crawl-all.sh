#!/bin/bash
# Crawl alle Spieltage 1-18

for i in {1..18}; do
    echo "========================================"
    echo "SPIELTAG $i"
    echo "========================================"
    npm run crawl -- --test $i
    echo ""
done

echo "Fertig! Alle Spieltage gecrawlt."
