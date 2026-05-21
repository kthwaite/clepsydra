#!/usr/bin/env bash
# Regenerate coverage and run the CRAP gate.
# Acceptance target: 0/570 functions exceed CRAP threshold 30.
set -euo pipefail
cargo llvm-cov --lcov --output-path lcov.info
cargo crap --lcov lcov.info
