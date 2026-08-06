default: install

# Build the React frontend into ui/dist
ui:
    bun run --cwd ui build

# Install the clep binary; release build embeds ui/dist via rust-embed
install: ui
    cargo install --path . --locked --force
