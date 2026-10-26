/** The SQLite every library in this package is built from. */
export declare const SQLITE_VERSION: string

/** The sqlite-vec release the extension is built from. */
export declare const SQLITE_VEC_VERSION: string

/** The library for this platform, or for the one described, when this package has one. */
export declare const libraryFor: (target?: { platform?: string; arch?: string; musl?: boolean }) => string | undefined

/** The sqlite-vec loadable extension (`vec0`) for this platform, or for the one described, when this package has one. */
export declare const extensionFor: (target?: { platform?: string; arch?: string; musl?: boolean }) => string | undefined
