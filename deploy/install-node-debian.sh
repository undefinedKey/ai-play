#!/usr/bin/env bash
# Installs a reviewed official Node binary in a dedicated path, not over /usr/bin/node.
# Run explicitly with sudo bash deploy/install-node-debian.sh after reading this file.
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  printf '%s\n' 'Run with sudo bash deploy/install-node-debian.sh.' >&2
  exit 1
fi
if [[ ! -r /etc/os-release ]]; then
  printf '%s\n' 'Cannot identify this Linux distribution.' >&2
  exit 1
fi
. /etc/os-release
if [[ "${ID:-}" != debian || ! "${VERSION_ID:-}" =~ ^(12|13)$ ]]; then
  printf '%s\n' 'This installer targets Debian 12 or 13 only. Check /etc/os-release first.' >&2
  exit 1
fi

# Verified against https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt on 2026-10-29.
# To upgrade later, review the official release and update version AND checksum together.
node_version=v22.23.4
case "$(uname -m)" in
  x86_64)
    node_arch=x64
    expected_sha=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
    ;;
  aarch64|arm64)
    node_arch=arm64
    expected_sha=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b
    ;;
  *) printf '%s\n' 'Only x86_64 and aarch64/arm64 are supported by this installer.' >&2; exit 1 ;;
esac
for required in curl tar xz sha256sum install mktemp; do
  command -v "${required}" >/dev/null || { printf 'Missing command: %s\n' "${required}" >&2; exit 1; }
done

node_name="node-${node_version}-linux-${node_arch}"
archive="${node_name}.tar.xz"
destination="/opt/${node_name}"
link_path=/opt/ai-plaza-node
if [[ -e "${link_path}" && ! -L "${link_path}" ]]; then
  printf '%s\n' '/opt/ai-plaza-node exists and is not a symbolic link; leaving it untouched.' >&2
  exit 1
fi
if [[ -e "${destination}" ]]; then
  printf 'Destination already exists: %s. Verify the installed binary before reusing it.\n' "${destination}" >&2
  exit 1
fi

download_dir="$(mktemp -d /var/tmp/ai-plaza-node.XXXXXX)"
chmod 0700 "${download_dir}"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
  "https://nodejs.org/dist/${node_version}/${archive}" --output "${download_dir}/${archive}"
printf '%s  %s\n' "${expected_sha}" "${download_dir}/${archive}" | sha256sum --check --strict -
install -d -m 0755 /opt
tar --extract --xz --file "${download_dir}/${archive}" --directory /opt --no-same-owner
"${destination}/bin/node" --version
ln -sfn "${destination}" "${link_path}"
printf 'Installed runtime: %s\nDownloaded archive retained for inspection: %s\n' "${link_path}" "${download_dir}"
