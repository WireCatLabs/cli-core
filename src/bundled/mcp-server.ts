/**
 * The MCP SDK values cli-core runs, bundled with zod into `dist/bundled/mcp-server.js` by
 * `scripts/bundle-libraries.ts`. Import them from here, never from the package: it is only an optional peer
 * dependency, kept for the types the published declarations name.
 */
export {
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  InMemoryTransport,
  isLegacyRequest,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  oauthMetadataResponse,
  ResourceTemplate,
  requireBearerAuth,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server"
export { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio"
