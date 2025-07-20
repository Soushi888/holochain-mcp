# Holochain MCP Server

A Model Context Protocol (MCP) server built with **Effect TS** that provides AI agents with access to Holochain documentation, including:

- [Holochain Developer Documentation](https://developer.holochain.org/)
- [HDK (Holochain Development Kit) Rust Documentation](https://docs.rs/hdk/latest/hdk/)
- [HDI (Holochain Deterministic Integrity) Rust Documentation](https://docs.rs/hdi/latest/hdi/)

## Features

- **Built with Effect TS**: Leverages Effect's powerful type-safe error handling, concurrent operations, and functional programming patterns
- **Search across all Holochain docs**: Find relevant information across developer guides, HDK, and HDI documentation
- **Fetch complete documentation pages**: Get the full content of specific documentation pages
- **HDK function lookup**: Get detailed documentation for specific HDK functions
- **Concept explanations**: Access explanations of key Holochain concepts like source chain, DHT, links, etc.
- **Module listing**: Browse available HDK modules and their functions
- **Robust error handling**: Type-safe error management with Effect's error model

## Available Tools

### 1. `search_holochain_docs`
Search across all Holochain documentation sources.

**Parameters:**
- `query` (string, required): Search query
- `source` (string, optional): Specific source to search ("all", "developer", "hdk", "hdi")

### 2. `fetch_holochain_doc`
Fetch the complete content of a specific documentation page.

**Parameters:**
- `url` (string, required): URL of the documentation page

### 3. `get_hdk_function`
Get documentation for a specific HDK function.

**Parameters:**
- `functionName` (string, required): Name of the HDK function (e.g., "create_entry", "get_links")

### 4. `get_holochain_concept`
Get documentation for Holochain concepts.

**Parameters:**
- `concept` (string, required): Concept name (e.g., "source chain", "dht", "links")

### 5. `list_hdk_modules`
List available HDK modules and their main functions.

**Parameters:** None

## Installation

1. Clone this repository:
```bash
git clone https://github.com/yourusername/holochain-mcp-server
cd holochain-mcp-server
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
npm run build
```

## Usage

### With Claude Desktop

Add the following to your Claude Desktop configuration file (`~/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "holochain-docs": {
      "command": "node",
      "args": ["/absolute/path/to/holochain-mcp-server/build/index.js"]
    }
  }
}
```

### With Claude Code CLI

```bash
claude mcp add-json holochain-docs '{
  "command": "node",
  "args": ["/absolute/path/to/holochain-mcp-server/build/index.js"],
  "env": {}
}' -s user
```

### With other MCP clients

Run the server directly:
```bash
npm start
```

Or use it as a module in your MCP-compatible application.

## Development

### Running in development mode

```bash
npm run dev
```

### Testing with MCP Inspector

```bash
npm run inspector
```

Then open http://localhost:4000 in your browser to test the tools interactively.

## Examples

### Search for information about entries
```
Use the search_holochain_docs tool with query "create entry"
```

### Get specific HDK function documentation
```
Use the get_hdk_function tool with functionName "create_entry"
```

### Learn about Holochain concepts
```
Use the get_holochain_concept tool with concept "source chain"
```

### Fetch a specific documentation page
```
Use the fetch_holochain_doc tool with url "https://developer.holochain.org/concepts/3_source_chain"
```

## Architecture

The server is built using:
- **Effect TS**: Functional programming library with type-safe error handling and concurrency
- **@effect/platform**: Effect's platform abstractions for HTTP and other system operations
- **@modelcontextprotocol/sdk**: Official MCP TypeScript SDK
- **cheerio**: Server-side jQuery for parsing HTML content
- **Effect Schema**: Schema validation and parsing for tool inputs

### Effect TS Benefits

This implementation showcases Effect TS features:
- **Type-safe error handling**: All errors are typed and handled explicitly
- **Dependency injection**: Services are properly layered and injected
- **Concurrent operations**: Multiple documentation sources are searched concurrently
- **Functional composition**: Clean, composable code using Effect's pipe and combinators
- **Resource management**: Automatic cleanup and resource management

The `HolochainDocumentationService` class handles:
- Searching developer documentation by scraping common pages
- Searching Rust documentation (HDK/HDI) by checking module pages
- Fetching and parsing complete documentation pages
- Mapping function names and concepts to their documentation URLs

All operations are wrapped in Effect programs with proper error handling and resource management. Server-side jQuery for parsing HTML content
- **zod**: Schema validation for tool inputs

The `HolochainDocumentationService` class handles:
- Searching developer documentation by scraping common pages
- Searching Rust documentation (HDK/HDI) by checking module pages
- Fetching and parsing complete documentation pages
- Mapping function names and concepts to their documentation URLs

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Related Projects

- [Effect MCP](https://github.com/tim-smart/effect-mcp) - MCP server for Effect documentation (inspiration for this project)
- [Model Context Protocol](https://github.com/modelcontextprotocol) - Official MCP repositories
- [Holochain](https://github.com/holochain/holochain) - The Holochain core repository

## Support

- [Holochain Forum](https://forum.holochain.org/)
- [Holochain Discord](https://discord.gg/k55hHbRNVa)
- [Issues](https://github.com/yourusername/holochain-mcp-server/issues)