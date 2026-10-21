set default-list := true

# Start an isolated backend and live-reloading frontend
debug:
    ./scripts/debug.sh

# Run UI tests
test-ui:
    bun --cwd ui test

# Run API tests
test-api:
    cargo test --quiet -- --test-threads=4

# Run all tests
test: test-ui test-api
    echo 'Running all tests...'

# Build the React frontend into ui/dist
ui:
    bun install --cwd ui
    bun run --cwd ui build

# Install the clep binary; release build embeds ui/dist via rust-embed
install: ui
    cargo install --path crates/clep --locked --force

# Validate and test the Claude Code plugin
plugin-test:
    claude plugin validate integrations/claude-code/clepsydra && claude plugin validate . && claude plugin test integrations/claude-code/clepsydra
