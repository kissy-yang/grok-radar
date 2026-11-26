#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 || "$1" != *.app ]]; then
    printf 'Usage: %s <output.app>\n' "$0" >&2
    exit 2
fi

mac_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
project_dir="$(dirname -- "$mac_dir")"
output_parent="$(cd -- "$(dirname -- "$1")" && pwd)"
output="$output_parent/$(basename -- "$1")"
signing_identity="${WORKBENCH_SIGN_IDENTITY:--}"
lock="$output.build-lock"
if ! mkdir -- "$lock"; then
    printf 'Another build may be using %s.\n' "$output" >&2
    exit 2
fi

staging=""
installed=false
cleanup() {
    if [[ -n "$staging" ]]; then
        if [[ -d "$staging/Previous.app" && "$installed" == false ]] &&
            { [[ -e "$output" ]] || ! mv -- "$staging/Previous.app" "$output"; }; then
            printf 'The previous app remains at %s\n' "$staging/Previous.app" >&2
        else
            rm -rf -- "$staging"
        fi
    fi
    rmdir -- "$lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -L "$output" ]]; then
    printf 'Output must be a regular app bundle path.\n' >&2
    exit 2
fi
if [[ -e "$output" ]]; then
    if [[ ! -d "$output" ]] ||
        [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$output/Contents/Info.plist" 2>/dev/null || true)" != "local.grokbot.workbench" ]]; then
        printf 'Output path already contains a different file or app.\n' >&2
        exit 2
    fi
    if [[ "$signing_identity" == "-" ]] && /usr/bin/codesign --verify -R='anchor apple generic' "$output" 2>/dev/null; then
        printf 'Set WORKBENCH_SIGN_IDENTITY to the existing Apple signing identity to update this app.\n' >&2
        exit 2
    fi
fi

staging="$(mktemp -d "$output_parent/.grok-workbench-build.XXXXXXXX")"
app="$staging/Workbench.app"
dest="$app/Contents"
resources="$dest/Resources/Workbench"
mkdir -p -- "$dest/MacOS" "$resources"
cp -- "$mac_dir/Info.plist" "$dest/Info.plist"
cp -- "$mac_dir/Workbench.icns" "$dest/Resources/Workbench.icns"
for asset in index.html style.css mascot.css app.mjs data.mjs i18n.mjs otlp.mjs live-updates.mjs routing.mjs routing-controls.mjs event-store.mjs weekly-quota.mjs; do
    cp -- "$project_dir/$asset" "$resources/$asset"
done

xcrun --sdk macosx swiftc -O -parse-as-library \
    -target arm64-apple-macos13.0 \
    -module-cache-path "$staging/swift-cache" \
    "$mac_dir/Workbench.swift" "$mac_dir/GrokLocalSource.swift" "$mac_dir/WorkbenchConnection.swift" "$mac_dir/GrokDesktopActivity.swift" \
    -o "$dest/MacOS/GrokBotWorkbench"

/usr/bin/codesign --force --sign "$signing_identity" "$app"
/usr/bin/codesign --verify --strict "$app"
if [[ "$signing_identity" == "-" ]]; then
    printf 'Locally signed. A new build may need fresh Accessibility approval in System Settings.\n' >&2
fi
if [[ -e "$output" ]]; then
    mv -- "$output" "$staging/Previous.app"
fi
mv -- "$app" "$output"
installed=true
printf '%s\n' "$output"
