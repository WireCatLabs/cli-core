/**
 * Turns an official API description into committed code: types, Valibot schemas, an operation
 * manifest and a coverage page. Build-time only, and format-neutral: it parses no file format and
 * adds no dependency. The adapter from OpenAPI, Postman or anything else lives in the consumer.
 */
export { type CoverageOptions, coverageGenerator, type ManifestOperation, manifestGenerator } from "./manifest.js"
export type {
  ApiBody,
  ApiModel,
  ApiOperation,
  ApiParameter,
  ApiSchema,
  Binding,
  CodeGenerator,
  Confidence,
  Discriminator,
  Effect,
  GeneratedArtifact,
  HttpBinding,
  HttpMethod,
  Override,
  RpcBinding,
  SchemaNode,
  SourceInfo,
  SourceReference,
} from "./model.js"
export {
  applyOverrides,
  CodegenError,
  type GenerateOptions,
  generate,
  validateModel,
  type WriteOptions,
  writeArtifacts,
} from "./pipeline.js"
export { identifier, kebab } from "./tree.js"
export { typesGenerator } from "./typescript.js"
export { type ValibotOptions, valibotGenerator } from "./valibot.js"
