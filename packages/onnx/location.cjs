// Where binding.js finds onnxruntime_binding.node: beside the library it links to, set before the first load.
let path
exports.use = (binding) => {
  path = binding
}
exports.binding = () => {
  if (!path) throw new Error("no ONNX Runtime binding was chosen")
  return path
}
