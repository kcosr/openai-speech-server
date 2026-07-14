#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
config_dir=${XDG_CONFIG_HOME:-$HOME/.config}/openai-speech-server
state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/openai-speech-server
unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
node_path=$(command -v node)
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
if [[ -S "$XDG_RUNTIME_DIR/bus" ]]; then
  export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
fi
escape_replacement() { printf '%s' "$1" | sed 's/[\\&|]/\\&/g'; }

mkdir -p "$config_dir" "$state_dir/tmp" "$state_dir/huggingface" "$state_dir/torch" "$state_dir/cache" "$state_dir/matplotlib" "$unit_dir"
chmod 700 "$config_dir" "$state_dir" "$state_dir/tmp" "$state_dir/huggingface" "$state_dir/torch" "$state_dir/cache" "$state_dir/matplotlib"
if [[ ! -e "$config_dir/config.yaml" ]]; then
  sed \
    -e "s|^  temp_directory:.*|  temp_directory: $(escape_replacement "$state_dir/tmp")|" \
    -e "s|^  tokens_file:.*|  tokens_file: $(escape_replacement "$config_dir/tokens.json")|" \
    "$repo_dir/config/openai-speech-server.example.yaml" > "$config_dir/config.yaml"
  chmod 600 "$config_dir/config.yaml"
fi
sed \
  -e "s|@REPO_DIR@|$(escape_replacement "$repo_dir")|g" \
  -e "s|@CONFIG_DIR@|$(escape_replacement "$config_dir")|g" \
  -e "s|@STATE_DIR@|$(escape_replacement "$state_dir")|g" \
  -e "s|@NODE_PATH@|$(escape_replacement "$node_path")|g" \
  "$repo_dir/deploy/systemd/openai-speech-server.service" > "$unit_dir/openai-speech-server.service"
npm --prefix "$repo_dir" ci
npm --prefix "$repo_dir" run build
systemctl --user daemon-reload
systemctl --user enable openai-speech-server.service
systemctl --user restart openai-speech-server.service
systemctl --user status --no-pager openai-speech-server.service
