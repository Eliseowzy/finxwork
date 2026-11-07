#!/bin/bash
mkdir -p /logs/verifier
if printf 'finx-harbor-ok\n' | cmp -s - /app/answer.txt; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
