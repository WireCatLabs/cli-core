#!/bin/sh
# Copies what ONNX Runtime's Node builds load out of npm tarballs, each checked against the integrity npm
# records for it:
#   onnxruntime-web: the WebAssembly build — the other 130 MB of that package are browser builds nobody here runs;
#   onnxruntime-node: its JavaScript and the 0.4 MB binding of each platform — not its 46 MB libraries, which
#   @wirecat/cli-core downloads with the models, from Microsoft's release of the same version.
set -eu
cd "$(dirname "$0")"
VERSION=1.30.0
WEB_INTEGRITY="sha512-q0y+JrrtukXSzsBWEMccVfqX25LRmosXHF+CaRJmg8pZClzcV7svNc4rKY3jL02Vb7QmRMDs1SigqR4CXAfKYQ=="
NODE_INTEGRITY="sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw=="
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fetch() { # package integrity
  curl -fsSL "https://registry.npmjs.org/$1/-/$1-$VERSION.tgz" -o "$work/$1.tgz"
  actual="sha512-$(openssl dgst -sha512 -binary "$work/$1.tgz" | base64 | tr -d '\n')"
  [ "$actual" = "$2" ] || { echo "$1-$VERSION.tgz is not the file npm records" >&2; exit 1; }
  mkdir "$work/$1"
  tar -xzf "$work/$1.tgz" -C "$work/$1"
}

fetch onnxruntime-web "$WEB_INTEGRITY"
rm -rf dist && mkdir dist
for file in ort.node.min.mjs ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm; do
  cp "$work/onnxruntime-web/package/dist/$file" dist/
done

fetch onnxruntime-node "$NODE_INTEGRITY"
from=$work/onnxruntime-node/package
rm -rf native && mkdir native
for file in index.js backend.js binding.js version.js; do
  cp "$from/dist/$file" native/
done
# The binding is loaded from the folder its library was downloaded to, not from this package.
line='require(`../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`);'
[ "$(grep -cF "$line" native/binding.js)" = 1 ] || { echo "binding.js no longer loads its binding as expected" >&2; exit 1; }
sed -i.bak "s|require(\`../bin/napi-v6/\${process.platform}/\${process.arch}/onnxruntime_binding.node\`);|require(require(\"./location.js\").binding());|" native/binding.js
rm native/binding.js.bak
grep -qF 'require(require("./location.js").binding());' native/binding.js
cp location.cjs native/location.js
echo '{"type":"commonjs"}' > native/package.json
grep -qF "exports.version = '$VERSION';" native/version.js
for target in linux/x64 linux/arm64 darwin/arm64; do
  mkdir -p "native/$(echo "$target" | tr / -)"
  cp "$from/bin/napi-v6/$target/onnxruntime_binding.node" "native/$(echo "$target" | tr / -)/"
done
ls -lR dist native
