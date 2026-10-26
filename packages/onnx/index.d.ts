export * from "onnxruntime-common"

export declare const ONNX_RUNTIME_VERSION: string

/** The native binding this package carries for a platform, or `undefined` when it carries none. */
export declare const nativeBindingFor: (target?: { platform?: string; arch?: string }) => string | undefined

/**
 * onnxruntime-node's API on a binding copied beside the ONNX Runtime library it links to. Throws when the binding or
 * its library does not load. The first binding opened is the one the process keeps.
 */
export declare const openNative: (binding: string) => typeof import("onnxruntime-common")
