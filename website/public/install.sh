#!/bin/sh
set -e

AGENTOS_REPO="iii-hq/agentos"
III_INSTALL_URL="https://install.iii.dev/iii/main/install.sh"
INSTALL_DIR="${BIN_DIR:-${PREFIX:-$HOME/.local}/bin}"

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

info() { printf "${CYAN}>${RESET} %s\n" "$1"; }
ok() { printf "${GREEN}>${RESET} %s\n" "$1"; }
warn() { printf "${YELLOW}!${RESET} %s\n" "$1"; }
err() { printf "${RED}x${RESET} %s\n" "$1" >&2; exit 1; }

detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "darwin" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) err "Unsupported OS: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)   echo "x86_64" ;;
    arm64|aarch64)   echo "aarch64" ;;
    armv7*)          echo "armv7" ;;
    *) err "Unsupported architecture: $(uname -m)" ;;
  esac
}

check_cmd() { command -v "$1" > /dev/null 2>&1; }

get_latest_release() {
  local repo="$1"
  local url="https://api.github.com/repos/${repo}/releases/latest"

  if check_cmd jq; then
    curl -fsSL "$url" | jq -r '.tag_name'
  else
    curl -fsSL "$url" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/'
  fi
}

download_and_install() {
  local repo="$1"
  local version="$2"
  local os="$3"
  local arch="$4"
  local binary_name="$5"

  local tag="${version#v}"
  local archive_name="${binary_name}-${tag}-${arch}-${os}"

  local ext="tar.gz"
  if [ "$os" = "windows" ]; then
    ext="zip"
  fi

  local download_url="https://github.com/${repo}/releases/download/${version}/${archive_name}.${ext}"

  info "Downloading ${binary_name} ${version} for ${os}/${arch}..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap "rm -rf '$tmp_dir'" EXIT

  local archive_path="${tmp_dir}/${archive_name}.${ext}"

  if ! curl -fsSL -o "$archive_path" "$download_url" 2>/dev/null; then
    local alt_archive="${binary_name}-${version}-${arch}-${os}.${ext}"
    local alt_url="https://github.com/${repo}/releases/download/${version}/${alt_archive}"
    if ! curl -fsSL -o "$archive_path" "$alt_url" 2>/dev/null; then
      local alt2="${binary_name}-${os}-${arch}.${ext}"
      local alt2_url="https://github.com/${repo}/releases/download/${version}/${alt2}"
      curl -fsSL -o "$archive_path" "$alt2_url" || err "Failed to download ${binary_name} ${version}. Check https://github.com/${repo}/releases for available binaries."
    fi
  fi

  if [ "$ext" = "zip" ]; then
    unzip -qo "$archive_path" -d "$tmp_dir"
  else
    tar -xzf "$archive_path" -C "$tmp_dir"
  fi

  local found_binary=""
  for candidate in "$tmp_dir/$binary_name" "$tmp_dir/${archive_name}/$binary_name" "$tmp_dir/bin/$binary_name"; do
    if [ -f "$candidate" ]; then
      found_binary="$candidate"
      break
    fi
  done

  if [ -z "$found_binary" ]; then
    found_binary="$(find "$tmp_dir" -name "$binary_name" -type f | head -1)"
  fi

  if [ -z "$found_binary" ]; then
    err "Could not find ${binary_name} binary in downloaded archive"
  fi

  mkdir -p "$INSTALL_DIR"
  cp "$found_binary" "$INSTALL_DIR/$binary_name"
  chmod +x "$INSTALL_DIR/$binary_name"

  ok "${binary_name} ${version} installed to ${INSTALL_DIR}/${binary_name}"
}

ensure_path() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) return ;;
  esac

  warn "${INSTALL_DIR} is not in your PATH"

  local shell_name
  shell_name="$(basename "${SHELL:-/bin/sh}")"

  local rc_file=""
  case "$shell_name" in
    zsh)  rc_file="$HOME/.zshrc" ;;
    bash) rc_file="$HOME/.bashrc" ;;
    fish) rc_file="$HOME/.config/fish/config.fish" ;;
  esac

  if [ -n "$rc_file" ]; then
    local line="export PATH=\"${INSTALL_DIR}:\$PATH\""
    if [ "$shell_name" = "fish" ]; then
      line="set -gx PATH ${INSTALL_DIR} \$PATH"
    fi

    if [ -f "$rc_file" ] && grep -qF "$INSTALL_DIR" "$rc_file" 2>/dev/null; then
      return
    fi

    printf "\n%s\n" "$line" >> "$rc_file"
    ok "Added ${INSTALL_DIR} to PATH in ${rc_file}"
    warn "Run: source ${rc_file}  (or open a new terminal)"
  else
    warn "Add this to your shell profile: export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi
}

install_iii() {
  if check_cmd iii; then
    local current_version
    current_version="$(iii --version 2>/dev/null | head -1 | sed 's/[^0-9.]//g')"
    ok "iii-engine already installed (v${current_version})"
    return
  fi

  info "Installing iii-engine (required dependency)..."

  if ! curl -fsSL "$III_INSTALL_URL" | sh; then
    err "Failed to install iii-engine. Install manually: curl -fsSL ${III_INSTALL_URL} | sh"
  fi

  if [ -f "$HOME/.local/bin/iii" ]; then
    export PATH="$HOME/.local/bin:$PATH"
  fi

  if check_cmd iii; then
    ok "iii-engine installed successfully"
  else
    warn "iii-engine installed but not found in PATH. You may need to restart your terminal."
  fi
}

install_agentos() {
  local os arch version

  os="$(detect_os)"
  arch="$(detect_arch)"

  info "Detected platform: ${os}/${arch}"

  if [ -n "$AGENTOS_VERSION" ]; then
    version="$AGENTOS_VERSION"
  else
    info "Fetching latest AgentOS release..."
    version="$(get_latest_release "$AGENTOS_REPO")"
    if [ -z "$version" ] || [ "$version" = "null" ]; then
      err "Could not determine latest version. Set AGENTOS_VERSION=v0.1.0 to install a specific version."
    fi
  fi

  download_and_install "$AGENTOS_REPO" "$version" "$os" "$arch" "agentos"
}

main() {
  printf "\n"
  printf "${BOLD}  AgentOS Installer${RESET}\n"
  printf "${DIM}  Agent Operating System on iii-engine${RESET}\n"
  printf "\n"

  if ! check_cmd curl; then
    err "curl is required. Install it and try again."
  fi

  install_iii
  install_agentos
  ensure_path

  printf "\n"
  printf "${GREEN}${BOLD}  Installation complete!${RESET}\n"
  printf "\n"
  printf "  Get started:\n"
  printf "\n"
  printf "    ${CYAN}agentos init --quick${RESET}                          Scaffold a project\n"
  printf "    ${CYAN}agentos config set-key anthropic \$API_KEY${RESET}     Set LLM key\n"
  printf "    ${CYAN}agentos start${RESET}                                 Start the engine\n"
  printf "    ${CYAN}agentos chat default${RESET}                          Chat with an agent\n"
  printf "\n"
  printf "  ${DIM}Docs: https://github.com/iii-hq/agentos${RESET}\n"
  printf "\n"
}

main "$@"
